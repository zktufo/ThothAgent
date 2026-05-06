import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { UserHomePaths } from "../home/index.js";
import { ensureUserHomeReady } from "../home/index.js";
import { RetrievalMemory } from "../memory/layered/retrieval_memory.js";
import { SQLiteSessionStore } from "../session/SQLiteSessionStore.js";
import { SessionCompressor } from "../session/SessionCompressor.js";

export type PresetName = "tiny" | "personal" | "large";

export interface EvalConfig {
  preset: PresetName;
  sessions: number;
  turnsPerSession: number;
  retrievalRecords: number;
  queryCount: number;
  topK: number;
  homeRoot: string;
  agentName: string;
  cleanup: boolean;
  reuseDataset: boolean;
  forceRebuild: boolean;
}

export interface ScenarioCase {
  sessionId: string;
  sessionKey: string;
  caseId: string;
  petType: string;
  petName: string;
  ageLabel: string;
  symptom: string;
  concern: string;
  advice: string;
  anchorCode: string;
  anchorTheme: string;
  anchorDetail: string;
  domainLabel: string;
}

export interface QueryCase {
  query: string;
  expectedSessionId: string;
  expectedCaseId: string;
  expectedAnchorCode: string;
}

export interface LatencyStats {
  count: number;
  minMs: number;
  maxMs: number;
  meanMs: number;
  p50Ms: number;
  p95Ms: number;
  p99Ms: number;
}

export interface GeneratedDataset {
  config: EvalConfig;
  paths: UserHomePaths;
  store: SQLiteSessionStore;
  retrieval: RetrievalMemory;
  compressor: SessionCompressor;
  scenarios: ScenarioCase[];
  queries: QueryCase[];
  messages: number;
  storage: {
    sessionDbPath: string;
    retrievalDbPath: string;
  };
  generation: {
    generateMs: number;
    compressorMs: number;
    compactedMessages: number;
    reused: boolean;
  };
}

interface DatasetManifest {
  version: number;
  preset: PresetName;
  sessions: number;
  turnsPerSession: number;
  retrievalRecords: number;
  queryCount: number;
  topK: number;
  agentName: string;
}

const DATASET_MANIFEST_VERSION = 2;

const PET_TYPES = ["狗", "猫"];
const PET_NAMES = ["豆包", "元宝", "可乐", "奶球", "糯米", "芝麻", "花卷", "旺财", "小咪", "奶昔"];
const AGE_LABELS = ["3个月", "8个月", "1岁", "3岁", "7岁", "10岁"];
const SYMPTOMS = [
  { symptom: "换粮后挑食", concern: "最近换粮后突然不爱吃饭", advice: "先减慢换粮节奏，观察呕吐腹泻与精神状态" },
  { symptom: "软便腹泻", concern: "今天连续软便两次", advice: "先少量多次喂食并记录排便频次" },
  { symptom: "频繁抓耳朵", concern: "这两天总甩头抓耳", advice: "先检查是否有异味分泌物，避免自行滴药" },
  { symptom: "绝育后食欲下降", concern: "术后一天食欲明显下降", advice: "少量多次喂食，并观察精神与伤口情况" },
  { symptom: "咳嗽打喷嚏", concern: "夜里会打喷嚏伴轻微咳嗽", advice: "注意保暖和空气刺激，持续加重需就医" },
  { symptom: "喝水增多", concern: "最近明显比平时喝水多", advice: "记录饮水量和尿量，必要时排查代谢问题" },
  { symptom: "皮肤瘙痒", concern: "反复抓挠肚皮和脖子", advice: "先排查洗护和食物变化，避免频繁洗澡" },
  { symptom: "吐毛球", concern: "这周已经吐了两次毛球", advice: "增加梳毛频率和化毛支持，注意区分持续呕吐" },
];
const ANCHOR_THEMES = ["海盐协议", "银杏档案", "琥珀卡片", "北斗标签", "晨雾线索", "松针标记", "赤陶备注", "潮汐编号"];
const ANCHOR_DETAILS = [
  "昨晚吐了一次黄水",
  "本周刚换成三文鱼新粮",
  "术后第二天开始没胃口",
  "洗澡后第二天开始抓挠",
  "夜里空调直吹后开始打喷嚏",
  "驱虫后三小时出现软便",
  "最近饮水量比平时多一倍",
  "凌晨三点会反复甩头",
];
const DOMAIN_LABELS = ["营养管理", "术后恢复", "皮肤护理", "呼吸观察", "耳部检查", "胃肠管理", "饮水监测", "行为观察"];

