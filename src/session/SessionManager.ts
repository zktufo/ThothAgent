import type { UserHomePaths } from "../home/index.js";
import type { LogActionInput } from "../action/types.js";
import type { ArtifactThresholdPolicy } from "../artifacts/types.js";
import { SQLiteSessionStore } from "./SQLiteSessionStore.js";
import { SessionCompressor, type SessionCompressorOptions } from "./SessionCompressor.js";
import { SessionRouter } from "./SessionRouter.js";
import type {
  CreateSessionInput,
  ExtractionMaterial,
  SessionMessageRecord,
  SessionRecord,
  SessionRouteContext,
  SessionSearchHit,
  SessionListOptions,
  SessionSummaryPayload,
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

  async init() {
    if (this.initialized) return;
    await this.store.init();
    await this.getCurrentSession();
    this.initialized = true;
  }

  async getCurrentSession() {
    if (this.activeSession) return this.activeSession;
    const createInput = this.buildCreateSessionInput();
    this.activeSession = await this.store.getOrCreateSession(createInput);
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
    await this.afterAppend(session.id);
    return message;
  }

  async appendToolUse(toolName: string, input: Record<string, unknown>, metadata?: Record<string, unknown>) {
    const session = await this.getCurrentSession();
    return this.store.actions.logAction({
      sessionId: session.id,
      actionType: "tool_use",
      toolName,
      resourceType: "tool",
      resourceId: toolName,
      inputJson: input,
      outputStatus: "started",
      outputSummary: `${toolName} 已开始执行`,
      metadata,
    });
  }

  async appendToolResult(
    toolName: string,
    content: string,
    options: {
      success?: boolean;
      error?: string;
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
      resourceType: artifactId ? "artifact" : "tool",
      resourceId: artifactId || toolName,
      outputStatus: options.success === false ? "error" : "success",
      outputSummary: messageSummary,
      artifactId,
      metadata: options.metadata,
    });

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
    return this.store.loadMessagesForExtraction(targetSessionId, limit);
  }

  async updateLastActivity() {
    const session = await this.getCurrentSession();
    await this.store.updateLastActivity(session.id);
  }

  async endCurrentSession() {
    const session = await this.getCurrentSession();
    await this.compressor.updateSessionSummary(session.id);
    await this.store.endSession(session.id);
    const extractionMaterial = await this.store.onSessionEnd(session.id);
    return extractionMaterial;
  }

  async resetCurrentSession(title: string = "新会话") {
    const ended = await this.endCurrentSession();
    const next = await this.store.createChildSession({
      parentSessionId: ended?.session.id || await this.getCurrentSessionId(),
      title,
      metadata: {
        resetFrom: ended?.session.id || null,
        resetAt: new Date().toISOString(),
      },
    });
    this.activeSession = next;
    return { ended, next };
  }

  async createChildSession(title?: string, metadata?: Record<string, unknown>) {
    const parent = await this.getCurrentSession();
    const child = await this.store.createChildSession({
      parentSessionId: parent.id,
      title,
      metadata,
    });
    this.activeSession = child;
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

  private buildCreateSessionInput(): CreateSessionInput {
    const routeContext = this.normalizeRouteContext();
    return {
      ...routeContext,
      sessionKey: this.router.resolveSessionKey(routeContext),
      title: "新会话",
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
}

function summarizeText(text: string, limit: number) {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (normalized.length <= limit) return normalized;
  return `${normalized.slice(0, Math.max(0, limit - 1))}…`;
}
