/**
 * Unified memory facade.
 *
 * This file is intentionally small and boring:
 * - short-term session messages live in JSON files
 * - long-term searchable memory lives in layered retrieval memory
 * - prompt injection is delegated to the layered memory manager
 *
 * The goal is to make the memory entry points easy to understand from top to bottom.
 */
import fs from "fs";
import path from "path";
import { FileMemory } from "./layered/file_memory.js";
import { MemoryManager } from "./layered/manager.js";
import { RetrievalMemory } from "./layered/retrieval_memory.js";
import { FileMemoryProvider, RetrievalMemoryProvider, VisibleMemorySummaryProvider } from "./layered/providers.js";
import { type UserHomePaths, readHomeDocuments, resolveUserHomePaths } from "../home/index.js";
import {
  matchesRecord,
  newId,
  safeName,
  nowIso,
} from "./utils.js";
import type { ExtractionMaterial } from "../session/types.js";

export type MemoryRole = "user" | "assistant";
export type MemoryRecordKind = "message" | "fact" | "summary" | "preference" | "event";

export interface Message {
  role: MemoryRole;
  content: string;
  timestamp: string;
  imagePath?: string;
  metadata?: Record<string, any>;
}

export interface ConsultationRecord {
  pet_name: string;
  summary: string;
  archived_at: string;
  metadata?: Record<string, any>;
}

export interface MemoryRecord {
  id: string;
  namespace: string;
  kind: MemoryRecordKind;
  content: string;
  createdAt: string;
  updatedAt: string;
  tags: string[];
  metadata: Record<string, any>;
}

export interface MemoryQuery {
  namespace?: string;
  kind?: MemoryRecordKind;
  tags?: string[];
  text?: string;
  limit?: number;
}

export interface MemoryStoreOptions {
  namespace?: string;
  sessionId?: string;
  storeDir?: string;
  userId?: string;
  layeredRootDir?: string;
  homePaths?: UserHomePaths;
}

export interface VectorMemoryHit {
  id: string;
  kind: MemoryRecordKind;
  content: string;
  source: string;
  score: number;
  createdAt: string;
  updatedAt: string;
  tags: string[];
  metadata: Record<string, any>;
}

export interface MemorySearchOptions {
  query: string;
  limit?: number;
  kinds?: MemoryRecordKind[];
}

export class FileMemoryBackend {
  readonly agentRootDir: string;
  readonly sessionsDir: string;
  readonly historyPath: string;
  readonly recordsPath: string;

  constructor(options: { storeDir?: string; homePaths?: UserHomePaths } = {}) {
    const paths = options.homePaths || resolveUserHomePaths();
    this.agentRootDir = options.storeDir || paths.agentRoot;
    this.sessionsDir = path.join(this.agentRootDir, "sessions");
    this.historyPath = path.join(this.agentRootDir, "consultation_history.json");
    this.recordsPath = path.join(this.agentRootDir, "records.json");
    fs.mkdirSync(this.sessionsDir, { recursive: true });
  }

  private sessionFile(_namespace: string, sessionId: string) {
    return path.join(this.sessionsDir, `${safeName(sessionId)}.json`);
  }

  private historyFile(_namespace: string) {
    return this.historyPath;
  }

  private recordsFile(_namespace: string) {
    return this.recordsPath;
  }

  private readJson(filePath: string, fallback: any) {
    try {
      if (!fs.existsSync(filePath)) return fallback;
      return JSON.parse(fs.readFileSync(filePath, "utf-8"));
    } catch {
      return fallback;
    }
  }

  private writeJson(filePath: string, data: any) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2), "utf-8");
  }

  async appendMessage(namespace: string, sessionId: string, message: Message) {
    const filePath = this.sessionFile(namespace, sessionId);
    const messages = this.readJson(filePath, []);
    messages.push(message);
    this.writeJson(filePath, messages);
  }

  async getRecentMessages(namespace: string, sessionId: string, maxMessages: number) {
    return this.readJson(this.sessionFile(namespace, sessionId), []).slice(-maxMessages);
  }

  async clearSession(namespace: string, sessionId: string) {
    this.writeJson(this.sessionFile(namespace, sessionId), []);
  }

  async archiveConsultation(namespace: string, sessionId: string, record: ConsultationRecord) {
    const filePath = this.historyFile(namespace);
    const history = this.readJson(filePath, []);
    history.push(record);
    this.writeJson(filePath, history);
    await this.clearSession(namespace, sessionId);
  }

  async getConsultationHistory(namespace: string, limit = 50) {
    return this.readJson(this.historyFile(namespace), []).slice(-limit);
  }

  async upsertRecord(record: MemoryRecord) {
    const filePath = this.recordsFile(record.namespace);
    const records = this.readJson(filePath, []);
    const index = records.findIndex((item: MemoryRecord) => item.id === record.id);
    if (index >= 0) records[index] = record;
    else records.push(record);
    this.writeJson(filePath, records);
  }

  async queryRecords(query: MemoryQuery) {
    if (!query.namespace) return [];
    const records = this.readJson(this.recordsFile(query.namespace), []);
    return records
      .filter((record: MemoryRecord) => matchesRecord(record, query))
      .sort((a: MemoryRecord, b: MemoryRecord) => b.updatedAt.localeCompare(a.updatedAt))
      .slice(0, query.limit ?? 20);
  }

  async deleteRecord(namespace: string, id: string) {
    const filePath = this.recordsFile(namespace);
    const records = this.readJson(filePath, []);
    this.writeJson(filePath, records.filter((record: MemoryRecord) => record.id !== id));
  }
}

