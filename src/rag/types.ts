/**
 * RAG 系统类型定义
 *
 * 完全独立于 memory 层，专注宠物领域知识库。
 * 数据源：PDF/HTML/图片/Markdown 等文档。
 * 流程：加载 → 分块 → 向量化(可选) → 建索引 → 检索 → 重排序
 */

/** 文档来源类型 */
export type DocumentSource = "markdown" | "pdf" | "html" | "image" | "structured" | "web";

/** 原始文档 */
export interface RagDocument {
  id: string;
  source: DocumentSource;
  /** 文档标题 */
  title: string;
  /** 原始内容 */
  content: string;
  /** 元数据 */
  metadata: Record<string, any>;
    /** 导入时间 */
  importedAt: string;
}

export interface RagImportOptions {
  /** 是否强制重建索引 */
  force?: boolean;
  /** 导入进度回调 */
  onProgress?: (msg: string) => void;
}

/** 分块后的文本片段 */
export interface RagChunk {
  id: string;
  docId: string;
  /** 块序号 */
  chunkIndex: number;
  /** 块文本 */
  text: string;
  /** 在该 chunk 中的起始/结束偏移 */
  startOffset: number;
  endOffset: number;
  /** 摘要（可选，用于检索预览） */
  summary?: string;
  /** 关键词（从文本提取） */
  keywords: string[];
  /** 向量化后的 embedding（可选，仅为性能优化） */
  embedding?: number[];
  /** 该 chunk 的标签/分类 */
  tags: string[];
  /** 来源引用 */
  source: string;
}

/** 检索结果 */
export interface RagSearchResult {
  chunk: RagChunk;
  /** 混合检索的综合得分 */
  score: number;
  /** 关键词匹配得分 */
  keywordScore: number;
  /** 向量匹配得分（如果启用） */
  vectorScore?: number;
  /** 重排序后的最终排序 */
  rank?: number;
}

/** 检索选项 */
export interface RagSearchOptions {
  query: string;
  topK?: number;
  /** 启用语义搜索（需要 embedding 模型） */
  useSemantic?: boolean;
  /** 启用 reranker */
  useReranker?: boolean;
  /** 按来源过滤 */
  sourceFilter?: DocumentSource[];
  /** 按标签过滤 */
  tagFilter?: string[];
}

/** 导入进度回调 */
export interface RagImportProgress {
  total: number;
  current: number;
  stage: "loading" | "chunking" | "indexing";
  message: string;
}

/** RAG 知识库统计 */
export interface RagStats {
  totalDocuments: number;
  totalChunks: number;
  indexSize: number;
  lastIndexedAt: string | null;
  sources: Record<string, number>;
}

/** 加载器接口 */
export interface DocumentLoader {
  name: string;
  supportedSources: DocumentSource[];
  load(path: string, onProgress?: (msg: string) => void): Promise<RagDocument[]>;
}

/** 分块器接口 */
export interface Chunker {
  name: string;
  chunk(documents: RagDocument[], onProgress?: (msg: string) => void): Promise<RagChunk[]>;
}

/** 索引器接口 */
export interface Indexer {
  name: string;
  index(chunks: RagChunk[], onProgress?: (msg: string) => void): Promise<void>;
  search(options: RagSearchOptions): Promise<RagSearchResult[]>;
  stats(): Promise<RagStats>;
}

/** 重排序器接口 */
export interface Reranker {
  name: string;
  rerank(query: string, results: RagSearchResult[], topK: number): Promise<RagSearchResult[]>;
}
