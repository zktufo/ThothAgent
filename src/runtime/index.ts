import {
  type LLMProvider,
  type ToolTraceEvent,
  MiniMaxLLM,
} from "../llm/index.js";
import { MemoryStore, logDaily } from "../memory/index.js";
import { SkillRegistry, registry } from "../core/skill.js";
import { MCPClient } from "../core/mcp.js";
import { buildSkillCatalog, buildSystemPrompt, buildToolDirectory, buildEnvironmentMetadata, buildSkillsIndex } from "../agent/prompt.js";
import { verifyDrug } from "../tools/index.js";
import { SessionArchiver, SessionManager } from "../session/index.js";
import { ToolManager } from "./tool_manager.js";
import { ModelManager } from "../model_manager/index.js";

export interface TimingPoint {
  label: string;
  elapsed: number;
}

export interface RuntimeTurnResult {
  text: string;
  trace: ToolTraceEvent[];
  timings: TimingPoint[];
}

export interface RuntimeBudgetPolicy {
  compactUsageFraction: number;
  maxToolSteps: number;
  maxProviderAttempts: number;
  maxUsageFraction: number;
  fallbackMaxTokens: number;
  normalMaxTokens: number;
  reducedMaxTokens: number;
}

export interface AgentRuntimeOptions {
  memory?: MemoryStore;
  llm?: LLMProvider;
  llmProviders?: LLMProvider[];
  mcp?: MCPClient;
  skills?: SkillRegistry;
  sessions?: SessionManager;
  budget?: Partial<RuntimeBudgetPolicy>;
}

interface ProviderExecutionContext {
  provider: LLMProvider;
  maxToolSteps: number;
  responseMaxTokens: number;
  toolsEnabled: boolean;
}

const DEFAULT_BUDGET: RuntimeBudgetPolicy = {
  compactUsageFraction: 0.9,
  maxToolSteps: 4,
  maxProviderAttempts: 2,
  maxUsageFraction: 0.98,
  normalMaxTokens: 2048,
  reducedMaxTokens: 1024,
  fallbackMaxTokens: 768,
};

export class AgentRuntime {
  readonly memory: MemoryStore;
  readonly llm: LLMProvider;
  readonly llmProviders: LLMProvider[];
  readonly mcp: MCPClient;
  readonly skills: SkillRegistry;
  readonly sessions: SessionManager;
  readonly archiver: SessionArchiver;
  readonly tools: ToolManager;
  readonly budget: RuntimeBudgetPolicy;
  readonly modelManager: ModelManager;
  lastProviderLabel: string;

  constructor(options: AgentRuntimeOptions = {}) {
    this.memory = options.memory || new MemoryStore();
    this.mcp = options.mcp || new MCPClient();
    this.skills = options.skills || registry;
    this.sessions = options.sessions || new SessionManager({
      homePaths: this.memory.homePaths,
      sessionId: this.memory.sessionId,
    });
    this.modelManager = new ModelManager({
      homePaths: this.memory.homePaths,
    });
    this.budget = {
      ...DEFAULT_BUDGET,
      ...(options.budget || {}),
    };
    const configuredProviders = options.llmProviders?.length
      ? options.llmProviders
      : options.llm
        ? [options.llm]
        : this.modelManager.getConfiguredProviders();
    this.llmProviders = configuredProviders.length ? configuredProviders : [new MiniMaxLLM()];
    this.llm = this.llmProviders[0] || new MiniMaxLLM();
    this.lastProviderLabel = `${this.llm.name}/${this.llm.model}`;

    this.skills.setMCP(this.mcp);
    void this.skills.loadAll();
    this.archiver = new SessionArchiver(
      this.sessions.store,
    );
    this.tools = new ToolManager(this.memory, this.mcp, this.skills, this.sessions);

    const skillList = this.skills.listAll();
    const catalog = buildSkillCatalog(skillList);
    const modelRoute = this.modelManager.getAgentModelConfig(this.memory.homePaths.agentName);
    logDaily(`[启动] 毛孩子健康顾问启动，skills: ${skillList.length} 个`);
    logDaily(`[Skill目录]\n${catalog}`);
    logDaily(`[LLM Route] primary=${modelRoute.primary} fallbacks=${(modelRoute.fallbacks || []).join(", ") || "(none)"}`);
    logDaily(`[LLM Providers] ${this.llmProviders.map((provider) => `${provider.name}:${provider.model}`).join(", ")}`);
  }

