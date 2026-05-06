/**
 * RetrievalMemory — unified file-backed long-term memory store.
 *
 * Storage:
 * - A single JSONL file named `retrieval_memory.db`
 * - The file may contain both:
 *   1. retrieval records written by RetrievalMemory.append()
 *   2. external provider records written by ExternalFileMemoryProvider
 *
 * Why keep the `.db` suffix?
 * - We want one canonical runtime artifact path for long-term memory.
 * - The file format is JSONL for operability and debuggability, but the name
 *   stays stable so upper layers do not need to know the storage engine.
 */
import fs from "fs";
import path from "path";
import { stableDigest, tokenizeForEmbedding } from "../utils.js";
import type {
  ExternalMemoryRecord,
  RetrievalMemoryHit,
  RetrievalMemoryRecord,
} from "./types.js";
import { resolveUserHomePaths } from "../../home/index.js";
import { resolveSemanticAliases } from "./semantic_aliases.js";
import {
  embeddingSimilarity,
  HashEmbeddingProvider,
  type EmbeddingProvider,
} from "./embedding_provider.js";

export interface RetrievalMemoryOptions {
  jsonlPath?: string;
  dbPath?: string;
  topK?: number;
  searchMode?: "lexical" | "hybrid";
  cacheTtlMs?: number;
  cacheMaxEntries?: number;
  embeddingProvider?: EmbeddingProvider;
}

interface QueryCacheEntry {
  hits: RetrievalMemoryHit[];
  topK: number;
  version: number;
  expiresAt: number;
  lastAccessAt: number;
}

interface StoredRetrievalEntry {
  recordType: "retrieval_memory";
  record: RetrievalMemoryRecord & { embedding?: number[] };
}

interface StoredExternalEntry {
  recordType: "external_memory";
  id: string;
  source: string;
  memoryType: string;
  writtenAt: string;
  sessionId: string;
  summary: string;
  userRepresentation: string[];
  userPeerCard: string[];
  aiRepresentation: string[];
  aiIdentityCard: string[];
  userInput: string;
  assistantOutput: string;
  keywords: string[];
  topics: string[];
  importance: number;
  decayProfile: string;
  lastAccessAt?: string;
  accessCount?: number;
  metadata?: Record<string, unknown>;
  signals?: Record<string, unknown>;
}

type StoredEntry = StoredRetrievalEntry | StoredExternalEntry;

export class RetrievalMemory {
  readonly jsonlPath: string;
  readonly dbPath: string;
  readonly topK: number;
  readonly searchMode: "lexical" | "hybrid";
  readonly embeddingProvider: EmbeddingProvider;
  private initialized = false;
  private readonly cacheTtlMs: number;
  private readonly cacheMaxEntries: number;
  private cacheVersion = 0;
  private queryCache = new Map<string, QueryCacheEntry>();

  constructor(options: RetrievalMemoryOptions = {}) {
    const paths = resolveUserHomePaths();
    this.jsonlPath = options.jsonlPath || paths.retrievalMemoryPath;
    this.dbPath = options.dbPath || paths.retrievalDbPath;
    this.topK = options.topK ?? 4;
    this.searchMode = options.searchMode ?? "hybrid";
    this.embeddingProvider = options.embeddingProvider ?? new HashEmbeddingProvider();
    this.cacheTtlMs = options.cacheTtlMs ?? 5 * 60 * 1000;
    this.cacheMaxEntries = options.cacheMaxEntries ?? 256;
    fs.mkdirSync(path.dirname(this.dbPath), { recursive: true });
  }

  async init() {
    if (this.initialized) return;
    this.ensureStore();
    this.migrateLegacyJsonl();
    this.initialized = true;
  }

  async append(
    record: Omit<RetrievalMemoryRecord, "id" | "createdAt" | "keywords"> & { keywords?: string[] },
  ): Promise<RetrievalMemoryRecord> {
    await this.init();
    const id = `rm_${stableDigest(`${record.source}:${record.text}:${Date.now()}`)}`;
    const createdAt = new Date().toISOString();
    const normalized: RetrievalMemoryRecord & { embedding?: number[] } = {
      id,
      kind: record.kind,
      text: record.text,
      keywords: record.keywords || [],
      tags: record.tags || [],
      source: record.source,
      createdAt,
      metadata: record.metadata || {},
      embedding: await this.embeddingProvider.embed(buildEmbeddingSource(record.text, record.metadata || {})),
    };
    this.appendLine({
      recordType: "retrieval_memory",
      record: normalized,
    });
    this.bumpCacheVersion();
    return normalized;
  }

