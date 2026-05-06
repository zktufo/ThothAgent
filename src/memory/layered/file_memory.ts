/**
 * FileMemory owns the small set of files that define the layered-memory state.
 *
 * After cleanup (2026-05-05):
 * - Removed: session_summary.md (was raw log append, not real summarization)
 * - Removed: daily/ (dead files, never read/written)
 * - Simplified: working_state writes only when vars actually changes
 * - Simplified: MEMORY.md kept as read-only, no auto regeneration
 *
 * Remaining files:
 * - USER.md            → built-in user memory
 * - MEMORY.md          → built-in long-term memory
 * - DOMAIN.md          → built-in domain knowledge
 * - working_state.json → current task state + vars
 * - retrieval_memory.db → unified local long-term memory log (JSONL format)
 */
import fs from "fs";
import path from "path";
import { stableDigest, tokenizeForEmbedding } from "../utils.js";
import type {
  ExternalMemoryRecord,
  ExternalMemorySource,
  ExternalMemoryType,
  ExternalMemorySearchHit,
  WorkingState,
} from "./types.js";
import { resolveUserHomePaths } from "../../home/index.js";

export interface FileMemoryOptions {
  rootDir?: string;
  projectRootDir?: string;
  domainMemoryPath?: string;
  visibleMemoryPath?: string;
  userMemoryPath?: string;
  retrievalMemoryPath?: string;
}

export class FileMemory {
  readonly rootDir: string;
  readonly userMemoryPath: string;
  readonly domainMemoryPath: string;
  readonly workingStatePath: string;
  readonly visibleMemoryPath: string;
  readonly retrievalMemoryPath: string;
  private readonly projectRoot: string;

  constructor(options: FileMemoryOptions = {}) {
    const homePaths = resolveUserHomePaths();
    this.rootDir = options.rootDir || homePaths.layeredDir;
    this.projectRoot = options.projectRootDir || homePaths.agentDataDir;
    this.userMemoryPath = options.userMemoryPath || homePaths.userPath;
    this.domainMemoryPath = options.domainMemoryPath || homePaths.domainContextPath;
    this.workingStatePath = path.join(this.rootDir, "working_state.json");
    this.visibleMemoryPath = options.visibleMemoryPath || homePaths.visibleMemoryPath;
    this.retrievalMemoryPath = options.retrievalMemoryPath || homePaths.retrievalMemoryPath;
  }

  async init() {
    // Initialize all files lazily so a fresh checkout can boot without manual setup.
    fs.mkdirSync(this.rootDir, { recursive: true });
    this.migrateLegacyMemoryToDomain();
    this.ensureMarkdown(this.userMemoryPath, [
      "# USER.md",
      "",
      "- 用户称呼：未设置",
      "- 沟通偏好：希望回答清晰、直接、可操作",
      "",
    ].join("\n"));
    this.ensureMarkdown(this.visibleMemoryPath, [
      "# MEMORY.md",
      "",
      "- 暂无长期记忆。",
      "",
    ].join("\n"));
    this.ensureMarkdown(this.domainMemoryPath, [
      "# DOMAIN.md",
      "",
      "- 在这里写垂直业务规则、术语、流程边界和系统能力。",
      "- 这是给 LLM 理解业务背景的，不是代码实现说明。",
      "",
    ].join("\n"));
    this.ensureJson(this.workingStatePath, {
      status: "idle",
      turnCount: 0,
      vars: {},
    });
    this.ensureText(this.retrievalMemoryPath, "");
    this.migrateLegacyRetrievalMemory();
  }

  async getUserMemory() {
    return this.readText(this.userMemoryPath, "");
  }

  async saveUserMemory(content: string) {
    this.writeText(this.userMemoryPath, content.trim() ? `${content.trim()}\n` : "");
  }

  async getDomainMemory() {
    return this.readText(this.domainMemoryPath, "");
  }

  async saveDomainMemory(content: string) {
    this.writeText(this.domainMemoryPath, content.trim() ? `${content.trim()}\n` : "");
  }

  async getBuiltinMemory() {
    return this.readText(this.visibleMemoryPath, "");
  }

  async saveBuiltinMemory(content: string) {
    this.writeText(this.visibleMemoryPath, content.trim() ? `${content.trim()}\n` : "");
  }

  async getWorkingState() {
    return this.readJson<WorkingState>(this.workingStatePath, {});
  }