  async runTurn(
    userInput: string,
    imagePath?: string,
    onTrace?: (event: ToolTraceEvent) => void,
  ): Promise<RuntimeTurnResult> {
    const t0 = Date.now();
    const timings: TimingPoint[] = [];
    const mark = (label: string) => timings.push({ label, elapsed: Date.now() - t0 });
    const trace: ToolTraceEvent[] = [];
    const emitTrace = (event: ToolTraceEvent) => {
      trace.push(event);
      onTrace?.(event);
    };

    await this.sessions.init();
    await this.maybeCompactContext({
      forceCurrentSessionCompaction: this.primaryUsageFraction() >= this.budget.compactUsageFraction,
    });
    mark("session_init");
    const sessionId = await this.sessions.getCurrentSessionId();
    const recallIntent = /(昨天|昨日|前天|上次|之前|前面|刚才|聊了什么|说到哪|提到过|记得吗|remember|yesterday)/i.test(userInput);
    const turnMemory = await this.memory.manager.onTurnStart(userInput, sessionId);
    mark("memory_prefetch");

        if (this.primaryUsageFraction() >= this.budget.maxUsageFraction) {
      return {
        text: "⚠️ 当前会话预算已接近上限。请先新开一个会话，或让我先做摘要再继续。",
        trace,
        timings: [],
      };
    }

    if (userInput.startsWith("/")) {
      const skill = this.skills.match(userInput);
      if (skill) {
        await this.sessions.appendMessage("user", userInput);
        emitTrace({ type: "tool_use", toolName: skill.name, step: 0, input: { prompt: userInput } });
        const result = await this.skills.callSkill(skill, userInput);
        emitTrace({
          type: "tool_result",
          toolName: skill.name,
          step: 0,
          input: { prompt: userInput },
          success: !result.startsWith("⚠️"),
          message: this.summarizeTraceMessage(result),
        });
        await this.finalizeTurn(userInput, result, { userAlreadyStored: true });
        logDaily(`[skill:${skill.name}] ${userInput}`);
        mark("total");
        return { text: result, trace, timings };
      }
    }

    const drugKw = [
      "大宠爱","拜耳","内虫清","妙三多","卫佳","速诺","爱沃克","贝卫多",
      "耳康","美昔","消炎","驱虫","疫苗","阿莫西林","正品","验证","假药",
    ];
    if (drugKw.some((kw) => userInput.includes(kw))) {
      await this.sessions.appendMessage("user", userInput);
      const barcode = userInput.match(/\d{10,}/)?.[0];
      await this.sessions.appendToolUse("verify_drug", { barcode, name_hint: userInput });
      emitTrace({ type: "tool_use", toolName: "verify_drug", step: 0, input: { barcode, name_hint: userInput } });
      const result = verifyDrug(barcode, userInput);
      await this.sessions.appendToolResult("verify_drug", result.message, {
        success: result.success,
        error: result.error,
      });
      emitTrace({
        type: "tool_result",
        toolName: "verify_drug",
        step: 0,
        input: { barcode, name_hint: userInput },
        success: result.success,
        message: this.summarizeTraceMessage(result.message),
        error: result.error,
      });
            await this.finalizeTurn(userInput, result.message, { userAlreadyStored: true });
      logDaily(`[药品] ${userInput.slice(0, 40)}`);
      mark("total");
      return { text: result.message, trace, timings };
    }

    if (recallIntent) {
      await this.sessions.appendMessage("user", userInput);
      emitTrace({ type: "tool_use", toolName: "memory_search", step: 0, input: { query: userInput, limit: 8 } });
      const recallResult = await this.tools.execute("memory_search", { query: userInput, limit: 8 }, {
        fallbackUserInput: userInput,
        imagePath,
      });
      emitTrace({
        type: "tool_result",
        toolName: "memory_search",
        step: 0,
        input: { query: userInput, limit: 8 },
        success: recallResult.success,
        message: this.summarizeTraceMessage(recallResult.message),
        error: recallResult.error,
      });

      const recallContext = turnMemory.blocks.length
        ? [
          { role: "user" as const, content: this.memory.manager.buildMessages(userInput, [], turnMemory).memoryContext },
          { role: "user" as const, content: `用户问题：${userInput}\n\nmemory_search 结果：\n${recallResult.message}\n\n请基于这些记忆直接回答用户，不要再说“没有记录”，如果有不确定的地方就明确说明。` },
        ]
        : [
          { role: "user" as const, content: `用户问题：${userInput}\n\nmemory_search 结果：\n${recallResult.message}\n\n请基于这些记忆直接回答用户，不要再说“没有记录”，如果有不确定的地方就明确说明。` },
        ];

            const recallMemoryContext = turnMemory.blocks.length > 0
        ? this.memory.manager.buildMessages(userInput, [], turnMemory).memoryContext
        : undefined;
      const answer = await this.executeWithFallback({
        userInput,
        imagePath,
        context: recallContext,
        tools: [],
        toolsEnabled: false,
        systemPrompt: buildSystemPrompt(
          buildToolDirectory(),
          buildEnvironmentMetadata(await this.sessions.getCurrentSessionId()),
          buildSkillsIndex(this.skills.listAll()),
          this.memory.getHomeDocuments(),
          recallMemoryContext,
        ),
        emitTrace,
      });
            await this.finalizeTurn(userInput, answer, { userAlreadyStored: true });
      logDaily(`[回忆] ${userInput.slice(0, 40)}`);
      mark("total");
      return { text: answer, trace, timings };
    }

    const promptSession = await this.sessions.loadPromptContext(10);
    // session-summary 已包含在 Frozen Memory Snapshot 中，不再重复注入
    const recentContext = [
      ...promptSession.recentMessages
        .filter((message) => message.role === "user" || message.role === "assistant" || message.role === "tool")
        .map((message) => ({
          role: message.role === "assistant" ? "assistant" as const : "user" as const,
          content: message.contentSummary || message.content || "",
        })),
    ];
        const promptInput = this.memory.manager.buildMessages(userInput, recentContext, turnMemory);
    const context = promptInput.messages;
    const memorySnapshot = promptInput.includedBlocks.length > 0 ? promptInput.memoryContext : undefined;
    const systemPrompt = buildSystemPrompt(
      buildToolDirectory(),
      buildEnvironmentMetadata(await this.sessions.getCurrentSessionId()),
      buildSkillsIndex(this.skills.listAll()),
      this.memory.getHomeDocuments(),
      memorySnapshot,
    );
    const tools = this.tools.buildLLMTools(imagePath);

        mark("prompt_assembled");

    const text = await this.executeWithFallback({
      userInput,
      imagePath,
      context,
      tools,
      toolsEnabled: true,
      systemPrompt,
      emitTrace,
    });
    mark("llm_complete");

    await this.finalizeTurn(userInput, text);
    mark("finalize_complete");
    logDaily(`[对话] ${userInput.slice(0, 40)}`);
    return { text, trace, timings };
  }