  getCached(query: string) {
    const normalized = normalizeQuery(query);
    const exact = this.readCacheEntry(cacheKey(normalized, this.topK));
    if (exact) return exact.hits;

    const fallback = [...this.queryCache.entries()]
      .filter(([key]) => key.startsWith(`${normalized}::`))
      .sort((a, b) => parseTopK(b[0]) - parseTopK(a[0]))[0];

    if (!fallback) return [];
    const entry = this.readCacheEntry(fallback[0]);
    return entry?.hits || [];
  }

  async warmQuery(query: string, topK: number = this.topK) {
    await this.init();
    const normalized = normalizeQuery(query);
    const hits = await this.searchInternal(query, topK);
    this.writeCacheEntry(cacheKey(normalized, topK), topK, hits);
    return hits;
  }

  async search(query: string, topK: number = this.topK) {
    await this.init();
    const normalized = normalizeQuery(query);
    const exactKey = cacheKey(normalized, topK);
    const exactEntry = this.readCacheEntry(exactKey);
    if (exactEntry) return exactEntry.hits;

    const broaderCached = [...this.queryCache.entries()]
      .filter(([key]) => key.startsWith(`${normalized}::`) && parseTopK(key) >= topK)
      .sort((a, b) => parseTopK(a[0]) - parseTopK(b[0]))[0];
    if (broaderCached) {
      const entry = this.readCacheEntry(broaderCached[0]);
      if (entry) return entry.hits.slice(0, topK);
    }

    const hits = await this.searchInternal(query, topK);
    this.writeCacheEntry(exactKey, topK, hits);
    return hits;
  }

