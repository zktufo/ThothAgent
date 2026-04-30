/**
 * RetrievalMemory is the MVP long-term memory store.
 *
 * This first version intentionally uses JSONL + keyword scoring:
 * - cheap to inspect
 * - easy to migrate
 * - good enough to validate the layered lifecycle
 *
 * When needed, the inside of this class can later be swapped for SQLite FTS
 * or embedding search without changing the rest of the app.
 */
import fs from "fs";
import path from "path";
import { cosineSimilarity, stableDigest, tokenizeForEmbedding } from "../utils.js";
import type { RetrievalMemoryHit, RetrievalMemoryRecord } from "./types.js";
import { resolveUserHomePaths } from "../../home/index.js";
import { resolveSemanticAliases } from "./semantic_aliases.js";

export interface RetrievalMemoryOptions {
  filePath?: string;
  topK?: number;
}

export class RetrievalMemory {
  readonly filePath: string;
  readonly topK: number;
  private initialized = false;
  private records: RetrievalMemoryRecord[] = [];
  private queryCache = new Map<string, RetrievalMemoryHit[]>();

  constructor(options: RetrievalMemoryOptions = {}) {
    this.filePath = options.filePath || resolveUserHomePaths().retrievalMemoryPath;
    this.topK = options.topK ?? 4;
  }

  async init() {
    if (this.initialized) return;
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    if (!fs.existsSync(this.filePath)) fs.writeFileSync(this.filePath, "", "utf-8");
    this.records = this.loadAll();
    this.initialized = true;
  }

  async append(record: Omit<RetrievalMemoryRecord, "id" | "createdAt" | "keywords"> & { keywords?: string[] }) {
    await this.init();
    const keywords = record.keywords?.length ? record.keywords : tokenize(record.text);
    const next: RetrievalMemoryRecord = {
      ...record,
      id: `rm_${stableDigest(`${record.source}:${record.text}:${Date.now()}`)}`,
      createdAt: new Date().toISOString(),
      keywords,
      embedding: record.embedding?.length ? record.embedding : buildSemanticEmbedding(record.text, keywords),
    };
    fs.appendFileSync(this.filePath, `${JSON.stringify(next)}\n`, "utf-8");
    this.records.push(next);
    this.queryCache.clear();
    return next;
  }

  getCached(query: string) {
    return this.queryCache.get(normalizeQuery(query)) || [];
  }

  async warmQuery(query: string, topK: number = this.topK) {
    // queuePrefetch uses this path so the next turn can hit cache instead of recomputing retrieval.
    await this.init();
    const normalized = normalizeQuery(query);
    const hits = this.searchInternal(query, topK);
    this.queryCache.set(normalized, hits);
    return hits;
  }

  async search(query: string, topK: number = this.topK) {
    await this.init();
    const normalized = normalizeQuery(query);
    if (this.queryCache.has(normalized)) return this.queryCache.get(normalized)!;
    const hits = this.searchInternal(query, topK);
    this.queryCache.set(normalized, hits);
    return hits;
  }

  async recent(limit: number = this.topK) {
    await this.init();
    return [...this.records]
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, limit);
  }

  private searchInternal(query: string, topK: number) {
    // Hybrid retrieval:
    // 1. keyword/tag overlap does a cheap coarse filter
    // 2. local semantic embedding reranks the shortlist
    const queryTokens = tokenize(query);
    const queryEmbedding = buildSemanticEmbedding(query, queryTokens);
    if (!queryTokens.length) return [] as RetrievalMemoryHit[];

    const lexicalCandidates = this.records
      .map((record) => ({
        record,
        lexicalScore: keywordScore(queryTokens, record),
      }))
      .filter((item) => item.lexicalScore > 0)
      .sort((a, b) => {
        if (b.lexicalScore !== a.lexicalScore) return b.lexicalScore - a.lexicalScore;
        return b.record.createdAt.localeCompare(a.record.createdAt);
      })
      .slice(0, Math.max(topK * 8, 12));

    const candidateRecords = lexicalCandidates.length
      ? lexicalCandidates
      : this.records.map((record) => ({ record, lexicalScore: 0 }));

    return candidateRecords
      .map(({ record, lexicalScore }) => {
        const semanticScore = cosineSimilarity(queryEmbedding, record.embedding || buildSemanticEmbedding(record.text, record.keywords));
        const recencyScore = recencyBoost(record.createdAt);
        return {
          ...record,
          lexicalScore,
          semanticScore,
          score: (lexicalScore * 0.7) + (semanticScore * 4.5) + recencyScore,
        } satisfies RetrievalMemoryHit;
      })
      .filter((record) => record.lexicalScore > 0 || record.semanticScore > 0.18)
      .sort((a, b) => {
        if (b.score !== a.score) return b.score - a.score;
        return b.createdAt.localeCompare(a.createdAt);
      })
      .slice(0, topK);
  }

  private loadAll() {
    try {
      return fs.readFileSync(this.filePath, "utf-8")
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => hydrateRecord(JSON.parse(line) as RetrievalMemoryRecord));
    } catch {
      return [] as RetrievalMemoryRecord[];
    }
  }
}

function tokenize(text: string) {
  return [...new Set([
    ...tokenizeForEmbedding(text),
    ...semanticPhraseTokens(text),
  ])];
}

function keywordScore(queryTokens: string[], record: RetrievalMemoryRecord) {
  const keywordSet = new Set(record.keywords);
  let score = 0;
  for (const token of queryTokens) {
    if (keywordSet.has(token)) score += 3;
    if (record.text.includes(token)) score += 1;
    if (record.tags.some((tag) => tag.includes(token))) score += 2;
  }
  return score;
}

function normalizeQuery(query: string) {
  return query.trim().toLowerCase();
}

function hydrateRecord(record: RetrievalMemoryRecord): RetrievalMemoryRecord {
  const keywords = record.keywords?.length ? record.keywords : tokenize(record.text);
  return {
    ...record,
    keywords,
    embedding: record.embedding?.length ? record.embedding : buildSemanticEmbedding(record.text, keywords),
  };
}

function buildSemanticEmbedding(text: string, keywords?: string[], dimensions: number = 192) {
  const vector = new Array<number>(dimensions).fill(0);
  const tokens = keywords?.length ? keywords : tokenize(text);
  if (!tokens.length) return vector;

  for (const token of tokens) {
    const hash = stableDigest(token);
    for (let i = 0; i < 6; i += 1) {
      const offset = i * 8;
      const bucket = parseInt(hash.slice(offset, offset + 8), 16) % dimensions;
      const sign = parseInt(hash.slice(offset + 8, offset + 10), 16) % 2 === 0 ? 1 : -1;
      vector[bucket] += sign * (1 / (i + 1));
    }
  }

  const magnitude = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
  if (!magnitude) return vector;
  return vector.map((value) => value / magnitude);
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

function recencyBoost(createdAt: string) {
  const ageMs = Math.max(0, Date.now() - new Date(createdAt).getTime());
  const ageDays = ageMs / (24 * 60 * 60 * 1000);
  return Math.max(0, 0.4 - (ageDays * 0.02));
}