  async saveWorkingState(state: WorkingState) {
    this.writeJson(this.workingStatePath, state);
  }

  async updateWorkingState(patch: Partial<WorkingState>) {
    // Working state is operational state, so we overwrite it frequently and keep the latest truth.
    const current = await this.getWorkingState();
    const next: WorkingState = {
      ...current,
      ...patch,
      vars: {
        ...(current.vars || {}),
        ...(patch.vars || {}),
      },
      updatedAt: new Date().toISOString(),
    };
    await this.saveWorkingState(next);
    return next;
  }

  async getVisibleMemorySummary() {
    return this.getBuiltinMemory();
  }

  async saveVisibleMemorySummary(content: string) {
    await this.saveBuiltinMemory(content);
  }

  async rewriteBuiltinMemory(
    target: "memory" | "user" | "domain",
    input: { action: "add" | "replace" | "remove"; content: string; oldText?: string },
  ) {
    const filePath = this.resolveBuiltinPath(target);
    const current = this.readText(filePath, "");
    const next = rewriteMemoryDocument(current, input);
    this.writeText(filePath, next);
    return next;
  }

  async appendExternalMemoryRecord(record: {
    schemaVersion?: number;
    sessionId: string;
    userInput: string;
    assistantOutput: string;
    summary: string;
    userRepresentation: string[];
    userPeerCard: string[];
    aiRepresentation: string[];
    aiIdentityCard: string[];
    source: ExternalMemoryRecord["source"];
    memoryType: ExternalMemoryRecord["memoryType"];
    keywords: string[];
    topics: string[];
    importance: number;
    decayProfile: ExternalMemoryRecord["decayProfile"];
    signals: ExternalMemoryRecord["signals"];
    metadata?: Record<string, unknown>;
    writtenAt?: string;
  }) {
    fs.mkdirSync(path.dirname(this.retrievalMemoryPath), { recursive: true });
    const normalized = normalizeExternalMemoryRecord({
      schemaVersion: record.schemaVersion ?? 1,
      id: `ext_${stableDigest(`${record.sessionId}:${record.source}:${record.userInput}:${record.assistantOutput}:${record.writtenAt || new Date().toISOString()}`)}`,
      writtenAt: record.writtenAt || new Date().toISOString(),
      source: record.source,
      memoryType: record.memoryType,
      sessionId: record.sessionId,
      summary: record.summary,
      userRepresentation: record.userRepresentation,
      userPeerCard: record.userPeerCard,
      aiRepresentation: record.aiRepresentation,
      aiIdentityCard: record.aiIdentityCard,
      userInput: record.userInput,
      assistantOutput: record.assistantOutput,
      keywords: record.keywords,
      topics: record.topics,
      importance: record.importance,
      decayProfile: record.decayProfile,
      signals: record.signals,
      metadata: record.metadata || {},
      accessCount: 0,
    });
    fs.appendFileSync(this.retrievalMemoryPath, `${JSON.stringify(wrapExternalMemoryRecord(normalized))}\n`, "utf-8");
  }

  async searchExternalMemory(query: string, limit: number = 4) {
    const normalized = query.toLowerCase().trim();
    if (!normalized) return [];
    const tokens = tokenizeExternalQuery(query);
    const records = this.readExternalMemoryRecords();
    const hits = records
      .map((record) => scoreExternalMemoryRecord(record, tokens))
      .filter((hit) => hit.score > 0)
      .sort((a, b) => {
        if (b.score !== a.score) return b.score - a.score;
        if (b.importanceScore !== a.importanceScore) return b.importanceScore - a.importanceScore;
        return b.record.writtenAt.localeCompare(a.record.writtenAt);
      })
      .slice(0, limit);
    return hits;
  }

