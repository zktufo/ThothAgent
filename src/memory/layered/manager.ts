import { PromptBuilder } from "./prompt_builder.js";
import type { MemoryProvider } from "./provider.js";
import type {
  MemorySearchRequest,
  MemoryManagerOptions,
  MemorySnapshot,
  PromptBuildOutput,
  RetrievalMemoryHit,
  SyncTurnInput,
} from "./types.js";

export class MemoryManager {
  readonly promptBuilder: PromptBuilder;
  private initialized = false;
  private pendingBackgroundTasks = new Set<Promise<void>>();
  private lastSnapshot: MemorySnapshot | null = null;
  private sessionSnapshots = new Map<string, MemorySnapshot>();
  private readonly maxMemoryTokens: number;
  private readonly debug: boolean;

  constructor(
    private providers: MemoryProvider[],
    private options: MemoryManagerOptions,
  ) {
    this.promptBuilder = new PromptBuilder();
    this.maxMemoryTokens = options.maxMemoryTokens ?? 500;
    this.debug = options.debug ?? false;
  }

  async init() {
    if (this.initialized) return;
    const settled = await Promise.allSettled(this.providers.map((provider) => provider.init()));
    this.initialized = true;
    this.logFailures("init", settled);
  }

  async onTurnStart(userInput: string, sessionId: string = this.options.sessionId) {
    // onTurnStart constructs a frozen snapshot once per session and reuses it
    // until the session changes (reset/new child session).
    await this.init();
    const existing = this.sessionSnapshots.get(sessionId);
    if (existing) {
      this.lastSnapshot = existing;
      return existing;
    }

    const now = new Date().toISOString();
    const settled = await Promise.allSettled(
      this.providers.map((provider) => provider.prefetch({
        userInput,
        sessionId,
        now,
        debug: this.debug,
      })),
    );

    const blocks = settled
      .flatMap((result) => result.status === "fulfilled" ? (result.value.blocks || []) : [])
      .sort((a, b) => b.priority - a.priority);
    const workingState = settled
      .flatMap((result) => result.status === "fulfilled" && result.value.workingState ? [result.value.workingState] : [])
      .at(-1);
    const systemPromptBlocks = settled
      .flatMap((result) => result.status === "fulfilled" && result.value.systemPromptBlock
        ? [result.value.systemPromptBlock]
        : []);
    const debugLines = settled.flatMap((result, index) => {
      if (result.status === "rejected") return [`provider:${this.providers[index]?.name || index} prefetch failed: ${String(result.reason)}`];
      return result.value.debug || [];
    });

    const snapshot: MemorySnapshot = {
      userInput,
      createdAt: now,
      blocks,
      workingState,
      systemPromptBlocks,
      debug: debugLines,
    };
    this.sessionSnapshots.set(sessionId, snapshot);
    this.lastSnapshot = snapshot;
    return snapshot;
  }

  buildMessages(userInput: string, history: PromptBuildOutput["messages"] = [], snapshot: MemorySnapshot = this.lastSnapshot || emptySnapshot(userInput)) {
    return this.promptBuilder.buildMessages({
      userInput,
      history,
      snapshot,
      maxMemoryTokens: this.maxMemoryTokens,
    });
  }

  async buildSystemPromptAdditions() {
    await this.init();
    const settled = await Promise.allSettled(
      this.providers
        .filter((provider) => typeof provider.systemPromptBlock === "function")
        .map((provider) => provider.systemPromptBlock!()),
    );
    return settled
      .flatMap((result) => result.status === "fulfilled" && result.value ? [result.value] : []);
  }

  async searchMemory(input: MemorySearchRequest): Promise<RetrievalMemoryHit[]> {
    await this.init();
    const providers = this.providers.filter((provider) => typeof provider.searchMemory === "function");
    if (!providers.length) return [];

    const settled = await Promise.allSettled(
      providers.map((provider) => provider.searchMemory!(input)),
    );

    const merged: RetrievalMemoryHit[] = [];
    const seen = new Set<string>();
    for (const result of settled) {
      if (result.status !== "fulfilled") continue;
      for (const hit of result.value || []) {
        if (seen.has(hit.id)) continue;
        seen.add(hit.id);
        merged.push(hit);
      }
    }

    return merged
      .sort((a, b) => {
        if (b.score !== a.score) return b.score - a.score;
        return b.createdAt.localeCompare(a.createdAt);
      })
      .slice(0, input.limit);
  }

