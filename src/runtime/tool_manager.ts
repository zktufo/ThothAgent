import type { LLMToolDefinition, LLMToolExecutionResult } from "../llm/index.js";
import { type VectorMemoryHit, MemoryStore } from "../memory/index.js";
import { verifyDrug } from "../tools/index.js";
import { SkillRegistry } from "../core/skill.js";
import { MCPClient } from "../core/mcp.js";
import { formatMemorySearchResults } from "../agent/memory_format.js";
import { SessionManager } from "../session/index.js";
import { initPetRag } from "../rag/index.js";

export interface ToolExecutionContext {
  fallbackUserInput: string;
  imagePath?: string;
}

function normalizeSearchQuery(input: Record<string, any>, fallback: string): Record<string, any> {
  return {
    query: typeof input.query === "string" && input.query.trim()
      ? input.query.trim()
      : fallback,
  };
}

/**
 * ToolManager owns:
 * - the LLM-visible tool catalog
 * - actual tool execution and compatibility routing
 * - session event logging for tool use/result
 */
export class ToolManager {
  constructor(
    private memory: MemoryStore,
    private mcp: MCPClient,
    private skills: SkillRegistry,
    private sessions: SessionManager,
  ) {}

  buildLLMTools(imagePath?: string): LLMToolDefinition[] {
    const tools: LLMToolDefinition[] = [
      {
        name: "memory",
        description: "维护长期记忆。用于保存重要偏好、项目事实、经验教训；支持 add、replace、remove；没有 read。",
        input_schema: {
          type: "object",
          properties: {
            action: { type: "string", enum: ["add", "replace", "remove"], description: "记忆操作" },
            target: { type: "string", enum: ["memory", "user"], description: "memory 保存环境/项目/经验；user 保存用户偏好/沟通方式" },
            content: { type: "string", description: "add 时的新条目；remove 时也可作为 old_text；replace 时可作为 new_text" },
            old_text: { type: "string", description: "replace/remove 用的唯一子串" },
            new_text: { type: "string", description: "replace 的新条目内容" },
          },
          required: ["action"],
        },
      },
      {
        name: "memory_search",
        description: "搜索用户专属记忆库。适合回答昨天聊了什么、之前提到过什么、上次说到哪里等问题。",
        input_schema: {
          type: "object",
          properties: {
            query: { type: "string", description: "要回忆的主题、关键词或自然语言问题" },
            limit: { type: "number", description: "返回的最多条数，默认 8" },
            kinds: {
              type: "array",
              items: { type: "string", enum: ["message", "fact", "summary", "preference", "event"] },
              description: "可选：限制记忆类型",
            },
          },
          required: ["query"],
        },
      },
      {
        name: "session_search",
        description: "搜索 session 历史，用于回忆过去讨论过但未写入长期记忆的内容。",
        input_schema: {
          type: "object",
          properties: {
            query: { type: "string", description: "要搜索的历史对话关键词或问题" },
            limit: { type: "number", description: "最多返回多少条历史片段，默认 8" },
          },
          required: ["query"],
        },
      },
      {
        name: "verify_drug",
        description: "校验宠物药品条码、名称和基础安全提醒",
        input_schema: {
          type: "object",
          properties: {
            barcode: { type: "string", description: "药品条码，通常为 10 位及以上数字" },
            name_hint: { type: "string", description: "药品名称、描述或用户原话" },
          },
        },
      },
            {
        name: "analyze_pet_image",
        description: "分析宠物照片中的健康线索",
        input_schema: {
          type: "object",
          properties: {
            prompt: { type: "string", description: "希望模型重点关注的图片分析要求" },
            image_path: { type: "string", description: "图片路径；默认使用当前用户上传的图片" },
          },
        },
      },
      {
                name: "pet_symptom_query",
        description: "【Agentic Search】智能搜索宠物知识库。自动多步搜索、评估结果质量、需要时追问。用户描述症状时优先调用，比LLM自己的知识更权威。",
        input_schema: {
          type: "object",
          properties: {
            query: { type: "string", description: "用户描述的症状或问题" },
            species: {
              type: "array",
              items: { type: "string", enum: ["dog", "cat", "rabbit", "hamster", "bird", "general"] },
              description: "可选：限定物种，如未指定会自动从query推断",
            },
          },
          required: ["query"],
        },
      },
    ];

    const activeTools = imagePath
      ? tools
      : tools.filter((tool) => tool.name !== "analyze_pet_image");

    activeTools.push(...this.skills.listLLMTools());
    return activeTools;
  }

