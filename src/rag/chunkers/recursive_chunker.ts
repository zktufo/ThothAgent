/**
 * 文本分块器
 *
 * 采用 RecursiveCharacterTextSplit 策略：
 * 优先按自然边界分割（段落 → 句子 → 子句），
 * 逐步降低分隔符粒度直到符合 chunk_size。
 *
 * 参考 LangChain 的 RecursiveCharacterTextSplitter 思路，
 * 但无外部依赖。
 */
import type { RagDocument, RagChunk } from "../types.js";

export interface ChunkerOptions {
  /** 每块最大字符数 */
  chunkSize?: number;
  /** 块间重叠字符数 */
  chunkOverlap?: number;
}

/** 分级分隔符（从粗到细） */
const SEPARATORS = [
  "\n## ",    // 二级标题
  "\n### ",   // 三级标题
  "\n\n",     // 空行/段落
  "\n",       // 换行
  ". ",       // 句号
  "。",       // 中文句号
  "！",       // 感叹号
  "？",       // 问号
  "；",       // 分号
  ", ",       // 英文逗号
  "，",       // 中文逗号
  " ",        // 空格（最后手段）
];

export class RecursiveChunker {
  readonly chunkSize: number;
  readonly chunkOverlap: number;

  constructor(options: ChunkerOptions = {}) {
    this.chunkSize = options.chunkSize ?? 512;
    this.chunkOverlap = options.chunkOverlap ?? 48;
  }

  async chunk(
    documents: RagDocument[],
    onProgress?: (msg: string) => void,
  ): Promise<RagChunk[]> {
    const allChunks: RagChunk[] = [];
    let docIndex = 0;

    for (const doc of documents) {
      const chunks = this.chunkDocument(doc, docIndex);
      allChunks.push(...chunks);
      docIndex++;
      onProgress?.(`🔪 ${doc.title} → ${chunks.length} chunks`);
    }

    return allChunks;
  }

  private chunkDocument(doc: RagDocument, docIndex: number): RagChunk[] {
    // 先按标题分大段
    const sections = this.splitByHeaders(doc.content);
    const chunks: RagChunk[] = [];
    let chunkIndex = 0;

    for (const section of sections) {
      // 每个大段再递归分块
      const sectionChunks = this.recursiveSplit(section.text, doc.title);
      for (const text of sectionChunks) {
        const keywords = this.extractKeywords(text);
        chunks.push({
          id: `chunk_${docIndex}_${chunkIndex}`,
          docId: doc.id,
          chunkIndex,
          text,
          startOffset: 0,
          endOffset: text.length,
          keywords,
          tags: [...section.tags],
          source: doc.metadata?.fileName || doc.title,
        });
        chunkIndex++;
      }
    }

    return chunks;
  }

