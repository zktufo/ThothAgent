import fs from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";
import {
  buildSyntheticDataset,
  cleanupHomeRoot,
  fileSize,
  parseEvalArgs,
  round,
  safeRate,
  summarizeLatencies,
} from "./memory_eval_shared.js";

async function main() {
  const config = parseEvalArgs(process.argv.slice(2));
  const startedAt = performance.now();
  const dataset = await buildSyntheticDataset(config);

  const sessionLatencies: number[] = [];
  const retrievalColdLatencies: number[] = [];
  const retrievalWarmLatencies: number[] = [];
  let sessionHits = 0;
  let retrievalColdHits = 0;
  let retrievalWarmHits = 0;

  for (const item of dataset.queries) {
    const sessionT0 = performance.now();
    const sessionResults = await dataset.store.searchMessages(item.query, { limit: config.topK });
    sessionLatencies.push(performance.now() - sessionT0);
    if (sessionResults.some((hit) =>
      hit.message.sessionId === item.expectedSessionId
      || String(hit.message.content || "").includes(item.expectedCaseId)
      || String(hit.message.contentSummary || "").includes(item.expectedCaseId)
      || String(hit.message.content || "").includes(item.expectedAnchorCode)
      || String(hit.message.contentSummary || "").includes(item.expectedAnchorCode)
    )) {
      sessionHits += 1;
    }

    const retrievalColdT0 = performance.now();
    const coldResults = await dataset.retrieval.search(item.query, config.topK);
    retrievalColdLatencies.push(performance.now() - retrievalColdT0);
    if (coldResults.some((hit) =>
      String(hit.metadata?.caseId || "") === item.expectedCaseId
      || String(hit.metadata?.anchorCode || "") === item.expectedAnchorCode
    )) {
      retrievalColdHits += 1;
    }

    await dataset.retrieval.warmQuery(item.query, config.topK);
    const retrievalWarmT0 = performance.now();
    const warmResults = await dataset.retrieval.search(item.query, config.topK);
    retrievalWarmLatencies.push(performance.now() - retrievalWarmT0);
    if (warmResults.some((hit) =>
      String(hit.metadata?.caseId || "") === item.expectedCaseId
      || String(hit.metadata?.anchorCode || "") === item.expectedAnchorCode
    )) {
      retrievalWarmHits += 1;
    }
  }

  const report = {
    config,
    storage: {
      sessionDbPath: dataset.storage.sessionDbPath,
      retrievalDbPath: dataset.storage.retrievalDbPath,
      sessionDbBytes: fileSize(dataset.storage.sessionDbPath),
      retrievalDbBytes: fileSize(dataset.storage.retrievalDbPath),
    },
    generated: {
      sessions: dataset.scenarios.length,
      messages: dataset.messages,
      retrievalRecords: config.retrievalRecords,
    },
    indexing: dataset.generation,
    search: {
      session: {
        hitRate: safeRate(sessionHits, dataset.queries.length),
        latency: summarizeLatencies(sessionLatencies),
      },
      retrievalCold: {
        hitRate: safeRate(retrievalColdHits, dataset.queries.length),
        latency: summarizeLatencies(retrievalColdLatencies),
      },
      retrievalWarm: {
        hitRate: safeRate(retrievalWarmHits, dataset.queries.length),
        latency: summarizeLatencies(retrievalWarmLatencies),
      },
    },
  };

  const reportPath = path.join(config.homeRoot, "memory-scale-report.json");
  fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf-8");

  printHumanReport(report, reportPath, performance.now() - startedAt);

  if (config.cleanup) {
    cleanupHomeRoot(config.homeRoot);
    console.log(`\n临时 benchmark 数据已清理: ${config.homeRoot}`);
  }
}

function printHumanReport(
  report: {
    config: { preset: string; homeRoot: string };
    generated: { sessions: number; messages: number; retrievalRecords: number };
    indexing: { generateMs: number; compressorMs: number; compactedMessages: number };
    search: {
      session: { hitRate: number; latency: { meanMs: number; p50Ms: number; p95Ms: number } };
      retrievalCold: { hitRate: number; latency: { meanMs: number; p50Ms: number; p95Ms: number } };
      retrievalWarm: { hitRate: number; latency: { meanMs: number; p50Ms: number; p95Ms: number } };
    };
    storage: { sessionDbBytes: number; retrievalDbBytes: number };
  },
  reportPath: string,
  totalMs: number,
) {
  console.log("Memory Scale Benchmark");
  console.log("======================");
  console.log(`preset: ${report.config.preset}`);
  console.log(`sessions: ${report.generated.sessions}`);
  console.log(`messages: ${report.generated.messages}`);
  console.log(`retrieval_records: ${report.generated.retrievalRecords}`);
  console.log(`generation_ms: ${round(report.indexing.generateMs)}`);
  console.log(`compressor_ms: ${round(report.indexing.compressorMs)} (compacted_messages=${report.indexing.compactedMessages})`);
  console.log(`total_ms: ${round(totalMs)}`);
  console.log("");
  console.log("Session Search");
  console.log(`hit_rate: ${report.search.session.hitRate}`);
  console.log(`latency_ms: mean=${report.search.session.latency.meanMs} p50=${report.search.session.latency.p50Ms} p95=${report.search.session.latency.p95Ms}`);
  console.log("");
  console.log("Retrieval Search");
  console.log(`cold_hit_rate: ${report.search.retrievalCold.hitRate}`);
  console.log(`cold_latency_ms: mean=${report.search.retrievalCold.latency.meanMs} p50=${report.search.retrievalCold.latency.p50Ms} p95=${report.search.retrievalCold.latency.p95Ms}`);
  console.log(`warm_hit_rate: ${report.search.retrievalWarm.hitRate}`);
  console.log(`warm_latency_ms: mean=${report.search.retrievalWarm.latency.meanMs} p50=${report.search.retrievalWarm.latency.p50Ms} p95=${report.search.retrievalWarm.latency.p95Ms}`);
  console.log("");
  console.log("Storage");
  console.log(`session_db_mb: ${round(report.storage.sessionDbBytes / 1024 / 1024)}`);
  console.log(`retrieval_db_mb: ${round(report.storage.retrievalDbBytes / 1024 / 1024)}`);
  console.log("");
  console.log(`report: ${reportPath}`);
  console.log(`home_root: ${report.config.homeRoot}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
