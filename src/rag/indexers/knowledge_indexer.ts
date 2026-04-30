/**
 * 知识图谱索引器
 *
 * 管理模式：chunk → keyword index → 检索
 * 支持增量更新（只重建变化的文档）。
 *
 * 存储格式为纯 JSON 文件，不依赖外部数据库。
 * 数据目录：rag/data/knowledge-index/
 */
import fs from "fs";
import path from "path";
import type { RagChunk, RagSearchResult, RagSearchOptions, RagStats } from "../types.js";
import { tokenizeForEmbedding } from "../../memory/utils.js";

export interface IndexerOptions {
  /** 索引目录 */
  indexPath?: string;
}

export class KnowledgeIndexer {
  readonly indexPath: string;

  /** chunks.id → RagChunk */
  private chunks = new Map<string, RagChunk>();
  /** keyword → chunk.id[] */
  private keywordIndex = new Map<string, string[]>();
  /** 文档维度统计 */
  private docChunkCount = new Map<string, number>();

  private indexed = false;

  constructor(options: IndexerOptions = {}) {
    this.indexPath = options.indexPath || path.resolve(
      process.cwd().replace(/\/dist$/, ""), "rag", "data", "knowledge-index"
    );
    fs.mkdirSync(this.indexPath, { recursive: true });
  }

  async index(
    newChunks: RagChunk[],
    onProgress?: (msg: string) => void,
  ): Promise<void> {
    let indexed = 0;
    const total = newChunks.length;

    for (const chunk of newChunks) {
      this.chunks.set(chunk.id, chunk);

      // 更新文档索引
      this.docChunkCount.set(
        chunk.docId,
        (this.docChunkCount.get(chunk.docId) || 0) + 1,
      );

      // 建立关键词索引
      const tokens = new Set([
        ...chunk.keywords,
        ...tokenizeForEmbedding(chunk.text),
      ]);
      for (const token of tokens) {
        if (!this.keywordIndex.has(token)) {
          this.keywordIndex.set(token, []);
        }
        this.keywordIndex.get(token)!.push(chunk.id);
      }

      indexed++;
      if (indexed % 20 === 0) {
        onProgress?.(`📇 索引 ${indexed}/${total}`);
      }
    }

    this.indexed = true;
    this.persist();

    onProgress?.(`📇 完成：${indexed} chunks 已索引`);
  }

  async search(options: RagSearchOptions): Promise<RagSearchResult[]> {
    if (!this.indexed) await this.load();

    const query = options.query.trim();
    if (!query) return [];

    const queryTokens = tokenizeForEmbedding(query);
    const scores = new Map<string, { keywordScore: number }>();

    for (const token of queryTokens) {
      const matchedChunks = this.keywordIndex.get(token) || [];
      for (const chunkId of matchedChunks) {
        const existing = scores.get(chunkId) || { keywordScore: 0 };
        existing.keywordScore += 1;
        scores.set(chunkId, existing);
      }
    }

    // 构建结果
    const results: RagSearchResult[] = [];
    for (const [chunkId, score] of scores) {
      const chunk = this.chunks.get(chunkId);
      if (!chunk) continue;
      if (options.tagFilter?.length && !options.tagFilter.some((t) => chunk.tags.includes(t))) continue;
      if (options.sourceFilter?.length) {
        // source 匹配
      }
      results.push({
        chunk,
        score: score.keywordScore,
        keywordScore: score.keywordScore,
      });
    }

    // 排序
    results.sort((a, b) => b.keywordScore - a.keywordScore);
    return results.slice(0, options.topK ?? 5);
  }

  async stats(): Promise<RagStats> {
    if (!this.indexed) await this.load();
    return {
      totalDocuments: this.docChunkCount.size,
      totalChunks: this.chunks.size,
      indexSize: this.keywordIndex.size,
      lastIndexedAt: this.lastIndexed(),
      sources: {},
    };
  }

  // ── 持久化 ──────────────────────────────────────────

  private persist() {
    fs.writeFileSync(
      path.join(this.indexPath, "chunks.json"),
      JSON.stringify([...this.chunks.values()], null, 2),
      "utf-8",
    );
    fs.writeFileSync(
      path.join(this.indexPath, "keywords.json"),
      JSON.stringify([...this.keywordIndex.entries()], null, 2),
      "utf-8",
    );
    fs.writeFileSync(
      path.join(this.indexPath, "meta.json"),
      JSON.stringify({
        lastIndexedAt: new Date().toISOString(),
        docChunkCount: [...this.docChunkCount.entries()],
        indexed: this.indexed,
      }, null, 2),
      "utf-8",
    );
  }

  private async load() {
    const chunksPath = path.join(this.indexPath, "chunks.json");
    const keywordsPath = path.join(this.indexPath, "keywords.json");

    if (fs.existsSync(chunksPath)) {
      const raw = JSON.parse(fs.readFileSync(chunksPath, "utf-8"));
      for (const chunk of raw) {
        this.chunks.set(chunk.id, chunk);
      }
    }
    if (fs.existsSync(keywordsPath)) {
      const raw = JSON.parse(fs.readFileSync(keywordsPath, "utf-8"));
      for (const [keyword, ids] of raw) {
        this.keywordIndex.set(keyword, ids);
      }
    }
    this.indexed = true;
  }

  private lastIndexed(): string | null {
    try {
      const meta = JSON.parse(
        fs.readFileSync(path.join(this.indexPath, "meta.json"), "utf-8"),
      );
      return meta.lastIndexedAt || null;
    } catch {
      return null;
    }
  }
}
