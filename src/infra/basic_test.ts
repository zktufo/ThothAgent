import assert from "node:assert/strict";
import { Logger } from "./logger.js";
import { MetricsRegistry } from "./metrics.js";
import { Scheduler } from "./scheduler.js";
import { TraceManager } from "./tracing.js";

async function main() {
  const logger = new Logger({
    service: "infra-test",
    level: "error",
  });
  const metrics = new MetricsRegistry();
  const tracer = new TraceManager(logger, metrics);
  const scheduler = new Scheduler({
    logger,
    metrics,
    tracer,
    cronTickMs: 20,
  });

  let intervalRuns = 0;
  scheduler.registerIntervalJob({
    id: "interval-test",
    everyMs: 25,
    runOnStart: true,
    run: async () => {
      intervalRuns += 1;
    },
  });

  let cronRuns = 0;
  scheduler.registerCronJob({
    id: "cron-test",
    cron: "* * * * *",
    run: async () => {
      cronRuns += 1;
    },
  });

  scheduler.start();
  await scheduler.runJobNow("cron-test");
  await new Promise((resolve) => setTimeout(resolve, 80));
  scheduler.stop();

  const snapshot = scheduler.getSnapshot();
  const intervalJob = snapshot.jobs.find((job) => job.id === "interval-test");
  const cronJob = snapshot.jobs.find((job) => job.id === "cron-test");
  const metricsSnapshot = metrics.snapshot();

  assert.ok(intervalRuns >= 1, "interval job 应至少执行一次");
  assert.ok(cronRuns >= 1, "cron job 应支持手动触发");
  assert.ok(intervalJob?.runCount && intervalJob.runCount >= 1);
  assert.ok(cronJob?.runCount && cronJob.runCount >= 1);
  assert.ok(metricsSnapshot.counters.some((sample) => sample.name === "scheduler_job_started_total"));
  assert.ok(metricsSnapshot.timers.some((sample) => sample.name === "scheduler_job_duration_ms"));

  console.log("infra basic test passed");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

