import { Logger } from "./logger.js";
import { MetricsRegistry } from "./metrics.js";
import { TraceManager } from "./tracing.js";

export interface SchedulerOptions {
  logger: Logger;
  metrics: MetricsRegistry;
  tracer?: TraceManager;
  cronTickMs?: number;
}

export interface ScheduledJobContext {
  scheduledAt: string;
  trigger: "interval" | "cron" | "manual";
}

export interface ScheduledJobDefinition {
  id: string;
  description?: string;
  run: (context: ScheduledJobContext) => Promise<unknown>;
}

export interface IntervalJobDefinition extends ScheduledJobDefinition {
  everyMs: number;
  runOnStart?: boolean;
}

export interface CronJobDefinition extends ScheduledJobDefinition {
  cron: string;
}

export interface SchedulerJobSnapshot {
  id: string;
  mode: "interval" | "cron";
  schedule: string;
  running: boolean;
  runCount: number;
  successCount: number;
  errorCount: number;
  lastStartedAt?: string;
  lastFinishedAt?: string;
  lastDurationMs?: number;
  lastError?: string;
}

interface SchedulerJobState {
  id: string;
  mode: "interval" | "cron";
  schedule: string;
  description?: string;
  run: (context: ScheduledJobContext) => Promise<unknown>;
  everyMs?: number;
  cron?: string;
  timer?: NodeJS.Timeout;
  running: boolean;
  runCount: number;
  successCount: number;
  errorCount: number;
  lastStartedAt?: string;
  lastFinishedAt?: string;
  lastDurationMs?: number;
  lastError?: string;
  lastCronMinuteKey?: string;
}

export class Scheduler {
  private readonly logger: Logger;
  private readonly metrics: MetricsRegistry;
  private readonly tracer: TraceManager;
  private readonly cronTickMs: number;
  private readonly jobs = new Map<string, SchedulerJobState>();
  private cronTimer: NodeJS.Timeout | null = null;
  private started = false;

  constructor(options: SchedulerOptions) {
    this.logger = options.logger.child({ component: "scheduler" });
    this.metrics = options.metrics;
    this.tracer = options.tracer ?? new TraceManager(this.logger, this.metrics);
    this.cronTickMs = options.cronTickMs ?? 30_000;
  }

  registerIntervalJob(definition: IntervalJobDefinition) {
    this.ensureUnique(definition.id);
    const job: SchedulerJobState = {
      id: definition.id,
      mode: "interval",
      schedule: `${definition.everyMs}ms`,
      description: definition.description,
      run: definition.run,
      everyMs: definition.everyMs,
      running: false,
      runCount: 0,
      successCount: 0,
      errorCount: 0,
    };
    this.jobs.set(job.id, job);
    if (this.started) {
      this.startIntervalJob(job, definition.runOnStart ?? false);
    }
  }

  registerCronJob(definition: CronJobDefinition) {
    validateCron(definition.cron);
    this.ensureUnique(definition.id);
    const job: SchedulerJobState = {
      id: definition.id,
      mode: "cron",
      schedule: definition.cron,
      description: definition.description,
      run: definition.run,
      cron: definition.cron,
      running: false,
      runCount: 0,
      successCount: 0,
      errorCount: 0,
    };
    this.jobs.set(job.id, job);
    if (this.started) {
      this.ensureCronLoop();
    }
  }

  start() {
    if (this.started) return;
    this.started = true;
    for (const job of this.jobs.values()) {
      if (job.mode === "interval") {
        this.startIntervalJob(job, false);
      }
    }
    this.ensureCronLoop();
    this.logger.info("scheduler.started", {
      jobs: this.jobs.size,
    });
  }

  stop() {
    this.started = false;
    if (this.cronTimer) {
      clearInterval(this.cronTimer);
      this.cronTimer = null;
    }
    for (const job of this.jobs.values()) {
      if (job.timer) {
        clearInterval(job.timer);
        job.timer = undefined;
      }
    }
    this.logger.info("scheduler.stopped", {
      jobs: this.jobs.size,
    });
  }

  async runJobNow(id: string) {
    const job = this.jobs.get(id);
    if (!job) throw new Error(`scheduler job not found: ${id}`);
    await this.executeJob(job, "manual");
  }

  getSnapshot() {
    return {
      started: this.started,
      jobs: [...this.jobs.values()].map((job) => ({
        id: job.id,
        mode: job.mode,
        schedule: job.schedule,
        running: job.running,
        runCount: job.runCount,
        successCount: job.successCount,
        errorCount: job.errorCount,
        lastStartedAt: job.lastStartedAt,
        lastFinishedAt: job.lastFinishedAt,
        lastDurationMs: job.lastDurationMs,
        lastError: job.lastError,
      } satisfies SchedulerJobSnapshot)),
    };
  }

  private ensureUnique(id: string) {
    if (this.jobs.has(id)) {
      throw new Error(`scheduler job already exists: ${id}`);
    }
  }

