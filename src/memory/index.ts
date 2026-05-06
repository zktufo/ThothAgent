/**
 * Unified memory facade.
 *
 * This file is intentionally small and boring:
 * - raw conversation/session history lives in SQLiteSessionStore
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
import { createExternalMemoryProvider } from "./layered/external_provider.js";
import { BuiltinMemoryProvider } from "./layered/providers.js";
import { type UserHomePaths, readHomeDocuments, resolveUserHomePaths } from "../home/index.js";
import {
  safeName,
  nowIso,
} from "./utils.js";
import type { ExtractionMaterial } from "../session/types.js";

export type MemoryRole = "user" | "assistant";
export type MemoryRecordKind = "message" | "fact" | "summary" | "preference" | "event" | "best_try";

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

export class MemoryStore {
  readonly namespace: string;
  readonly sessionId: string;
  readonly userId: string;
  readonly homePaths: UserHomePaths;
  readonly fileMemory: FileMemory;
  readonly retrievalMemory: RetrievalMemory;
  readonly manager: MemoryManager;

  constructor(options: MemoryStoreOptions = {}) {
    this.homePaths = options.homePaths || resolveUserHomePaths();
    this.namespace = options.namespace || process.env.PET_AGENT_MEMORY_NAMESPACE || "default";
    this.sessionId = options.sessionId || process.env.PET_AGENT_SESSION_ID || "current";
    this.userId = options.userId || process.env.PET_AGENT_USER_ID || this.deriveUserId();
    this.fileMemory = new FileMemory({
      rootDir: options.layeredRootDir || this.homePaths.layeredDir,
      domainMemoryPath: this.homePaths.domainContextPath,
      visibleMemoryPath: this.homePaths.visibleMemoryPath,
      userMemoryPath: this.homePaths.userPath,
      retrievalMemoryPath: this.homePaths.retrievalMemoryPath,
    });
    this.retrievalMemory = new RetrievalMemory({
      jsonlPath: this.homePaths.retrievalMemoryPath,
      dbPath: this.homePaths.retrievalDbPath,
      topK: 6,
    });

    this.manager = new MemoryManager([
      new BuiltinMemoryProvider(this.fileMemory),
      createExternalMemoryProvider({
        homePaths: this.homePaths,
        fileMemory: this.fileMemory,
        retrievalMemory: this.retrievalMemory,
      }),
    ], {
      sessionId: this.sessionId,
      maxMemoryTokens: 600,
      debug: process.env.PET_AGENT_DEBUG_MEMORY === "1",
    });
  }

  private deriveUserId() {
    // USER.md 已退出运行时主链路，不再从文档里推导身份。
    return safeName(this.namespace || "default-user");
  }

  getHomeDocuments() {
    return readHomeDocuments(this.homePaths);
  }

  getRecentContext(_maxMessages = 12) {
    // Raw recent conversation context now comes from SessionManager/SQLiteSessionStore.
    // Keep this compatibility method as an empty fallback for older callers.
    return Promise.resolve([] as Message[]);
  }

  async archiveConsultation(petName: string, summary: string, metadata?: Record<string, any>) {
    return this.retrievalMemory.append({
      kind: "summary",
      text: `${petName}: ${summary}`,
      tags: ["consultation", "summary"],
      source: "consultation-summary",
      metadata: {
        namespace: this.namespace,
        sessionId: this.sessionId,
        petName,
        archivedAt: nowIso(),
        ...(metadata || {}),
      },
    });
  }

  async getHistory(limit: number = 50) {
    const recent = await this.retrievalMemory.recent(Math.max(limit * 4, limit));
    return recent
      .filter((item) => item.tags.includes("consultation"))
      .slice(0, limit)
      .map((item) => ({
        pet_name: String(item.metadata?.petName || ""),
        summary: item.text,
        archived_at: String(item.metadata?.archivedAt || item.createdAt),
        metadata: item.metadata,
      } satisfies ConsultationRecord));
  }

  async clearSession() {
    await this.fileMemory.updateWorkingState({
      status: "idle",
      currentTask: "",
      currentStep: "session-cleared",
      vars: {},
    });
    this.manager.clearSessionSnapshot();
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

  async remember(
    kind: MemoryRecordKind,
    content: string,
    options: { id?: string; tags?: string[]; metadata?: Record<string, any>; namespace?: string } = {},
  ) {
    const namespace = options.namespace || this.namespace;
    const stored = await this.retrievalMemory.append({
      kind,
      text: content,
      tags: options.tags || [],
      source: "memory-record",
      metadata: {
        namespace,
        requestedId: options.id,
        ...(options.metadata || {}),
      },
    });

    return {
      id: stored.id,
      namespace,
      kind: stored.kind,
      content: stored.text,
      createdAt: stored.createdAt,
      updatedAt: stored.createdAt,
      tags: stored.tags,
      metadata: stored.metadata || {},
    } satisfies MemoryRecord;
  }

  async recall(query: MemoryQuery = {}) {
    const namespace = query.namespace || this.namespace;
    const limit = query.limit ?? 20;
    const hits = query.text
      ? await this.searchMemory({ query: query.text, limit, kinds: query.kind ? [query.kind] : undefined })
      : (await this.retrievalMemory.recent(limit)).map((item) => ({
        id: item.id,
        kind: item.kind,
        content: item.text,
        source: item.source,
        score: 1,
        createdAt: item.createdAt,
        updatedAt: item.createdAt,
        tags: item.tags,
        metadata: item.metadata || {},
      } satisfies VectorMemoryHit));

    return hits
      .filter((hit) => !query.kind || hit.kind === query.kind)
      .filter((hit) => !query.tags?.length || query.tags.every((tag) => hit.tags.includes(tag)))
      .filter((hit) => !hit.metadata?.namespace || hit.metadata.namespace === namespace)
      .map((hit) => ({
        id: hit.id,
        namespace,
        kind: hit.kind,
        content: hit.content,
        createdAt: hit.createdAt,
        updatedAt: hit.updatedAt,
        tags: hit.tags,
        metadata: hit.metadata || {},
      } satisfies MemoryRecord));
  }

  async searchMemory(options: MemorySearchOptions) {
    const hits = await this.manager.searchMemory({
      query: options.query,
      limit: options.limit ?? 8,
      kinds: options.kinds,
    });
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
    const hits = await this.manager.searchMemory({
      query: dateKey,
      limit,
      datePrefix: dateKey,
    });
    return hits.map((record) => ({
      id: record.id,
      kind: record.kind,
      content: record.text,
      source: record.source,
      score: typeof record.score === "number" ? record.score : 1,
      createdAt: record.createdAt,
      updatedAt: record.createdAt,
      tags: record.tags,
      metadata: record.metadata || {},
    }));
  }

  private dateKeyFromOffset(offsetDays: number) {
    const date = new Date();
    date.setDate(date.getDate() + offsetDays);
    return date.toISOString().slice(0, 10);
  }

  async forget(id: string, _namespace: string = this.namespace) {
    return this.retrievalMemory.delete(id);
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
