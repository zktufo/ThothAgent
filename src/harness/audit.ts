/**
 * SQLite-based audit trail for tool execution.
 *
 * Every tool call is logged with agent identity, input, success/failure
 * status, error details, and duration. The log is persisted to
 * `~/.ThothAgent/audit/audit.db` and supports queries by tool name,
 * agent ID, time range, and aggregate statistics.
 *
 * Uses node:sqlite (DatabaseSync) — the same approach as KnowledgeIndexer.
 */

import fs from "fs";
import path from "path";
import os from "os";
import crypto from "crypto";
import { DatabaseSync } from "node:sqlite";
import type { AuditEntry } from "./types.js";

const DEFAULT_DB_DIR = path.resolve(os.homedir(), ".ThothAgent", "audit");
const DEFAULT_DB_PATH = path.join(DEFAULT_DB_DIR, "audit.db");

export class AuditLogger {
  readonly db: DatabaseSync;
  readonly dbPath: string;
  private ready = false;

  constructor(dbPath?: string) {
    this.dbPath = dbPath || DEFAULT_DB_PATH;
    fs.mkdirSync(path.dirname(this.dbPath), { recursive: true });
    this.db = new DatabaseSync(this.dbPath);
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec("PRAGMA synchronous = NORMAL;");
    this.ensureSchema();
    this.ready = true;
  }

  /**
   * Ensure the audit table exists with the correct schema.
   */
  private ensureSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS audit (
        id TEXT PRIMARY KEY,
        timestamp TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        tool_name TEXT NOT NULL,
        input TEXT NOT NULL,
        success INTEGER NOT NULL DEFAULT 1,
        error TEXT,
        duration REAL NOT NULL DEFAULT 0
      );

      CREATE INDEX IF NOT EXISTS idx_audit_tool_name ON audit(tool_name);
      CREATE INDEX IF NOT EXISTS idx_audit_agent_id ON audit(agent_id);
      CREATE INDEX IF NOT EXISTS idx_audit_timestamp ON audit(timestamp);
    `);
  }

  /**
   * Log a single tool execution to the audit trail.
   *
   * Generates a UUID for the entry and records the current timestamp.
   * The operation is synchronous (DatabaseSync) but wrapped in a Promise
   * interface for ergonomic use across the codebase.
   */
  async log(entry: Omit<AuditEntry, "id" | "timestamp">): Promise<void> {
    if (!this.ready) return;

    const id = crypto.randomUUID();
    const timestamp = new Date().toISOString();

    const stmt = this.db.prepare(`
      INSERT INTO audit (id, timestamp, agent_id, session_id, tool_name, input, success, error, duration)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    stmt.run(
      id,
      timestamp,
      entry.agentId,
      entry.sessionId,
      entry.toolName,
      // Truncate input to 4 KB to avoid bloating the DB
      entry.input.length > 4096 ? entry.input.slice(0, 4096) + "…" : entry.input,
      entry.success ? 1 : 0,
      entry.error || null,
      entry.duration,
    );
  }

  /**
   * Query audit entries with optional filters.
   *
   * All filters are combined with AND. Results are sorted by timestamp
   * descending (newest first) and limited to `limit` entries (default 50).
   */
  async query(options: {
    toolName?: string;
    agentId?: string;
    limit?: number;
    since?: string;
  }): Promise<AuditEntry[]> {
    if (!this.ready) return [];

    const conditions: string[] = [];
    const params: (string | number)[] = [];
    const limit = options.limit ?? 50;

    if (options.toolName) {
      conditions.push("tool_name = ?");
      params.push(options.toolName);
    }

    if (options.agentId) {
      conditions.push("agent_id = ?");
      params.push(options.agentId);
    }

    if (options.since) {
      conditions.push("timestamp >= ?");
      params.push(options.since);
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    params.push(limit);

    const rows = this.db
      .prepare(`SELECT * FROM audit ${where} ORDER BY timestamp DESC LIMIT ?`)
      .all(...params) as Array<Record<string, unknown>>;

    return rows.map(rowToAuditEntry);
  }

  /**
   * Get aggregate statistics over all audit entries.
   *
   * Returns total calls, success rate, and top-10 most used tools.
   */
  async stats(): Promise<{
    totalCalls: number;
    successRate: number;
    topTools: Array<{ tool: string; count: number }>;
  }> {
    if (!this.ready) {
      return { totalCalls: 0, successRate: 1, topTools: [] };
    }

    const totalRow = this.db
      .prepare("SELECT COUNT(*) AS c FROM audit")
      .get() as { c: number };
    const totalCalls = totalRow?.c ?? 0;

    const successRow = this.db
      .prepare("SELECT COUNT(*) AS c FROM audit WHERE success = 1")
      .get() as { c: number };
    const successCount = successRow?.c ?? 0;

    const successRate = totalCalls > 0 ? successCount / totalCalls : 1;

    const topToolsRows = this.db
      .prepare(
        "SELECT tool_name AS tool, COUNT(*) AS count FROM audit GROUP BY tool_name ORDER BY count DESC LIMIT 10",
      )
      .all() as Array<{ tool: string; count: number }>;

    return {
      totalCalls,
      successRate,
      topTools: topToolsRows ?? [],
    };
  }

  /**
   * Close the database connection.
   */
  close(): void {
    this.ready = false;
    this.db.close();
  }
}

/**
 * Convert a raw SQLite row to an AuditEntry object.
 */
function rowToAuditEntry(row: Record<string, unknown>): AuditEntry {
  return {
    id: String(row.id),
    timestamp: String(row.timestamp),
    agentId: String(row.agent_id),
    sessionId: String(row.session_id),
    toolName: String(row.tool_name),
    input: String(row.input),
    success: Number(row.success) === 1,
    error: (row.error as string) ?? undefined,
    duration: Number(row.duration),
  };
}
