import type { DatabaseSync } from "node:sqlite";
import type { SessionMessageRecord, SessionSearchHit, SessionSearchOptions } from "./types.js";

export class SessionSearch {
  constructor(
    private db: DatabaseSync,
    private ftsEnabled: boolean,
  ) {}

  async searchMessages(query: string, options: SessionSearchOptions = {}): Promise<SessionSearchHit[]> {
    const keywords = splitChineseKeywords(query);
    if (!keywords.length) return [];

    if (this.ftsEnabled && !options.forceLike) {
      try {
        const hits = this.searchWithFts(keywords, options);
        return hits.length ? hits : this.searchWithLike(keywords, options);
      } catch {
        return this.searchWithLike(keywords, options);
      }
    }

    return this.searchWithLike(keywords, options);
  }

  private searchWithFts(keywords: string[], options: SessionSearchOptions) {
    const matchExpr = keywords.map((keyword) => `"${keyword.replace(/"/g, '""')}"`).join(" OR ");
    const { clause, params } = buildSessionClause(options);
    const stmt = this.db.prepare(`
      SELECT
        m.id,
        m.session_id,
        m.role,
        m.content,
        m.content_summary,
        m.tool_name,
        m.tool_call_id,
        m.artifact_id,
        m.token_estimate,
        m.created_at,
        m.metadata_json,
        -bm25(messages_fts) AS rank_score
      FROM messages_fts
      JOIN messages m ON m.id = messages_fts.message_id
      ${clause}
      AND messages_fts MATCH ?
      ORDER BY rank_score DESC, m.created_at DESC
      LIMIT ?
    `);
    const rows = stmt.all(...params, matchExpr, options.limit ?? 8) as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      message: rowToMessage(row),
      keywordHits: keywords.length,
    }));
  }

  private searchWithLike(keywords: string[], options: SessionSearchOptions) {
    const { clause, params } = buildSessionClause(options);
    const hitScore = keywords
      .map(() => `
        (CASE WHEN COALESCE(m.content, '') LIKE ? THEN 1 ELSE 0 END) +
        (CASE WHEN COALESCE(m.content_summary, '') LIKE ? THEN 1 ELSE 0 END)
      `)
      .join(" + ");

    const whereClause = keywords
      .map(() => `(COALESCE(m.content, '') LIKE ? OR COALESCE(m.content_summary, '') LIKE ?)`)
      .join(" OR ");

    const likeParams = keywords.flatMap((keyword) => {
      const pattern = `%${keyword}%`;
      return [pattern, pattern];
    });

    const scoreParams = keywords.flatMap((keyword) => {
      const pattern = `%${keyword}%`;
      return [pattern, pattern];
    });

    const stmt = this.db.prepare(`
      SELECT
        m.id,
        m.session_id,
        m.role,
        m.content,
        m.content_summary,
        m.tool_name,
        m.tool_call_id,
        m.artifact_id,
        m.token_estimate,
        m.created_at,
        m.metadata_json,
        (${hitScore}) AS keyword_hits
      FROM messages m
      ${clause}
      AND (${whereClause})
      ORDER BY keyword_hits DESC, m.created_at DESC
      LIMIT ?
    `);
    const rows = stmt.all(...scoreParams, ...params, ...likeParams, options.limit ?? 8) as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      message: rowToMessage(row),
      keywordHits: Number(row.keyword_hits || 0),
    }));
  }
}

export function splitChineseKeywords(input: string) {
  const normalized = input.trim().toLowerCase();
  if (!normalized) return [] as string[];

  const tokens = new Set<string>();
  const latin = normalized.match(/[a-z0-9_]+/g) || [];
  for (const token of latin) {
    if (token.length >= 2) tokens.add(token);
  }

  const hanMatches = normalized.match(/[\u4e00-\u9fff]+/g) || [];
  for (const block of hanMatches) {
    if (block.length <= 2) {
      tokens.add(block);
      continue;
    }
    tokens.add(block);
    for (let index = 0; index < block.length - 1; index += 1) {
      tokens.add(block.slice(index, index + 2));
    }
  }

  return [...tokens];
}

function buildSessionClause(options: SessionSearchOptions) {
  if (options.sessionId) {
    return {
      clause: "WHERE m.session_id = ?",
      params: [options.sessionId],
    };
  }

  if (options.sessionIds?.length) {
    const placeholders = options.sessionIds.map(() => "?").join(", ");
    return {
      clause: `WHERE m.session_id IN (${placeholders})`,
      params: [...options.sessionIds],
    };
  }

  return {
    clause: "WHERE 1 = 1",
    params: [] as string[],
  };
}

function rowToMessage(row: Record<string, unknown>): SessionMessageRecord {
  return {
    id: String(row.id),
    sessionId: String(row.session_id),
    role: row.role as SessionMessageRecord["role"],
    content: (row.content as string | null | undefined) ?? null,
    contentSummary: (row.content_summary as string | null | undefined) ?? null,
    toolName: (row.tool_name as string | null | undefined) ?? null,
    toolCallId: (row.tool_call_id as string | null | undefined) ?? null,
    artifactId: (row.artifact_id as string | null | undefined) ?? null,
    tokenEstimate: Number(row.token_estimate || 0),
    createdAt: String(row.created_at),
    metadata: parseJsonRecord(row.metadata_json),
  };
}

function parseJsonRecord(value: unknown) {
  try {
    return value ? JSON.parse(String(value)) as Record<string, unknown> : {};
  } catch {
    return {};
  }
}
