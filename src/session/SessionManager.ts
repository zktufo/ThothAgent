import fs from "fs";
import type { UserHomePaths } from "../home/index.js";
import type { LogActionInput } from "../action/types.js";
import type { ArtifactThresholdPolicy } from "../artifacts/types.js";
import { SQLiteSessionStore } from "./SQLiteSessionStore.js";
import { SessionCompressor, type SessionCompressorOptions } from "./SessionCompressor.js";
import { SessionRouter } from "./SessionRouter.js";
import type {
  CreateSessionInput,
  ExtractionMaterial,
  ArchivedSessionSummaryHit,
  SessionMessageRecord,
  SessionIndexEntry,
  SessionRecord,
  SessionRouteContext,
  SessionSearchHit,
  SessionListOptions,
  SessionSummaryPayload,
  ArchivedSessionSummaryPayload,
} from "./types.js";

export interface SessionManagerOptions {
  homePaths: UserHomePaths;
  routeContext?: Partial<SessionRouteContext>;
  sessionId?: string;
  store?: SQLiteSessionStore;
  artifactPolicy?: Partial<ArtifactThresholdPolicy>;
  compressor?: Partial<SessionCompressorOptions>;
  recentMessageLimit?: number;
  debug?: boolean;
}

/**
 * SessionManager is the runtime-facing facade.
 *
 * Runtime uses this to:
 * - resolve the active business session
 * - append original dialog/tool events
 * - fetch only recent prompt context + summary
 * - expose extraction material when a session ends
 *
 * It does not write long-term memory directly.
 */
export class SessionManager {
  readonly homePaths: UserHomePaths;
  readonly store: SQLiteSessionStore;
  readonly compressor: SessionCompressor;
  readonly router = new SessionRouter();
  readonly recentMessageLimit: number;
  readonly artifactPolicy: ArtifactThresholdPolicy;
  private initialized = false;
  private activeSession: SessionRecord | null = null;
  private readonly routeContext: Partial<SessionRouteContext>;
  private readonly sessionIdHint: string;

  constructor(options: SessionManagerOptions) {
    this.homePaths = options.homePaths;
    this.store = options.store || new SQLiteSessionStore({
      homePaths: options.homePaths,
      debug: options.debug,
    });
    this.compressor = new SessionCompressor(this.store, options.compressor);
    this.recentMessageLimit = options.recentMessageLimit ?? 12;
    this.routeContext = options.routeContext || {};
    this.sessionIdHint = options.sessionId || "";
    this.artifactPolicy = {
      inlineMaxChars: options.artifactPolicy?.inlineMaxChars ?? 1200,
      trimAfterDays: options.artifactPolicy?.trimAfterDays ?? 30,
      trimMinBytes: options.artifactPolicy?.trimMinBytes ?? 24 * 1024,
    };
  }

  private get defaultSessionTitle() {
    return this.homePaths.agentName || "main";
  }

  async init() {
    if (this.initialized) return;
    await this.store.init();
    await this.getCurrentSession();
    this.initialized = true;
  }

  async getCurrentSession() {
    if (this.activeSession) return this.activeSession;
    const indexEntry = this.loadSessionIndex();
    if (indexEntry?.sessionId || indexEntry?.sessionKey) {
      const indexed = await this.restoreSessionFromIndex(indexEntry);
      if (indexed) {
        this.activeSession = indexed;
        return indexed;
      }
      const repaired = await this.restoreLatestActiveSession();
      if (repaired) {
        this.activeSession = repaired;
        this.saveSessionIndex(repaired);
        return repaired;
      }
    }
    const createInput = this.buildCreateSessionInput();
    this.activeSession = await this.store.getOrCreateSession(createInput);
    this.saveSessionIndex(this.activeSession);
    return this.activeSession;
  }

  async getCurrentSessionId() {
    return (await this.getCurrentSession()).id;
  }

  async getCurrentSessionSummary() {
    const session = await this.getCurrentSession();
    return this.store.loadSessionSummary(session.id);
  }

  async appendMessage(
    role: "user" | "assistant" | "system",
    content: string,
    metadata?: Record<string, unknown>,
  ) {
    const session = await this.getCurrentSession();
    const message = await this.store.appendMessage({
      sessionId: session.id,
      role,
      content,
      metadata,
    });
    this.saveSessionIndex(session);
    await this.afterAppend(session.id);
    return message;
  }

  async appendToolUse(toolName: string, input: Record<string, unknown>, options?: { metadata?: Record<string, unknown>; step?: number }) {
    const session = await this.getCurrentSession();
    this.saveSessionIndex(session);
    return this.store.actions.logAction({
      sessionId: session.id,
      actionType: "tool_use",
      toolName,
      step: options?.step,
      resourceType: "tool",
      resourceId: toolName,
      inputJson: input,
      outputStatus: "started",
      outputSummary: `${toolName}`,
      metadata: options?.metadata,
    });
  }