  async compactExternalMemory(options: {
    dedupeSimilarityThreshold?: number;
    maxRecordsPerCluster?: number;
    compactOlderThanDays?: number;
  } = {}) {
    const records = this.readExternalMemoryRecords();
    if (!records.length) {
      return {
        scanned: 0,
        deduped: 0,
        compacted: 0,
        remaining: 0,
      };
    }

    const dedupeSimilarityThreshold = options.dedupeSimilarityThreshold ?? 0.82;
    const maxRecordsPerCluster = options.maxRecordsPerCluster ?? 3;
    const compactOlderThanDays = options.compactOlderThanDays ?? 21;
    const now = Date.now();
    const keep: ExternalMemoryRecord[] = [];
    const compacted: ExternalMemoryRecord[] = [];
    const seen = new Set<string>();
    let deduped = 0;
    let compactedCount = 0;

    const sorted = [...records].sort((a, b) => b.writtenAt.localeCompare(a.writtenAt));

    for (const record of sorted) {
      if (seen.has(record.id)) continue;

      const cluster = sorted.filter((candidate) => {
        if (seen.has(candidate.id)) return false;
        if (candidate.memoryType !== record.memoryType) return false;
        if (candidate.sessionId !== record.sessionId && record.memoryType === "explicit_memory_write") return false;
        return externalMemorySimilarity(record, candidate) >= dedupeSimilarityThreshold;
      });

      cluster.forEach((item) => seen.add(item.id));

      if (cluster.length === 1) {
        keep.push(cluster[0]!);
        continue;
      }

      deduped += cluster.length - 1;
      const oldestAgeDays = Math.max(...cluster.map((item) => (now - new Date(item.writtenAt).getTime()) / (24 * 60 * 60 * 1000)));

      if (cluster.length > maxRecordsPerCluster || oldestAgeDays >= compactOlderThanDays) {
        compacted.push(compactExternalMemoryCluster(cluster));
        compactedCount += cluster.length;
        continue;
      }

      keep.push(selectPrimaryExternalMemory(cluster));
    }

    const rewritten = [...keep, ...compacted]
      .sort((a, b) => b.writtenAt.localeCompare(a.writtenAt));
    this.rewriteExternalMemoryRecords(rewritten);

    return {
      scanned: records.length,
      deduped,
      compacted: compactedCount,
      remaining: rewritten.length,
    };
  }

  private ensureJson(filePath: string, fallback: any) {
    if (fs.existsSync(filePath)) return;
    this.writeJson(filePath, fallback);
  }

  private ensureMarkdown(filePath: string, fallback: string) {
    if (fs.existsSync(filePath)) return;
    this.writeText(filePath, fallback);
  }

  private ensureText(filePath: string, fallback: string) {
    if (fs.existsSync(filePath)) return;
    this.writeText(filePath, fallback);
  }

  private migrateLegacyMemoryToDomain() {
    if (fs.existsSync(this.domainMemoryPath)) return;
    if (!fs.existsSync(this.visibleMemoryPath)) return;
    const legacy = this.readText(this.visibleMemoryPath, "").trim();
    if (!legacy) return;
    this.writeText(this.domainMemoryPath, legacy.endsWith("\n") ? legacy : `${legacy}\n`);
  }

  private readJson<T>(filePath: string, fallback: T): T {
    try {
      return JSON.parse(fs.readFileSync(filePath, "utf-8")) as T;
    } catch {
      return fallback;
    }
  }

  private writeJson(filePath: string, data: any) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const tmp = filePath + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2), "utf-8");
    fs.renameSync(tmp, filePath);
  }

  private readText(filePath: string, fallback: string) {
    try {
      return fs.readFileSync(filePath, "utf-8");
    } catch {
      return fallback;
    }
  }

  private writeText(filePath: string, content: string) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const tmp = filePath + ".tmp";
    fs.writeFileSync(tmp, content, "utf-8");
    fs.renameSync(tmp, filePath);
  }

  private resolveBuiltinPath(target: "memory" | "user" | "domain") {
    if (target === "user") return this.userMemoryPath;
    if (target === "domain") return this.domainMemoryPath;
    return this.visibleMemoryPath;
  }

  private readExternalMemoryRecords() {
    return this.readText(this.retrievalMemoryPath, "")
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        try {
          return parseExternalMemoryRecord(JSON.parse(line));
        } catch {
          return null;
        }
      })
      .filter((item): item is ExternalMemoryRecord => item !== null);
  }

  private rewriteExternalMemoryRecords(records: ExternalMemoryRecord[]) {
    const payload = records.map((record) => JSON.stringify(wrapExternalMemoryRecord(normalizeExternalMemoryRecord(record)))).join("\n");
    this.writeText(this.retrievalMemoryPath, payload ? `${payload}\n` : "");
  }

  private migrateLegacyRetrievalMemory() {
    if (!fs.existsSync(this.retrievalMemoryPath)) return;
    const content = this.readText(this.retrievalMemoryPath, "").trim();
    if (!content) return;

    const lines = content.split(/\r?\n/).filter(Boolean);
    const allJson = lines.every((line) => {
      try {
        JSON.parse(line);
        return true;
      } catch {
        return false;
      }
    });
    if (allJson) return;

    const legacyPath = `${this.retrievalMemoryPath}.legacy-${Date.now()}`;
    try {
      fs.renameSync(this.retrievalMemoryPath, legacyPath);
    } catch {
      return;
    }

    if (legacyPath.endsWith(".db")) {
      fs.writeFileSync(this.retrievalMemoryPath, "", "utf-8");
    }
  }
}

