/**
 * SessionArchiver 是 session 结束时的唯一归档入口。
 *
 * Session 结束 → 归档到 retrieval_memory.db（通过 ingestSessionExtraction）
 * Session 结束 → 清理 working state
 *
 * 清理 (2026-05-05): session_summary.md 已移除。
 * 旧的 session_summary.md / retrieval_memory.jsonl 双写问题已修复。
 */
import type { SQLiteSessionStore } from "./SQLiteSessionStore.js";
import type { ExtractionMaterial } from "./types.js";

export class SessionArchiver {
  constructor(
    private store: SQLiteSessionStore,
  ) {}

  /**
   * 归档一个已结束的 session。
   *
   * 摘要来源优先级：
   *   0. `llmSummary` — 外部传入的 LLM 摘要（最优质）
   *   1. SQLite 存档摘要
   *   2. 最近 6 条消息的原始截断 — 兜底
   *
   * 清理 (2026-05-05): session_summary.md 已移除。
   */
  async archive(sessionId: string, llmSummary?: string): Promise<ExtractionMaterial | null> {
    const material = await this.store.onSessionEnd(sessionId);
    if (!material) return null;

    const archived = selectArchivedSummary({
      llmSummary,
      sqliteSummary: material.summaryMarkdown.trim(),
      fallbackMessages: material.messages,
      sessionKey: material.session.sessionKey,
      title: material.session.title,
      endedAt: material.session.endedAt || material.session.lastActivityAt,
    });

    if (archived.markdown) {
      await this.store.saveArchivedSessionSummary(sessionId, archived);
    }

    return material;
  }

  /**
   * 完整结束流程：压缩 → 结束 → 归档 → 创建子 session。
   * 这是 Runtime.endCurrentBusinessSession 需要的完整原子操作。
   */
  async finalize(sessionId: string, llmSummary?: string): Promise<ExtractionMaterial | null> {
    return this.archive(sessionId, llmSummary);
  }
}

function selectArchivedSummary(input: {
  llmSummary?: string;
  sqliteSummary: string;
  fallbackMessages: Array<{ role: string; content?: string | null; contentSummary?: string | null }>;
  sessionKey: string;
  title: string;
  endedAt: string;
}) {
  const fallback = renderFallbackArchiveSummary(input.fallbackMessages, input.sessionKey, input.title, input.endedAt);
  const summary = input.llmSummary?.trim()
    ? { markdown: wrapArchiveSummary(input.llmSummary.trim(), input.sessionKey, input.title, input.endedAt), source: "llm" as const }
    : input.sqliteSummary
        ? { markdown: wrapArchiveSummary(input.sqliteSummary, input.sessionKey, input.title, input.endedAt), source: "sqlite" as const }
        : { markdown: fallback, source: "fallback" as const };

  return {
    markdown: summary.markdown,
    updatedAt: new Date().toISOString(),
    source: summary.source,
  };
}

function wrapArchiveSummary(summary: string, sessionKey: string, title: string, endedAt: string) {
  const body = summary.trim();
  if (!body) return "";
  return [
    "# Archived Session Summary",
    "",
    `- session_key: ${sessionKey}`,
    `- title: ${title}`,
    `- ended_at: ${endedAt}`,
    "",
    body,
    "",
  ].join("\n");
}

function renderFallbackArchiveSummary(
  messages: Array<{ role: string; content?: string | null; contentSummary?: string | null }>,
  sessionKey: string,
  title: string,
  endedAt: string,
) {
  const bullets = messages
    .filter((item) => item.role === "user" || item.role === "assistant" || item.role === "tool")
    .slice(-10)
    .map((item) => {
      const label = item.role === "user" ? "用户" : item.role === "assistant" ? "助手" : "工具";
      const content = String(item.contentSummary || item.content || "").replace(/\s+/g, " ").trim();
      return content ? `- ${label}：${clip(content, 140)}` : "";
    })
    .filter(Boolean);

  return [
    "# Archived Session Summary",
    "",
    `- session_key: ${sessionKey}`,
    `- title: ${title}`,
    `- ended_at: ${endedAt}`,
    "",
    "## Recent Turns",
    bullets.length ? bullets.join("\n") : "- 暂无可归档内容。",
    "",
  ].join("\n");
}

function clip(text: string, limit: number) {
  if (text.length <= limit) return text;
  return `${text.slice(0, Math.max(0, limit - 1))}…`;
}