  async appendToolResult(
    toolName: string,
    content: string,
    options: {
      success?: boolean;
      error?: string;
      step?: number;
      metadata?: Record<string, unknown>;
      toolCallId?: string;
    } = {},
  ) {
    const session = await this.getCurrentSession();
    let artifactId: string | undefined;
    let messageContent: string | null = content;
    let messageSummary = summarizeText(content, 240);

    if (content.length > this.artifactPolicy.inlineMaxChars) {
      const artifact = await this.store.artifacts.createArtifact({
        type: "tool_result",
        contentType: "application/json",
        content,
        metadata: {
          toolName,
          sessionId: session.id,
          ...(options.metadata || {}),
        },
      });
      artifactId = artifact.id;
      messageContent = messageSummary;
    }

    const message = await this.store.appendToolMessage({
      sessionId: session.id,
      toolName,
      content: messageContent,
      contentSummary: messageSummary,
      toolCallId: options.toolCallId,
      artifactId,
      metadata: {
        success: options.success ?? true,
        error: options.error,
        ...(options.metadata || {}),
      },
    });

    await this.store.actions.logAction({
      sessionId: session.id,
      actionType: "tool_result",
      toolName,
      step: options.step,
      resourceType: artifactId ? "artifact" : "tool",
      resourceId: artifactId || toolName,
      outputStatus: options.success === false ? "error" : "success",
      outputSummary: messageSummary,
      artifactId,
      metadata: options.metadata,
    });

    this.saveSessionIndex(session);
    await this.afterAppend(session.id);
    return message;
  }

  async getRecentMessages(limit: number = this.recentMessageLimit) {
    const session = await this.getCurrentSession();
    return this.store.loadRecentMessages(session.id, limit);
  }

  async loadPromptContext(limit: number = this.recentMessageLimit) {
    const session = await this.getCurrentSession();
    const recentMessages = await this.store.loadRecentMessages(session.id, limit);
    const sessionSummary = await this.store.loadSessionSummary(session.id);
    return { recentMessages, sessionSummary };
  }

  async search(query: string, limit: number = 8): Promise<SessionSearchHit[]> {
    const session = await this.getCurrentSession();
    return this.store.searchMessages(query, {
      sessionId: session.id,
      limit,
    });
  }

  async searchArchivedSummaries(query: string, limit: number = 8): Promise<ArchivedSessionSummaryHit[]> {
    return this.store.searchArchivedSummaries(query, limit);
  }

  async listSessions(options?: SessionListOptions) {
    return this.store.listSessions(options);
  }

  async listSessionActions(sessionId?: string) {
    const targetSessionId = sessionId || await this.getCurrentSessionId();
    return this.store.actions.listActions(targetSessionId);
  }

  async resolveSession(input: { sessionId?: string; sessionKey?: string } = {}) {
    if (input.sessionId) {
      return this.store.getSessionById(input.sessionId);
    }
    if (input.sessionKey) {
      return this.store.getSessionByKey(input.sessionKey);
    }
    return this.getCurrentSession();
  }

  async loadHistory(sessionId?: string, limit: number = 80) {
    const targetSessionId = sessionId || await this.getCurrentSessionId();
    return this.store.loadRecentMessages(targetSessionId, limit);
  }

  async updateLastActivity() {
    const session = await this.getCurrentSession();
    await this.store.updateLastActivity(session.id);
    this.saveSessionIndex(session);
  }

  async endCurrentSession() {
    const session = await this.getCurrentSession();
    await this.compressor.updateSessionSummary(session.id);
    await this.store.endSession(session.id);
    const extractionMaterial = await this.store.onSessionEnd(session.id);
    this.saveSessionIndex({
      ...session,
      status: "ended",
    });
    return extractionMaterial;
  }

  async resetCurrentSession(title?: string) {
    const ended = await this.endCurrentSession();
    const next = await this.store.createChildSession({
      parentSessionId: ended?.session.id || await this.getCurrentSessionId(),
      title: title || this.defaultSessionTitle,
      metadata: {
        resetFrom: ended?.session.id || null,
        resetAt: new Date().toISOString(),
      },
    });
    this.activeSession = next;
    this.saveSessionIndex(next);
    return { ended, next };
  }

  async createChildSession(title?: string, metadata?: Record<string, unknown>) {
    const parent = await this.getCurrentSession();
    const child = await this.store.createChildSession({
      parentSessionId: parent.id,
      title: title || this.defaultSessionTitle,
      metadata,
    });
    this.activeSession = child;
    this.saveSessionIndex(child);
    return child;
  }

  async loadMessagesForExtraction(sessionId?: string) {
    const targetSessionId = sessionId || await this.getCurrentSessionId();
    return this.store.loadMessagesForExtraction(targetSessionId);
  }