  private startIntervalJob(job: SchedulerJobState, runOnStart: boolean) {
    if (!job.everyMs) return;
    job.timer = setInterval(() => {
      void this.executeJob(job, "interval");
    }, job.everyMs);
    job.timer.unref?.();
    if (runOnStart) {
      void this.executeJob(job, "interval");
    }
  }

  private ensureCronLoop() {
    const hasCron = [...this.jobs.values()].some((job) => job.mode === "cron");
    if (!hasCron || this.cronTimer) return;
    this.cronTimer = setInterval(() => {
      const now = new Date();
      const minuteKey = formatMinuteKey(now);
      for (const job of this.jobs.values()) {
        if (job.mode !== "cron" || !job.cron) continue;
        if (job.lastCronMinuteKey === minuteKey) continue;
        if (!matchesCron(job.cron, now)) continue;
        job.lastCronMinuteKey = minuteKey;
        void this.executeJob(job, "cron");
      }
    }, this.cronTickMs);
    this.cronTimer.unref?.();
  }

  private async executeJob(job: SchedulerJobState, trigger: "interval" | "cron" | "manual") {
    if (job.running) {
      this.metrics.increment("scheduler_job_skipped_total", 1, {
        job: job.id,
        trigger,
        reason: "already_running",
      });
      return;
    }

    job.running = true;
    job.runCount += 1;
    job.lastStartedAt = new Date().toISOString();
    const startedAt = Date.now();
    this.metrics.increment("scheduler_job_started_total", 1, { job: job.id, trigger });

    try {
      await this.tracer.span(`scheduler:${job.id}`, () => job.run({
        scheduledAt: job.lastStartedAt!,
        trigger,
      }), { job: job.id, trigger });
      job.successCount += 1;
      this.metrics.increment("scheduler_job_success_total", 1, { job: job.id, trigger });
    } catch (error) {
      job.errorCount += 1;
      job.lastError = error instanceof Error ? error.message : String(error);
      this.metrics.increment("scheduler_job_error_total", 1, { job: job.id, trigger });
      this.logger.error("scheduler.job_failed", error, {
        job: job.id,
        trigger,
      });
    } finally {
      job.running = false;
      job.lastFinishedAt = new Date().toISOString();
      job.lastDurationMs = Date.now() - startedAt;
      this.metrics.recordTimer("scheduler_job_duration_ms", job.lastDurationMs, {
        job: job.id,
        trigger,
      });
    }
  }
}

function formatMinuteKey(date: Date) {
  return `${date.getUTCFullYear()}-${date.getUTCMonth()}-${date.getUTCDate()}-${date.getUTCHours()}-${date.getUTCMinutes()}`;
}

function validateCron(cron: string) {
  const fields = cron.trim().split(/\s+/);
  if (fields.length !== 5) {
    throw new Error(`invalid cron expression: ${cron}`);
  }
  fields.forEach((field, index) => parseCronField(field, index));
}

function matchesCron(cron: string, date: Date) {
  const [minute, hour, day, month, weekday] = cron.trim().split(/\s+/);
  return matchCronField(minute, date.getMinutes(), 0)
    && matchCronField(hour, date.getHours(), 1)
    && matchCronField(day, date.getDate(), 2)
    && matchCronField(month, date.getMonth() + 1, 3)
    && matchCronField(weekday, date.getDay(), 4);
}

function matchCronField(field: string, value: number, index: number) {
  const allowed = parseCronField(field, index);
  return allowed.has(value);
}

function parseCronField(field: string, index: number) {
  const [min, max] = cronBounds(index);
  const values = new Set<number>();
  for (const part of field.split(",")) {
    if (part === "*") {
      for (let i = min; i <= max; i += 1) values.add(i);
      continue;
    }

    if (part.startsWith("*/")) {
      const step = Number(part.slice(2));
      if (!Number.isFinite(step) || step <= 0) {
        throw new Error(`invalid cron step: ${part}`);
      }
      for (let i = min; i <= max; i += Math.max(step, 1)) values.add(i);
      continue;
    }

    if (part.includes("-")) {
      const [rawStart, rawEnd] = part.split("-");
      const start = Number(rawStart);
      const end = Number(rawEnd);
      if (!Number.isFinite(start) || !Number.isFinite(end) || start < min || end > max || start > end) {
        throw new Error(`invalid cron range: ${part}`);
      }
      for (let i = start; i <= end; i += 1) values.add(i);
      continue;
    }

    const single = Number(part);
    if (Number.isFinite(single)) {
      if (single < min || single > max) {
        throw new Error(`cron value out of range: ${part}`);
      }
      values.add(single);
    }
  }
  if (!values.size) {
    throw new Error(`invalid cron field: ${field}`);
  }
  return values;
}

function cronBounds(index: number): [number, number] {
  switch (index) {
    case 0:
      return [0, 59];
    case 1:
      return [0, 23];
    case 2:
      return [1, 31];
    case 3:
      return [1, 12];
    case 4:
      return [0, 6];
    default:
      throw new Error(`invalid cron field index: ${index}`);
  }
}
