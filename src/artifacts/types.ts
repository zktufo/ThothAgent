export interface CreateArtifactInput {
  type: string;
  contentType?: string;
  content?: string | null;
  filePath?: string | null;
  sizeBytes?: number;
  createdAt?: string;
  metadata?: Record<string, unknown>;
}

export interface ArtifactThresholdPolicy {
  inlineMaxChars: number;
  trimAfterDays: number;
  trimMinBytes: number;
}