  syncTurn(userInput: string, assistantOutput: string, sessionId: string = this.options.sessionId) {
    // syncTurn is intentionally fire-and-forget from the caller's perspective.
    const task = this.runBackground("syncTurn", async () => {
      await this.init();
      const now = new Date().toISOString();
      const settled: PromiseSettledResult<void>[] = [];
      for (const provider of this.providers.filter((item) => typeof item.syncTurn === "function")) {
        try {
          await provider.syncTurn!({
            userInput,
            assistantOutput,
            sessionId,
            now,
          } satisfies SyncTurnInput);
          settled.push({ status: "fulfilled", value: undefined });
        } catch (error) {
          settled.push({ status: "rejected", reason: error });
        }
      }
      this.logFailures("syncTurn", settled);
    });

    return task;
  }

  queuePrefetch(userInput: string, sessionId: string = this.options.sessionId) {
    // queuePrefetch is where providers can do heavier cache warming for the next round.
    return this.runBackground("queuePrefetch", async () => {
      await this.init();
      const now = new Date().toISOString();
      const settled = await Promise.allSettled(
        this.providers
          .filter((provider) => typeof provider.queuePrefetch === "function")
          .map((provider) => provider.queuePrefetch!({
            userInput,
            sessionId,
            now,
          })),
      );
      this.logFailures("queuePrefetch", settled);
    });
  }

  onMemoryWrite(
    input: {
      action: "add" | "replace" | "remove";
      target: "memory" | "user" | "domain";
      content: string;
      oldText?: string;
    },
    sessionId: string = this.options.sessionId,
  ) {
    return this.runBackground("onMemoryWrite", async () => {
      await this.init();
      const now = new Date().toISOString();
      const settled = await Promise.allSettled(
        this.providers
          .filter((provider) => typeof provider.onMemoryWrite === "function")
          .map((provider) => provider.onMemoryWrite!({
            ...input,
            sessionId,
            now,
          })),
      );
      this.logFailures("onMemoryWrite", settled);
    });
  }

  getLastSnapshot() {
    return this.lastSnapshot;
  }

  clearSessionSnapshot(sessionId?: string) {
    if (!sessionId) {
      this.sessionSnapshots.clear();
      this.lastSnapshot = null;
      return;
    }
    const removed = this.sessionSnapshots.get(sessionId);
    this.sessionSnapshots.delete(sessionId);
    if (this.lastSnapshot && removed && this.lastSnapshot === removed) {
      this.lastSnapshot = null;
    }
  }

  async flushBackgroundTasks() {
    await Promise.allSettled([...this.pendingBackgroundTasks]);
  }

  private runBackground(label: string, fn: () => Promise<void>) {
    // Background task tracking lets tests or shutdown hooks wait for write-behind work to finish.
    const task = Promise.resolve()
      .then(fn)
      .catch((error) => {
        if (this.debug) console.error(`[layered-memory] ${label} failed`, error);
      })
      .finally(() => {
        this.pendingBackgroundTasks.delete(task);
      });
    this.pendingBackgroundTasks.add(task);
    return task;
  }

  private logFailures(stage: string, settled: PromiseSettledResult<any>[]) {
    if (!this.debug) return;
    settled.forEach((result, index) => {
      if (result.status === "rejected") {
        console.error(`[layered-memory] ${stage}:${this.providers[index]?.name || index}`, result.reason);
      }
    });
  }
}

function emptySnapshot(userInput: string): MemorySnapshot {
  return {
    userInput,
    createdAt: new Date().toISOString(),
    blocks: [],
    debug: [],
  };
}
