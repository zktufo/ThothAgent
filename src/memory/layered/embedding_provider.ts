import { buildHashEmbedding, cosineSimilarity } from "../utils.js";

export interface EmbeddingProvider {
  readonly name: string;
  embed(text: string): Promise<number[]>;
  similarity?(queryEmbedding: number[], recordEmbedding: number[]): number;
}

export class HashEmbeddingProvider implements EmbeddingProvider {
  readonly name = "hash-local";

  async embed(text: string): Promise<number[]> {
    return buildHashEmbedding(text);
  }

  similarity(queryEmbedding: number[], recordEmbedding: number[]) {
    return cosineSimilarity(queryEmbedding, recordEmbedding);
  }
}

export function embeddingSimilarity(
  provider: EmbeddingProvider,
  queryEmbedding: number[],
  recordEmbedding: number[],
) {
  if (typeof provider.similarity === "function") {
    return provider.similarity(queryEmbedding, recordEmbedding);
  }
  return cosineSimilarity(queryEmbedding, recordEmbedding);
}
