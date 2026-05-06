import { wrapMemoryContext } from "./safety.js";
import { clipCompactText, isLowInformationMessage, isMetaConversationTurn, isRecallHistoryQuery } from "../utils.js";
import { FileMemory } from "./file_memory.js";
import type { MemoryProvider } from "./provider.js";
import { RetrievalMemory } from "./retrieval_memory.js";
import { estimateTokens } from "./prompt_builder.js";
import type {
  ExternalMemoryRecord,
  MemoryContextBlock,
  ProviderPrefetchContext,
  ProviderPrefetchResult,
  QueuePrefetchInput,
  RetrievalMemoryHit,
  SyncTurnInput,
  WorkingState,
} from "./types.js";

export class BuiltinMemoryProvider implements MemoryProvider {
  readonly name = "builtin-memory";
  private initialized = false;
  private userMemory = "";
  private builtinMemory = "";
  private domainMemory = "";
  private workingState: WorkingState | null = null;

  constructor(private fileMemory: FileMemory) {}

  async init() {
    if (this.initialized) return;
    await this.fileMemory.init();
    await this.reloadCache();
    this.initialized = true;
  }

  async prefetch(context: ProviderPrefetchContext): Promise<ProviderPrefetchResult> {
    await this.init();
    const blocks: MemoryContextBlock[] = [];

    if (!isLowInformationMessage(context.userInput)) {
      const content = renderBuiltinSnapshot({
        memory: this.builtinMemory,
        user: this.userMemory,
        domain: this.domainMemory,
      }, isRecallHistoryQuery(context.userInput));
      if (content) {
        blocks.push({
          layer: "builtin_memory",
          title: "Built-in Memory Snapshot",
          content,
          priority: 100,
          tokensEstimate: estimateTokens(content),
          source: "MEMORY.md|USER.md|DOMAIN.md",
        });
      }
    }

    return {
      blocks,
      workingState: this.workingState || undefined,
      systemPromptBlock: [
        "你拥有以下内置记忆文件，可通过 `memory` 工具维护：",
        "- `MEMORY.md`：长期项目/环境/经验记忆",
        "- `USER.md`：用户偏好、称呼、沟通习惯",
        "- `DOMAIN.md`：领域知识、业务规则、术语和流程边界",
        "- `working_state.json`：当前会话状态机，由系统自动维护",
        "注意：这些文件在 session 启动时被冻结成 snapshot 注入本轮 system prompt。",
        "若你调用 `memory` 工具改写文件，修改会写盘，但通常在下一个 session 才重新注入。",
      ].join("\n"),
      debug: [`${this.name}: built-in memory snapshot loaded`],
    };
  }

  async systemPromptBlock() {
    await this.init();
    return null;
  }

  async syncTurn(input: SyncTurnInput) {
    await this.init();
    const turnCount = (this.workingState?.turnCount || 0) + 1;
    this.workingState = {
      ...(this.workingState || { status: "idle", turnCount: 0, vars: {} }),
      status: "completed",
      currentTask: clipCompactText(input.userInput, 80),
      currentStep: "turn-complete",
      lastUserInput: input.userInput,
      lastAssistantOutput: input.assistantOutput,
      turnCount,
      updatedAt: input.now,
    };
    await this.fileMemory.saveWorkingState(this.workingState);
  }

  async queuePrefetch(_input: QueuePrefetchInput) {
    await this.init();
    await this.reloadCache();
  }

  async onMemoryWrite() {
    // Built-in snapshot is frozen per session, so we intentionally do not
    // refresh the in-memory cache here. Changes take effect next session.
  }

  private async reloadCache() {
    const [userMemory, builtinMemory, domainMemory, workingState] = await Promise.all([
      this.fileMemory.getUserMemory(),
      this.fileMemory.getBuiltinMemory(),
      this.fileMemory.getDomainMemory(),
      this.fileMemory.getWorkingState(),
    ]);
    this.userMemory = userMemory;
    this.builtinMemory = builtinMemory;
    this.domainMemory = domainMemory;
    this.workingState = workingState;
  }
}

