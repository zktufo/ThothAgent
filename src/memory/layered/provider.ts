/**
 * MemoryProvider is the pluggable contract for each layer.
 *
 * The lifecycle is split on purpose:
 * - init(): one-time boot
 * - prefetch(): cheap, cache-first, on critical path
 * - syncTurn(): async write-back after a response
 * - queuePrefetch(): heavier preparation for the next turn
 */
import type {
  ProviderPrefetchContext,
  ProviderPrefetchResult,
  QueuePrefetchInput,
  SyncTurnInput,
} from "./types.js";

export interface MemoryProvider {
  name: string;
  init(): Promise<void>;
  prefetch(context: ProviderPrefetchContext): Promise<ProviderPrefetchResult>;
  syncTurn?(input: SyncTurnInput): Promise<void>;
  queuePrefetch?(input: QueuePrefetchInput): Promise<void>;
}
