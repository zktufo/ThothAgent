import { clipCompactText, isLowInformationMessage } from "../utils.js";
import { FileMemory } from "./file_memory.js";
import { MemoryProvider } from "./provider.js";
import { RetrievalMemory } from "./retrieval_memory.js";
import { estimateTokens } from "./prompt_builder.js";
import type {
  MemoryContextBlock,
  ProviderPrefetchContext,
  ProviderPrefetchResult,
  QueuePrefetchInput,
  RetrievalMemoryHit,
  SyncTurnInput,
  UserProfile,
  WorkingState,
} from "./types.js";

export interface FileMemoryProviderOptions {
  summaryEveryTurns?: number;
  sessionSummaryMaxChars?: number;
}

/**
 * FileMemoryProvider 负责“稳定、轻量、可缓存”的几层记忆：
 * - user_profile.json
 * - domain_context.md
 * - session_summary.md
 * - working_state.json
 *
 * 这里故意不做重计算，只读取缓存或本地轻量文件。
 */
export class FileMemoryProvider implements MemoryProvider {
  readonly name = "file-memory";
  private initialized = false;
  private cachedProfile: UserProfile | null = null;
  private cachedDomainContext = "";
  private cachedSessionSummary = "";
  private cachedWorkingState: WorkingState | null = null;
  private readonly summaryEveryTurns: number;
  private readonly sessionSummaryMaxChars: number;

  constructor(
    private fileMemory: FileMemory,
    options: FileMemoryProviderOptions = {},
  ) {
    this.summaryEveryTurns = options.summaryEveryTurns ?? 4;
    this.sessionSummaryMaxChars = options.sessionSummaryMaxChars ?? 2_400;
  }

  async init() {
    if (this.initialized) return;
    await this.fileMemory.init();
    await this.reloadCache();
    this.initialized = true;
  }

  async prefetch(_context: ProviderPrefetchContext): Promise<ProviderPrefetchResult> {
    await this.init();

    // 对寒暄、测试输入不注入业务背景，尽量把 token 降到最低。
    if (isLowInformationMessage(_context.userInput)) {
      return {
        workingState: this.cachedWorkingState || undefined,
        debug: [`${this.name}: skipped prompt blocks for low-information input`],
      };
    }

    const blocks: MemoryContextBlock[] = [];

    if (this.cachedProfile) {
      const content = renderUserProfile(this.cachedProfile);
      if (content) {
        blocks.push({
          layer: "user_profile",
          title: "User Profile",
          content,
          priority: 100,
          tokensEstimate: estimateTokens(content),
          source: "user_profile.json",
        });
      }
    }

    if (this.cachedDomainContext.trim()) {
      const content = renderMarkdownBulletSummary(this.cachedDomainContext, 6);
      blocks.push({
        layer: "domain_context",
        title: "Domain Context",
        content,
        priority: 80,
        tokensEstimate: estimateTokens(content),
        source: "domain_context.md",
      });
    }

    if (this.cachedSessionSummary.trim()) {
      const content = renderMarkdownBulletSummary(this.cachedSessionSummary, 5);
      blocks.push({
        layer: "session_summary",
        title: "Session Summary",
        content,
        priority: 60,
        tokensEstimate: estimateTokens(content),
        source: "session_summary.md",
      });
    }

    return {
      blocks,
      workingState: this.cachedWorkingState || undefined,
      debug: [`${this.name}: profile/domain/session loaded from cache`],
    };
  }

  async syncTurn(input: SyncTurnInput) {
    await this.init();

    const previousTurnCount = Number(this.cachedWorkingState?.turnCount || 0);
    const turnCount = previousTurnCount + 1;
    await this.fileMemory.updateWorkingState({
      status: "completed",
      currentTask: clipCompactText(input.userInput, 80),
      currentStep: "turn-complete",
      lastUserInput: input.userInput,
      lastAssistantOutput: input.assistantOutput,
      turnCount,
      updatedAt: input.now,
    });

    const profilePatch = inferUserProfilePatch(input.userInput);
    if (profilePatch) {
      await this.fileMemory.updateUserProfile(profilePatch);
    }

    if (turnCount === 1 || turnCount % this.summaryEveryTurns === 0) {
      await this.fileMemory.appendSessionSummary([
        "",
        `- 用户：${clipCompactText(input.userInput, 80)}`,
        `- 助手：${clipCompactText(input.assistantOutput, 120)}`,
      ], this.sessionSummaryMaxChars);
    }

    await this.reloadCache();
  }

