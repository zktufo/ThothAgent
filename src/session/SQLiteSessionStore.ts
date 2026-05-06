import fs from "node:fs";
import crypto from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import type { UserHomePaths } from "../home/index.js";
import { ActionLogStore } from "../action/ActionLogStore.js";
import { ArtifactStore } from "../artifacts/ArtifactStore.js";
import { SessionSearch } from "./SessionSearch.js";
import type { SessionStore } from "./SessionStore.js";
import type {
  AppendMessageInput,
  AppendToolMessageInput,
  CreateChildSessionInput,
  CreateSessionInput,
  ExtractionMaterial,
  ArchivedSessionSummaryPayload,
  ArchivedSessionSummaryHit,
  SessionMessageRecord,
  SessionRecord,
  SessionSearchHit,
  SessionListOptions,
  SessionSearchOptions,
  SessionSummaryPayload,
} from "./types.js";

export interface SQLiteSessionStoreOptions {
  homePaths: UserHomePaths;
  dbPath?: string;
  forceDisableFts?: boolean;
  debug?: boolean;
}

/**
 * SQLiteSessionStore is the raw storage layer for sessions.
 *
 * It only stores what happened:
 * - sessions
 * - messages
 * - actions
 * - artifacts
 *
 * It intentionally does not decide what should become long-term memory.
 */
export class SQLiteSessionStore implements SessionStore {
  readonly homePaths: UserHomePaths;
  readonly dbPath: string;
  readonly debug: boolean;
  readonly db: DatabaseSync;
  readonly artifacts: ArtifactStore;
  readonly actions: ActionLogStore;
  readonly searcher: SessionSearch;
  private initialized = false;
  private ftsEnabled = false;

  constructor(options: SQLiteSessionStoreOptions) {
    this.homePaths = options.homePaths;
    this.dbPath = options.dbPath || this.homePaths.sessionDbPath;
    this.debug = Boolean(options.debug);
    fs.mkdirSync(this.homePaths.sessionsDir, { recursive: true });
    this.db = new DatabaseSync(this.dbPath);
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec("PRAGMA synchronous = NORMAL;");
    this.db.exec("PRAGMA foreign_keys = ON;");
    this.db.exec("PRAGMA temp_store = MEMORY;");
    this.ensureSchema(Boolean(options.forceDisableFts));
    this.artifacts = new ArtifactStore(this.db);
    this.actions = new ActionLogStore(this.db);
    this.searcher = new SessionSearch(this.db, this.ftsEnabled);
  }

  async init() {
    if (this.initialized) return;
    this.archiveDuplicateActiveSessions();
    this.initialized = true;
  }

  supportsFts() {
    return this.ftsEnabled;
  }

