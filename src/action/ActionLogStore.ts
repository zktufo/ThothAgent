import type { DatabaseSync } from "node:sqlite";
import crypto from "node:crypto";
import type { LogActionInput } from "./types.js";
import type { SessionActionRecord } from "../session/types.js";

/**
 * ActionLogStore records runtime/tool behaviors separately from user-visible messages.
 *
 * This keeps session messages focused on dialog while preserving an audit trail of
 * tool calls, approvals, and resource-level actions.
 */
export class ActionLogStore {
  constructor(private db: DatabaseSync) {}

  async logAction(input: LogActionInput): Promise<SessionActionRecord> {
    const record: SessionActionRecord = {
      id: crypto.randomUUID(),
      sessionId: input.sessionId,
      actionType: input.actionType,
      toolName: input.toolName ?? null,
      resourceType: input.resourceType ?? null,
      resourceId: input.resourceId ?? null,
      inputJson: input.inputJson ? JSON.stringify(input.inputJson) : null,
      outputStatus: input.outputStatus ?? null,
      outputSummary: input.outputSummary ?? null,
      artifactId: input.artifactId ?? null,
      approvedBy: input.approvedBy ?? null,
      createdAt: input.createdAt ?? new Date().toISOString(),
      metadata: input.metadata ?? {},
    };

    this.db.prepare(`
      INSERT INTO actions (
        id, session_id, action_type, tool_name, resource_type, resource_id,
        input_json, output_status, output_summary, artifact_id, approved_by,
        created_at, metadata_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      record.id,
      record.sessionId,
      record.actionType,
      record.toolName ?? null,
      record.resourceType ?? null,
      record.resourceId ?? null,
      record.inputJson ?? null,
      record.outputStatus ?? null,
      record.outputSummary ?? null,
      record.artifactId ?? null,
      record.approvedBy ?? null,
      record.createdAt,
      JSON.stringify(record.metadata),
    );

    return record;
  }

  async listActions(sessionId: string): Promise<SessionActionRecord[]> {
    const rows = this.db.prepare(`
      SELECT
        id, session_id, action_type, tool_name, resource_type, resource_id,
        input_json, output_status, output_summary, artifact_id, approved_by,
        created_at, metadata_json
      FROM actions
      WHERE session_id = ?
      ORDER BY created_at ASC
    `).all(sessionId) as Array<Record<string, unknown>>;

    return rows.map((row) => ({
      id: String(row.id),
      sessionId: String(row.session_id),
      actionType: String(row.action_type),
      toolName: (row.tool_name as string | null | undefined) ?? null,
      resourceType: (row.resource_type as string | null | undefined) ?? null,
      resourceId: (row.resource_id as string | null | undefined) ?? null,
      inputJson: (row.input_json as string | null | undefined) ?? null,
      outputStatus: (row.output_status as string | null | undefined) ?? null,
      outputSummary: (row.output_summary as string | null | undefined) ?? null,
      artifactId: (row.artifact_id as string | null | undefined) ?? null,
      approvedBy: (row.approved_by as string | null | undefined) ?? null,
      createdAt: String(row.created_at),
      metadata: parseJson(row.metadata_json),
    }));
  }
}

function parseJson(value: unknown) {
  try {
    return value ? JSON.parse(String(value)) as Record<string, unknown> : {};
  } catch {
    return {};
  }
}