export class MemoryStore {
  readonly namespace: string;
  readonly sessionId: string;
  readonly backend: FileMemoryBackend;
  readonly userId: string;
  readonly homePaths: UserHomePaths;
  readonly fileMemory: FileMemory;
  readonly retrievalMemory: RetrievalMemory;
  readonly manager: MemoryManager;

  constructor(options: MemoryStoreOptions = {}) {
    this.homePaths = options.homePaths || resolveUserHomePaths();
    this.namespace = options.namespace || process.env.PET_AGENT_MEMORY_NAMESPACE || "default";
    this.sessionId = options.sessionId || process.env.PET_AGENT_SESSION_ID || "current";
    this.backend = new FileMemoryBackend({
      storeDir: options.storeDir,
      homePaths: this.homePaths,
    });
    this.userId = options.userId || process.env.PET_AGENT_USER_ID || this.deriveUserId();
    this.fileMemory = new FileMemory({
      rootDir: options.layeredRootDir || this.homePaths.layeredDir,
      domainContextPath: this.homePaths.domainContextPath,
      visibleMemoryPath: this.homePaths.visibleMemoryPath,
    });
    this.retrievalMemory = new RetrievalMemory({
      filePath: this.homePaths.retrievalMemoryPath,
      topK: 6,
    });

    this.manager = new MemoryManager([
      new FileMemoryProvider(this.fileMemory),
      new RetrievalMemoryProvider(this.retrievalMemory, 4),
      new VisibleMemorySummaryProvider(this.fileMemory, this.retrievalMemory),
    ], {
      sessionId: this.sessionId,
      maxMemoryTokens: 600,
      debug: process.env.PET_AGENT_DEBUG_MEMORY === "1",
    });
  }

  private deriveUserId() {
    try {
      const userFile = this.homePaths.userPath;
      const lines = fs.readFileSync(userFile, "utf-8").split(/\r?\n/).map((line) => line.trim());
      for (const label of ["用户称呼：", "姓名：", "称呼："]) {
        const line = lines.find((item) => item.includes(label));
        const value = line?.split("：").slice(1).join("：").trim();
        if (value && value !== "未设置") return safeName(value);
      }
    } catch {}
    return safeName(this.namespace || "default-user");
  }

  getHomeDocuments() {
    return readHomeDocuments(this.homePaths);
  }

  async addMessage(role: MemoryRole, content: string, imagePath?: string, metadata?: Record<string, any>) {
    const timestamp = nowIso();
    const message: Message = {
      role,
      content,
      timestamp,
      ...(imagePath ? { imagePath } : {}),
      ...(metadata ? { metadata } : {}),
    };

    await this.backend.appendMessage(this.namespace, this.sessionId, message);
    await this.backend.upsertRecord({
      id: `message_${this.sessionId}_${timestamp}_${Math.random().toString(36).slice(2, 10)}`,
      namespace: this.namespace,
      kind: "message",
      content,
      createdAt: timestamp,
      updatedAt: timestamp,
      tags: ["session", role],
      metadata: {
        role,
        sessionId: this.sessionId,
        ...(imagePath ? { imagePath } : {}),
        ...(metadata || {}),
      },
    });
  }

  getRecentContext(maxMessages = 12) {
    return this.backend.getRecentMessages(this.namespace, this.sessionId, maxMessages);
  }

  archiveConsultation(petName: string, summary: string, metadata?: Record<string, any>) {
    void this.retrievalMemory.append({
      kind: "summary",
      text: `${petName}: ${summary}`,
      tags: ["consultation", "summary"],
      source: "consultation-summary",
      metadata: { petName, ...(metadata || {}) },
    }).catch(() => {});

    return this.backend.archiveConsultation(this.namespace, this.sessionId, {
      pet_name: petName,
      summary,
      archived_at: nowIso(),
      ...(metadata ? { metadata } : {}),
    });
  }