  async createSession(input: CreateSessionInput): Promise<SessionRecord> {
    await this.init();
    const now = new Date().toISOString();
    const record: SessionRecord = {
      id: crypto.randomUUID(),
      sessionKey: input.sessionKey,
      tenantId: input.tenantId,
      userId: input.userId,
      channel: input.channel,
      businessObjectType: input.businessObjectType ?? null,
      businessObjectId: input.businessObjectId ?? null,
      title: input.title?.trim() || "新会话",
      parentSessionId: input.parentSessionId ?? null,
      status: input.status ?? "active",
      startedAt: now,
      lastActivityAt: now,
      endedAt: null,
      metadata: input.metadata ?? {},
    };

    try {
      this.db.prepare(`
        INSERT INTO sessions (
          id, session_key, tenant_id, user_id, channel,
          business_object_type, business_object_id, title,
          parent_session_id, status, started_at, last_activity_at,
          ended_at, metadata_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        record.id,
        record.sessionKey,
        record.tenantId,
        record.userId,
        record.channel,
        record.businessObjectType ?? null,
        record.businessObjectId ?? null,
        record.title,
        record.parentSessionId ?? null,
        record.status,
        record.startedAt,
        record.lastActivityAt,
        record.endedAt ?? null,
        JSON.stringify(record.metadata),
      );
      this.archiveRouteSiblingSessions(record);
      this.log(`createSession ${record.sessionKey}`);
      return record;
    } catch (error) {
      this.log(`createSession failed: ${String(error)}`);
      throw error;
    }
  }

  async getOrCreateSession(input: CreateSessionInput): Promise<SessionRecord> {
    const existing = await this.getSessionByKey(input.sessionKey);
    if (!existing) {
      return this.createSession(input);
    }

    if (existing.status === "ended" || existing.status === "archived") {
      return this.reopenSession(existing.id);
    }

    return existing;
  }

  async getSessionById(sessionId: string): Promise<SessionRecord | null> {
    await this.init();
    const row = this.db.prepare(`
      SELECT
        id, session_key, tenant_id, user_id, channel, business_object_type,
        business_object_id, title, parent_session_id, status, started_at,
        last_activity_at, ended_at, metadata_json
      FROM sessions
      WHERE id = ?
    `).get(sessionId) as Record<string, unknown> | undefined;

    return row ? toSessionRecord(row) : null;
  }

  async getSessionByKey(sessionKey: string): Promise<SessionRecord | null> {
    await this.init();
    const row = this.db.prepare(`
      SELECT
        id, session_key, tenant_id, user_id, channel, business_object_type,
        business_object_id, title, parent_session_id, status, started_at,
        last_activity_at, ended_at, metadata_json
      FROM sessions
      WHERE session_key = ?
      ORDER BY last_activity_at DESC
      LIMIT 1
    `).get(sessionKey) as Record<string, unknown> | undefined;

    return row ? toSessionRecord(row) : null;
  }

  async listSessions(options: SessionListOptions = {}): Promise<SessionRecord[]> {
    await this.init();
    const limit = options.limit ?? 20;
    const status = options.status ?? "all";

    if (status === "all") {
      const rows = this.db.prepare(`
        SELECT
          id, session_key, tenant_id, user_id, channel, business_object_type,
          business_object_id, title, parent_session_id, status, started_at,
          last_activity_at, ended_at, metadata_json
        FROM sessions
        ORDER BY last_activity_at DESC
        LIMIT ?
      `).all(limit) as Array<Record<string, unknown>>;
      return rows.map(toSessionRecord);
    }

    const rows = this.db.prepare(`
      SELECT
        id, session_key, tenant_id, user_id, channel, business_object_type,
        business_object_id, title, parent_session_id, status, started_at,
        last_activity_at, ended_at, metadata_json
      FROM sessions
      WHERE status = ?
      ORDER BY last_activity_at DESC
      LIMIT ?
    `).all(status, limit) as Array<Record<string, unknown>>;
    return rows.map(toSessionRecord);
  }

  async createChildSession(input: CreateChildSessionInput): Promise<SessionRecord> {
    const parent = await this.getSessionById(input.parentSessionId);
    if (!parent) {
      throw new Error(`parent session not found: ${input.parentSessionId}`);
    }

    return this.createSession({
      sessionKey: input.sessionKey || `${parent.sessionKey}:child:${shortId()}`,
      tenantId: parent.tenantId,
      userId: parent.userId,
      channel: parent.channel,
      businessObjectType: parent.businessObjectType ?? undefined,
      businessObjectId: parent.businessObjectId ?? undefined,
      title: input.title || `${parent.title} / 子会话`,
      parentSessionId: parent.id,
      metadata: {
        ...parent.metadata,
        ...(input.metadata || {}),
      },
    });
  }

  async appendMessage(input: AppendMessageInput): Promise<SessionMessageRecord> {
    await this.init();
    const createdAt = new Date().toISOString();
    const normalized = normalizeMessageInput(input, createdAt);

    try {
      this.db.prepare(`
        INSERT INTO messages (
          id, session_id, role, content, content_summary, tool_name,
          tool_call_id, artifact_id, token_estimate, created_at, metadata_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        normalized.id,
        normalized.sessionId,
        normalized.role,
        normalized.content ?? null,
        normalized.contentSummary ?? null,
        normalized.toolName ?? null,
        normalized.toolCallId ?? null,
        normalized.artifactId ?? null,
        normalized.tokenEstimate,
        normalized.createdAt,
        JSON.stringify(normalized.metadata),
      );
      this.insertIntoFts(normalized);
      await this.updateLastActivity(normalized.sessionId, normalized.createdAt);
      await this.updateSessionTitleIfNeeded(normalized.sessionId, normalized);
      return normalized;
    } catch (error) {
      this.log(`appendMessage failed: ${String(error)}`);
      throw error;
    }
  }

  async appendToolMessage(input: AppendToolMessageInput): Promise<SessionMessageRecord> {
    return this.appendMessage({
      sessionId: input.sessionId,
      role: "tool",
      content: input.content ?? null,
      contentSummary: input.contentSummary ?? null,
      toolName: input.toolName,
      toolCallId: input.toolCallId,
      artifactId: input.artifactId,
      tokenEstimate: input.tokenEstimate,
      metadata: input.metadata,
    });
  }

  async loadRecentMessages(sessionId: string, limit: number): Promise<SessionMessageRecord[]> {
    await this.init();
    const rows = this.db.prepare(`
      SELECT
        id, session_id, role, content, content_summary, tool_name,
        tool_call_id, artifact_id, token_estimate, created_at, metadata_json
      FROM messages
      WHERE session_id = ?
      ORDER BY created_at DESC
      LIMIT ?
    `).all(sessionId, limit) as Array<Record<string, unknown>>;

    return rows.map(toMessageRecord).reverse();
  }

  async updateLastActivity(sessionId: string, at: string = new Date().toISOString()): Promise<void> {
    await this.init();
    this.db.prepare(`
      UPDATE sessions
      SET last_activity_at = ?, status = CASE WHEN status = 'ended' THEN status ELSE 'active' END
      WHERE id = ?
    `).run(at, sessionId);
  }

  async endSession(sessionId: string, endedAt: string = new Date().toISOString()): Promise<void> {
    await this.init();
    this.db.prepare(`
      UPDATE sessions
      SET status = 'ended', ended_at = ?, last_activity_at = ?
      WHERE id = ?
    `).run(endedAt, endedAt, sessionId);
  }

  async reopenSession(sessionId: string, reopenedAt: string = new Date().toISOString()): Promise<SessionRecord> {
    await this.init();
    this.db.prepare(`
      UPDATE sessions
      SET status = 'active', ended_at = NULL, last_activity_at = ?
      WHERE id = ?
    `).run(reopenedAt, sessionId);

    const reopened = await this.getSessionById(sessionId);
    if (!reopened) {
      throw new Error(`session not found after reopen: ${sessionId}`);
    }
    this.archiveRouteSiblingSessions(reopened);
    return reopened;
  }

  async searchMessages(query: string, options: SessionSearchOptions = {}): Promise<SessionSearchHit[]> {
    await this.init();
    return this.searcher.searchMessages(query, options);
  }

  async searchArchivedSummaries(query: string, limit: number = 8): Promise<ArchivedSessionSummaryHit[]> {
    await this.init();
    const tokens = query
      .toLowerCase()
      .split(/[\s,，。！？?!.:：/\\|()[\]{}<>]+/)
      .map((item) => item.trim())
      .filter((item) => item.length >= 2);

    const rows = this.db.prepare(`
      SELECT
        id, session_key, tenant_id, user_id, channel, business_object_type,
        business_object_id, title, parent_session_id, status, started_at,
        last_activity_at, ended_at, metadata_json
      FROM sessions
      WHERE json_extract(metadata_json, '$.archivedSessionSummary') IS NOT NULL
      ORDER BY last_activity_at DESC
      LIMIT 200
    `).all() as Array<Record<string, unknown>>;

    const candidates: Array<ArchivedSessionSummaryHit | null> = rows
      .map((row) => {
        const session = toSessionRecord(row);
        const markdown = typeof session.metadata.archivedSessionSummary === "string"
          ? String(session.metadata.archivedSessionSummary)
          : "";
        if (!markdown.trim()) return null;

        const haystack = `${session.title}\n${markdown}`.toLowerCase();
        const keywordHits = tokens.length
          ? tokens.reduce((sum, token) => sum + (haystack.includes(token) ? 1 : 0), 0)
          : 0;
        if (tokens.length && keywordHits === 0) return null;

        const summary: ArchivedSessionSummaryPayload = {
          markdown,
          updatedAt: typeof session.metadata.archivedSessionSummaryUpdatedAt === "string"
            ? String(session.metadata.archivedSessionSummaryUpdatedAt)
            : session.lastActivityAt,
          source: typeof session.metadata.archivedSessionSummarySource === "string"
            ? session.metadata.archivedSessionSummarySource as ArchivedSessionSummaryPayload["source"]
            : "fallback",
        };

        return {
          session,
          summary,
          keywordHits,
        };
      });

    return candidates
      .filter((item): item is ArchivedSessionSummaryHit => item !== null)
      .sort((a, b) => {
        if (b.keywordHits !== a.keywordHits) return b.keywordHits - a.keywordHits;
        return b.session.lastActivityAt.localeCompare(a.session.lastActivityAt);
      })
      .slice(0, limit);
  }

  async saveSessionSummary(sessionId: string, summary: SessionSummaryPayload): Promise<void> {
    await this.init();
    const session = await this.getSessionById(sessionId);
    if (!session) throw new Error(`session not found: ${sessionId}`);
    const metadata = {
      ...session.metadata,
      sessionSummary: summary.markdown,
      sessionSummaryUpdatedAt: summary.updatedAt,
    };
    this.db.prepare(`
      UPDATE sessions
      SET metadata_json = ?, last_activity_at = ?
      WHERE id = ?
    `).run(JSON.stringify(metadata), summary.updatedAt, sessionId);
  }

  async loadSessionSummary(sessionId: string): Promise<SessionSummaryPayload | null> {
    const session = await this.getSessionById(sessionId);
    const markdown = typeof session?.metadata.sessionSummary === "string"
      ? session.metadata.sessionSummary
      : "";
    if (!session || !markdown) return null;
    return {
      markdown,
      updatedAt: typeof session.metadata.sessionSummaryUpdatedAt === "string"
        ? String(session.metadata.sessionSummaryUpdatedAt)
        : session.lastActivityAt,
    };
  }

  async saveArchivedSessionSummary(sessionId: string, summary: ArchivedSessionSummaryPayload): Promise<void> {
    await this.init();
    const session = await this.getSessionById(sessionId);
    if (!session) throw new Error(`session not found: ${sessionId}`);
    const metadata = {
      ...session.metadata,
      archivedSessionSummary: summary.markdown,
      archivedSessionSummaryUpdatedAt: summary.updatedAt,
      archivedSessionSummarySource: summary.source || "fallback",
    };
    this.db.prepare(`
      UPDATE sessions
      SET metadata_json = ?, last_activity_at = ?
      WHERE id = ?
    `).run(JSON.stringify(metadata), summary.updatedAt, sessionId);
  }

  async loadArchivedSessionSummary(sessionId: string): Promise<ArchivedSessionSummaryPayload | null> {
    const session = await this.getSessionById(sessionId);
    const markdown = typeof session?.metadata.archivedSessionSummary === "string"
      ? session.metadata.archivedSessionSummary
      : "";
    if (!session || !markdown) return null;
    return {
      markdown,
      updatedAt: typeof session.metadata.archivedSessionSummaryUpdatedAt === "string"
        ? String(session.metadata.archivedSessionSummaryUpdatedAt)
        : session.lastActivityAt,
      source: typeof session.metadata.archivedSessionSummarySource === "string"
        ? session.metadata.archivedSessionSummarySource as ArchivedSessionSummaryPayload["source"]
        : "fallback",
    };
  }

  async loadMessagesForExtraction(sessionId: string, limit: number = 100): Promise<SessionMessageRecord[]> {
    await this.init();
    const rows = this.db.prepare(`
      SELECT
        id, session_id, role, content, content_summary, tool_name,
        tool_call_id, artifact_id, token_estimate, created_at, metadata_json
      FROM messages
      WHERE session_id = ?
      ORDER BY created_at ASC
      LIMIT ?
    `).all(sessionId, limit) as Array<Record<string, unknown>>;
    return rows.map(toMessageRecord);
  }

  async onSessionEnd(sessionId: string): Promise<ExtractionMaterial | null> {
    const session = await this.getSessionById(sessionId);
    if (!session) return null;
    const summary = await this.loadSessionSummary(sessionId);
    const messages = await this.loadMessagesForExtraction(sessionId);
    return {
      session,
      summaryMarkdown: summary?.markdown || "",
      messages,
    };
  }

  async countMessages(sessionId: string) {
    const row = this.db.prepare(`
      SELECT COUNT(*) AS count
      FROM messages
      WHERE session_id = ?
    `).get(sessionId) as Record<string, unknown> | undefined;
    return Number(row?.count ?? 0);
  }

  async compactSessionMessagesBefore(sessionId: string, cutoffIso: string) {
    await this.init();
    const rows = this.db.prepare(`
      SELECT id, content, content_summary
      FROM messages
      WHERE session_id = ?
        AND created_at < ?
        AND content IS NOT NULL
    `).all(sessionId, cutoffIso) as Array<Record<string, unknown>>;

    let changed = 0;
    const updateStmt = this.db.prepare(`
      UPDATE messages
      SET content = NULL, content_summary = ?
      WHERE id = ?
    `);

    for (const row of rows) {
      const content = String(row.content ?? "");
      const summary = String(row.content_summary ?? "") || summarizeText(content, 160);
      updateStmt.run(summary, String(row.id));
      if (this.ftsEnabled) {
        this.db.prepare(`
          UPDATE messages_fts
          SET content = '', content_summary = ?
          WHERE message_id = ?
        `).run(summary, String(row.id));
      }
      changed += 1;
    }

    return changed;
  }

  async compactSessionMessagesExceptRecent(sessionId: string, keepRecent: number) {
    await this.init();
    const recentRows = this.db.prepare(`
      SELECT id, created_at
      FROM messages
      WHERE session_id = ?
      ORDER BY created_at DESC
      LIMIT ?
    `).all(sessionId, keepRecent) as Array<Record<string, unknown>>;

    const cutoffIso = recentRows.length === keepRecent
      ? String(recentRows[recentRows.length - 1]?.created_at || "")
      : "";

    if (!cutoffIso) return 0;

    const rows = this.db.prepare(`
      SELECT id, content, content_summary
      FROM messages
      WHERE session_id = ?
        AND created_at < ?
        AND content IS NOT NULL
    `).all(sessionId, cutoffIso) as Array<Record<string, unknown>>;

    let changed = 0;
    const updateStmt = this.db.prepare(`
      UPDATE messages
      SET content = NULL, content_summary = ?
      WHERE id = ?
    `);

    for (const row of rows) {
      const content = String(row.content ?? "");
      const summary = String(row.content_summary ?? "") || summarizeText(content, 160);
      updateStmt.run(summary, String(row.id));
      if (this.ftsEnabled) {
        this.db.prepare(`
          UPDATE messages_fts
          SET content = '', content_summary = ?
          WHERE message_id = ?
        `).run(summary, String(row.id));
      }
      changed += 1;
    }

    return changed;
  }

  async listSessionsOlderThan(cutoffIso: string): Promise<SessionRecord[]> {
    const rows = this.db.prepare(`
      SELECT
        id, session_key, tenant_id, user_id, channel, business_object_type,
        business_object_id, title, parent_session_id, status, started_at,
        last_activity_at, ended_at, metadata_json
      FROM sessions
      WHERE last_activity_at < ?
      ORDER BY last_activity_at ASC
    `).all(cutoffIso) as Array<Record<string, unknown>>;
    return rows.map(toSessionRecord);
  }

  private ensureSchema(forceDisableFts: boolean) {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        session_key TEXT NOT NULL UNIQUE,
        tenant_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        channel TEXT NOT NULL,
        business_object_type TEXT,
        business_object_id TEXT,
        title TEXT NOT NULL,
        parent_session_id TEXT,
        status TEXT NOT NULL,
        started_at TEXT NOT NULL,
        last_activity_at TEXT NOT NULL,
        ended_at TEXT,
        metadata_json TEXT NOT NULL DEFAULT '{}'
      );

      CREATE INDEX IF NOT EXISTS idx_sessions_key ON sessions(session_key);
      CREATE INDEX IF NOT EXISTS idx_sessions_last_activity ON sessions(last_activity_at);

      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        role TEXT NOT NULL,
        content TEXT,
        content_summary TEXT,
        tool_name TEXT,
        tool_call_id TEXT,
        artifact_id TEXT,
        token_estimate INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        metadata_json TEXT NOT NULL DEFAULT '{}',
        FOREIGN KEY(session_id) REFERENCES sessions(id)
      );

