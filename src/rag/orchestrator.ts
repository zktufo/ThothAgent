/**
 * RAG Orchestrator — 编排加载→分块→建索引→检索全流程
 *
 * 对外暴露的 API：
 * - build()   → 加载源文档 → 分块 → 建索引
 * - search()  → 混合检索（关键词 + 可选向量）
 * - stats()   → 知识库统计
 */
import type { RagDocument, RagChunk, RagSearchResult, RagSearchOptions, RagStats } from "./types.js";
import { SourceLoader } from "./loaders/source_loader.js";
import { RecursiveChunker } from "./chunkers/recursive_chunker.js";
import { KnowledgeIndexer } from "./indexers/knowledge_indexer.js";

export interface RagOrchestratorOptions {
  knowledgeDir?: string;
  indexPath?: string;
  chunkSize?: number;
  chunkOverlap?: number;
}

export class PetRag {
  private loader: SourceLoader;
  private chunker: RecursiveChunker;
  private indexer: KnowledgeIndexer;
  private ready = false;

  constructor(options: RagOrchestratorOptions = {}) {
    this.loader = new SourceLoader({ knowledgeDir: options.knowledgeDir });
    this.chunker = new RecursiveChunker({
      chunkSize: options.chunkSize ?? 512,
      chunkOverlap: options.chunkOverlap ?? 48,
    });
    this.indexer = new KnowledgeIndexer({ indexPath: options.indexPath });
  }

  /**
   * 构建/重建知识库索引
   * 1. 加载源文档
   * 2. 分块
   * 3. 建索引
   */
  async build(onProgress?: (msg: string) => void): Promise<{
    documents: number;
    chunks: number;
  }> {
    onProgress?.("📖 加载源文档...");
    const docs = await this.loader.loadAll(onProgress);
    onProgress?.(`📖 加载完成：${docs.length} 个文档`);

    onProgress?.("🔪 分块处理...");
    const chunks = await this.chunker.chunk(docs, onProgress);
    onProgress?.(`🔪 分块完成：${chunks.length} 个 chunks`);

    onProgress?.("📇 建索引...");
    await this.indexer.index(chunks, onProgress);

    this.ready = true;
    return { documents: docs.length, chunks: chunks.length };
  }

  /**
   * 检索知识库
   */
  async search(options: RagSearchOptions): Promise<RagSearchResult[]> {
    if (!this.ready) await this.build();
    return this.indexer.search(options);
  }

  /**
   * 格式化检索结果为 LLM 可读文本
   */
  formatResults(results: RagSearchResult[], query: string): string {
    if (!results.length) return "";

    const sections = results.map((r, i) => {
      const source = r.chunk.source ? `（来源：${r.chunk.source}）` : "";
      const tags = r.chunk.tags.length
        ? ` [${r.chunk.tags.join(", ")}]`
        : "";
      return [
        `[${i + 1}]${tags} ${source}`,
        r.chunk.text,
      ].join("\n");
    });

    return [
      "<pet-knowledge>",
      "",
      `查询: ${query}`,
      `匹配 ${results.length} 条相关知识`,
      "",
      ...sections,
      "",
      "</pet-knowledge>",
    ].join("\n");
  }

  async stats(): Promise<RagStats> {
    return this.indexer.stats();
  }

  get isReady() {
    return this.ready;
  }
}

/** 单例 */
export let petRag: PetRag;
export function initPetRag(options?: RagOrchestratorOptions): PetRag {
  if (!petRag) petRag = new PetRag(options);
  return petRag;
}
