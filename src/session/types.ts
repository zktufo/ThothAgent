export type SessionStatus = "active" | "idle" | "ended" | "archived";
export type SessionMessageRole = "system" | "user" | "assistant" | "tool";
export type SessionActionStatus = "started" | "success" | "error" | "skipped";

export interface SessionRouteContext {
  tenantId: string;
  userId: string;
  channel: string;
  businessObjectType?: string;
  businessObjectId?: string;
}

export interface SessionRecord {
  id: string;
  sessionKey: string;
  tenantId: string;
  userId: string;
  channel: string;
  businessObjectType?: string | null;
  businessObjectId?: string | null;
  title: string;
  parentSessionId?: string | null;
  status: SessionStatus;
  startedAt: string;
  lastActivityAt: string;
  endedAt?: string | null;
  metadata: Record<string, unknown>;
}

export interface SessionMessageRecord {
  id: string;
  sessionId: string;
  role: SessionMessageRole;
  content?: string | null;
  contentSummary?: string | null;
  toolName?: string | null;
  toolCallId?: string | null;
  artifactId?: string | null;
  tokenEstimate: number;
  createdAt: string;
  metadata: Record<string, unknown>;
}

export interface SessionActionRecord {
  id: string;
  sessionId: string;
  actionType: string;
  toolName?: string | null;
  resourceType?: string | null;
  resourceId?: string | null;
  inputJson?: string | null;
  outputStatus?: string | null;
  outputSummary?: string | null;
  artifactId?: string | null;
  approvedBy?: string | null;
  createdAt: string;
  metadata: Record<string, unknown>;
}

export interface SessionArtifactRecord {
  id: string;
  type: string;
  contentType?: string | null;
  content?: string | null;
  filePath?: string | null;
  sizeBytes: number;
  createdAt: string;
  metadata: Record<string, unknown>;
}

export interface SessionSearchHit {
  message: SessionMessageRecord;
  session?: SessionRecord | null;
  keywordHits: number;
}

export interface CreateSessionInput extends SessionRouteContext {
  sessionKey: string;
  title?: string;
  parentSessionId?: string;
  status?: SessionStatus;
  metadata?: Record<string, unknown>;
}

export interface CreateChildSessionInput {
  parentSessionId: string;
  sessionKey?: string;
  title?: string;
  metadata?: Record<string, unknown>;
}

export interface AppendMessageInput {
  sessionId: string;
  role: SessionMessageRole;
  content?: string | null;
  contentSummary?: string | null;
  toolName?: string;
  toolCallId?: string;
  artifactId?: string;
  tokenEstimate?: number;
  metadata?: Record<string, unknown>;
}

export interface AppendToolMessageInput {
  sessionId: string;
  toolName: string;
  content?: string | null;
  contentSummary?: string | null;
  toolCallId?: string;
  artifactId?: string;
  tokenEstimate?: number;
  metadata?: Record<string, unknown>;
}

export interface SessionSearchOptions {
  sessionId?: string;
  sessionIds?: string[];
  limit?: number;
  forceLike?: boolean;
}

export interface SessionSummaryPayload {
  markdown: string;
  updatedAt: string;
}

export interface ArchivedSessionSummaryPayload extends SessionSummaryPayload {
  source?: "llm" | "file" | "sqlite" | "fallback";
}

export interface ArchivedSessionSummaryHit {
  session: SessionRecord;
  summary: ArchivedSessionSummaryPayload;
  keywordHits: number;
}

export interface RetentionCleanupResult {
  sessionsScanned: number;
  messagesCompacted: number;
  artifactsTrimmed: number;
}

export interface ExtractionMaterial {
  session: SessionRecord;
  summaryMarkdown: string;
  messages: SessionMessageRecord[];
}

export interface SessionListOptions {
  limit?: number;
  status?: SessionStatus | "all";
}

export interface SessionIndexEntry {
  sessionId: string;
  sessionKey: string;
  status: SessionStatus;
  title: string;
  updatedAt: string;
}
