import fs from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { RetrievalMemory } from "../memory/layered/retrieval_memory.js";
import {
  buildSyntheticDataset,
  cleanupHomeRoot,
  fileSize,
  parseEvalArgs,
  round,
  safeRate,
  summarizeLatencies,
  type GeneratedDataset,
  type LatencyStats,
  type QueryCase,
} from "./memory_eval_shared.js";

type VariantName =
  | "session_search"
  | "retrieval_cold"
  | "retrieval_warm"
  | "retrieval_lexical"
  | "retrieval_hybrid"
  | "retrieval_hybrid_warm"
  | "hybrid_union";

interface VariantResult {
  variant: VariantName;
  hitRate: number;
  latency: LatencyStats;
  hits: number;
  total: number;
}

interface AbReport {
  dataset: {
    preset: string;
    sessions: number;
    messages: number;
    retrievalRecords: number;
    queryCount: number;
    homeRoot: string;
  };
  generation: GeneratedDataset["generation"];
  storage: {
    sessionDbPath: string;
    retrievalDbPath: string;
    sessionDbBytes: number;
    retrievalDbBytes: number;
  };
  baseline: VariantResult;
  candidate: VariantResult;
  diff: {
    hitRateDelta: number;
    meanLatencyDeltaMs: number;
    p95LatencyDeltaMs: number;
  };
}

async function main() {
  const config = parseEvalArgs(process.argv.slice(2));
  const params = parseVariantArgs(process.argv.slice(2));
  const totalStart = performance.now();
  const dataset = await buildSyntheticDataset(config);

  const baseline = await runVariant(dataset, params.baseline);
  const candidate = await runVariant(dataset, params.candidate);

  const report: AbReport = {
    dataset: {
      preset: config.preset,
      sessions: dataset.scenarios.length,
      messages: dataset.messages,
      retrievalRecords: config.retrievalRecords,
      queryCount: dataset.queries.length,
      homeRoot: config.homeRoot,
    },
    generation: dataset.generation,
    storage: {
      sessionDbPath: dataset.storage.sessionDbPath,
      retrievalDbPath: dataset.storage.retrievalDbPath,
      sessionDbBytes: fileSize(dataset.storage.sessionDbPath),
      retrievalDbBytes: fileSize(dataset.storage.retrievalDbPath),
    },
    baseline,
    candidate,
    diff: {
      hitRateDelta: round(candidate.hitRate - baseline.hitRate),
      meanLatencyDeltaMs: round(candidate.latency.meanMs - baseline.latency.meanMs),
      p95LatencyDeltaMs: round(candidate.latency.p95Ms - baseline.latency.p95Ms),
    },
  };

  const reportPath = path.join(config.homeRoot, `memory-ab-report-${params.baseline}-vs-${params.candidate}.json`);
  fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf-8");

  printAbReport(report, reportPath, round(performance.now() - totalStart));

  if (config.cleanup) {
    cleanupHomeRoot(config.homeRoot);
    console.log(`\n临时 A/B 数据已清理: ${config.homeRoot}`);
  }
}

async function runVariant(dataset: GeneratedDataset, variant: VariantName): Promise<VariantResult> {
  const latencies: number[] = [];
  let hits = 0;
  const retrievalClient = getRetrievalClient(dataset, variant);

  for (const query of dataset.queries) {
    if (variant === "retrieval_warm" || variant === "retrieval_hybrid_warm") {
      await retrievalClient.warmQuery(query.query, dataset.config.topK);
    }

    const t0 = performance.now();
    const matched = await evaluateQuery(dataset, query, variant, retrievalClient);
    latencies.push(performance.now() - t0);
    if (matched) hits += 1;
  }

  return {
    variant,
    hitRate: safeRate(hits, dataset.queries.length),
    latency: summarizeLatencies(latencies),
    hits,
    total: dataset.queries.length,
  };
}