  async searchByDate(datePrefix: string, limit: number = this.topK) {
    await this.init();
    return this.readSearchableRecords()
      .filter((record) => record.createdAt.startsWith(datePrefix))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, limit)
      .map(stripEmbedding);
  }

  async recent(limit: number = this.topK) {
    await this.init();
    return this.readSearchableRecords()
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, limit)
      .map(stripEmbedding);
  }

  async delete(id: string) {
    await this.init();
    const before = this.readStoredEntries();
    const filtered = before.filter((entry) => entryId(entry) !== id);
    if (filtered.length === before.length) return 0;
    this.rewriteStore(filtered);
    this.bumpCacheVersion();
    return before.length - filtered.length;
  }

  pruneExpiredCache(now: number = Date.now()) {
    let removed = 0;
    for (const [key, entry] of this.queryCache.entries()) {
      if (entry.version !== this.cacheVersion || entry.expiresAt <= now) {
        this.queryCache.delete(key);
        removed += 1;
      }
    }
    return removed;
  }

  getCacheStats() {
    return {
      size: this.queryCache.size,
      version: this.cacheVersion,
      ttlMs: this.cacheTtlMs,
      maxEntries: this.cacheMaxEntries,
    };
  }

  private async searchInternal(query: string, topK: number): Promise<RetrievalMemoryHit[]> {
    const tokens = tokenize(query);
    if (!tokens.length) return [];

    const records = this.readSearchableRecords();
    const queryFeatures = extractQueryFeatures(query);
    const exactMatches = records
      .filter((record) => hasExactMetadataMatch(queryFeatures, record))
      .map((record) => {
        const metadataScore = computeMetadataScore(queryFeatures, record) + 200;
        return {
          ...record,
          score: metadataScore,
          lexicalScore: 0,
          semanticScore: 0,
          metadataScore,
        } satisfies RetrievalMemoryHit;
      })
      .sort((a, b) => {
        if (b.score !== a.score) return b.score - a.score;
        return b.createdAt.localeCompare(a.createdAt);
      });

    if (exactMatches.length > 0 && (queryFeatures.anchorCode || queryFeatures.caseId)) {
      return exactMatches.slice(0, topK);
    }

    const candidateLimit = Math.min(Math.max(topK * 6, 24), 96);
    const queryEmbedding = this.searchMode === "hybrid"
      ? await this.embeddingProvider.embed(buildEmbeddingQuery(query, queryFeatures))
      : null;

    const scored = records
      .map((record) => {
        const lexicalScore = computeLexicalScore(record, tokens);
        const metadataScore = computeMetadataScore(queryFeatures, record);
        const recencyDays = daysAgo(record.createdAt);
        const recencyScore = recencyDays <= 1 ? 2 : recencyDays <= 7 ? 1 : 0;
        const semanticScore = queryEmbedding && record.embedding?.length
          ? computeSemanticScore(this.embeddingProvider, queryEmbedding, record.embedding, queryFeatures, record)
          : 0;
        const score = lexicalScore + recencyScore + metadataScore + semanticScore;
        return {
          ...record,
          score,
          lexicalScore,
          semanticScore,
          metadataScore,
        } satisfies RetrievalMemoryHit;
      })
      .filter((record) => record.score > 0)
      .sort((a, b) => {
        if (b.score !== a.score) return b.score - a.score;
        if ((b.metadataScore || 0) !== (a.metadataScore || 0)) return (b.metadataScore || 0) - (a.metadataScore || 0);
        if ((b.semanticScore || 0) !== (a.semanticScore || 0)) return (b.semanticScore || 0) - (a.semanticScore || 0);
        if ((b.lexicalScore || 0) !== (a.lexicalScore || 0)) return (b.lexicalScore || 0) - (a.lexicalScore || 0);
        return b.createdAt.localeCompare(a.createdAt);
      })
      .slice(0, candidateLimit);

    const merged = mergeUniqueHits([...exactMatches, ...scored]);
    return merged.slice(0, topK).map((record) => ({
      ...record,
      embedding: undefined,
    }));
  }

  private ensureStore() {
    if (fs.existsSync(this.dbPath)) return;
    fs.mkdirSync(path.dirname(this.dbPath), { recursive: true });
    fs.writeFileSync(this.dbPath, "", "utf-8");
  }

  private migrateLegacyJsonl() {
    if (!this.jsonlPath || this.jsonlPath === this.dbPath) return;
    if (!fs.existsSync(this.jsonlPath)) return;

    const legacyContent = fs.readFileSync(this.jsonlPath, "utf-8");
    if (legacyContent.trim()) {
      const current = fs.readFileSync(this.dbPath, "utf-8");
      const next = [current.trim(), legacyContent.trim()].filter(Boolean).join("\n");
      fs.writeFileSync(this.dbPath, next ? `${next}\n` : "", "utf-8");
    }
    fs.renameSync(this.jsonlPath, `${this.jsonlPath}.migrated`);
  }

  private readStoredEntries(): StoredEntry[] {
    return fs.readFileSync(this.dbPath, "utf-8")
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map(parseStoredEntry)
      .filter((entry): entry is StoredEntry => entry !== null);
  }

  private readSearchableRecords(): Array<RetrievalMemoryRecord & { embedding?: number[] }> {
    return this.readStoredEntries()
      .map(toSearchableRecord)
      .filter((entry): entry is RetrievalMemoryRecord & { embedding?: number[] } => entry !== null);
  }

  private appendLine(entry: StoredEntry) {
    fs.mkdirSync(path.dirname(this.dbPath), { recursive: true });
    fs.appendFileSync(this.dbPath, `${JSON.stringify(entry)}\n`, "utf-8");
  }

  private rewriteStore(entries: StoredEntry[]) {
    const payload = entries.map((entry) => JSON.stringify(entry)).join("\n");
    const tmp = `${this.dbPath}.tmp`;
    fs.writeFileSync(tmp, payload ? `${payload}\n` : "", "utf-8");
    fs.renameSync(tmp, this.dbPath);
  }

  private bumpCacheVersion() {
    this.cacheVersion += 1;
    this.queryCache.clear();
  }

  private readCacheEntry(key: string) {
    const entry = this.queryCache.get(key);
    if (!entry) return null;
    if (entry.version !== this.cacheVersion || entry.expiresAt <= Date.now()) {
      this.queryCache.delete(key);
      return null;
    }
    entry.lastAccessAt = Date.now();
    this.queryCache.delete(key);
    this.queryCache.set(key, entry);
    return entry;
  }

  private writeCacheEntry(key: string, topK: number, hits: RetrievalMemoryHit[]) {
    const now = Date.now();
    this.queryCache.delete(key);
    this.queryCache.set(key, {
      hits,
      topK,
      version: this.cacheVersion,
      expiresAt: now + this.cacheTtlMs,
      lastAccessAt: now,
    });
    this.evictCacheEntries();
  }

  private evictCacheEntries() {
    const now = Date.now();
    for (const [key, entry] of this.queryCache.entries()) {
      if (entry.version !== this.cacheVersion || entry.expiresAt <= now) {
        this.queryCache.delete(key);
      }
    }
    while (this.queryCache.size > this.cacheMaxEntries) {
      const oldestKey = this.queryCache.keys().next().value;
      if (!oldestKey) break;
      this.queryCache.delete(oldestKey);
    }
  }
}

