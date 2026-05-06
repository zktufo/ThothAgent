/**
 * ToolManager — owns LLM-visible tool catalog, execution, and security.
 *
 * Each tool call passes through the ToolHarness for:
 *   - L1 command/path sandboxing (exec, read, write tools)
 *   - Resource concurrency locks (optional)
 *   - SQLite audit trail (all tools)
 *
 * Three new tools added:
 *   - exec: run terminal commands (sandboxed)
 *   - read: read file contents (sandboxed)
 *   - write: write content to files (sandboxed)
 */

import type { LLMToolDefinition, LLMToolExecutionResult } from "../llm/index.js";
import { type MemoryRecordKind, type VectorMemoryHit, MemoryStore } from "../memory/index.js";
import { verifyDrug } from "../tools/index.js";
import { SkillRegistry } from "../core/skill.js";
import { MCPClient } from "../core/mcp.js";
import { formatMemorySearchResults } from "../agent/memory_format.js";
import { SessionManager } from "../session/index.js";
import { ragSearch } from "../tools/local_rag.js";
import { clipCompactText, isRecallHistoryQuery } from "../memory/utils.js";
import { validateMemoryContent, checkMemoryLength, scanMemoryContent, findDuplicate, MEMORY_LIMITS } from "../memory/layered/safety.js";
import { ModelManager } from "../model_manager/index.js";
import {
  ToolHarness,
  type HarnessPolicy,
  type ExecutionContext,
  type ToolResult,
} from "../harness/index.js";
import { buildBuiltinLLMToolDefinitions } from "./tool_catalog.js";

export interface ToolExecutionContext {
  fallbackUserInput: string;
  imagePath?: string;
  /** ReAct step 序号 */
  step?: number;
}

function sanitizeAgentId(value: string) {
  const normalized = value.trim().toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
  return normalized || "main";
}

function normalizeSearchQuery(input: Record<string, any>, fallback: string): Record<string, any> {
  return {
    query: typeof input.query === "string" && input.query.trim()
      ? input.query.trim()
      : fallback,
  };
}

function summarizeToolStats(actions: Array<{ toolName?: string | null; outputStatus?: string | null }>) {
  const map = new Map<string, { tool: string; total: number; success: number; error: number; successRate: string }>();
  for (const action of actions) {
    const tool = action.toolName || "unknown";
    const current = map.get(tool) || { tool, total: 0, success: 0, error: 0, successRate: "100%" };
    current.total += 1;
    if (action.outputStatus === "error") current.error += 1;
    else current.success += 1;
    current.successRate = `${Math.round((current.success / current.total) * 1000) / 10}%`;
    map.set(tool, current);
  }
  return [...map.values()].sort((a, b) => b.total - a.total || a.tool.localeCompare(b.tool));
}

/**
 * ToolManager owns:
 * - the LLM-visible tool catalog
 * - actual tool execution and compatibility routing
 * - session event logging for tool use/result
 * - security/resource/audit via ToolHarness
 */
export class ToolManager {
  private harness: ToolHarness;
  private modelManager: ModelManager;

  constructor(
    private memory: MemoryStore,
    private mcp: MCPClient,
    private skills: SkillRegistry,
    private sessions: SessionManager,
    harness?: ToolHarness,
  ) {
    this.harness = harness ?? new ToolHarness();
    this.modelManager = new ModelManager({ homePaths: this.memory.homePaths });
  }

  /**
   * Update the security policy at runtime.
   * Creates a new ToolHarness with the merged policy.
   */
  configureSecurity(policy: Partial<HarnessPolicy>): void {
    this.harness.updatePolicy(policy);
  }

  buildLLMTools(imagePath?: string): LLMToolDefinition[] {
    const activeTools = buildBuiltinLLMToolDefinitions({ imagePath });

    activeTools.push(...this.skills.listLLMTools());
    return activeTools;
  }

  async execute(
    toolName: string,
    input: Record<string, any>,
    context: ToolExecutionContext,
  ): Promise<LLMToolExecutionResult> {
    await this.sessions.appendToolUse(toolName, input, {
      metadata: { fallbackUserInput: context.fallbackUserInput },
      step: context.step,
    });

    const result = await this.runTool(toolName, input, context);

    await this.sessions.appendToolResult(toolName, result.message, {
      success: result.success,
      error: result.error,
      step: context.step,
      metadata: { input },
    });

    return result;
  }

  /**
   * Build an ExecutionContext from the tool context + default policy.
   */
  private buildExecCtx(context: ToolExecutionContext): ExecutionContext {
    return {
      agentId: this.memory.homePaths.agentName,
      sessionId: context.fallbackUserInput?.slice(0, 64) || "unknown",
      userInput: context.fallbackUserInput,
      policy: {}, // uses harness defaults
    };
  }