  getHistory(limit?: number) {
    return this.backend.getConsultationHistory(this.namespace, limit);
  }

  clearSession() {
    return this.backend.clearSession(this.namespace, this.sessionId);
  }

  async ingestSessionExtraction(material: ExtractionMaterial) {
    const summary = material.summaryMarkdown.trim()
      || material.messages
        .slice(-6)
        .map((message) => `${message.role}: ${message.contentSummary || message.content || ""}`)
        .join("\n");

    if (!summary) return null;

    return this.retrievalMemory.append({
      kind: "summary",
      text: [
        `session_key: ${material.session.sessionKey}`,
        `title: ${material.session.title}`,
        summary,
      ].join("\n"),
      tags: [
        "session-end",
        material.session.channel,
        material.session.businessObjectType || "general",
      ].filter(Boolean),
      source: "session-extraction",
      metadata: {
        sessionId: material.session.id,
        sessionKey: material.session.sessionKey,
        title: material.session.title,
        endedAt: material.session.endedAt || material.session.lastActivityAt,
      },
    });
  }

  remember(
    kind: MemoryRecordKind,
    content: string,
    options: { id?: string; tags?: string[]; metadata?: Record<string, any>; namespace?: string } = {},
  ) {
    const timestamp = nowIso();
    const record: MemoryRecord = {
      id: options.id || newId(kind),
      namespace: options.namespace || this.namespace,
      kind,
      content,
      createdAt: timestamp,
      updatedAt: timestamp,
      tags: options.tags || [],
      metadata: options.metadata || {},
    };

    return this.backend.upsertRecord(record).then(() => {
      void this.retrievalMemory.append({
        kind,
        text: content,
        tags: options.tags || [],
        source: "memory-record",
        metadata: options.metadata || {},
      }).catch(() => {});
      return record;
    });
  }

  recall(query: MemoryQuery = {}) {
    return this.backend.queryRecords({
      namespace: query.namespace || this.namespace,
      ...query,
    });
  }

  async searchMemory(options: MemorySearchOptions) {
    const hits = await this.retrievalMemory.search(options.query, options.limit ?? 8);
    return hits
      .filter((hit) => !options.kinds?.length || options.kinds.includes(hit.kind))
      .map<VectorMemoryHit>((hit) => ({
        id: hit.id,
        kind: hit.kind,
        content: hit.text,
        source: hit.source,
        score: hit.score,
        createdAt: hit.createdAt,
        updatedAt: hit.createdAt,
        tags: hit.tags,
        metadata: hit.metadata || {},
      }));
  }

  recallRelativeDay(dayOffset: number, limit: number = 12) {
    return this.recallByDate(this.dateKeyFromOffset(dayOffset), limit);
  }

    async recallByDate(dateKey: string, limit: number = 12): Promise<VectorMemoryHit[]> {
    const records: MemoryRecord[] = await this.recall({ limit: 500 });
    return records
      .filter((r: MemoryRecord) => r.createdAt.startsWith(dateKey) || r.updatedAt.startsWith(dateKey))
      .sort((a: MemoryRecord, b: MemoryRecord) => a.createdAt.localeCompare(b.createdAt))
      .slice(0, limit)
      .map((record: MemoryRecord) => ({
        id: record.id,
        kind: record.kind,
        content: record.content,
        source: "record-memory",
        score: 1,
        createdAt: record.createdAt,
        updatedAt: record.updatedAt,
        tags: record.tags,
        metadata: record.metadata,
      }));
  }

  private dateKeyFromOffset(offsetDays: number) {
    const date = new Date();
    date.setDate(date.getDate() + offsetDays);
    return date.toISOString().slice(0, 10);
  }

  forget(id: string, namespace: string = this.namespace) {
    return this.backend.deleteRecord(namespace, id);
  }
}

/**
 * Daily log helper used by the CLI and agent orchestration.
 */
export function logDaily(note: string) {
  const today = new Date().toISOString().slice(0, 10);
  const dailyPath = path.join(resolveUserHomePaths().dailyDir, `${today}.md`);
  const header = `# ${today} 日志\n\n`;

  try {
    const existing = fs.existsSync(dailyPath)
      ? fs.readFileSync(dailyPath, "utf-8")
      : header;

    const content = existing.startsWith(header)
      ? existing + `${note}\n`
      : header + existing + `${note}\n`;

    fs.mkdirSync(path.dirname(dailyPath), { recursive: true });
    fs.writeFileSync(dailyPath, content, "utf-8");
  } catch {}
}