  async loadSessionSummary(sessionId?: string): Promise<SessionSummaryPayload | null> {
    const targetSessionId = sessionId || await this.getCurrentSessionId();
    return this.store.loadSessionSummary(targetSessionId);
  }

  async loadArchivedSessionSummary(sessionId?: string): Promise<ArchivedSessionSummaryPayload | null> {
    const targetSessionId = sessionId || await this.getCurrentSessionId();
    return this.store.loadArchivedSessionSummary(targetSessionId);
  }

  async onSessionEnd(sessionId?: string): Promise<ExtractionMaterial | null> {
    const targetSessionId = sessionId || await this.getCurrentSessionId();
    return this.store.onSessionEnd(targetSessionId);
  }

  async logAction(input: Omit<LogActionInput, "sessionId">) {
    const session = await this.getCurrentSession();
    return this.store.actions.logAction({
      sessionId: session.id,
      ...input,
    });
  }

  async applyRetentionPolicy() {
    return this.compressor.applyRetentionPolicy();
  }

  async compactCurrentSession() {
    const sessionId = await this.getCurrentSessionId();
    return this.compressor.compactCurrentSession(sessionId);
  }

  getSessionIndex() {
    return this.loadSessionIndex();
  }

  async resolveSessionIndex() {
    const session = await this.getCurrentSession();
    const indexed = this.loadSessionIndex();
    if (indexed?.sessionId === session.id && indexed.sessionKey === session.sessionKey) {
      return indexed;
    }
    this.saveSessionIndex(session);
    return this.loadSessionIndex();
  }

  private buildCreateSessionInput(): CreateSessionInput {
    const routeContext = this.normalizeRouteContext();
    return {
      ...routeContext,
      sessionKey: this.router.resolveSessionKey(routeContext),
      title: this.defaultSessionTitle,
      metadata: {
        source: "cli",
        sessionIdHint: this.sessionIdHint || undefined,
      },
    };
  }

  private normalizeRouteContext(): SessionRouteContext {
    return {
      tenantId: this.routeContext.tenantId || "default",
      userId: this.routeContext.userId || this.homePaths.agentName,
      channel: this.routeContext.channel || "cli",
      businessObjectType: this.routeContext.businessObjectType || (this.sessionIdHint ? "session" : undefined),
      businessObjectId: this.routeContext.businessObjectId || this.sessionIdHint || undefined,
    };
  }

  private async afterAppend(sessionId: string) {
    if (await this.compressor.shouldCompress(sessionId)) {
      await this.compressor.updateSessionSummary(sessionId);
    }
  }

  private async restoreSessionFromIndex(indexed: SessionIndexEntry | null = this.loadSessionIndex()): Promise<SessionRecord | null> {
    if (!indexed?.sessionId && !indexed?.sessionKey) return null;
    const byId = indexed?.sessionId
      ? await this.store.getSessionById(indexed.sessionId)
      : null;
    const resolved = byId || (indexed?.sessionKey
      ? await this.store.getSessionByKey(indexed.sessionKey)
      : null);
    if (!resolved) return null;
    this.saveSessionIndex(resolved);
    return resolved;
  }

  private async restoreLatestActiveSession(): Promise<SessionRecord | null> {
    const active = await this.store.listSessions({ limit: 1, status: "active" });
    if (active[0]) return active[0];
    const idle = await this.store.listSessions({ limit: 1, status: "idle" });
    if (idle[0]) return idle[0];
    return null;
  }

  private loadSessionIndex(): SessionIndexEntry | null {
    try {
      const raw = fs.readFileSync(this.homePaths.sessionIndexPath, "utf-8");
      const parsed = JSON.parse(raw) as SessionIndexEntry;
      if (!parsed?.sessionId || !parsed?.sessionKey) return null;
      return parsed;
    } catch {
      return null;
    }
  }

  private saveSessionIndex(session: Pick<SessionRecord, "id" | "sessionKey" | "status" | "title">) {
    const entry: SessionIndexEntry = {
      sessionId: session.id,
      sessionKey: session.sessionKey,
      status: session.status,
      title: session.title,
      updatedAt: new Date().toISOString(),
    };
    try {
      fs.mkdirSync(this.homePaths.sessionsDir, { recursive: true });
      const tmpPath = `${this.homePaths.sessionIndexPath}.tmp`;
      fs.writeFileSync(tmpPath, JSON.stringify(entry, null, 2) + "\n", "utf-8");
      fs.renameSync(tmpPath, this.homePaths.sessionIndexPath);
    } catch {
      // best effort only; sqlite remains the source of truth
    }
  }
}

function summarizeText(text: string, limit: number) {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (normalized.length <= limit) return normalized;
  return `${normalized.slice(0, Math.max(0, limit - 1))}…`;
}
