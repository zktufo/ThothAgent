/**
 * FileMemory owns the small set of files that define the layered-memory state.
 *
 * Design notes:
 * - JSON files are used for structured machine-readable state.
 * - Markdown files are used for human-readable summaries and business context.
 * - The root-level MEMORY.md is preserved as a user-friendly summary view.
 */
import fs from "fs";
import path from "path";
import type { UserProfile, WorkingState } from "./types.js";
import { resolveUserHomePaths } from "../../home/index.js";

export interface FileMemoryOptions {
  rootDir?: string;
  projectRootDir?: string;
  domainContextPath?: string;
  visibleMemoryPath?: string;
}

export class FileMemory {
  readonly rootDir: string;
  readonly userProfilePath: string;
  readonly domainContextPath: string;
  readonly workingStatePath: string;
  readonly sessionSummaryPath: string;
  readonly visibleMemoryPath: string;
  private readonly projectRoot: string;

  constructor(options: FileMemoryOptions = {}) {
    const homePaths = resolveUserHomePaths();
    this.rootDir = options.rootDir || homePaths.layeredDir;
    this.projectRoot = options.projectRootDir || homePaths.agentDataDir;
    this.userProfilePath = path.join(this.rootDir, "user_profile.json");
    this.domainContextPath = options.domainContextPath || homePaths.domainContextPath;
    this.workingStatePath = path.join(this.rootDir, "working_state.json");
    this.sessionSummaryPath = path.join(this.rootDir, "session_summary.md");
    this.visibleMemoryPath = options.visibleMemoryPath || homePaths.visibleMemoryPath;
  }

  async init() {
    // Initialize all files lazily so a fresh checkout can boot without manual setup.
    fs.mkdirSync(this.rootDir, { recursive: true });
    this.migrateLegacyMemoryToDomainContext();
    this.ensureJson(this.userProfilePath, {
      preferences: {
        answerStyle: "direct",
        responseLength: "concise",
        formatting: ["bullet points"],
      },
      traits: [],
      stableFacts: {},
    });
    this.ensureMarkdown(this.domainContextPath, [
      "# Domain Context",
      "",
      "- 在这里写垂直业务规则、术语、流程边界和系统能力。",
      "- 这是给 LLM 理解业务背景的，不是代码实现说明。",
      "",
    ].join("\n"));
    this.ensureJson(this.workingStatePath, {
      status: "idle",
      turnCount: 0,
      vars: {},
    });
    this.ensureMarkdown(this.sessionSummaryPath, "# Session Summary\n\n- 暂无摘要。\n");
  }

  async getUserProfile() {
    return this.readJson<UserProfile>(this.userProfilePath, {});
  }

  async saveUserProfile(profile: UserProfile) {
    this.writeJson(this.userProfilePath, profile);
  }

  async updateUserProfile(patch: Partial<UserProfile>) {
    // User profile is merged conservatively because these facts should be stable and low-frequency.
    const current = await this.getUserProfile();
    const next: UserProfile = {
      ...current,
      ...patch,
      preferences: {
        ...(current.preferences || {}),
        ...(patch.preferences || {}),
      },
      stableFacts: {
        ...(current.stableFacts || {}),
        ...(patch.stableFacts || {}),
      },
      traits: dedupe([...(current.traits || []), ...(patch.traits || [])]),
      updatedAt: new Date().toISOString(),
    };
    await this.saveUserProfile(next);
    return next;
  }

  async getDomainContext() {
    return this.readText(this.domainContextPath, "");
  }

  async saveDomainContext(content: string) {
    this.writeText(this.domainContextPath, content.trim() ? `${content.trim()}\n` : "");
  }

  async getWorkingState() {
    return this.readJson<WorkingState>(this.workingStatePath, {});
  }

  async saveWorkingState(state: WorkingState) {
    this.writeJson(this.workingStatePath, state);
  }

  async updateWorkingState(patch: Partial<WorkingState>) {
    // Working state is operational state, so we overwrite it frequently and keep the latest truth.
    const current = await this.getWorkingState();
    const next: WorkingState = {
      ...current,
      ...patch,
      vars: {
        ...(current.vars || {}),
        ...(patch.vars || {}),
      },
      updatedAt: new Date().toISOString(),
    };
    await this.saveWorkingState(next);
    return next;
  }

  async getSessionSummary() {
    return this.readText(this.sessionSummaryPath, "");
  }

  async saveSessionSummary(content: string) {
    this.writeText(this.sessionSummaryPath, content.trim() ? `${content.trim()}\n` : "");
  }

  async getVisibleMemorySummary() {
    return this.readText(this.visibleMemoryPath, "");
  }

  async saveVisibleMemorySummary(content: string) {
    this.writeText(this.visibleMemoryPath, content.trim() ? `${content.trim()}\n` : "");
  }

  async appendSessionSummary(lines: string[], maxChars: number = 2_400) {
    // Session summary is a rolling digest that replaces long chat history in prompts.
    const current = (await this.getSessionSummary()).trim();
    const body = current && current !== "# Session Summary\n\n- 暂无摘要。"
      ? current
      : "# Session Summary";
    const next = [body, ...lines].filter(Boolean).join("\n");
    const clipped = next.length > maxChars ? `${next.slice(next.length - maxChars)}` : next;
    await this.saveSessionSummary(clipped.startsWith("# Session Summary") ? clipped : `# Session Summary\n${clipped}`);
    return clipped;
  }

  private ensureJson(filePath: string, fallback: any) {
    if (fs.existsSync(filePath)) return;
    this.writeJson(filePath, fallback);
  }

  private ensureMarkdown(filePath: string, fallback: string) {
    if (fs.existsSync(filePath)) return;
    this.writeText(filePath, fallback);
  }

  private migrateLegacyMemoryToDomainContext() {
    if (fs.existsSync(this.domainContextPath)) return;
    if (!fs.existsSync(this.visibleMemoryPath)) return;
    const legacy = this.readText(this.visibleMemoryPath, "").trim();
    if (!legacy) return;
    this.writeText(this.domainContextPath, legacy.endsWith("\n") ? legacy : `${legacy}\n`);
  }

  private readJson<T>(filePath: string, fallback: T): T {
    try {
      return JSON.parse(fs.readFileSync(filePath, "utf-8")) as T;
    } catch {
      return fallback;
    }
  }

  private writeJson(filePath: string, data: any) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2), "utf-8");
  }

  private readText(filePath: string, fallback: string) {
    try {
      return fs.readFileSync(filePath, "utf-8");
    } catch {
      return fallback;
    }
  }

  private writeText(filePath: string, content: string) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, content, "utf-8");
  }
}

function dedupe(values: string[]) {
  return [...new Set(values.filter(Boolean))];
}