  async queuePrefetch(_input: QueuePrefetchInput) {
    await this.init();
    await this.reloadCache();
  }

  private async reloadCache() {
    const [profile, domainContext, sessionSummary, workingState] = await Promise.all([
      this.fileMemory.getUserProfile(),
      this.fileMemory.getDomainContext(),
      this.fileMemory.getSessionSummary(),
      this.fileMemory.getWorkingState(),
    ]);
    this.cachedProfile = profile;
    this.cachedDomainContext = domainContext;
    this.cachedSessionSummary = sessionSummary;
    this.cachedWorkingState = workingState;
  }
}

export class RetrievalMemoryProvider implements MemoryProvider {
  readonly name = "retrieval-memory";
  private initialized = false;

  constructor(
    private retrievalMemory: RetrievalMemory,
    private topK: number = 4,
  ) {}

  async init() {
    if (this.initialized) return;
    await this.retrievalMemory.init();
    this.initialized = true;
  }

  async prefetch(context: ProviderPrefetchContext): Promise<ProviderPrefetchResult> {
    await this.init();

    // retrieval 是最容易“白花 token”的一层，所以低信息输入直接跳过。
    if (isLowInformationMessage(context.userInput)) {
      return {
        debug: [`${this.name}: skipped retrieval for low-information input`],
      };
    }

    const hits = this.retrievalMemory.getCached(context.userInput).slice(0, this.topK);
    if (!hits.length) {
      return {
        debug: [`${this.name}: cache miss, skipped heavy retrieval in prefetch`],
      };
    }

    const content = renderRelevantMemories(hits);
    return {
      blocks: [{
        layer: "retrieval",
        title: "Relevant Memories",
        content,
        priority: 40,
        tokensEstimate: estimateTokens(content),
        source: "retrieval_memory.jsonl",
      }],
      debug: [`${this.name}: cache hit with ${hits.length} retrieval memories`],
    };
  }

  async syncTurn(input: SyncTurnInput) {
    await this.init();
    if (!shouldPersistTurn(input.userInput, input.assistantOutput)) return;

    await this.retrievalMemory.append({
      kind: "message",
      text: `用户：${clipCompactText(input.userInput, 160)}\n助手：${clipCompactText(input.assistantOutput, 220)}`,
      tags: ["turn", input.sessionId],
      source: "sync-turn",
      metadata: {
        sessionId: input.sessionId,
      },
    });
  }

  async queuePrefetch(input: QueuePrefetchInput) {
    await this.init();
    await this.retrievalMemory.warmQuery(input.userInput, this.topK);
  }
}

export class VisibleMemorySummaryProvider implements MemoryProvider {
  readonly name = "visible-memory-summary";
  private initialized = false;

  constructor(
    private fileMemory: FileMemory,
    private retrievalMemory: RetrievalMemory,
  ) {}

  async init() {
    if (this.initialized) return;
    await Promise.all([
      this.fileMemory.init(),
      this.retrievalMemory.init(),
    ]);
    await this.refreshSummary();
    this.initialized = true;
  }

  async prefetch(_context: ProviderPrefetchContext): Promise<ProviderPrefetchResult> {
    await this.init();
    return {
      debug: [`${this.name}: visible MEMORY.md ready`],
    };
  }

  async syncTurn(_input: SyncTurnInput) {
    await this.init();
    await this.refreshSummary();
  }

  async queuePrefetch(_input: QueuePrefetchInput) {
    await this.init();
    await this.refreshSummary();
  }