export class LocalFileExternalMemoryProvider implements MemoryProvider {
  readonly name = "external-file-memory";
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
    this.initialized = true;
  }

  async prefetch(context: ProviderPrefetchContext): Promise<ProviderPrefetchResult> {
    await this.init();
    if (isLowInformationMessage(context.userInput)) {
      return {
        debug: [`${this.name}: skipped retrieval for low-information input`],
      };
    }

    const hits = await this.fileMemory.searchExternalMemory(context.userInput, 4);
    if (!hits.length) {
      return {
        debug: [`${this.name}: no external memory hits`],
      };
    }

    const content = wrapMemoryContext(renderExternalMemories(hits));
    return {
      blocks: [{
        layer: "retrieval",
        title: "External Provider Memories",
        content,
        priority: 40,
        tokensEstimate: estimateTokens(content),
        source: "retrieval_memory.db",
      }],
      debug: [`${this.name}: injected ${hits.length} external memory hits`],
    };
  }

  async syncTurn(input: SyncTurnInput) {
    await this.init();
    if (!shouldPersistTurn(input.userInput, input.assistantOutput)) return;
    await this.fileMemory.appendExternalMemoryRecord(buildExternalMemoryRecord({
      source: "sync_turn",
      memoryType: "conversation_insight",
      sessionId: input.sessionId,
      userInput: input.userInput,
      assistantOutput: input.assistantOutput,
    }));
  }

  async queuePrefetch(_input: QueuePrefetchInput) {
    await this.init();
    await this.fileMemory.compactExternalMemory({
      dedupeSimilarityThreshold: 0.86,
      maxRecordsPerCluster: 4,
      compactOlderThanDays: 14,
    });
  }

  async onMemoryWrite(input: {
    action: "add" | "replace" | "remove";
    target: "memory" | "user" | "domain";
    content: string;
    oldText?: string;
    sessionId: string;
    now: string;
  }) {
    await this.init();
    await this.fileMemory.appendExternalMemoryRecord(buildExternalMemoryRecord({
      source: "on_memory_write",
      memoryType: "explicit_memory_write",
      sessionId: input.sessionId,
      userInput: `memory ${input.action} ${input.target}`,
      assistantOutput: input.content || input.oldText || "",
      explicitMemoryWrite: `${input.target}:${input.action}:${input.content || input.oldText || ""}`,
      writtenAt: input.now,
    }));
  }

  async searchMemory(input: {
    query: string;
    limit: number;
    kinds?: RetrievalMemoryHit["kind"][];
    datePrefix?: string;
  }): Promise<RetrievalMemoryHit[]> {
    await this.init();
    const hits = input.datePrefix
      ? (await this.retrievalMemory.searchByDate(input.datePrefix, input.limit)).map((hit) => ({
        ...hit,
        score: 1,
      }))
      : await this.retrievalMemory.search(input.query, input.limit);

    return hits
      .filter((hit) => !input.kinds?.length || input.kinds.includes(hit.kind))
      .map((hit) => ({ ...hit, score: typeof hit.score === "number" ? hit.score : 1 }));
  }
}

export class UnsupportedExternalMemoryProvider implements MemoryProvider {
  readonly name: string;
  private initialized = false;

  constructor(
    providerKind: string,
    private options: Record<string, unknown> = {},
  ) {
    this.name = `external-${providerKind}`;
  }

  async init() {
    this.initialized = true;
  }

  async prefetch(): Promise<ProviderPrefetchResult> {
    await this.init();
    return {
      debug: [`${this.name}: configured but not implemented in this build`],
    };
  }

  async searchMemory(): Promise<RetrievalMemoryHit[]> {
    await this.init();
    return [];
  }

  async syncTurn() {
    await this.init();
  }

  async queuePrefetch() {
    await this.init();
  }

  async onMemoryWrite() {
    await this.init();
  }
}

// Backward-compatible export while callers migrate to factory wiring.
export const ExternalFileMemoryProvider = LocalFileExternalMemoryProvider;

export class VisibleMemorySummaryProvider implements MemoryProvider {
  readonly name = "visible-memory-summary";

  constructor(private fileMemory: FileMemory) {}

  async init() {
    await this.fileMemory.init();
  }