interface QueryFeatures {
  normalized: string;
  tokens: string[];
  anchorCode?: string;
  caseId?: string;
}

function parseStoredEntry(line: string): StoredEntry | null {
  try {
    const parsed = JSON.parse(line) as Record<string, unknown>;
    if (parsed.recordType === "retrieval_memory" && parsed.record && typeof parsed.record === "object") {
      const record = normalizeRetrievalRecord(parsed.record as Record<string, unknown>);
      return record ? { recordType: "retrieval_memory", record } : null;
    }
    if (parsed.recordType === "external_memory" || isLegacyExternalRecord(parsed)) {
      return normalizeExternalEntry(parsed);
    }
    if (isLegacyRetrievalRecord(parsed)) {
      const record = normalizeRetrievalRecord(parsed);
      return record ? { recordType: "retrieval_memory", record } : null;
    }
    return null;
  } catch {
    return null;
  }
}

function normalizeRetrievalRecord(value: Record<string, unknown>): (RetrievalMemoryRecord & { embedding?: number[] }) | null {
  if (!value.id || !value.kind || !value.text) return null;
  return {
    id: String(value.id),
    kind: String(value.kind) as RetrievalMemoryRecord["kind"],
    text: String(value.text),
    keywords: Array.isArray(value.keywords) ? value.keywords.map(String) : [],
    tags: Array.isArray(value.tags) ? value.tags.map(String) : [],
    source: String(value.source || "retrieval-memory"),
    createdAt: String(value.createdAt || new Date().toISOString()),
    metadata: value.metadata && typeof value.metadata === "object" ? value.metadata as Record<string, any> : {},
    embedding: Array.isArray(value.embedding) ? value.embedding.map((item) => Number(item) || 0) : undefined,
  };
}

function normalizeExternalEntry(value: Record<string, unknown>): StoredExternalEntry | null {
  if (!value.id || !value.summary) return null;
  return {
    recordType: "external_memory",
    id: String(value.id),
    source: String(value.source || "sync_turn"),
    memoryType: String(value.memoryType || "conversation_insight"),
    writtenAt: String(value.writtenAt || new Date().toISOString()),
    sessionId: String(value.sessionId || "unknown"),
    summary: String(value.summary || ""),
    userRepresentation: Array.isArray(value.userRepresentation) ? value.userRepresentation.map(String) : [],
    userPeerCard: Array.isArray(value.userPeerCard) ? value.userPeerCard.map(String) : [],
    aiRepresentation: Array.isArray(value.aiRepresentation) ? value.aiRepresentation.map(String) : [],
    aiIdentityCard: Array.isArray(value.aiIdentityCard) ? value.aiIdentityCard.map(String) : [],
    userInput: String(value.userInput || ""),
    assistantOutput: String(value.assistantOutput || ""),
    keywords: Array.isArray(value.keywords) ? value.keywords.map(String) : [],
    topics: Array.isArray(value.topics) ? value.topics.map(String) : [],
    importance: clamp(Number(value.importance || 0.5), 0.05, 1),
    decayProfile: String(value.decayProfile || "normal"),
    lastAccessAt: typeof value.lastAccessAt === "string" ? value.lastAccessAt : undefined,
    accessCount: Number(value.accessCount || 0),
    metadata: value.metadata && typeof value.metadata === "object" ? value.metadata as Record<string, unknown> : {},
    signals: value.signals && typeof value.signals === "object" ? value.signals as Record<string, unknown> : {},
  };
}