  /**
   * 按 ## / ### 标题拆分
   */
  private splitByHeaders(
    content: string,
  ): Array<{ text: string; tags: string[] }> {
    const sections: Array<{ text: string; tags: string[] }> = [];
    const headerRegex = /^(#{2,4})\s+(.+)$/gm;
    let lastIndex = 0;
    let lastTags: string[] = [];

    let match: RegExpExecArray | null;
    while ((match = headerRegex.exec(content)) !== null) {
      // 保存上一个小节
      if (match.index > 0) {
        const text = content.slice(lastIndex, match.index).trim();
        if (text) {
          sections.push({ text, tags: [...lastTags] });
        }
      }
      lastIndex = match.index;
      lastTags = [match[2].trim()]; // 标题内容作为 tag
    }

    // 最后一段
    const remaining = content.slice(lastIndex).trim();
    if (remaining) {
      sections.push({ text: remaining, tags: [...lastTags] });
    }

    // 如果没有任何标题，整篇作为一段
    if (sections.length === 0 && content.trim()) {
      sections.push({ text: content.trim(), tags: [] });
    }

    return sections;
  }

  /**
   * RecursiveCharacterTextSplit 的核心
   * 逐步降低分隔符粒度
   */
  private recursiveSplit(text: string, source: string): string[] {
    if (text.length <= this.chunkSize) {
      return [text];
    }

    // 尝试当前层级分隔符
    for (const separator of SEPARATORS) {
      const parts = this.splitBySeparator(text, separator);
      if (parts.length > 1) {
        // 合并小的 fragments，超过 chunk_size 的递归拆分
        return this.mergeParts(parts, source);
      }
    }

    // 最后手段：按字符硬切
    return this.hardSplit(text, source);
  }

  private splitBySeparator(text: string, separator: string): string[] {
    const parts: string[] = [];
    let start = 0;
    while (start < text.length) {
      const idx = text.indexOf(separator, start + 1);
      if (idx === -1) {
        parts.push(text.slice(start).trim());
        break;
      }
      parts.push(text.slice(start, idx + separator.length).trim());
      start = idx + separator.length;
    }
    return parts.filter(Boolean);
  }

  private mergeParts(parts: string[], source: string): string[] {
    const merged: string[] = [];
    let current = "";

    for (const part of parts) {
      if (!current) {
        current = part;
      } else if ((current.length + part.length) <= this.chunkSize) {
        current += "\n" + part;
      } else {
        merged.push(current);
        // 带重叠
        current = this.applyOverlap(current, part);
      }
    }

    if (current) merged.push(current);
    return merged;
  }

  private applyOverlap(previous: string, next: string): string {
    // 取上一块的尾部作为 overlap
    const overlapLen = Math.min(this.chunkOverlap, previous.length);
    const tail = previous.slice(-overlapLen);
    const boundary = tail.search(/[.。!！?？\n]/);
    if (boundary > 0) {
      return tail.slice(boundary + 1).trimStart() + "\n" + next;
    }
    return tail + "\n" + next;
  }

  private hardSplit(text: string, source: string): string[] {
    const chunks: string[] = [];
    for (let i = 0; i < text.length; i += this.chunkSize) {
      const chunk = text.slice(i, i + this.chunkSize);
      if (chunk.trim()) chunks.push(chunk.trim());
    }
    return chunks;
  }

  /** 提取关键词（去重） */
  private extractKeywords(text: string): string[] {
    const words = text
      .toLowerCase()
      .replace(/[#*`_>|()[\]{}]/g, " ")
      .split(/\s+/)
      .filter((w) => w.length >= 2 && !STOP_WORDS.has(w));
    return [...new Set(words)].slice(0, 20);
  }
}

const STOP_WORDS = new Set([
  "the", "a", "an", "is", "are", "was", "were", "be", "been", "being",
  "have", "has", "had", "do", "does", "did", "will", "would", "could",
  "should", "may", "can", "shall", "to", "of", "in", "for", "on", "with",
  "at", "by", "from", "as", "into", "through", "during", "before", "after",
  "above", "below", "between", "and", "but", "or", "nor", "not", "so",
  "yet", "both", "either", "neither", "each", "every", "all", "any",
  "few", "more", "most", "other", "some", "such", "no", "only", "own",
  "same", "very", "just", "also", "than", "that", "this", "these", "those",
  "i", "me", "my", "myself", "we", "our", "ours", "ourselves",
  "you", "your", "yours", "yourself", "yourselves",
  "he", "him", "his", "himself", "she", "her", "hers", "herself",
  "it", "its", "itself", "they", "them", "their", "theirs", "themselves",
  "what", "which", "who", "whom", "whose", "when", "where", "why", "how",
  "的", "了", "在", "是", "我", "有", "和", "就", "不", "人", "都", "一",
  "一个", "上", "也", "很", "到", "说", "要", "去", "你", "会", "着",
  "没有", "看", "好", "自己", "这", "他", "她", "它", "们", "那", "些",
]);