  async prefetch(_context: ProviderPrefetchContext): Promise<ProviderPrefetchResult> {
    await this.init();
    return {
      debug: [`${this.name}: MEMORY.md is human-managed builtin memory`],
    };
  }
}

function renderBuiltinSnapshot(
  docs: { memory: string; user: string; domain: string },
  recallMode: boolean,
) {
  const sections = [
    docs.memory.trim()
      ? ["[MEMORY.md]", clipDocument(docs.memory, 800)].join("\n")
      : "",
    !recallMode && docs.user.trim()
      ? ["[USER.md]", clipDocument(docs.user, 600)].join("\n")
      : "",
    docs.domain.trim()
      ? ["[DOMAIN.md]", clipDocument(docs.domain, 800)].join("\n")
      : "",
  ].filter(Boolean);
  return sections.join("\n\n");
}

function clipDocument(content: string, maxChars: number) {
  const compact = content.trim();
  if (compact.length <= maxChars) return compact;
  return `${compact.slice(0, Math.max(0, maxChars - 1))}…`;
}

function renderExternalMemories(items: Array<{ record: ExternalMemoryRecord; score: number }>) {
  return items.map(({ record, score }) => {
    const summary = record.summary;
    const userRepresentation = record.userRepresentation.join("；");
    const peerCard = record.userPeerCard.join("；");
    const aiRepresentation = record.aiRepresentation.join("；");
    const aiIdentityCard = record.aiIdentityCard.join("；");
    return [
      `- score=${score} type=${record.memoryType} importance=${record.importance.toFixed(2)} decay=${record.decayProfile}`,
      `  - summary: ${clipCompactText(summary, 120)}`,
      `  - user_representation: ${clipCompactText(userRepresentation, 120)}`,
      `  - user_peer_card: ${clipCompactText(peerCard, 120)}`,
      `  - ai_representation: ${clipCompactText(aiRepresentation, 120)}`,
      `  - ai_identity_card: ${clipCompactText(aiIdentityCard, 120)}`,
    ].join("\n");
  }).join("\n");
}

function shouldPersistTurn(userInput: string, assistantOutput: string) {
  if (userInput.trim().length <= 6 || assistantOutput.trim().length <= 12) return false;
  if (isLowInformationMessage(userInput)) return false;
  if (isMetaConversationTurn(userInput, assistantOutput)) return false;
  return true;
}

function buildExternalMemoryRecord(input: {
  source: ExternalMemoryRecord["source"];
  memoryType: ExternalMemoryRecord["memoryType"];
  sessionId: string;
  userInput: string;
  assistantOutput: string;
  explicitMemoryWrite?: string;
  writtenAt?: string;
}) {
  const summary = [
    `用户问题：${clipCompactText(input.userInput, 120)}`,
    `助手回答：${clipCompactText(input.assistantOutput, 160)}`,
  ].join(" | ");

  const userRepresentation = [
    clipCompactText(input.userInput, 140),
    input.explicitMemoryWrite ? `显式记忆操作：${input.explicitMemoryWrite}` : "",
  ].filter(Boolean);

  const userPeerCard = inferUserPeerCard(input.userInput);
  const aiRepresentation = [
    clipCompactText(input.assistantOutput, 140),
    input.source === "on_memory_write" ? "assistant handled an explicit built-in memory write" : "assistant completed a turn",
  ];
  const aiIdentityCard = [
    "pet-agent-ts assistant",
    "acts as a vertical-domain agent with builtin files plus external memory provider",
  ];
  const keywords = inferKeywords(input.userInput, input.assistantOutput, input.explicitMemoryWrite);
  const topics = inferTopics(input.userInput, input.assistantOutput, input.explicitMemoryWrite);
  const signals = inferMemorySignals(input.userInput, input.assistantOutput, input.explicitMemoryWrite);
  const importance = inferImportance({
    source: input.source,
    explicitMemoryWrite: input.explicitMemoryWrite,
    signals,
  });
  const decayProfile = inferDecayProfile({
    explicitMemoryWrite: input.explicitMemoryWrite,
    signals,
  });

  return {
    schemaVersion: 1,
    sessionId: input.sessionId,
    userInput: input.userInput,
    assistantOutput: input.assistantOutput,
    summary,
    userRepresentation,
    userPeerCard,
    aiRepresentation,
    aiIdentityCard,
    keywords,
    topics,
    importance,
    decayProfile,
    signals,
    source: input.source,
    memoryType: input.memoryType,
    writtenAt: input.writtenAt,
    metadata: input.explicitMemoryWrite ? { explicitMemoryWrite: input.explicitMemoryWrite } : {},
  };
}