function rewriteMemoryDocument(
  current: string,
  input: { action: "add" | "replace" | "remove"; content: string; oldText?: string },
) {
  const normalized = current.trim();
  const lines = normalized ? normalized.split(/\r?\n/) : [];
  if (input.action === "add") {
    return [...lines, input.content].filter(Boolean).join("\n").trim() + "\n";
  }
  if (input.action === "replace" && input.oldText) {
    const replaced = current.includes(input.oldText)
      ? current.replace(input.oldText, input.content)
      : [...lines, input.content].filter(Boolean).join("\n");
    return replaced.trim() + "\n";
  }
  if (input.action === "remove" && input.oldText) {
    return current.replace(input.oldText, "").trim() + "\n";
  }
  return current.trim() + "\n";
}

function normalizeExternalMemoryRecord(record: ExternalMemoryRecord): ExternalMemoryRecord {
  return {
    ...record,
    schemaVersion: Number(record.schemaVersion || 1),
    keywords: dedupeStrings(record.keywords || []),
    topics: dedupeStrings(record.topics || []),
    userRepresentation: dedupeStrings(record.userRepresentation || []),
    userPeerCard: dedupeStrings(record.userPeerCard || []),
    aiRepresentation: dedupeStrings(record.aiRepresentation || []),
    aiIdentityCard: dedupeStrings(record.aiIdentityCard || []),
    importance: clamp(Number(record.importance || 0.5), 0.05, 1),
    decayProfile: record.decayProfile || "normal",
    accessCount: Number(record.accessCount || 0),
    signals: {
      hasExplicitMemoryWrite: Boolean(record.signals?.hasExplicitMemoryWrite),
      hasPreferenceSignal: Boolean(record.signals?.hasPreferenceSignal),
      hasDomainSignal: Boolean(record.signals?.hasDomainSignal),
      hasIdentitySignal: Boolean(record.signals?.hasIdentitySignal),
      hasPositiveFeedback: Boolean(record.signals?.hasPositiveFeedback),
    },
    metadata: record.metadata || {},
  };
}

function wrapExternalMemoryRecord(record: ExternalMemoryRecord) {
  return {
    recordType: "external_memory",
    ...record,
  };
}

function parseExternalMemoryRecord(value: unknown): ExternalMemoryRecord | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const source = String(record.source || "");
  if (!source) return null;

  if (record.recordType && record.recordType !== "external_memory") {
    return null;
  }

  return normalizeExternalMemoryRecord({
    schemaVersion: Number(record.schemaVersion || 1),
    id: String(record.id || `ext_${stableDigest(JSON.stringify(record))}`),
    source: source as ExternalMemorySource,
    memoryType: String(record.memoryType || "conversation_insight") as ExternalMemoryType,
    writtenAt: String(record.writtenAt || new Date().toISOString()),
    sessionId: String(record.sessionId || "unknown"),
    summary: String(record.summary || ""),
    userRepresentation: Array.isArray(record.userRepresentation) ? record.userRepresentation.map(String) : [],
    userPeerCard: Array.isArray(record.userPeerCard) ? record.userPeerCard.map(String) : [],
    aiRepresentation: Array.isArray(record.aiRepresentation) ? record.aiRepresentation.map(String) : [],
    aiIdentityCard: Array.isArray(record.aiIdentityCard) ? record.aiIdentityCard.map(String) : [],
    userInput: String(record.userInput || ""),
    assistantOutput: String(record.assistantOutput || ""),
    keywords: Array.isArray(record.keywords) ? record.keywords.map(String) : [],
    topics: Array.isArray(record.topics) ? record.topics.map(String) : [],
    importance: Number(record.importance || 0.5),
    decayProfile: String(record.decayProfile || "normal") as ExternalMemoryRecord["decayProfile"],
    lastAccessAt: typeof record.lastAccessAt === "string" ? record.lastAccessAt : undefined,
    accessCount: Number(record.accessCount || 0),
    metadata: record.metadata && typeof record.metadata === "object" ? record.metadata as Record<string, unknown> : {},
    signals: record.signals && typeof record.signals === "object"
      ? {
        hasExplicitMemoryWrite: Boolean((record.signals as Record<string, unknown>).hasExplicitMemoryWrite),
        hasPreferenceSignal: Boolean((record.signals as Record<string, unknown>).hasPreferenceSignal),
        hasDomainSignal: Boolean((record.signals as Record<string, unknown>).hasDomainSignal),
        hasIdentitySignal: Boolean((record.signals as Record<string, unknown>).hasIdentitySignal),
        hasPositiveFeedback: Boolean((record.signals as Record<string, unknown>).hasPositiveFeedback),
      }
      : {
        hasExplicitMemoryWrite: false,
        hasPreferenceSignal: false,
        hasDomainSignal: false,
        hasIdentitySignal: false,
        hasPositiveFeedback: false,
      },
  });
}