  private async refreshSummary() {
    // 这份 MEMORY.md 是给人读的，所以它更像“仪表盘摘要”，而不是原始存储导出。
    const [profile, sessionSummary, recent] = await Promise.all([
      this.fileMemory.getUserProfile(),
      this.fileMemory.getSessionSummary(),
      this.retrievalMemory.recent(6),
    ]);

    const content = [
      "# MEMORY.md - 记忆摘要",
      "",
      "> 这是面向用户可见的记忆摘要，会随着对话自动整理更新。",
      "",
      "## 用户画像",
      renderVisibleUserProfile(profile),
      "",
      "## 当前会话摘要",
      renderVisibleSessionSummary(sessionSummary),
      "",
      "## 近期重要记忆",
      recent.length
        ? recent.map((item) => `- ${clipCompactText(item.text, 140)}`).join("\n")
        : "- 暂无长期记忆。",
      "",
      "## 说明",
      "- 更底层的业务规则放在 `domain_context.md`。",
      "- `working_state.json` 用于流程控制，不会直接展示给模型。",
    ].join("\n");

    await this.fileMemory.saveVisibleMemorySummary(content);
  }
}

function renderUserProfile(profile: UserProfile) {
  const lines: string[] = [];
  if (profile.displayName) lines.push(`- 用户称呼偏好：${profile.displayName}`);
  if (profile.preferences?.answerStyle) lines.push(`- 用户偏好 ${profile.preferences.answerStyle} 的回答风格`);
  if (profile.preferences?.responseLength) lines.push(`- 用户偏好 ${profile.preferences.responseLength} 的回答长度`);
  if (profile.preferences?.formatting?.length) lines.push(`- 输出格式偏好：${profile.preferences.formatting.join("、")}`);
  if (profile.traits?.length) lines.push(...profile.traits.slice(0, 4).map((trait) => `- ${trait}`));
  for (const [key, value] of Object.entries(profile.stableFacts || {}).slice(0, 4)) {
    lines.push(`- ${key}：${String(value)}`);
  }
  return lines.join("\n");
}

function renderVisibleUserProfile(profile: UserProfile) {
  const lines: string[] = [];
  if (profile.displayName) lines.push(`- 你希望被称呼为：${profile.displayName}`);
  if (profile.preferences?.answerStyle) lines.push(`- 你偏好的回答风格：${profile.preferences.answerStyle}`);
  if (profile.preferences?.responseLength) lines.push(`- 你偏好的回答长度：${profile.preferences.responseLength}`);
  if (profile.preferences?.formatting?.length) lines.push(`- 你喜欢的表达形式：${profile.preferences.formatting.join("、")}`);
  if (profile.traits?.length) lines.push(...profile.traits.slice(0, 3).map((trait) => `- ${trait}`));
  return lines.length ? lines.join("\n") : "- 暂无稳定画像。";
}

function renderMarkdownBulletSummary(markdown: string, limit: number) {
  return markdown
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"))
    .slice(0, limit)
    .map((line) => line.startsWith("-") ? line : `- ${line}`)
    .join("\n");
}

function renderVisibleSessionSummary(markdown: string) {
  const lines = renderMarkdownBulletSummary(markdown, 6);
  return lines || "- 暂无会话摘要。";
}

function renderRelevantMemories(hits: RetrievalMemoryHit[]) {
  return hits.map((hit) => `- ${clipCompactText(hit.text, 140)}`).join("\n");
}

function shouldPersistTurn(userInput: string, assistantOutput: string) {
  return userInput.trim().length > 6 && assistantOutput.trim().length > 12;
}

function inferUserProfilePatch(userInput: string): Partial<UserProfile> | null {
  const patch: Partial<UserProfile> = {};

  const nameMatch = userInput.match(/叫我([^\s，。!！?？]{1,12})/);
  if (nameMatch) patch.displayName = nameMatch[1];

  if (/直接一点|别绕弯|工程化|给结论/i.test(userInput)) {
    patch.preferences = {
      ...(patch.preferences || {}),
      answerStyle: "direct and engineering-focused",
    };
  }

  if (/简短|短一点|一句话/i.test(userInput)) {
    patch.preferences = {
      ...(patch.preferences || {}),
      responseLength: "concise",
    };
  }

  if (/分点|条理|列表/i.test(userInput)) {
    patch.preferences = {
      ...(patch.preferences || {}),
      formatting: ["bullet points"],
    };
  }

  return Object.keys(patch).length ? patch : null;
}