  /**
   * Convert a ToolResult to LLMToolExecutionResult.
   */
  private toLLMResult(result: ToolResult): LLMToolExecutionResult {
    return {
      success: result.success,
      message: result.message,
      data: result.data,
      error: result.error,
    };
  }

  private async runTool(
    toolName: string,
    input: Record<string, any>,
    context: ToolExecutionContext,
  ): Promise<LLMToolExecutionResult> {
    const execCtx = this.buildExecCtx(context);

    // --- NEW: exec tool ---
    if (toolName === "exec") {
      const command = typeof input.command === "string" ? input.command.trim() : "";
      if (!command) {
        return { success: false, error: "missing_command", message: "⚠️ exec 需要 command 参数。" };
      }

      const result = await this.harness.exec(command, execCtx);
      return this.toLLMResult(result);
    }

    // --- NEW: read tool ---
    if (toolName === "read") {
      const filePath = typeof input.file_path === "string" ? input.file_path.trim() : "";
      if (!filePath) {
        return { success: false, error: "missing_file_path", message: "⚠️ read 需要 file_path 参数。" };
      }

      const offset = typeof input.offset === "number" ? input.offset : undefined;
      const limit = typeof input.limit === "number" ? input.limit : undefined;

      const result = await this.harness.readFile(filePath, execCtx, { offset, limit });
      return this.toLLMResult(result);
    }

    // --- NEW: write tool ---
    if (toolName === "write") {
      const filePath = typeof input.file_path === "string" ? input.file_path.trim() : "";
      const content = typeof input.content === "string" ? input.content : "";

      if (!filePath) {
        return { success: false, error: "missing_file_path", message: "⚠️ write 需要 file_path 参数。" };
      }
      if (!content) {
        return { success: false, error: "missing_content", message: "⚠️ write 需要 content 参数。" };
      }

      const append = input.append === true;

      const result = await this.harness.writeFile(filePath, content, execCtx, { append });
      return this.toLLMResult(result);
    }

    // --- EXISTING: memory tool ---
    if (toolName === "agent_manage") {
      const action = String(input.action || "").trim();
      if (action === "list") {
        const agents = this.modelManager.listAgents();
        const message = agents.length
          ? [
            "## Agents",
            ...agents.map((agent, index) => `${index + 1}. id=${agent.id} name=${agent.name} model=${agent.model.primary}`),
          ].join("\n")
          : "当前还没有注册任何 agent。";
        return { success: true, data: agents, message };
      }

      if (action === "create") {
        const displayName = String(input.display_name || "").trim();
        const description = String(input.description || "").trim();
        const preferredId = String(input.agent_id || displayName || description || "main");
        const agentId = sanitizeAgentId(preferredId);
        if (agentId === "main") {
          return { success: false, error: "invalid_agent_id", message: "⚠️ 新 agent 不能使用 main 作为 ID，请提供更具体的 agent_id 或 display_name。" };
        }

        const primaryModel = typeof input.primary_model === "string" && input.primary_model.trim()
          ? input.primary_model.trim()
          : undefined;
        const fallbackModels = Array.isArray(input.fallback_models)
          ? input.fallback_models.map((item) => String(item).trim()).filter(Boolean)
          : undefined;

        const ensured = await this.modelManager.ensureAgentRegistered(agentId, {
          displayName: displayName || agentId,
          primaryModel,
          fallbackModels,
        });

        if (description) {
          const fs = await import("fs");
          let domainDoc = "";
          try {
            domainDoc = fs.readFileSync(ensured.paths.domainContextPath, "utf-8");
          } catch {}
          const nextDoc = [
            domainDoc.trim() || "# DOMAIN.md",
            "",
            `## Agent Scope`,
            `- Agent ID: ${ensured.agentId}`,
            `- Display Name: ${displayName || ensured.agentId}`,
            `- Description: ${description}`,
          ].join("\n");
          fs.writeFileSync(ensured.paths.domainContextPath, `${nextDoc.trim()}\n`, "utf-8");
        }

        return {
          success: true,
          data: ensured,
          message: [
            `✅ 已创建新 agent：${ensured.agentId}`,
            `- 路径: ${ensured.paths.agentRoot}`,
            `- 工作区: ${ensured.paths.workspaceDir}`,
            `- 主模型: ${ensured.model.primary}`,
            description ? `- 说明: ${description}` : "",
          ].filter(Boolean).join("\n"),
        };
      }

      return { success: false, error: "invalid_action", message: "⚠️ agent_manage 只支持 action=create 或 action=list。" };
    }

    // --- EXISTING: memory tool ---
    if (toolName === "memory") {
      const action = String(input.action || "add");
      const target = String(input.target || "memory");
      let content = String(input.new_text || input.content || "").trim();
      const oldText = String(input.old_text || "").trim();
      if (!["memory", "user", "domain"].includes(target)) {
        return { success: false, error: "invalid_target", message: "⚠️ memory target 只支持 memory / user / domain。" };
      }

      if (action !== "remove" && content) {
        const length = checkMemoryLength(content, "fact");
        if (!length.ok) {
          return { success: false, error: "content_too_long", message: `⚠️ 记忆内容 (${length.used} 字符) 超过 ${length.limit} 字符限制。请缩短内容后重试。` };
        }

        const safety = scanMemoryContent(content);
        if (!safety.safe) {
          return { success: false, error: "content_blocked", message: `⛔ ${safety.error}` };
        }
      }

      if ((action === "replace" || action === "remove") && !oldText) {
        return { success: false, error: "missing_old_text", message: "⚠️ replace/remove 需要 old_text 参数。" };
      }

      if (action === "add" || action === "replace" || action === "remove") {
        await this.memory.fileMemory.rewriteBuiltinMemory(target as "memory" | "user" | "domain", {
          action: action as "add" | "replace" | "remove",
          content,
          oldText,
        });
        void this.memory.manager.onMemoryWrite({
          action: action as "add" | "replace" | "remove",
          target: target as "memory" | "user" | "domain",
          content,
          oldText,
        }).catch(() => {});
      }

      const doc = target === "user"
        ? await this.memory.fileMemory.getUserMemory()
        : target === "domain"
          ? await this.memory.fileMemory.getDomainMemory()
          : await this.memory.fileMemory.getBuiltinMemory();
      return {
        success: true,
        data: { action, content },
        message: [
          `✅ memory ${action} -> ${target}: ${content ? content.slice(0, 60) : "(empty)"}`,
          `Updated document preview:`,
          clipCompactText(doc, 400),
          "Note: built-in memory files are rewritten immediately, but the current session keeps using its frozen startup snapshot.",
        ].join("\n"),
      };
    }

    // --- EXISTING: session_search ---
    if (toolName === "session_search") {
      const query = typeof input.query === "string" ? input.query.trim() : "";
      if (!query) {
        return { success: false, error: "missing_query", message: "⚠️ session_search 需要 query 参数。" };
      }

      const limit = typeof input.limit === "number" ? input.limit : 8;
      const hits = await this.sessions.search(query, limit);
      const message = hits.length
        ? hits.map((hit, index) => {
          const role = hit.message.role;
          const when = hit.message.createdAt.slice(0, 19);
          const content = hit.message.contentSummary || hit.message.content || "";
          return `${index + 1}. [${when}] ${role}: ${content}`;
        }).join("\n")
        : "没有找到相关历史会话。";

      return { success: true, data: hits, message };
    }

    // --- EXISTING: memory_search ---
    if (toolName === "memory_search") {
      const query = typeof input.query === "string" ? input.query.trim() : "";
      if (!query) {
        return { success: false, error: "missing_query", message: "⚠️ memory_search 需要 query 参数。" };
      }

      const limit = typeof input.limit === "number" ? input.limit : 8;
      const memoryKinds: MemoryRecordKind[] = ["message", "fact", "summary", "preference", "event", "best_try"];
      const explicitKinds = Array.isArray(input.kinds)
        ? input.kinds.filter((kind): kind is MemoryRecordKind => memoryKinds.includes(String(kind) as MemoryRecordKind))
        : undefined;
      const defaultRecallKinds: MemoryRecordKind[] = ["message", "summary", "best_try"];
      const kinds = explicitKinds?.length
        ? explicitKinds
        : isRecallHistoryQuery(query)
          ? defaultRecallKinds
          : undefined;

      const relativeYesterday = /昨天|昨日|yesterday/i.test(query);
      const relativeToday = /今天|today/i.test(query);
      const relativeBefore = /前天/i.test(query);
      const recallHistory = isRecallHistoryQuery(query);
      const archivedSummaryHits = recallHistory
        ? await this.sessions.searchArchivedSummaries(query, Math.min(4, limit))
        : [];

      const hits = relativeYesterday
        ? await this.memory.recallRelativeDay(-1, limit)
        : relativeToday
          ? await this.memory.recallRelativeDay(0, limit)
          : relativeBefore
            ? await this.memory.recallRelativeDay(-2, limit)
            : await this.memory.searchMemory({ query, limit, kinds });

      const parts = [
        formatArchivedSessionSummaryHits(archivedSummaryHits),
        formatMemorySearchResults(hits as VectorMemoryHit[]),
      ].filter(Boolean);
      const message = parts.join("\n\n");
      return { success: true, data: hits, message };
    }

    if (toolName === "tool_stats") {
      const limit = typeof input.limit === "number" ? Math.max(1, Math.min(20, input.limit)) : 5;
      const actions = await this.sessions.listSessionActions();
      const results = actions.filter((action) => action.actionType === "tool_result" && action.toolName);
      const uses = actions.filter((action) => action.actionType === "tool_use" && action.toolName);
      const successCount = results.filter((action) => action.outputStatus === "success").length;
      const failureCount = results.filter((action) => action.outputStatus === "error").length;
      const totalResults = results.length;
      const successRate = totalResults > 0 ? successCount / totalResults : 1;
      const byTool = summarizeToolStats(results);
      const inFlight = Math.max(0, uses.length - results.length);
      const recentFailures = results
        .filter((action) => action.outputStatus === "error")
        .slice(-limit)
        .reverse()
        .map((action) => ({
          tool: action.toolName,
          step: action.step,
          at: action.createdAt,
          summary: action.outputSummary,
        }));

      const percent = `${Math.round(successRate * 1000) / 10}%`;
      const lines = [
        "## Tool 调用统计",
        `- 当前 session 已完成 tool result: ${totalResults}`,
        `- 成功: ${successCount}`,
        `- 失败: ${failureCount}`,
        `- 成功率: ${percent}`,
        `- 进行中/未配对 tool_use: ${inFlight}`,
        "",
        "### 按工具统计",
        ...byTool.map((item) => `- ${item.tool}: total=${item.total}, success=${item.success}, error=${item.error}, successRate=${item.successRate}`),
        recentFailures.length ? "" : "",
        recentFailures.length ? "### 最近失败" : "",
        ...recentFailures.map((item) => `- [${item.at}] ${item.tool}${item.step ? `#${item.step}` : ""}: ${item.summary || "(empty)"}`),
      ].filter(Boolean);

      return {
        success: true,
        data: {
          totalResults,
          successCount,
          failureCount,
          successRate,
          inFlight,
          byTool,
          recentFailures,
        },
        message: lines.join("\n"),
      };
    }

    // --- EXISTING: verify_drug ---
    if (toolName === "verify_drug") {
      const barcode = typeof input.barcode === "string"
        ? input.barcode
        : context.fallbackUserInput.match(/\d{10,}/)?.[0];
      const nameHint = typeof input.name_hint === "string" && input.name_hint.trim()
        ? input.name_hint.trim()
        : context.fallbackUserInput;
      return verifyDrug(barcode, nameHint);
    }

    // --- EXISTING: analyze_pet_image ---
    if (toolName === "analyze_pet_image") {
      if (!context.imagePath && typeof input.image_path !== "string") {
        return { success: false, error: "missing_image", message: "⚠️ 当前没有可分析的宠物图片。" };
      }

      return this.mcp.call("minimax.understand_image", {
        prompt: typeof input.prompt === "string" && input.prompt.trim()
          ? input.prompt.trim()
          : `请分析这张宠物照片，并结合用户问题给出健康建议：${context.fallbackUserInput}`,
        image_source: typeof input.image_path === "string" && input.image_path.trim()
          ? input.image_path.trim()
          : context.imagePath,
      });
    }

    // --- RAG: 知识库查询（外挂 Python 混合检索服务） ---
    if (toolName === "rag_query") {
      const query = typeof input.query === "string" && input.query.trim()
        ? input.query.trim()
        : context.fallbackUserInput;

      if (input.mode === "search") {
        // 只搜不生成，返回原文片段
        return await ragSearch(query, input.topK ?? 3);
      }

      // 默认：问答模式，外挂 RAG 服务做检索+生成
      const { ragAsk } = await import("../tools/local_rag.js");
      return await ragAsk(query, input.mode === "agentic" ? "agentic" : "simple");
    }

    // --- SKILL TOOLS ---
    const skill = this.skills.findByLLMToolName(toolName);
    if (!skill) {
      return { success: false, error: "tool_not_found", message: `⚠️ 未找到工具：${toolName}` };
    }

    const payload = toolName === "web_search"
      ? normalizeSearchQuery(input, context.fallbackUserInput)
      : input;

    const result = await this.skills.callSkill(skill, payload);
    return { success: !result.startsWith("⚠️"), message: result };
  }
}

function formatArchivedSessionSummaryHits(hits: Array<{
  session: { sessionKey: string; title: string };
  summary: { markdown: string; source?: string };
}>) {
  if (!hits.length) return "";

  return [
    "## Archived Session Summaries",
    ...hits.map((hit, index) => {
      const bullets = hit.summary.markdown
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line.startsWith("- "))
        .slice(0, 4)
        .join("\n");
      return [
        `${index + 1}. session=${hit.session.sessionKey} title=${hit.session.title} source=${hit.summary.source || "unknown"}`,
        bullets || "- 暂无摘要片段。",
      ].join("\n");
    }),
  ].join("\n");
}