async function evaluateQuery(
  dataset: GeneratedDataset,
  query: QueryCase,
  variant: VariantName,
  retrievalClient: RetrievalMemory,
) {
  if (variant === "session_search") {
    const hits = await dataset.store.searchMessages(query.query, { limit: dataset.config.topK });
    return hits.some((item) =>
      item.message.sessionId === query.expectedSessionId
      || String(item.message.content || "").includes(query.expectedCaseId)
      || String(item.message.contentSummary || "").includes(query.expectedCaseId)
      || String(item.message.content || "").includes(query.expectedAnchorCode)
      || String(item.message.contentSummary || "").includes(query.expectedAnchorCode)
    );
  }

  if (
    variant === "retrieval_cold"
    || variant === "retrieval_warm"
    || variant === "retrieval_lexical"
    || variant === "retrieval_hybrid"
    || variant === "retrieval_hybrid_warm"
  ) {
    const hits = await retrievalClient.search(query.query, dataset.config.topK);
    return hits.some((item) =>
      String(item.metadata?.caseId || "") === query.expectedCaseId
      || String(item.metadata?.anchorCode || "") === query.expectedAnchorCode
    );
  }

  const [sessionHits, retrievalHits] = await Promise.all([
    dataset.store.searchMessages(query.query, { limit: dataset.config.topK }),
    getRetrievalClient(dataset, "retrieval_hybrid").search(query.query, dataset.config.topK),
  ]);

  return sessionHits.some((item) =>
    item.message.sessionId === query.expectedSessionId
    || String(item.message.content || "").includes(query.expectedCaseId)
    || String(item.message.contentSummary || "").includes(query.expectedCaseId)
    || String(item.message.content || "").includes(query.expectedAnchorCode)
    || String(item.message.contentSummary || "").includes(query.expectedAnchorCode)
  ) || retrievalHits.some((item) =>
    String(item.metadata?.caseId || "") === query.expectedCaseId
    || String(item.metadata?.anchorCode || "") === query.expectedAnchorCode
  );
}

function parseVariantArgs(args: string[]) {
  const map = new Map<string, string>();
  for (const arg of args) {
    if (!arg.startsWith("--")) continue;
    const [key, ...rest] = arg.slice(2).split("=");
    map.set(key, rest.join("=") || "true");
  }

  return {
    baseline: normalizeVariant(map.get("baseline"), "retrieval_cold"),
    candidate: normalizeVariant(map.get("candidate"), "retrieval_warm"),
  };
}

function normalizeVariant(value: string | undefined, fallback: VariantName): VariantName {
  if (
    value === "session_search"
    || value === "retrieval_cold"
    || value === "retrieval_warm"
    || value === "retrieval_lexical"
    || value === "retrieval_hybrid"
    || value === "retrieval_hybrid_warm"
    || value === "hybrid_union"
  ) {
    return value;
  }
  return fallback;
}

const retrievalClients = new WeakMap<GeneratedDataset, Map<string, RetrievalMemory>>();

function getRetrievalClient(dataset: GeneratedDataset, variant: VariantName) {
  let bucket = retrievalClients.get(dataset);
  if (!bucket) {
    bucket = new Map<string, RetrievalMemory>();
    retrievalClients.set(dataset, bucket);
  }

  const mode = variant === "retrieval_lexical" ? "lexical" : "hybrid";
  const cacheKey = `${mode}:${variant.includes("warm") ? "warm" : "cold"}`;
  const existing = bucket.get(cacheKey);
  if (existing) return existing;

  const client = new RetrievalMemory({
    jsonlPath: dataset.paths.retrievalMemoryPath,
    dbPath: dataset.paths.retrievalDbPath,
    topK: dataset.config.topK,
    searchMode: mode,
  });
  bucket.set(cacheKey, client);
  return client;
}

function printAbReport(report: AbReport, reportPath: string, totalMs: number) {
  console.log("Memory A/B Evaluation");
  console.log("=====================");
  console.log(`dataset: preset=${report.dataset.preset} sessions=${report.dataset.sessions} messages=${report.dataset.messages} retrieval=${report.dataset.retrievalRecords} queries=${report.dataset.queryCount}`);
  console.log(`generation_ms: ${round(report.generation.generateMs)} total_ms: ${totalMs}`);
  console.log("");
  console.log(`baseline: ${report.baseline.variant}`);
  console.log(`hit_rate=${report.baseline.hitRate} mean_ms=${report.baseline.latency.meanMs} p95_ms=${report.baseline.latency.p95Ms}`);
  console.log("");
  console.log(`candidate: ${report.candidate.variant}`);
  console.log(`hit_rate=${report.candidate.hitRate} mean_ms=${report.candidate.latency.meanMs} p95_ms=${report.candidate.latency.p95Ms}`);
  console.log("");
  console.log("diff(candidate - baseline)");
  console.log(`hit_rate_delta=${report.diff.hitRateDelta}`);
  console.log(`mean_latency_delta_ms=${report.diff.meanLatencyDeltaMs}`);
  console.log(`p95_latency_delta_ms=${report.diff.p95LatencyDeltaMs}`);
  console.log("");
  console.log(`report: ${reportPath}`);
  console.log(`home_root: ${report.dataset.homeRoot}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
