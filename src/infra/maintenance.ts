import type { ThothAgent } from "../agent/index.js";
import { Logger } from "./logger.js";
import { MetricsRegistry } from "./metrics.js";
import { Scheduler } from "./scheduler.js";
import { TraceManager } from "./tracing.js";

export interface MaintenanceCoordinatorOptions {
  logger: Logger;
  metrics: MetricsRegistry;
  scheduler: Scheduler;
  tracer?: TraceManager;
  listAgents: () => Array<{ agentId: string; agent: ThothAgent }>;
  sessionRetentionCron?: string;
  retrievalCacheCleanupMs?: number;
  memoryFlushMs?: number;
}

export class MaintenanceCoordinator {
  private readonly logger: Logger;
  private readonly metrics: MetricsRegistry;
  private readonly scheduler: Scheduler;
  private readonly tracer: TraceManager;
  private readonly listAgents: () => Array<{ agentId: string; agent: ThothAgent }>;

  constructor(options: MaintenanceCoordinatorOptions) {
    this.logger = options.logger.child({ component: "maintenance" });
    this.metrics = options.metrics;
    this.scheduler = options.scheduler;
    this.tracer = options.tracer ?? new TraceManager(this.logger, this.metrics);
    this.listAgents = options.listAgents;

    this.scheduler.registerCronJob({
      id: "session-retention",
      cron: options.sessionRetentionCron ?? "17 */6 * * *",
      description: "压缩旧 session 消息并裁剪大体积 artifact",
      run: async () => {
        await this.runAcrossAgents("session-retention", async ({ agent }) => {
          return agent.runtime.sessions.applyRetentionPolicy();
        });
      },
    });

    this.scheduler.registerIntervalJob({
      id: "retrieval-cache-cleanup",
      everyMs: options.retrievalCacheCleanupMs ?? 10 * 60 * 1000,
      runOnStart: true,
      description: "清理 retrieval query cache 的过期项",
      run: async () => {
        await this.runAcrossAgents("retrieval-cache-cleanup", async ({ agent }) => {
          return {
            removed: agent.runtime.memory.retrievalMemory.pruneExpiredCache(),
            cacheSize: agent.runtime.memory.retrievalMemory.getCacheStats().size,
          };
        });
      },
    });

    this.scheduler.registerIntervalJob({
      id: "memory-background-flush",
      everyMs: options.memoryFlushMs ?? 60 * 1000,
      description: "冲刷 memory write-behind 后台任务",
      run: async () => {
        await this.runAcrossAgents("memory-background-flush", async ({ agent }) => {
          await agent.runtime.memory.manager.flushBackgroundTasks();
          return {
            pendingTasks: 0,
          };
        });
      },
    });
  }

  async runRetentionNow() {
    await this.scheduler.runJobNow("session-retention");
  }

  private async runAcrossAgents(
    jobId: string,
    run: (entry: { agentId: string; agent: ThothAgent }) => Promise<unknown>,
  ) {
    const agents = this.listAgents();
    this.metrics.setGauge("maintenance_agent_count", agents.length, { job: jobId });

    for (const entry of agents) {
      await this.tracer.span(`maintenance:${jobId}:${entry.agentId}`, async () => {
        const result = await run(entry);
        this.logger.info("maintenance.job_completed", {
          job: jobId,
          agentId: entry.agentId,
          result: sanitizeResult(result),
        });
      }, {
        job: jobId,
        agentId: entry.agentId,
      });
    }
  }
}

function sanitizeResult(result: unknown) {
  if (!result || typeof result !== "object") return { value: result };
  return result as Record<string, unknown>;
}