function tokenizeExternalQuery(query: string) {
  return dedupeStrings(tokenizeForEmbedding(query).filter((token) => token.length >= 2));
}

function scoreExternalMemoryRecord(record: ExternalMemoryRecord, tokens: string[]): ExternalMemorySearchHit {
  const haystack = [
    record.summary,
    record.userInput,
    record.assistantOutput,
    ...record.userRepresentation,
    ...record.userPeerCard,
    ...record.aiRepresentation,
    ...record.aiIdentityCard,
    ...record.keywords,
    ...record.topics,
  ].join("\n").toLowerCase();

  const lexicalScore = tokens.reduce((sum, token) => {
    let tokenScore = 0;
    if (haystack.includes(token)) tokenScore += 1.25;
    if (record.keywords.some((item) => item.toLowerCase() === token)) tokenScore += 2;
    if (record.topics.some((item) => item.toLowerCase().includes(token))) tokenScore += 1.5;
    return sum + tokenScore;
  }, 0);

  const importanceScore = record.importance * 6;
  const recencyScore = computeRecencyScore(record.writtenAt);
  const decayScore = computeDecayScore(record);
  const typeScore = record.memoryType === "explicit_memory_write" ? 2.5 : record.memoryType === "session_summary" ? 1.5 : 1;
  const score = lexicalScore + importanceScore + recencyScore + decayScore + typeScore;

  return {
    record,
    score: round(score),
    lexicalScore: round(lexicalScore),
    importanceScore: round(importanceScore),
    recencyScore: round(recencyScore),
    decayScore: round(decayScore),
  };
}

function externalMemorySimilarity(a: ExternalMemoryRecord, b: ExternalMemoryRecord) {
  if (a.id === b.id) return 1;
  const keywordOverlap = jaccard(a.keywords, b.keywords);
  const topicOverlap = jaccard(a.topics, b.topics);
  const summaryOverlap = jaccard(tokenizeForEmbedding(a.summary), tokenizeForEmbedding(b.summary));
  const signalOverlap = compareSignals(a.signals, b.signals);
  return round((keywordOverlap * 0.35) + (topicOverlap * 0.25) + (summaryOverlap * 0.3) + (signalOverlap * 0.1));
}

function selectPrimaryExternalMemory(cluster: ExternalMemoryRecord[]) {
  return [...cluster].sort((a, b) => {
    if (b.importance !== a.importance) return b.importance - a.importance;
    return b.writtenAt.localeCompare(a.writtenAt);
  })[0]!;
}