export async function buildSyntheticDataset(config: EvalConfig): Promise<GeneratedDataset> {
  const paths = await ensureUserHomeReady({
    homeRoot: config.homeRoot,
    agentName: config.agentName,
  });
  const manifestPath = path.join(config.homeRoot, "memory-scale-dataset-manifest.json");
  const expectedManifest = buildDatasetManifest(config);
  const scenarios = buildScenarioCases(config.sessions);
  const canReuse = config.reuseDataset
    && !config.forceRebuild
    && matchesManifest(readDatasetManifest(manifestPath), expectedManifest)
    && fs.existsSync(paths.sessionDbPath)
    && fs.existsSync(paths.retrievalDbPath);

  if (!canReuse) {
    resetDatasetFiles(paths);
  }

  const store = new SQLiteSessionStore({
    homePaths: paths,
    debug: false,
  });
  const retrieval = new RetrievalMemory({
    jsonlPath: paths.retrievalMemoryPath,
    dbPath: paths.retrievalDbPath,
    topK: config.topK,
    searchMode: "hybrid",
  });
  const compressor = new SessionCompressor(store, {
    messageThreshold: Math.max(6, config.turnsPerSession * 2),
    recentSummaryLimit: Math.min(10, config.turnsPerSession * 2),
  });

  await Promise.all([store.init(), retrieval.init()]);

  if (canReuse) {
    for (const scenario of scenarios) {
      const session = await store.getSessionByKey(scenario.sessionKey);
      if (!session) {
        throw new Error(`reused dataset is missing session: ${scenario.sessionKey}`);
      }
      scenario.sessionId = session.id;
    }
    const messageCount = await countMessages(store, scenarios);
    return {
      config,
      paths,
      store,
      retrieval,
      compressor,
      scenarios,
      queries: buildQueryCases(scenarios, config.queryCount),
      messages: messageCount,
      storage: {
        sessionDbPath: paths.sessionDbPath,
        retrievalDbPath: paths.retrievalDbPath,
      },
      generation: {
        generateMs: 0,
        compressorMs: 0,
        compactedMessages: 0,
        reused: true,
      },
    };
  }
  const generateStart = performance.now();
  let messageCount = 0;

  for (const scenario of scenarios) {
    await store.createSession({
      sessionKey: scenario.sessionKey,
      tenantId: "benchmark",
      userId: "synthetic-user",
      channel: "eval",
      title: `${scenario.petName}-${scenario.symptom}`,
      metadata: {
        seed: "memory-scale-benchmark",
        caseId: scenario.caseId,
        petType: scenario.petType,
        anchorCode: scenario.anchorCode,
        anchorTheme: scenario.anchorTheme,
        anchorDetail: scenario.anchorDetail,
      },
    });
  }

  for (const scenario of scenarios) {
    const session = await store.getSessionByKey(scenario.sessionKey);
    if (!session) throw new Error(`session missing after create: ${scenario.sessionKey}`);
    scenario.sessionId = session.id;
    messageCount += await seedSession(store, scenario, config.turnsPerSession);
    await compressor.updateSessionSummary(session.id);
    await store.endSession(session.id);
  }

  for (let i = 0; i < config.retrievalRecords; i += 1) {
    const scenario = scenarios[i % scenarios.length];
    await retrieval.append({
      kind: i % 5 === 0 ? "summary" : "fact",
      text: [
        `case_id: ${scenario.caseId}`,
        `anchor_code: ${scenario.anchorCode}`,
        `domain: ${scenario.domainLabel}`,
        `${scenario.petType} ${scenario.petName} ${scenario.ageLabel}`,
        `症状：${scenario.symptom}`,
        `锚点主题：${scenario.anchorTheme}`,
        `唯一线索：${scenario.anchorDetail}`,
        `用户描述：${scenario.concern}`,
        `建议：${scenario.advice}`,
      ].join("\n"),
      tags: ["benchmark", scenario.petType, scenario.symptom, scenario.caseId, scenario.anchorCode, scenario.domainLabel],
      source: "synthetic-benchmark",
      metadata: {
        sessionId: scenario.sessionId,
        sessionKey: scenario.sessionKey,
        caseId: scenario.caseId,
        petType: scenario.petType,
        petName: scenario.petName,
        ageLabel: scenario.ageLabel,
        symptom: scenario.symptom,
        anchorCode: scenario.anchorCode,
        anchorTheme: scenario.anchorTheme,
        anchorDetail: scenario.anchorDetail,
        domainLabel: scenario.domainLabel,
      },
    });
  }
  const generateMs = performance.now() - generateStart;

  const compressorStart = performance.now();
  const compression = await compressor.applyRetentionPolicy();
  const compressorMs = performance.now() - compressorStart;
  fs.writeFileSync(manifestPath, `${JSON.stringify(expectedManifest, null, 2)}\n`, "utf-8");

  return {
    config,
    paths,
    store,
    retrieval,
    compressor,
    scenarios,
    queries: buildQueryCases(scenarios, config.queryCount),
    messages: messageCount,
    storage: {
      sessionDbPath: paths.sessionDbPath,
      retrievalDbPath: paths.retrievalDbPath,
    },
    generation: {
      generateMs,
      compressorMs,
      compactedMessages: compression.messagesCompacted,
      reused: false,
    },
  };
}