  async execute(toolName: string, input: Record<string, any>, context: ToolExecutionContext): Promise<LLMToolExecutionResult> {
    await this.sessions.appendToolUse(toolName, input, {
      fallbackUserInput: context.fallbackUserInput,
    });

    const result = await this.runTool(toolName, input, context);

    await this.sessions.appendToolResult(toolName, result.message, {
      success: result.success,
      error: result.error,
      metadata: {
        input,
      },
    });

    return result;
  }

    private async runTool(toolName: string, input: Record<string, any>, context: ToolExecutionContext): Promise<LLMToolExecutionResult> {
    if (toolName === "memory") {
      const action = String(input.action || "add");
      const content = String(input.new_text || input.content || "").trim();
      const oldText = String(input.old_text || "").trim();

      if (action === "add" && content) {
        void this.memory.fileMemory.updateUserProfile({ traits: [content] }).catch(() => {});
        void this.memory.retrievalMemory.append({
          kind: "fact",
          text: content,
          tags: ["memory"],
          source: "memory-tool",
        }).catch(() => {});
      }

            const entries = this.memory.retrievalMemory.recent(5);
      const recentText = (await entries).map((e: any) => `- ${e.text.slice(0, 80)}`).join("\n") || "(empty)";
      return {
        success: true,
        data: { action, content },
        message: [
          `✅ memory ${action}: ${content.slice(0, 60) || "(empty)"}`,
                    `Current memories:`,
          recentText,
          "Note: memory changes are written asynchronously and usually show up from the next turn onward.",
        ].join("\n"),
      };
        }

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

    if (toolName === "memory_search") {
      const query = typeof input.query === "string" ? input.query.trim() : "";
      if (!query) {
        return { success: false, error: "missing_query", message: "⚠️ memory_search 需要 query 参数。" };
      }

      const limit = typeof input.limit === "number" ? input.limit : 8;
      const kinds = Array.isArray(input.kinds)
        ? input.kinds.filter((kind): kind is "message" | "fact" | "summary" | "preference" | "event" =>
          ["message", "fact", "summary", "preference", "event"].includes(String(kind)))
        : undefined;

      const relativeYesterday = /昨天|昨日|yesterday/i.test(query);
      const relativeToday = /今天|today/i.test(query);
      const relativeBefore = /前天/i.test(query);

      const hits = relativeYesterday
        ? await this.memory.recallRelativeDay(-1, limit)
        : relativeToday
          ? await this.memory.recallRelativeDay(0, limit)
          : relativeBefore
            ? await this.memory.recallRelativeDay(-2, limit)
            : await this.memory.searchMemory({ query, limit, kinds });

      const message = formatMemorySearchResults(hits as VectorMemoryHit[]);
      return { success: true, data: hits, message };
    }

    if (toolName === "verify_drug") {
      const barcode = typeof input.barcode === "string"
        ? input.barcode
        : context.fallbackUserInput.match(/\d{10,}/)?.[0];
      const nameHint = typeof input.name_hint === "string" && input.name_hint.trim()
        ? input.name_hint.trim()
        : context.fallbackUserInput;
      return verifyDrug(barcode, nameHint);
    }

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

            if (toolName === "pet_symptom_query") {
      const query = typeof input.query === "string" && input.query.trim()
        ? input.query.trim()
        : context.fallbackUserInput;

      const { AgenticSearcher } = await import("../rag/agentic_search.js");
      const searcher = new AgenticSearcher();
      const plan = await searcher.search(query, 5);
      const message = searcher.formatForPrompt(plan);

      return { success: true, data: plan, message };
    }

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