function compactExternalMemoryCluster(cluster: ExternalMemoryRecord[]): ExternalMemoryRecord {
  const primary = selectPrimaryExternalMemory(cluster);
  const mergedSummary = dedupeStrings(cluster.map((item) => item.summary)).slice(0, 3).join(" || ");
  const mergedUserRepresentation = dedupeStrings(cluster.flatMap((item) => item.userRepresentation)).slice(0, 6);
  const mergedPeerCard = dedupeStrings(cluster.flatMap((item) => item.userPeerCard)).slice(0, 6);
  const mergedAiRepresentation = dedupeStrings(cluster.flatMap((item) => item.aiRepresentation)).slice(0, 6);
  const mergedAiIdentityCard = dedupeStrings(cluster.flatMap((item) => item.aiIdentityCard)).slice(0, 4);
  const mergedKeywords = dedupeStrings(cluster.flatMap((item) => item.keywords)).slice(0, 24);
  const mergedTopics = dedupeStrings(cluster.flatMap((item) => item.topics)).slice(0, 10);
  const mergedSignals = cluster.reduce<ExternalMemoryRecord["signals"]>((acc, item) => ({
    hasExplicitMemoryWrite: acc.hasExplicitMemoryWrite || item.signals.hasExplicitMemoryWrite,
    hasPreferenceSignal: acc.hasPreferenceSignal || item.signals.hasPreferenceSignal,
    hasDomainSignal: acc.hasDomainSignal || item.signals.hasDomainSignal,
    hasIdentitySignal: acc.hasIdentitySignal || item.signals.hasIdentitySignal,
    hasPositiveFeedback: acc.hasPositiveFeedback || item.signals.hasPositiveFeedback,
  }), {
    hasExplicitMemoryWrite: false,
    hasPreferenceSignal: false,
    hasDomainSignal: false,
    hasIdentitySignal: false,
    hasPositiveFeedback: false,
  });

  return normalizeExternalMemoryRecord({
    ...primary,
    id: `ext_${stableDigest(`compact:${cluster.map((item) => item.id).join(":")}`)}`,
    summary: clipJoinedSummaries(mergedSummary, 360),
    userRepresentation: mergedUserRepresentation,
    userPeerCard: mergedPeerCard,
    aiRepresentation: mergedAiRepresentation,
    aiIdentityCard: mergedAiIdentityCard,
    keywords: mergedKeywords,
    topics: mergedTopics,
    importance: clamp(Math.max(...cluster.map((item) => item.importance)) + 0.05, 0.05, 1),
    decayProfile: primary.decayProfile === "sticky" ? "sticky" : "slow",
    writtenAt: primary.writtenAt,
    metadata: {
      ...(primary.metadata || {}),
      compactedFrom: cluster.map((item) => item.id),
      compactedCount: cluster.length,
    },
    signals: mergedSignals,
  });
}

function computeRecencyScore(writtenAt: string) {
  const ageDays = Math.max(0, (Date.now() - new Date(writtenAt).getTime()) / (24 * 60 * 60 * 1000));
  if (ageDays <= 1) return 2.5;
  if (ageDays <= 7) return 1.5;
  if (ageDays <= 30) return 0.8;
  return 0.2;
}

function computeDecayScore(record: ExternalMemoryRecord) {
  const ageDays = Math.max(0, (Date.now() - new Date(record.writtenAt).getTime()) / (24 * 60 * 60 * 1000));
  const halfLifeDays = record.decayProfile === "sticky"
    ? 365
    : record.decayProfile === "slow"
      ? 120
      : record.decayProfile === "normal"
        ? 45
        : 10;
  const retention = Math.exp((-Math.log(2) * ageDays) / Math.max(halfLifeDays, 1));
  return retention * 3;
}

function dedupeStrings(values: string[]) {
  return [...new Set(values.map((item) => String(item || "").trim()).filter(Boolean))];
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function round(value: number) {
  return Math.round(value * 1000) / 1000;
}

function jaccard(left: string[], right: string[]) {
  const a = new Set(left.map((item) => item.toLowerCase()));
  const b = new Set(right.map((item) => item.toLowerCase()));
  if (!a.size && !b.size) return 0;
  let intersection = 0;
  for (const value of a) {
    if (b.has(value)) intersection += 1;
  }
  const union = new Set([...a, ...b]).size;
  return union ? intersection / union : 0;
}

function compareSignals(
  left: ExternalMemoryRecord["signals"],
  right: ExternalMemoryRecord["signals"],
) {
  const keys: Array<keyof ExternalMemoryRecord["signals"]> = [
    "hasExplicitMemoryWrite",
    "hasPreferenceSignal",
    "hasDomainSignal",
    "hasIdentitySignal",
    "hasPositiveFeedback",
  ];
  let score = 0;
  for (const key of keys) {
    if (left[key] === right[key]) score += 1;
  }
  return score / keys.length;
}

function clipJoinedSummaries(text: string, maxChars: number) {
  const compact = text.replace(/\s+/g, " ").trim();
  if (compact.length <= maxChars) return compact;
  return `${compact.slice(0, Math.max(0, maxChars - 1))}…`;
}
