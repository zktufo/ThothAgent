/**
 * MemoryProvider is the pluggable contract for each layer.
 *
 * The lifecycle is split on purpose:
 * - init(): one-time boot
 * - prefetch(): cheap, cache-first, on critical path
 * - syncTurn(): async write-back after a response
 * - queuePrefetch(): heavier preparation for the next turn
 *
 * Additional hooks (optional, for advanced use):
 * - onSessionEnd(): end-of-session extraction
 * - onSessionSwitch(): handle session_id rotation mid-process
 * - onPreCompress(): extract insights before context compression
 * - onDelegation(): parent-side observation of subagent work
 */
import type {
  MemorySearchRequest,
  ProviderPrefetchContext,
  ProviderPrefetchResult,
  QueuePrefetchInput,
  RetrievalMemoryHit,
  SyncTurnInput,
} from "./types.js";

export interface MemoryProvider {
  name: string;
  init(): Promise<void>;
  prefetch(context: ProviderPrefetchContext): Promise<ProviderPrefetchResult>;
  systemPromptBlock?(): Promise<string | null>;
  searchMemory?(input: MemorySearchRequest): Promise<RetrievalMemoryHit[]>;
  syncTurn?(input: SyncTurnInput): Promise<void>;
  queuePrefetch?(input: QueuePrefetchInput): Promise<void>;
  onMemoryWrite?(input: {
    action: "add" | "replace" | "remove";
    target: "memory" | "user" | "domain";
    content: string;
    oldText?: string;
    sessionId: string;
    now: string;
  }): Promise<void>;
}

/**
 * Optional hooks for memory providers.
 * Implement these to opt into advanced lifecycle events.
 */
export interface MemoryProviderHooks {
  /**
   * Called when a session ends (explicit exit or timeout).
   * Use for end-of-session fact extraction, summarization, etc.
   */
  onSessionEnd?(messages: Array<{ role: string; content: string }>): Promise<void>;

  /**
   * Called when the agent switches session_id mid-process.
   * Fires on /resume, /branch, /reset, /new, and context compression.
   */
  onSessionSwitch?(
    newSessionId: string,
    options?: { parentSessionId?: string; reset?: boolean },
  ): Promise<void>;

  /**
   * Called before context compression discards old messages.
   * Use to extract insights from messages about to be compressed.
   */
  onPreCompress?(messages: Array<{ role: string; content: string }>): Promise<string>;

  /**
   * Called on the parent agent when a subagent completes.
   */
  onDelegation?(
    task: string,
    result: string,
    options?: { childSessionId?: string },
  ): Promise<void>;
}

/**
 * Provider config schema for memory setup wizards.
 */
export interface MemoryProviderConfigField {
  key: string;
  description: string;
  secret?: boolean;
  required?: boolean;
  default?: string;
  choices?: string[];
  url?: string;
  envVar?: string;
}
