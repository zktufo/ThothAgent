import type { SQLiteSessionStore } from "./SQLiteSessionStore.js";
import type { RetentionCleanupResult, SessionMessageRecord } from "./types.js";

export interface SessionCompressorOptions {
  messageThreshold?: number;
  recentSummaryLimit?: number;
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
  readonly retentionDays: number;
  readonly artifactTrimAfterDays: number;
  readonly artifactTrimMinBytes: number;

  constructor(
    private store: SQLiteSessionStore,
    options: SessionCompressorOptions = {},
  ) {
    this.messageThreshold = options.messageThreshold ?? 18;
    this.recentSummaryLimit = options.recentSummaryLimit ?? 8;
    this.retentionDays = options.retentionDays ?? 30;
    this.artifactTrimAfterDays = options.artifactTrimAfterDays ?? 30;
    this.artifactTrimMinBytes = options.artifactTrimMinBytes ?? 24 * 1024;
  }

  async shouldCompress(sessionId: string) {
    const count = await this.store.countMessages(sessionId);
    return count >= this.messageThreshold;
  }

  async compressSession(sessionId: string) {
    const recent = await this.store.loadRecentMessages(sessionId, this.recentSummaryLimit);
    const markdown = renderSummary(recent);
    await this.store.saveSessionSummary(sessionId, {
      markdown,
      updatedAt: new Date().toISOString(),
    });
    return markdown;
  }

  async updateSessionSummary(sessionId: string) {
    return this.compressSession(sessionId);
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

function renderSummary(messages: SessionMessageRecord[]) {
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

  return [
    "# Session Summary",
    "",
    bullets.length ? bullets.join("\n") : "- 暂无摘要。",
  ].join("\n");
}

function clip(text: string, limit: number) {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (normalized.length <= limit) return normalized;
  return `${normalized.slice(0, Math.max(0, limit - 1))}…`;
}
