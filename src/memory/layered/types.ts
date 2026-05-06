import type { LLMMessage } from "../../llm/index.js";

/**
 * Shared types for the layered-memory subsystem.
 *
 * Keeping them in one file makes the data model easy to scan before reading
 * the individual providers and manager implementation.
 *
 * Cleanup (2026-05-05):
 * - Removed "session_summary" layer (was raw log append, now defunct)
 */
export type MemoryLayer =
  | "builtin_memory"
  | "working_state"
  | "retrieval";

export interface UserProfile {
  displayName?: string;
  preferences?: {
    answerStyle?: string;
    responseLength?: string;
    formatting?: string[];
  };
  traits?: string[];
  stableFacts?: Record<string, string | number | boolean>;
  updatedAt?: string;
}

export interface WorkingState {
  currentTask?: string;
  currentStep?: string;
  status?: string;
  lastUserInput?: string;
  lastAssistantOutput?: string;
  turnCount?: number;
  updatedAt?: string;
  vars?: Record<string, any>;
}

export type ExternalMemorySource = "sync_turn" | "on_memory_write" | "session_archive";
export type ExternalMemoryType = "conversation_insight" | "explicit_memory_write" | "session_summary";
export type MemoryDecayProfile = "ephemeral" | "normal" | "slow" | "sticky";

export interface ExternalMemorySignals {
  hasExplicitMemoryWrite: boolean;
  hasPreferenceSignal: boolean;
  hasDomainSignal: boolean;
  hasIdentitySignal: boolean;
  hasPositiveFeedback: boolean;
}

export interface ExternalMemoryRecord {
  schemaVersion: number;
  id: string;
  source: ExternalMemorySource;
  memoryType: ExternalMemoryType;
  writtenAt: string;
  sessionId: string;
  summary: string;
  userRepresentation: string[];
  userPeerCard: string[];
  aiRepresentation: string[];
  aiIdentityCard: string[];
  userInput: string;
  assistantOutput: string;
  keywords: string[];
  topics: string[];
  importance: number;
  decayProfile: MemoryDecayProfile;
  lastAccessAt?: string;
  accessCount?: number;
  metadata?: Record<string, unknown>;
  signals: ExternalMemorySignals;
}

export interface ExternalMemorySearchHit {
  record: ExternalMemoryRecord;
  score: number;
  lexicalScore: number;
  importanceScore: number;
  recencyScore: number;
  decayScore: number;
}

export interface RetrievalMemoryRecord {
  id: string;
  kind: "message" | "fact" | "summary" | "preference" | "event" | "best_try";
  text: string;
  keywords: string[];
  embedding?: number[];
  tags: string[];
  source: string;
  createdAt: string;
  metadata?: Record<string, any>;
}

export interface RetrievalMemoryHit extends RetrievalMemoryRecord {
  score: number;
  lexicalScore?: number;
  semanticScore?: number;
  metadataScore?: number;
}

export interface MemorySearchRequest {
  query: string;
  limit: number;
  kinds?: RetrievalMemoryRecord["kind"][];
  datePrefix?: string;
}

export interface MemoryContextBlock {
  layer: Exclude<MemoryLayer, "working_state">;
  title: string;
  content: string;
  priority: number;
  tokensEstimate: number;
  source: string;
}

export interface MemorySnapshot {
  userInput: string;
  createdAt: string;
  blocks: MemoryContextBlock[];
  workingState?: WorkingState;
  systemPromptBlocks?: string[];
  debug: string[];
}

export interface ProviderPrefetchContext {
  userInput: string;
  sessionId: string;
  now: string;
  debug: boolean;
}

export interface ProviderPrefetchResult {
  blocks?: MemoryContextBlock[];
  workingState?: WorkingState;
  systemPromptBlock?: string;
  debug?: string[];
}

export interface SyncTurnInput {
  userInput: string;
  assistantOutput: string;
  sessionId: string;
  now: string;
}

export interface QueuePrefetchInput {
  userInput: string;
  sessionId: string;
  now: string;
}

export interface PromptBuildInput {
  userInput: string;
  history?: LLMMessage[];
  snapshot: MemorySnapshot;
  maxMemoryTokens?: number;
}

export interface PromptBuildOutput {
  memoryContext: string;
  messages: LLMMessage[];
  usedTokensEstimate: number;
  includedBlocks: MemoryContextBlock[];
  systemPromptBlocks?: string[];
}

export interface MemoryManagerOptions {
  sessionId: string;
  maxMemoryTokens?: number;
  debug?: boolean;
}
