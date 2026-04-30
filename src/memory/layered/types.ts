import type { LLMMessage } from "../../llm/index.js";

/**
 * Shared types for the layered-memory subsystem.
 *
 * Keeping them in one file makes the data model easy to scan before reading
 * the individual providers and manager implementation.
 */
export type MemoryLayer =
  | "user_profile"
  | "domain_context"
  | "working_state"
  | "session_summary"
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

export interface RetrievalMemoryRecord {
  id: string;
  kind: "message" | "fact" | "summary" | "preference" | "event";
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
}

export interface MemoryManagerOptions {
  sessionId: string;
  maxMemoryTokens?: number;
  debug?: boolean;
}