function toSearchableRecord(entry: StoredEntry): (RetrievalMemoryRecord & { embedding?: number[] }) | null {
  if (entry.recordType === "retrieval_memory") return entry.record;

  const metadata = {
    ...(entry.metadata || {}),
    sessionId: entry.sessionId,
    memoryType: entry.memoryType,
    source: entry.source,
  };
  const text = [
    `summary: ${entry.summary}`,
    entry.userInput ? `user_input: ${entry.userInput}` : "",
    entry.assistantOutput ? `assistant_output: ${entry.assistantOutput}` : "",
    entry.userRepresentation.length ? `user_representation: ${entry.userRepresentation.join("；")}` : "",
    entry.userPeerCard.length ? `user_peer_card: ${entry.userPeerCard.join("；")}` : "",
    entry.aiRepresentation.length ? `ai_representation: ${entry.aiRepresentation.join("；")}` : "",
    entry.aiIdentityCard.length ? `ai_identity_card: ${entry.aiIdentityCard.join("；")}` : "",
    entry.topics.length ? `topics: ${entry.topics.join("、")}` : "",
  ].filter(Boolean).join("\n");

  return {
    id: entry.id,
    kind: mapExternalTypeToRetrievalKind(entry.memoryType),
    text,
    keywords: entry.keywords,
    tags: dedupeStrings([
      "external-memory",
      entry.memoryType,
      entry.source,
      ...entry.topics,
      ...entry.keywords,
    ]),
    source: `external:${entry.source}`,
    createdAt: entry.writtenAt,
    metadata,
    embedding: undefined,
  };
}

function stripEmbedding(record: RetrievalMemoryRecord & { embedding?: number[] }): RetrievalMemoryRecord {
  return {
    id: record.id,
    kind: record.kind,
    text: record.text,
    keywords: record.keywords,
    tags: record.tags,
    source: record.source,
    createdAt: record.createdAt,
    metadata: record.metadata,
  };
}

function mapExternalTypeToRetrievalKind(memoryType: string): RetrievalMemoryRecord["kind"] {
  if (memoryType === "explicit_memory_write") return "preference";
  if (memoryType === "session_summary") return "summary";
  return "best_try";
}

function isLegacyRetrievalRecord(value: Record<string, unknown>) {
  return Boolean(value.id && value.kind && value.text && value.createdAt);
}

function isLegacyExternalRecord(value: Record<string, unknown>) {
  return Boolean(value.id && value.summary && value.memoryType && value.writtenAt);
}

function entryId(entry: StoredEntry) {
  return entry.recordType === "retrieval_memory" ? entry.record.id : entry.id;
}

function extractQueryFeatures(query: string): QueryFeatures {
  const normalized = normalizeQuery(query);
  return {
    normalized,
    tokens: tokenize(query),
    anchorCode: normalized.match(/anchor-[a-z0-9-]+/)?.[0],
    caseId: normalized.match(/case-\d+/)?.[0],
  };
}

function hasExactMetadataMatch(features: QueryFeatures, record: RetrievalMemoryRecord) {
  const metadata = record.metadata || {};
  return Boolean(
    (features.caseId && String(metadata.caseId || "").toLowerCase() === features.caseId)
    || (features.anchorCode && String(metadata.anchorCode || "").toLowerCase() === features.anchorCode),
  );
}

function computeLexicalScore(record: RetrievalMemoryRecord, tokens: string[]) {
  const haystack = [record.text, ...record.tags, ...record.keywords].join("\n").toLowerCase();
  return tokens.reduce((sum, token) => {
    if (!token) return sum;
    let tokenScore = 0;
    if (record.text.toLowerCase().includes(token)) tokenScore += 1;
    if (record.tags.some((tag) => tag.toLowerCase().includes(token))) tokenScore += 2;
    if (record.keywords.some((keyword) => keyword.toLowerCase().includes(token))) tokenScore += 1.5;
    return sum + tokenScore;
  }, 0);
}

function computeMetadataScore(features: QueryFeatures, record: RetrievalMemoryRecord) {
  const metadata = record.metadata || {};
  const normalizedText = record.text.toLowerCase();
  let score = 0;

  if (features.caseId && String(metadata.caseId || "").toLowerCase() === features.caseId) score += 120;
  if (features.anchorCode && String(metadata.anchorCode || "").toLowerCase() === features.anchorCode) score += 90;
  if (features.anchorCode && normalizedText.includes(features.anchorCode)) score += 36;

  score += exactFieldBoost(features.normalized, metadata.petType, 8);
  score += exactFieldBoost(features.normalized, metadata.petName, 12);
  score += exactFieldBoost(features.normalized, metadata.ageLabel, 6);
  score += exactFieldBoost(features.normalized, metadata.symptom, 18);
  score += exactFieldBoost(features.normalized, metadata.anchorTheme, 16);
  score += exactFieldBoost(features.normalized, metadata.anchorDetail, 22);
  score += tokenCoverageBoost(features.tokens, metadata, normalizedText);

  if (metadata.memoryType === "explicit_memory_write") score += 8;
  if (metadata.memoryType === "session_summary") score += 4;

  return score;
}

