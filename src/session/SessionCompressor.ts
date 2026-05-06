import type { SQLiteSessionStore } from "./SQLiteSessionStore.js";
import type { RetentionCleanupResult, SessionMessageRecord } from "./types.js";

export interface SessionCompressorOptions {
  messageThreshold?: number;
  recentSummaryLimit?: number;
  recentKeepLimit?: number;
  retentionDays?: number;
  artifactTrimAfterDays?: number;
  artifactTrimMinBytes?: number;
}

/**
 * SessionCompressor keeps prompt-facing session context compact without turning
 * session storage into long-term memory.
 *
 * The first version uses a deterministic mock summarizer so the behavior is
 * stable, cheap, and testable.
 */
export class SessionCompressor {
  readonly messageThreshold: number;
  readonly recentSummaryLimit: number;
  readonly recentKeepLimit: number;
  readonly retentionDays: number;
  readonly artifactTrimAfterDays: number;
  readonly artifactTrimMinBytes: number;

  constructor(
    private store: SQLiteSessionStore,
    options: SessionCompressorOptions = {},
  ) {
    this.messageThreshold = options.messageThreshold ?? 18;
    this.recentSummaryLimit = options.recentSummaryLimit ?? 8;
    this.recentKeepLimit = options.recentKeepLimit ?? 12;
    this.retentionDays = options.retentionDays ?? 30;
    this.artifactTrimAfterDays = options.artifactTrimAfterDays ?? 30;
    this.artifactTrimMinBytes = options.artifactTrimMinBytes ?? 24 * 1024;
  }

  async shouldCompress(sessionId: string) {
    const count = await this.store.countMessages(sessionId);
    return count >= this.messageThreshold;
  }

  async compressSession(sessionId: string) {
    const previous = await this.store.loadSessionSummary(sessionId);
    const recent = await this.store.loadRecentMessages(sessionId, this.recentSummaryLimit);
    const markdown = renderSummary(previous?.markdown || "", recent);
    await this.store.saveSessionSummary(sessionId, {
      markdown,
      updatedAt: new Date().toISOString(),
    });
    return markdown;
  }

  async updateSessionSummary(sessionId: string) {
    return this.compressSession(sessionId);
  }

  async compactCurrentSession(sessionId: string) {
    await this.compressSession(sessionId);
    return this.store.compactSessionMessagesExceptRecent(sessionId, this.recentKeepLimit);
  }

  async applyRetentionPolicy(): Promise<RetentionCleanupResult> {
    const cutoffIso = new Date(Date.now() - (this.retentionDays * 24 * 60 * 60 * 1000)).toISOString();
    const oldSessions = await this.store.listSessionsOlderThan(cutoffIso);

    let messagesCompacted = 0;
    for (const session of oldSessions) {
      const summary = await this.store.loadSessionSummary(session.id);
      if (!summary?.markdown.trim()) continue;
      messagesCompacted += await this.store.compactSessionMessagesBefore(session.id, cutoffIso);
    }

    const artifactsTrimmed = await this.store.artifacts.trimArtifacts({
      olderThanDays: this.artifactTrimAfterDays,
      minSizeBytes: this.artifactTrimMinBytes,
    });

    return {
      sessionsScanned: oldSessions.length,
      messagesCompacted,
      artifactsTrimmed,
    };
  }
}

function renderSummary(previousSummary: string, messages: SessionMessageRecord[]) {
  const bullets = messages
    .filter((message) => message.role === "user" || message.role === "assistant" || message.role === "tool")
    .map((message) => {
      const label = message.role === "user"
        ? "用户"
        : message.role === "assistant"
          ? "助手"
          : `工具${message.toolName ? `(${message.toolName})` : ""}`;
      const content = message.contentSummary || message.content || "";
      return `- ${label}：${clip(content, 120)}`;
    });

  const userFacts = extractUserFacts(messages);
  const assistantConclusions = extractAssistantConclusions(messages);
  const previousCarry = extractCarryForward(previousSummary);

  return [
    "# Session Summary",
    "",
    "## Carry Forward",
    previousCarry.length ? previousCarry.join("\n") : "- 暂无历史沉淀。",
    "",
    "## Key Facts",
    userFacts.length ? userFacts.join("\n") : "- 暂无稳定关键信息。",
    "",
    "## Current Conclusions",
    assistantConclusions.length ? assistantConclusions.join("\n") : "- 暂无明确结论。",
    "",
    "## Recent Turns",
    bullets.length ? bullets.join("\n") : "- 暂无摘要。",
  ].join("\n");
}

function clip(text: string, limit: number) {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (normalized.length <= limit) return normalized;
  return `${normalized.slice(0, Math.max(0, limit - 1))}…`;
}

function extractCarryForward(previousSummary: string) {
  return previousSummary
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.startsWith("- "))
    .slice(0, 4);
}

function extractUserFacts(messages: SessionMessageRecord[]) {
  return messages
    .filter((message) => message.role === "user")
    .map((message) => String(message.contentSummary || message.content || "").trim())
    .filter(Boolean)
    .filter((line) => /狗|猫|宠物|岁|月|症状|食欲|呕吐|腹泻|咳嗽|耳朵|皮肤|喝水|绝育/.test(line))
    .slice(-4)
    .map((line) => `- ${clip(line, 120)}`);
}

function extractAssistantConclusions(messages: SessionMessageRecord[]) {
  return messages
    .filter((message) => message.role === "assistant")
    .map((message) => String(message.contentSummary || message.content || "").trim())
    .filter(Boolean)
    .slice(-3)
    .map((line) => `- ${clip(line, 140)}`);
}