export function parseEvalArgs(args: string[]): EvalConfig {
  const map = new Map<string, string>();
  for (const arg of args) {
    if (!arg.startsWith("--")) continue;
    const [key, ...rest] = arg.slice(2).split("=");
    map.set(key, rest.join("=") || "true");
  }

  const preset = normalizePreset(map.get("preset"));
  const base = presetDefaults(preset);
  const homeRoot = map.get("home-root")
    ? path.resolve(String(map.get("home-root")))
    : fs.mkdtempSync(path.join(os.tmpdir(), "petagent-memory-bench-"));

  return {
    preset,
    sessions: intArg(map.get("sessions"), base.sessions),
    turnsPerSession: intArg(map.get("turns"), base.turnsPerSession),
    retrievalRecords: intArg(map.get("retrieval"), base.retrievalRecords),
    queryCount: intArg(map.get("queries"), base.queryCount),
    topK: intArg(map.get("topk"), 5),
    homeRoot,
    agentName: String(map.get("agent") || "memory-benchmark"),
    cleanup: map.get("cleanup") === "true",
    reuseDataset: map.get("reuse-dataset") !== "false",
    forceRebuild: map.get("force-rebuild") === "true",
  };
}

export function summarizeLatencies(values: number[]): LatencyStats {
  if (!values.length) {
    return {
      count: 0,
      minMs: 0,
      maxMs: 0,
      meanMs: 0,
      p50Ms: 0,
      p95Ms: 0,
      p99Ms: 0,
    };
  }

  const sorted = [...values].sort((a, b) => a - b);
  const sum = values.reduce((acc, value) => acc + value, 0);
  return {
    count: values.length,
    minMs: round(sorted[0]),
    maxMs: round(sorted[sorted.length - 1]),
    meanMs: round(sum / values.length),
    p50Ms: round(percentile(sorted, 0.5)),
    p95Ms: round(percentile(sorted, 0.95)),
    p99Ms: round(percentile(sorted, 0.99)),
  };
}

export function safeRate(hits: number, total: number) {
  if (!total) return 0;
  return Number((hits / total).toFixed(4));
}

export function round(value: number) {
  return Math.round(value * 1000) / 1000;
}

export function fileSize(filePath: string) {
  try {
    return fs.statSync(filePath).size;
  } catch {
    return 0;
  }
}

export function cleanupHomeRoot(homeRoot: string) {
  fs.rmSync(homeRoot, { recursive: true, force: true });
}

function buildScenarioCases(count: number): ScenarioCase[] {
  const cases: ScenarioCase[] = [];
  for (let i = 0; i < count; i += 1) {
    const symptomSeed = SYMPTOMS[i % SYMPTOMS.length];
    const petType = PET_TYPES[i % PET_TYPES.length];
    const petName = PET_NAMES[i % PET_NAMES.length];
    const ageLabel = AGE_LABELS[i % AGE_LABELS.length];
    const caseId = `case-${String(i + 1).padStart(5, "0")}`;
    const anchorTheme = ANCHOR_THEMES[i % ANCHOR_THEMES.length];
    const anchorDetail = ANCHOR_DETAILS[i % ANCHOR_DETAILS.length];
    const domainLabel = DOMAIN_LABELS[i % DOMAIN_LABELS.length];
    const anchorCode = `anchor-${String(i + 1).padStart(5, "0")}-${(i % 97).toString(36)}`;
    cases.push({
      sessionId: "",
      sessionKey: `bench-${caseId}`,
      caseId,
      petType,
      petName,
      ageLabel,
      symptom: symptomSeed.symptom,
      concern: symptomSeed.concern,
      advice: symptomSeed.advice,
      anchorCode,
      anchorTheme,
      anchorDetail,
      domainLabel,
    });
  }
  return cases;
}