  async endCurrentBusinessSession() {
    const session = await this.sessions.getCurrentSession();
    await this.sessions.compressor.updateSessionSummary(session.id);
    await this.sessions.store.endSession(session.id);
    await this.memory.manager.flushBackgroundTasks();

    // 用最便宜的 LLM 生成会话摘要，提升归档质量
    let llmSummary: string | undefined;
    try {
      llmSummary = await this.generateSessionSummary(session.id);
    } catch (e) {
      logDaily(`[Session Summary] LLM summarization failed: ${e}`);
    }

    const extraction = await this.archiver.archive(session.id, llmSummary);
    if (extraction) {
      logDaily(`[Session End] ${extraction.session.sessionKey}`);
    }
    return extraction;
  }

  private async generateSessionSummary(sessionId: string): Promise<string> {
    const messages = await this.sessions.loadHistory(sessionId, 80);
    if (messages.length < 2) return "";

    // 选最便宜的 provider（首选最后一个 fallback，通常是轻量模型）
    const provider = this.llmProviders.length > 1
      ? this.llmProviders[this.llmProviders.length - 1]
      : this.llmProviders[0];

    const dialog = messages
      .filter((m) => m.role === "user" || m.role === "assistant")
      .slice(-30)
      .map((m) => `${m.role === "user" ? "用户" : "助手"}：${m.contentSummary || m.content || ""}`)
      .join("\n");

    if (!dialog.trim()) return "";

    const prompt = [
      "总结以下对话（宠物健康顾问），用中文、分点列出：",
      "- 用户问的核心问题",
      "- 重要的宠物信息（品种、年龄、症状等）",
      "- 最终处理建议或结论",
      "",
      dialog.slice(-4000),
    ].join("\n");

    const result = await provider.chat(
      [{ role: "user", content: prompt }],
      "你是一个简洁的摘要助手。",
      1024,
    );

    return result.text.trim();
  }

