import type { DatabaseSync } from "node:sqlite";
import crypto from "node:crypto";
import type { CreateArtifactInput } from "./types.js";
import type { SessionArtifactRecord } from "../session/types.js";

/**
 * ArtifactStore keeps bulky tool outputs out of the prompt-facing message table.
 *
 * For MVP we store artifact payloads in SQLite directly. The `file_path` column is
 * left available for a later filesystem/blob-store strategy.
 */
export class ArtifactStore {
  constructor(private db: DatabaseSync) {}

  async createArtifact(input: CreateArtifactInput): Promise<SessionArtifactRecord> {
    const record: SessionArtifactRecord = {
      id: crypto.randomUUID(),
      type: input.type,
      contentType: input.contentType ?? "text/plain",
      content: input.content ?? null,
      filePath: input.filePath ?? null,
      sizeBytes: input.sizeBytes ?? estimateBytes(input.content ?? ""),
      createdAt: input.createdAt ?? new Date().toISOString(),
      metadata: input.metadata ?? {},
    };

    this.db.prepare(`
      INSERT INTO artifacts (
        id, type, content_type, content, file_path, size_bytes, created_at, metadata_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      record.id,
      record.type,
      record.contentType ?? null,
      record.content ?? null,
      record.filePath ?? null,
      record.sizeBytes,
      record.createdAt,
      JSON.stringify(record.metadata),
    );

    return record;
  }

  async getArtifact(artifactId: string): Promise<SessionArtifactRecord | null> {
    const row = this.db.prepare(`
      SELECT id, type, content_type, content, file_path, size_bytes, created_at, metadata_json
      FROM artifacts
      WHERE id = ?
    `).get(artifactId) as Record<string, unknown> | undefined;

    return row ? toArtifactRecord(row) : null;
  }

  async trimArtifacts(options: { olderThanDays: number; minSizeBytes: number }) {
    const cutoff = new Date(Date.now() - (options.olderThanDays * 24 * 60 * 60 * 1000)).toISOString();
    const stmt = this.db.prepare(`
      UPDATE artifacts
      SET content = NULL
      WHERE created_at < ?
        AND size_bytes >= ?
        AND content IS NOT NULL
    `);
    const result = stmt.run(cutoff, options.minSizeBytes) as { changes?: number };
    return Number(result.changes ?? 0);
  }
}

function toArtifactRecord(row: Record<string, unknown>): SessionArtifactRecord {
  return {
    id: String(row.id),
    type: String(row.type),
    contentType: (row.content_type as string | null | undefined) ?? null,
    content: (row.content as string | null | undefined) ?? null,
    filePath: (row.file_path as string | null | undefined) ?? null,
    sizeBytes: Number(row.size_bytes ?? 0),
    createdAt: String(row.created_at),
    metadata: parseJson(row.metadata_json),
  };
}

function parseJson(value: unknown) {
  try {
    return value ? JSON.parse(String(value)) as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function estimateBytes(text: string) {
  return Buffer.byteLength(text, "utf-8");
}