      CREATE INDEX IF NOT EXISTS idx_messages_session_created ON messages(session_id, created_at);

      CREATE TABLE IF NOT EXISTS actions (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        action_type TEXT NOT NULL,
        tool_name TEXT,
        step INTEGER,
        resource_type TEXT,
        resource_id TEXT,
        input_json TEXT,
        output_status TEXT,
        output_summary TEXT,
        artifact_id TEXT,
        approved_by TEXT,
        created_at TEXT NOT NULL,
        metadata_json TEXT NOT NULL DEFAULT '{}',
        FOREIGN KEY(session_id) REFERENCES sessions(id)
      );

      CREATE INDEX IF NOT EXISTS idx_actions_session_created ON actions(session_id, created_at);

      CREATE TABLE IF NOT EXISTS artifacts (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        content_type TEXT,
        content TEXT,
        file_path TEXT,
        size_bytes INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        metadata_json TEXT NOT NULL DEFAULT '{}'
      );
    `);

    if (!this.columnExists("actions", "step")) {
      this.db.exec(`ALTER TABLE actions ADD COLUMN step INTEGER;`);
    }

    if (forceDisableFts) {
      this.ftsEnabled = false;
      return;
    }

    try {
      this.db.exec(`
        CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
          message_id UNINDEXED,
          session_id UNINDEXED,
          content,
          content_summary,
          tokenize = 'unicode61'
        );
      `);
      this.ftsEnabled = true;
    } catch (error) {
      this.ftsEnabled = false;
      this.log(`FTS5 unavailable, fallback to LIKE search: ${String(error)}`);
    }
  }

  private columnExists(tableName: string, columnName: string) {
    const rows = this.db.prepare(`PRAGMA table_info(${tableName})`).all() as Array<Record<string, unknown>>;
    return rows.some((row) => String(row.name || "") === columnName);
  }

  private insertIntoFts(message: SessionMessageRecord) {
    if (!this.ftsEnabled) return;
    this.db.prepare(`
      INSERT INTO messages_fts (message_id, session_id, content, content_summary)
      VALUES (?, ?, ?, ?)
    `).run(
      message.id,
      message.sessionId,
      message.content ?? "",
      message.contentSummary ?? "",
    );
  }

  private async updateSessionTitleIfNeeded(sessionId: string, message: SessionMessageRecord) {
    if (message.role !== "user") return;
    const session = await this.getSessionById(sessionId);
    if (!session || session.title !== "新会话") return;
    const title = summarizeText(message.content || message.contentSummary || "新会话", 32);
    this.db.prepare(`
      UPDATE sessions
      SET title = ?
      WHERE id = ?
    `).run(title, sessionId);
  }

  private log(message: string) {
    if (this.debug) {
      console.log(`[SQLiteSessionStore] ${message}`);
    }
  }

  private archiveDuplicateActiveSessions() {
    const rows = this.db.prepare(`
      SELECT
        id, session_key, tenant_id, user_id, channel, business_object_type,
        business_object_id, title, parent_session_id, status, started_at,
        last_activity_at, ended_at, metadata_json
      FROM sessions
      WHERE status = 'active'
      ORDER BY tenant_id, user_id, channel, business_object_type, business_object_id, last_activity_at DESC
    `).all() as Array<Record<string, unknown>>;

    const seen = new Set<string>();
    for (const row of rows) {
      const session = toSessionRecord(row);
      const routeKey = this.routeFingerprint(session);
      if (seen.has(routeKey)) {
        this.archiveSession(session.id, session.lastActivityAt);
        continue;
      }
      seen.add(routeKey);
    }
  }

  private archiveRouteSiblingSessions(session: SessionRecord) {
    if (session.status !== "active") return;
    this.db.prepare(`
      UPDATE sessions
      SET status = 'archived', ended_at = COALESCE(ended_at, last_activity_at)
      WHERE status = 'active'
        AND id != ?
        AND tenant_id = ?
        AND user_id = ?
        AND channel = ?
        AND COALESCE(business_object_type, '') = COALESCE(?, '')
        AND COALESCE(business_object_id, '') = COALESCE(?, '')
    `).run(
      session.id,
      session.tenantId,
      session.userId,
      session.channel,
      session.businessObjectType ?? null,
      session.businessObjectId ?? null,
    );
  }

  private archiveSession(sessionId: string, endedAt: string) {
    this.db.prepare(`
      UPDATE sessions
      SET status = 'archived', ended_at = COALESCE(ended_at, ?)
      WHERE id = ?
    `).run(endedAt, sessionId);
  }

  private routeFingerprint(session: SessionRecord) {
    return [
      session.tenantId,
      session.userId,
      session.channel,
      session.businessObjectType || "",
      session.businessObjectId || "",
    ].join("\u0001");
  }
}

function normalizeMessageInput(input: AppendMessageInput, createdAt: string): SessionMessageRecord {
  const content = normalizeNullableString(input.content);
  const contentSummary = normalizeNullableString(input.contentSummary)
    || (content ? summarizeText(content, 240) : null);
  return {
    id: crypto.randomUUID(),
    sessionId: input.sessionId,
    role: input.role,
    content,
    contentSummary,
    toolName: input.toolName ?? null,
    toolCallId: input.toolCallId ?? null,
    artifactId: input.artifactId ?? null,
    tokenEstimate: input.tokenEstimate ?? estimateTokens(content || contentSummary || ""),
    createdAt,
    metadata: input.metadata ?? {},
  };
}

function toSessionRecord(row: Record<string, unknown>): SessionRecord {
  return {
    id: String(row.id),
    sessionKey: String(row.session_key),
    tenantId: String(row.tenant_id),
    userId: String(row.user_id),
    channel: String(row.channel),
    businessObjectType: (row.business_object_type as string | null | undefined) ?? null,
    businessObjectId: (row.business_object_id as string | null | undefined) ?? null,
    title: String(row.title),
    parentSessionId: (row.parent_session_id as string | null | undefined) ?? null,
    status: row.status as SessionRecord["status"],
    startedAt: String(row.started_at),
    lastActivityAt: String(row.last_activity_at),
    endedAt: (row.ended_at as string | null | undefined) ?? null,
    metadata: parseJson(row.metadata_json),
  };
}

function toMessageRecord(row: Record<string, unknown>): SessionMessageRecord {
  return {
    id: String(row.id),
    sessionId: String(row.session_id),
    role: row.role as SessionMessageRecord["role"],
    content: normalizeNullableString(row.content),
    contentSummary: normalizeNullableString(row.content_summary),
    toolName: (row.tool_name as string | null | undefined) ?? null,
    toolCallId: (row.tool_call_id as string | null | undefined) ?? null,
    artifactId: (row.artifact_id as string | null | undefined) ?? null,
    tokenEstimate: Number(row.token_estimate ?? 0),
    createdAt: String(row.created_at),
    metadata: parseJson(row.metadata_json),
  };
}

function parseJson(value: unknown) {
  try {
    return value ? JSON.parse(String(value)) as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function normalizeNullableString(value: unknown) {
  if (typeof value !== "string") return null;
  return value;
}

function summarizeText(text: string, limit: number) {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (normalized.length <= limit) return normalized;
  return `${normalized.slice(0, Math.max(0, limit - 1))}…`;
}

function estimateTokens(text: string) {
  return Math.max(1, Math.ceil(text.length / 4));
}

function shortId() {
  return crypto.randomUUID().slice(0, 8);
}