  private async executeWithFallback(input: {
    userInput: string;
    imagePath?: string;
    context: Array<{ role: "user" | "assistant"; content: string | Array<Record<string, any>> }>;
    tools: any[];
    toolsEnabled: boolean;
    systemPrompt: string;
    emitTrace: (event: ToolTraceEvent) => void;
  }) {
    const attempts = this.selectProviders(input.userInput).slice(0, this.budget.maxProviderAttempts);
    let lastError: any = null;

    for (let index = 0; index < attempts.length; index += 1) {
      const provider = attempts[index];
      const route = this.routeBudgetForProvider(provider, input.toolsEnabled);

      try {
        if (route.toolsEnabled && input.tools.length > 0) {
          const { text, toolCalls } = await provider.runToolLoop(
            input.context,
            input.systemPrompt,
            input.tools,
            (toolName, toolInput) => this.tools.execute(toolName, toolInput, {
              fallbackUserInput: input.userInput,
              imagePath: input.imagePath,
            }),
            route.maxToolSteps,
            (event) => {
              if (event.type === "tool_result" && event.message) {
                input.emitTrace({ ...event, message: this.summarizeTraceMessage(event.message) });
                return;
              }
              input.emitTrace(event);
            },
          );
          if (toolCalls.length > 0) {
            logDaily(`[ReAct:${provider.name}] ${input.userInput.slice(0, 40)} -> ${toolCalls.join(", ")}`);
          }
          this.lastProviderLabel = `${provider.name}/${provider.model}`;
          return text;
        }

        return provider.chat(input.context, input.systemPrompt, route.responseMaxTokens).then((result) => {
          this.lastProviderLabel = `${provider.name}/${provider.model}`;
          return result.text;
        });
      } catch (error: any) {
        lastError = error;
        logDaily(`[LLM Fallback] provider=${provider.name} reason=${String(error?.message || error)}`);
      }
    }

    const primary = attempts[0] || this.llm;
    try {
      return await primary.chat(
        input.context,
        `${input.systemPrompt}\n\n请在预算有限的情况下，直接给出简洁结论，不要调用任何工具。`,
        this.budget.fallbackMaxTokens,
      ).then((result) => {
        this.lastProviderLabel = `${primary.name}/${primary.model}`;
        return result.text;
      });
    } catch (fallbackError: any) {
      lastError = fallbackError;
    }

    throw lastError || new Error("LLM 调用出错");
  }

  private selectProviders(userInput: string) {
    const providers = this.llmProviders.filter((provider) => provider.isAvailable());
    if (!providers.length) return [this.llm];

    const preferCheap = userInput.trim().length < 24;
    if (preferCheap) {
      return [...providers].sort((a, b) => a.model.length - b.model.length);
    }
    return providers;
  }

  private routeBudgetForProvider(provider: LLMProvider, toolsEnabled: boolean): ProviderExecutionContext {
    const usageFraction = provider.usage.usageFraction;
    const reduced = usageFraction >= 0.75;

    return {
      provider,
      toolsEnabled,
      maxToolSteps: reduced ? Math.max(1, this.budget.maxToolSteps - 2) : this.budget.maxToolSteps,
      responseMaxTokens: reduced ? this.budget.reducedMaxTokens : this.budget.normalMaxTokens,
    };
  }

  private primaryUsageFraction() {
    return this.llm.usage.usageFraction;
  }

  private async finalizeTurn(userInput: string, assistantText: string, options: { userAlreadyStored?: boolean } = {}) {
    if (!options.userAlreadyStored) {
      await this.sessions.appendMessage("user", userInput);
    }
    await this.sessions.appendMessage("assistant", assistantText);
    const sessionId = await this.sessions.getCurrentSessionId();
    void this.memory.manager.syncTurn(userInput, assistantText, sessionId);
    void this.memory.manager.queuePrefetch(userInput, sessionId);
  }

  private async maybeCompactContext(options: { forceCurrentSessionCompaction?: boolean } = {}) {
    const sessionId = await this.sessions.getCurrentSessionId();
    if (await this.sessions.compressor.shouldCompress(sessionId)) {
      await this.sessions.compressor.updateSessionSummary(sessionId);
    }
    if (options.forceCurrentSessionCompaction) {
      await this.sessions.compactCurrentSession();
      this.memory.manager.clearSessionSnapshot(sessionId);
      logDaily(`[Session Compact] auto-compacted current session at usage=${this.primaryUsageFraction().toFixed(2)}`);
    }
  }

  private summarizeTraceMessage(message: string, maxLen: number = 120) {
    const compact = message.replace(/\s+/g, " ").trim();
    if (compact.length <= maxLen) return compact;
    return `${compact.slice(0, maxLen - 1)}…`;
  }
}