function computeSemanticScore(
  embeddingProvider: EmbeddingProvider,
  queryEmbedding: number[],
  recordEmbedding: number[],
  features: QueryFeatures,
  record: RetrievalMemoryRecord,
) {
  const similarity = embeddingSimilarity(embeddingProvider, queryEmbedding, recordEmbedding);
  if (!Number.isFinite(similarity) || similarity <= 0) return 0;

  let boost = similarity * 24;
  const metadata = record.metadata || {};
  if (features.anchorCode && String(metadata.anchorCode || "").toLowerCase() === features.anchorCode) boost += 12;
  if (features.caseId && String(metadata.caseId || "").toLowerCase() === features.caseId) boost += 16;
  return boost;
}

function exactFieldBoost(normalizedQuery: string, value: unknown, weight: number) {
  const text = String(value || "").trim().toLowerCase();
  if (!text) return 0;
  return normalizedQuery.includes(text) ? weight : 0;
}

function tokenCoverageBoost(features: string[], metadata: Record<string, unknown>, normalizedText: string) {
  if (!features.length) return 0;

  const focusedValues = [
    metadata.petType,
    metadata.petName,
    metadata.ageLabel,
    metadata.symptom,
    metadata.anchorTheme,
    metadata.anchorDetail,
  ]
    .map((value) => String(value || "").trim().toLowerCase())
    .filter(Boolean);

  let score = 0;
  for (const token of features) {
    if (token.length < 2) continue;
    if (focusedValues.some((value) => value.includes(token))) {
      score += 2;
      continue;
    }
    if (normalizedText.includes(token)) {
      score += 0.5;
    }
  }
  return score;
}

function mergeUniqueHits(hits: RetrievalMemoryHit[]) {
  const merged: RetrievalMemoryHit[] = [];
  const seen = new Set<string>();
  for (const hit of hits) {
    if (seen.has(hit.id)) continue;
    seen.add(hit.id);
    merged.push(hit);
  }
  return merged;
}

function buildEmbeddingSource(text: string, metadata: Record<string, unknown>) {
  return [
    text,
    metadata.petType,
    metadata.petName,
    metadata.ageLabel,
    metadata.symptom,
    metadata.anchorTheme,
    metadata.anchorDetail,
    metadata.domainLabel,
  ]
    .map((item) => String(item || "").trim())
    .filter(Boolean)
    .join("\n");
}

function buildEmbeddingQuery(query: string, features: QueryFeatures) {
  return [
    query,
    features.anchorCode || "",
    features.caseId || "",
    ...features.tokens.slice(0, 24),
  ].filter(Boolean).join("\n");
}

function tokenize(text: string) {
  return [...new Set([
    ...tokenizeForEmbedding(text),
    ...semanticPhraseTokens(text),
  ])];
}

function semanticPhraseTokens(input: string) {
  const normalized = input.trim().toLowerCase();
  if (!normalized) return [] as string[];

  const tokens = new Set<string>();
  const latinBlocks = normalized.match(/[a-z0-9_]+/g) || [];
  for (const token of latinBlocks) {
    if (token.length >= 2) tokens.add(token);
  }

  const hanBlocks = normalized.match(/[\u4e00-\u9fff]{2,}/g) || [];
  for (const block of hanBlocks) {
    tokens.add(block);
    for (let size = 2; size <= Math.min(4, block.length); size += 1) {
      for (let index = 0; index <= block.length - size; index += 1) {
        tokens.add(block.slice(index, index + size));
      }
    }
  }

  for (const token of [...tokens]) {
    for (const alias of resolveSemanticAliases(token)) {
      tokens.add(alias);
    }
  }

  return [...tokens];
}

function daysAgo(iso: string): number {
  const ms = Date.now() - new Date(iso).getTime();
  return ms / (24 * 60 * 60 * 1000);
}

function normalizeQuery(query: string) {
  return query.trim().toLowerCase();
}

function cacheKey(normalizedQuery: string, topK: number) {
  return `${normalizedQuery}::${topK}`;
}

function parseTopK(key: string) {
  const value = Number(key.split("::").pop() || 0);
  return Number.isFinite(value) ? value : 0;
}

function dedupeStrings(values: string[]) {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values.map((item) => item.trim()).filter(Boolean)) {
    const key = value.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(value);
  }
  return result;
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}
