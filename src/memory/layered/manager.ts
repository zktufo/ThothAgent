import { PromptBuilder } from "./prompt_builder.js";
import type { MemoryProvider } from "./provider.js";
import type {
  MemoryManagerOptions,
  MemorySnapshot,
  PromptBuildOutput,
  SyncTurnInput,
} from "./types.js";

export class MemoryManager {
  readonly promptBuilder: PromptBuilder;
  private initialized = false;
  private pendingBackgroundTasks = new Set<Promise<void>>();
  private lastSnapshot: MemorySnapshot | null = null;
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

  async onTurnStart(userInput: string) {
    // onTurnStart only orchestrates cheap provider prefetch and never performs heavy background work.
    await this.init();
    const now = new Date().toISOString();
    const settled = await Promise.allSettled(
      this.providers.map((provider) => provider.prefetch({
        userInput,
        sessionId: this.options.sessionId,
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
    const debugLines = settled.flatMap((result, index) => {
      if (result.status === "rejected") return [`provider:${this.providers[index]?.name || index} prefetch failed: ${String(result.reason)}`];
      return result.value.debug || [];
    });

    const snapshot: MemorySnapshot = {
      userInput,
      createdAt: now,
      blocks,
      workingState,
      debug: debugLines,
    };
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

  syncTurn(userInput: string, assistantOutput: string) {
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
            sessionId: this.options.sessionId,
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

  queuePrefetch(userInput: string) {
    // queuePrefetch is where providers can do heavier cache warming for the next round.
    return this.runBackground("queuePrefetch", async () => {
      await this.init();
      const now = new Date().toISOString();
      const settled = await Promise.allSettled(
        this.providers
          .filter((provider) => typeof provider.queuePrefetch === "function")
          .map((provider) => provider.queuePrefetch!({
            userInput,
            sessionId: this.options.sessionId,
            now,
          })),
      );
      this.logFailures("queuePrefetch", settled);
    });
  }

  getLastSnapshot() {
    return this.lastSnapshot;
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