function inferUserPeerCard(userInput: string) {
  const lines: string[] = [];
  if (/直接|简洁|结论先/i.test(userInput)) lines.push("用户偏好直接、先结论式回答");
  if (/宠物|狗|猫|症状|驱虫|疫苗/i.test(userInput)) lines.push("用户当前关注宠物健康/护理主题");
  if (/记住|以后|下次/i.test(userInput)) lines.push("用户在表达长期偏好或稳定要求");
  return lines.length ? lines : ["用户画像待继续积累"];
}

function inferKeywords(userInput: string, assistantOutput: string, explicitMemoryWrite?: string) {
  return [...new Set([
    ...tokenizeCompact(userInput),
    ...tokenizeCompact(assistantOutput),
    ...tokenizeCompact(explicitMemoryWrite || ""),
  ])].slice(0, 20);
}

function inferTopics(userInput: string, assistantOutput: string, explicitMemoryWrite?: string) {
  const haystack = `${userInput}\n${assistantOutput}\n${explicitMemoryWrite || ""}`;
  const topics: string[] = [];
  if (/狗|猫|宠物|疫苗|驱虫|症状|健康/i.test(haystack)) topics.push("pet-health");
  if (/直接|简洁|结论|格式|风格/i.test(haystack)) topics.push("response-style");
  if (/记住|以后|下次|偏好|习惯/i.test(haystack)) topics.push("user-preference");
  if (/规则|领域|术语|流程/i.test(haystack)) topics.push("domain-knowledge");
  return topics.length ? topics : ["general"];
}

function inferMemorySignals(userInput: string, assistantOutput: string, explicitMemoryWrite?: string) {
  const haystack = `${userInput}\n${assistantOutput}\n${explicitMemoryWrite || ""}`;
  return {
    hasExplicitMemoryWrite: Boolean(explicitMemoryWrite),
    hasPreferenceSignal: /喜欢|偏好|直接|简洁|风格|以后|下次|结论先/i.test(haystack),
    hasDomainSignal: /规则|领域|术语|流程|知识/i.test(haystack),
    hasIdentitySignal: /叫我|我叫|用户称呼|身份|职业/i.test(haystack),
    hasPositiveFeedback: /很好|不错|对了|靠谱|好用|以后这样/i.test(haystack),
  };
}

function inferImportance(input: {
  source: ExternalMemoryRecord["source"];
  explicitMemoryWrite?: string;
  signals: ExternalMemoryRecord["signals"];
}) {
  let score = 0.35;
  if (input.source === "on_memory_write") score += 0.25;
  if (input.signals.hasExplicitMemoryWrite) score += 0.15;
  if (input.signals.hasPreferenceSignal) score += 0.1;
  if (input.signals.hasDomainSignal) score += 0.08;
  if (input.signals.hasIdentitySignal) score += 0.08;
  if (input.signals.hasPositiveFeedback) score += 0.12;
  return Math.min(1, score);
}

function inferDecayProfile(input: {
  explicitMemoryWrite?: string;
  signals: ExternalMemoryRecord["signals"];
}): ExternalMemoryRecord["decayProfile"] {
  if (input.signals.hasExplicitMemoryWrite || input.signals.hasIdentitySignal) return "sticky";
  if (input.signals.hasPreferenceSignal || input.signals.hasDomainSignal) return "slow";
  if (input.signals.hasPositiveFeedback) return "normal";
  return "ephemeral";
}

function tokenizeCompact(text: string) {
  return text
    .toLowerCase()
    .split(/[\s,，。！？?!.:：/\\|()[\]{}<>]+/)
    .map((item) => item.trim())
    .filter((item) => item.length >= 2)
    .slice(0, 12);
}