function buildQueryCases(scenarios: ScenarioCase[], queryCount: number): QueryCase[] {
  const queries: QueryCase[] = [];
  for (let i = 0; i < queryCount; i += 1) {
    const scenario = scenarios[i % scenarios.length];
    queries.push({
      query: `${scenario.domainLabel} 场景里，${scenario.petType}${scenario.petName}${scenario.symptom} 怎么办？唯一锚点 ${scenario.anchorTheme} ${scenario.anchorDetail} ${scenario.anchorCode}`,
      expectedSessionId: scenario.sessionId,
      expectedCaseId: scenario.caseId,
      expectedAnchorCode: scenario.anchorCode,
    });
  }
  return queries;
}

async function seedSession(store: SQLiteSessionStore, scenario: ScenarioCase, turns: number) {
  let inserted = 0;
  for (let turn = 0; turn < turns; turn += 1) {
    const isAnchorTurn = turn === 0;
    const userContent = isAnchorTurn
      ? `case_id=${scenario.caseId} anchor_code=${scenario.anchorCode} 我家${scenario.petType}${scenario.petName}${scenario.ageLabel}，${scenario.concern}，主要问题是${scenario.symptom}。补充唯一线索：${scenario.anchorTheme}，${scenario.anchorDetail}。应该先怎么处理？`
      : `补充一下，${scenario.petName}${turn % 2 === 0 ? "精神还可以" : "昨晚有点没胃口"}，这条记录对应 ${scenario.anchorCode}，我更担心${scenario.symptom}会不会继续加重。`;
    const assistantContent = isAnchorTurn
      ? `先给结论：针对${scenario.symptom}，建议${scenario.advice}。记录锚点 ${scenario.anchorCode} / ${scenario.anchorTheme}。如果出现精神差、持续呕吐腹泻或呼吸异常，请及时就医。`
      : `继续观察重点：食欲、饮水、排便/排尿、精神状态。保留线索 ${scenario.anchorDetail}。如果${scenario.symptom}在24到48小时内加重，建议尽快线下检查。`;

    await store.appendMessage({
      sessionId: scenario.sessionId,
      role: "user",
      content: userContent,
      metadata: {
        caseId: scenario.caseId,
        anchorCode: scenario.anchorCode,
        anchorTheme: scenario.anchorTheme,
        anchorDetail: scenario.anchorDetail,
        turn,
      },
    });
    await store.appendMessage({
      sessionId: scenario.sessionId,
      role: "assistant",
      content: assistantContent,
      metadata: {
        caseId: scenario.caseId,
        anchorCode: scenario.anchorCode,
        anchorTheme: scenario.anchorTheme,
        anchorDetail: scenario.anchorDetail,
        turn,
      },
    });
    inserted += 2;
  }
  return inserted;
}

function normalizePreset(value?: string): PresetName {
  if (value === "tiny" || value === "personal" || value === "large") return value;
  return "personal";
}

function presetDefaults(preset: PresetName) {
  switch (preset) {
    case "tiny":
      return { sessions: 200, turnsPerSession: 4, retrievalRecords: 500, queryCount: 40 };
    case "large":
      return { sessions: 10000, turnsPerSession: 6, retrievalRecords: 12000, queryCount: 300 };
    case "personal":
    default:
      return { sessions: 1500, turnsPerSession: 5, retrievalRecords: 2500, queryCount: 120 };
  }
}

function intArg(value: string | undefined, fallback: number) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

function percentile(sorted: number[], ratio: number) {
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * ratio) - 1));
  return sorted[index];
}

function buildDatasetManifest(config: EvalConfig): DatasetManifest {
  return {
    version: DATASET_MANIFEST_VERSION,
    preset: config.preset,
    sessions: config.sessions,
    turnsPerSession: config.turnsPerSession,
    retrievalRecords: config.retrievalRecords,
    queryCount: config.queryCount,
    topK: config.topK,
    agentName: config.agentName,
  };
}

function readDatasetManifest(filePath: string): DatasetManifest | null {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf-8")) as DatasetManifest;
  } catch {
    return null;
  }
}

function matchesManifest(current: DatasetManifest | null, expected: DatasetManifest) {
  if (!current) return false;
  return JSON.stringify(current) === JSON.stringify(expected);
}

async function countMessages(store: SQLiteSessionStore, scenarios: ScenarioCase[]) {
  let total = 0;
  for (const scenario of scenarios) {
    total += await store.countMessages(scenario.sessionId);
  }
  return total;
}

function resetDatasetFiles(paths: UserHomePaths) {
  for (const filePath of [paths.sessionDbPath, paths.retrievalDbPath, paths.retrievalMemoryPath]) {
    try {
      fs.rmSync(filePath, { force: true });
    } catch {}
  }
}
