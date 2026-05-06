import type {
  AppendMessageInput,
  AppendToolMessageInput,
  CreateChildSessionInput,
  CreateSessionInput,
  ExtractionMaterial,
  ArchivedSessionSummaryHit,
  SessionMessageRecord,
  SessionRecord,
  SessionSearchHit,
  SessionSearchOptions,
  SessionSummaryPayload,
  ArchivedSessionSummaryPayload,
  SessionListOptions,
} from "./types.js";

export interface SessionStore {
  init(): Promise<void>;
  supportsFts(): boolean;
  createSession(input: CreateSessionInput): Promise<SessionRecord>;
  getOrCreateSession(input: CreateSessionInput): Promise<SessionRecord>;
  getSessionById(sessionId: string): Promise<SessionRecord | null>;
  getSessionByKey(sessionKey: string): Promise<SessionRecord | null>;
  listSessions(options?: SessionListOptions): Promise<SessionRecord[]>;
  createChildSession(input: CreateChildSessionInput): Promise<SessionRecord>;
  appendMessage(input: AppendMessageInput): Promise<SessionMessageRecord>;
  appendToolMessage(input: AppendToolMessageInput): Promise<SessionMessageRecord>;
  loadRecentMessages(sessionId: string, limit: number): Promise<SessionMessageRecord[]>;
  updateLastActivity(sessionId: string, at?: string): Promise<void>;
  endSession(sessionId: string, endedAt?: string): Promise<void>;
  searchMessages(query: string, options?: SessionSearchOptions): Promise<SessionSearchHit[]>;
  searchArchivedSummaries(query: string, limit?: number): Promise<ArchivedSessionSummaryHit[]>;
  saveSessionSummary(sessionId: string, summary: SessionSummaryPayload): Promise<void>;
  loadSessionSummary(sessionId: string): Promise<SessionSummaryPayload | null>;
  saveArchivedSessionSummary(sessionId: string, summary: ArchivedSessionSummaryPayload): Promise<void>;
  loadArchivedSessionSummary(sessionId: string): Promise<ArchivedSessionSummaryPayload | null>;
  loadMessagesForExtraction(sessionId: string, limit?: number): Promise<SessionMessageRecord[]>;
  onSessionEnd(sessionId: string): Promise<ExtractionMaterial | null>;
}
