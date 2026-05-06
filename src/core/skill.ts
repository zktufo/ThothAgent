/**
 * Skill system — plugin architecture for ThothAgent.
 *
 * Supports three formats:
 *   1. skills/skill-name/SKILL.md (directory skill)
 *   2. skills/skill_*.json (JSON manifest)
 *   3. skills/user-created/*.json (user-created skills from conversation)
 *   4. skills/third-party/*.json (installed from npm/git/URL)
 *
 * Each skill can optionally carry an executor (prompt / code / mcp / workflow),
 * permissions, version information, and metadata about its source.
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ──────────────── Types ────────────────

export interface SkillManifest {
  name: string;
  description: string;
  commands?: string[];
  keywords?: string[];
  tool?: string;
  toolArgs?: Record<string, any>;
  inputSchema?: {
    type: "object";
    properties?: Record<string, any>;
    required?: string[];
    [key: string]: any;
  };
  enabled?: boolean;
  /** Optional LLM prompt injection for prompt-type skills */
  llmPrompt?: string;
  /** Required permissions, e.g. ["exec", "read", "write", "network", "filesystem"] */
  permissions?: string[];
  /** Author/creator info */
  author?: string;
  /** Semantic version string */
  version?: string;
  /** Skill origin */
  source?: "builtin" | "user-created" | "third-party";
}

export type SkillExecutorType = "prompt" | "code" | "mcp" | "workflow";

/**
 * A callable executor attached to a skill.
 *
 * - `prompt`: injects `llmPrompt` into the LLM system prompt
 * - `code`: executes inline code (requires exec permission)
 * - `mcp`: forwards to an MCP tool (uses existing `tool` field)
 * - `workflow`: runs a multi-step workflow (place holder)
 */
export interface SkillExecutor {
  type: SkillExecutorType;
  execute(input: any, ctx: any): Promise<string>;
}

// ──────────────── Skill class ────────────────

export class Skill {
  name: string;
  description: string;
  commands: string[] = [];
  keywords: string[] = [];
  tool?: string;
  toolArgs: Record<string, any> = {};
  inputSchema?: {
    type: "object";
    properties?: Record<string, any>;
    required?: string[];
    [key: string]: any;
  };
  enabled = true;
  path?: string;
  /** Optional executable behaviour */
  executor?: SkillExecutor;
  /** LLM prompt injection for prompt-type skills */
  llmPrompt?: string;
  /** Required permissions the skill needs at runtime */
  permissions: string[] = [];
  /** Author/creator */
  author?: string;
  /** Semantic version */
  version?: string;
  /** Skill origin */
  source: "builtin" | "user-created" | "third-party" = "builtin";

  constructor(manifest: SkillManifest) {
    this.name = manifest.name;
    this.description = manifest.description || "";
    this.commands = manifest.commands || [];
    this.keywords = manifest.keywords || [];
    this.tool = manifest.tool;
    this.toolArgs = manifest.toolArgs || {};
    this.inputSchema = manifest.inputSchema;
    this.enabled = manifest.enabled !== false;
    this.llmPrompt = manifest.llmPrompt;
    this.permissions = manifest.permissions || [];
    this.author = manifest.author;
    this.version = manifest.version;
    if (manifest.source) {
      this.source = manifest.source;
    }
  }

  /**
   * Check whether the skill's commands or keywords match user input.
   */
  matches(input: string): boolean {
    const t = input.toLowerCase();
    return (
      this.commands.some((c) => t.includes(c.toLowerCase())) ||
      this.keywords.some((k) => t.includes(k.toLowerCase()))
    );
  }

  /**
   * Execute the skill based on its executor type.
   *
   * - If an executor is attached, delegates to executor.execute().
   * - Otherwise falls back to the existing callSkill behaviour (MCP call).
   */
  async execute(input: any, ctx: any): Promise<string> {
    if (this.executor) {
      switch (this.executor.type) {
        case "prompt":
          // Prompt-type skills just inject the llmPrompt into context.
          // Execution is handled by the LLM. Return the prompt directive.
          return this.llmPrompt || `Follow instructions for skill "${this.name}".`;

        case "code":
          // Code-type skills run a user-defined function.
          return await this.executor.execute(input, ctx);

        case "mcp":
          // MCP-type skills forward to the MCP client.
          return await this.executor.execute(input, ctx);

        case "workflow":
          // Workflow-type skills run a multi-step process.
          return await this.executor.execute(input, ctx);

        default:
          return `⚠️ Skill '${this.name}' has unknown executor type: ${(this.executor as any).type}`;
      }
    }

    // No executor attached — rely on MCP call via SkillRegistry
    return `⚠️ Skill '${this.name}' 暂无可用实现`;
  }

  /**
   * Serialise the skill to a JSON-manifest object (for persistence).
   */
  toJSON(): SkillManifest {
    return {
      name: this.name,
      description: this.description,
      commands: this.commands,
      keywords: this.keywords,
      tool: this.tool,
      toolArgs: this.toolArgs,
      inputSchema: this.inputSchema,
      enabled: this.enabled,
      llmPrompt: this.llmPrompt,
      permissions: this.permissions,
      author: this.author,
      version: this.version,
      source: this.source,
    };
  }
}

// ──────────────── SkillRegistry ────────────────

export class SkillRegistry {
  private skills: Skill[] = [];
  private mcp?: import("../core/mcp.js").MCPClient;
  readonly skillsDir: string;
  readonly userSkillsDir: string;
  readonly thirdPartySkillsDir: string;

  constructor(skillsDir?: string) {
    this.skillsDir =
      skillsDir || path.resolve(__dirname, "..", "..", "skills");
    this.userSkillsDir = path.join(this.skillsDir, "user-created");
    this.thirdPartySkillsDir = path.join(this.skillsDir, "third-party");

    // Ensure sub-directories exist
    fs.mkdirSync(this.userSkillsDir, { recursive: true });
    fs.mkdirSync(this.thirdPartySkillsDir, { recursive: true });
  }

  setMCP(mcp: import("../core/mcp.js").MCPClient) {
    this.mcp = mcp;
  }

  register(skill: Skill) {
    this.skills.push(skill);
  }

  /**
   * Load all skills from disk: built-in, directory, JSON, user-created, third-party.
   */
  async loadAll(): Promise<void> {
    this.skills = [];

    // Load from main skills directory (SKILL.md folders + JSON files)
    if (fs.existsSync(this.skillsDir)) {
      for (const item of fs.readdirSync(this.skillsDir)) {
        // Skip internal dirs (they're loaded separately)
        if (item === "user-created" || item === "third-party") continue;

        const itemPath = path.join(this.skillsDir, item);
        const stat = fs.statSync(itemPath);

        if (stat.isDirectory() && fs.existsSync(path.join(itemPath, "SKILL.md"))) {
          this.loadDirSkill(itemPath);
        } else if (item.startsWith("skill_") && item.endsWith(".json")) {
          this.loadJsonSkill(itemPath);
        }
      }
    }

    // Load user-created skills
    await this.loadUserSkills();

    // Load third-party skills
    await this.loadThirdPartySkills();

    // Built-in non-duplicates
    const existingNames = new Set(this.skills.map((s) => s.name));
    for (const s of this.builtinSkills()) {
      if (!existingNames.has(s.name)) this.register(s);
    }
  }

  /**
   * Load user-created skills from skills/user-created/.
   */
  async loadUserSkills(): Promise<void> {
    if (!fs.existsSync(this.userSkillsDir)) return;

    for (const item of fs.readdirSync(this.userSkillsDir)) {
      if (!item.endsWith(".json")) continue;

      const itemPath = path.join(this.userSkillsDir, item);
      try {
        const data = JSON.parse(fs.readFileSync(itemPath, "utf-8")) as SkillManifest;
        data.source = "user-created";
        const skill = new Skill(data);
        skill.path = itemPath;
        this.register(skill);
      } catch (e) {
        console.error(`[Skill] Failed to load user skill ${itemPath}:`, e);
      }
    }
  }

  /**
   * Load third-party skills from skills/third-party/.
   */
  async loadThirdPartySkills(): Promise<void> {
    if (!fs.existsSync(this.thirdPartySkillsDir)) return;

    for (const item of fs.readdirSync(this.thirdPartySkillsDir)) {
      if (!item.endsWith(".json")) continue;

      const itemPath = path.join(this.thirdPartySkillsDir, item);
      try {
        const data = JSON.parse(fs.readFileSync(itemPath, "utf-8")) as SkillManifest;
        data.source = "third-party";
        const skill = new Skill(data);
        skill.path = itemPath;
        this.register(skill);
      } catch (e) {
        console.error(`[Skill] Failed to load third-party skill ${itemPath}:`, e);
      }
    }
  }

  /**
   * Create a skill from conversation data (LLM-generated).
   *
   * Steps:
   *   1. Create the Skill object from the data
   *   2. Persist as JSON to skills/user-created/{name}.json
   *   3. Register it
   */
  createFromConversation(data: {
    name: string;
    description: string;
    commands: string[];
    type: string;
    tool?: string;
    llmPrompt?: string;
  }): Skill {
    const manifest: SkillManifest = {
      name: data.name,
      description: data.description,
      commands: data.commands || [],
      keywords: [],
      tool: data.tool,
      llmPrompt: data.llmPrompt,
      source: "user-created",
      enabled: true,
    };

    const skill = new Skill(manifest);
    this.saveUserSkill(skill);
    this.register(skill);
    return skill;
  }

  /**
   * Install a skill from an external source.
   *
   * Supported sources:
   *   - URL ending with .json → fetch and load
   *   - GitHub repo URL → git clone the skills directory
   *   - npm package name → npm install and find skill files
   */
  async installFromSource(source: string): Promise<Skill> {
    // JSON URL
    if (source.endsWith(".json") && (source.startsWith("http://") || source.startsWith("https://"))) {
      return this.installFromUrl(source);
    }

    // GitHub repo URL
    if (source.includes("github.com")) {
      return this.installFromGitHub(source);
    }

    // npm package
    if (!source.startsWith("http")) {
      return this.installFromNpm(source);
    }

    throw new Error(`Unknown skill source: ${source}`);
  }

  /**
   * Save a user-created skill to disk as JSON.
   */
  async saveUserSkill(skill: Skill): Promise<void> {
    const fileName = `skill_${skill.name.replace(/[^a-zA-Z0-9_-]/g, "_")}.json`;
    const filePath = path.join(this.userSkillsDir, fileName);
    fs.writeFileSync(filePath, JSON.stringify(skill.toJSON(), null, 2), "utf-8");
    skill.path = filePath;
  }

  /**
   * Filter skills by source.
   */
  listBySource(source: string): Skill[] {
    return this.listAll().filter((s) => s.source === source);
  }

  // ────────── private helpers ──────────

  private loadDirSkill(dirPath: string) {
    try {
      const content = fs.readFileSync(path.join(dirPath, "SKILL.md"), "utf-8");
      const manifest = this.parseSkillMd(content, path.basename(dirPath));
      const skill = new Skill(manifest);
      skill.path = dirPath;
      this.register(skill);
    } catch (e) {
      console.error(`[Skill] Failed to load ${dirPath}:`, e);
    }
  }

  private loadJsonSkill(jsonPath: string) {
    try {
      const data = JSON.parse(fs.readFileSync(jsonPath, "utf-8"));
      const skill = new Skill(data);
      skill.path = jsonPath;
      this.register(skill);
    } catch (e) {
      console.error(`[Skill] Failed to load ${jsonPath}:`, e);
    }
  }

  private parseSkillMd(content: string, fallbackName: string): SkillManifest {
    const lines = content.split("\n");
    const manifest: any = { name: fallbackName };

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const colonIdx = trimmed.indexOf(":");
      if (colonIdx === -1) continue;

      const key = trimmed.slice(0, colonIdx).trim().toLowerCase();
      const val = trimmed.slice(colonIdx + 1).trim();

      switch (key) {
        case "name": manifest.name = val; break;
        case "description": manifest.description = val; break;
        case "commands":
          manifest.commands = val.split(",").map((s: string) => s.trim()).filter(Boolean);
          break;
        case "keywords":
          manifest.keywords = val.split(",").map((s: string) => s.trim()).filter(Boolean);
          break;
        case "tool": manifest.tool = val; break;
        case "enabled": manifest.enabled = val === "true"; break;
        case "llmprompt": manifest.llmPrompt = val; break;
        case "permissions":
          manifest.permissions = val.split(",").map((s: string) => s.trim()).filter(Boolean);
          break;
        case "author": manifest.author = val; break;
        case "version": manifest.version = val; break;
      }
    }

    return manifest as SkillManifest;
  }

  private builtinSkills(): Skill[] {
    return [
      new Skill({
        name: "drug-verify",
        description: "药品真伪验证",
        commands: ["/drug", "/药品", "/验证"],
        keywords: ["药", "正品", "假药", "大宠爱", "拜耳", "速诺", "疫苗", "驱虫"],
      }),
      new Skill({
        name: "web-search",
        description: "联网搜索宠物相关信息",
        commands: ["/search", "/搜索"],
        keywords: ["怎么", "怎么办", "是什么", "为什么", "查询"],
        tool: "minimax.web_search",
        inputSchema: {
          type: "object",
          properties: {
            query: {
              type: "string",
              description: "要搜索的问题或关键词",
            },
          },
          required: ["query"],
        },
      }),
    ];
  }

  /**
   * Install a skill from a JSON URL.
   */
  private async installFromUrl(url: string): Promise<Skill> {
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`Failed to fetch skill from ${url}: ${response.status}`);
    }
    const manifest = (await response.json()) as SkillManifest;
    manifest.source = "third-party";
    const skill = new Skill(manifest);

    // Persist to third-party directory
    const fileName = `skill_${skill.name.replace(/[^a-zA-Z0-9_-]/g, "_")}.json`;
    const filePath = path.join(this.thirdPartySkillsDir, fileName);
    fs.writeFileSync(filePath, JSON.stringify(manifest, null, 2), "utf-8");
    skill.path = filePath;

    this.register(skill);
    return skill;
  }

  /**
   * Install skills from a GitHub repository.
   * Clones the repo and finds skill files in a `skills/` directory.
   */
  private async installFromGitHub(repoUrl: string): Promise<Skill> {
    // Normalise: strip trailing .git, ensure https://
    const cleanUrl = repoUrl.replace(/\.git$/, "").replace(/^git@/, "https://");
    const repoName = cleanUrl.split("/").pop() || "repo";

    const tempDir = path.join(this.thirdPartySkillsDir, `.tmp_${repoName}`);
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true });
    }

    // Clone the repo shallowly
    const { execSync } = await import("child_process");
    execSync(`git clone --depth 1 "${cleanUrl}" "${tempDir}"`, {
      stdio: "pipe",
      timeout: 60_000,
    });

    const skillsDir = path.join(tempDir, "skills");
    if (!fs.existsSync(skillsDir)) {
      fs.rmSync(tempDir, { recursive: true });
      throw new Error(`No skills/ directory found in ${cleanUrl}`);
    }

    let lastSkill: Skill | undefined;

    for (const item of fs.readdirSync(skillsDir)) {
      const itemPath = path.join(skillsDir, item);
      const stat = fs.statSync(itemPath);

      if (stat.isDirectory() && fs.existsSync(path.join(itemPath, "SKILL.md"))) {
        const content = fs.readFileSync(path.join(itemPath, "SKILL.md"), "utf-8");
        const manifest = this.parseSkillMd(content, item);
        manifest.source = "third-party";
        const skill = new Skill(manifest);

        // Copy SKILL.md to third-party directory
        const targetDir = path.join(this.thirdPartySkillsDir, item);
        fs.mkdirSync(targetDir, { recursive: true });
        fs.copyFileSync(path.join(itemPath, "SKILL.md"), path.join(targetDir, "SKILL.md"));

        this.register(skill);
        lastSkill = skill;
      } else if (item.endsWith(".json")) {
        const data = JSON.parse(fs.readFileSync(itemPath, "utf-8")) as SkillManifest;
        data.source = "third-party";
        const skill = new Skill(data);

        const fileName = `skill_${skill.name.replace(/[^a-zA-Z0-9_-]/g, "_")}.json`;
        const targetPath = path.join(this.thirdPartySkillsDir, fileName);
        fs.writeFileSync(targetPath, JSON.stringify(data, null, 2), "utf-8");

        this.register(skill);
        lastSkill = skill;
      }
    }

    // Cleanup temp
    fs.rmSync(tempDir, { recursive: true });

    if (!lastSkill) {
      throw new Error(`No skills found in ${cleanUrl}`);
    }

    return lastSkill;
  }

  /**
   * Install a skill from an npm package.
   * Runs npm install in the third-party directory and looks for skill files.
   */
  private async installFromNpm(packageName: string): Promise<Skill> {
    const { execSync } = await import("child_process");

    // Install the package into third-party/node_modules
    execSync(`npm install --no-save --prefix "${this.thirdPartySkillsDir}" "${packageName}"`, {
      stdio: "pipe",
      timeout: 120_000,
    });

    // Look for skill files in the installed package
    const nodeModulesDir = path.join(this.thirdPartySkillsDir, "node_modules");
    const pkgDir = path.join(nodeModulesDir, packageName);
    if (!fs.existsSync(pkgDir)) {
      // Try scoped package name
      const scopedDir = path.join(nodeModulesDir, `@${packageName}`);
      if (!fs.existsSync(scopedDir)) {
        throw new Error(`Package "${packageName}" not found in node_modules after install`);
      }
    }

    const skillsDir = fs.existsSync(pkgDir) ? pkgDir : path.join(nodeModulesDir, `@${packageName}`);

    let lastSkill: Skill | undefined;

    // Check for a skills/ directory in the package
    const pkgSkillsDir = path.join(skillsDir, "skills");
    if (fs.existsSync(pkgSkillsDir)) {
      for (const item of fs.readdirSync(pkgSkillsDir)) {
        const itemPath = path.join(pkgSkillsDir, item);
        const stat = fs.statSync(itemPath);

        if (stat.isDirectory() && fs.existsSync(path.join(itemPath, "SKILL.md"))) {
          const content = fs.readFileSync(path.join(itemPath, "SKILL.md"), "utf-8");
          const manifest = this.parseSkillMd(content, item);
          manifest.source = "third-party";
          const skill = new Skill(manifest);

          const targetDir = path.join(this.thirdPartySkillsDir, item);
          fs.mkdirSync(targetDir, { recursive: true });
          fs.copyFileSync(path.join(itemPath, "SKILL.md"), path.join(targetDir, "SKILL.md"));

          this.register(skill);
          lastSkill = skill;
        }
      }
    }

    // Also check for skill JSON files at package root
    for (const item of fs.readdirSync(skillsDir)) {
      if (item.endsWith(".json") && item.startsWith("skill_")) {
        const itemPath = path.join(skillsDir, item);
        const data = JSON.parse(fs.readFileSync(itemPath, "utf-8")) as SkillManifest;
        data.source = "third-party";
        const skill = new Skill(data);

        const targetPath = path.join(this.thirdPartySkillsDir, item);
        fs.writeFileSync(targetPath, JSON.stringify(data, null, 2), "utf-8");

        // Avoid duplicate skill names
        if (!this.findByLLMToolName(this.sanitizeToolName(skill.name))) {
          this.register(skill);
          lastSkill = skill;
        }
      }
    }

    if (!lastSkill) {
      throw new Error(`No skills found in npm package "${packageName}"`);
    }

    return lastSkill;
  }

  // ────────── Existing public API ──────────

  match(input: string): Skill | undefined {
    return this.skills.find((s) => s.enabled && s.matches(input));
  }

  listAll(): Skill[] {
    return this.skills.filter((s) => s.enabled);
  }

  findByLLMToolName(toolName: string): Skill | undefined {
    return this.listAll().find((skill) => this.sanitizeToolName(skill.name) === toolName);
  }

  listLLMTools(): Array<{
    name: string;
    description: string;
    input_schema: {
      type: "object";
      properties?: Record<string, any>;
      required?: string[];
      [key: string]: any;
    };
  }> {
    return this.listAll()
      .filter((skill) => skill.tool)
      .map((skill) => ({
        name: this.sanitizeToolName(skill.name),
        description: skill.description,
        input_schema: skill.inputSchema || {
          type: "object",
          properties: {
            prompt: {
              type: "string",
              description: "给工具的原始用户请求",
            },
          },
          required: ["prompt"],
        },
      }));
  }

  async callSkill(skill: Skill, input: string | Record<string, any>): Promise<string> {
    if (skill.tool && this.mcp) {
      const args = { ...skill.toolArgs };

      if (typeof input === "string") {
        if (!args.prompt && !args.query) {
          args.prompt = input;
        }
      } else {
        Object.assign(args, input);
        if (!args.prompt && !args.query) {
          args.prompt = JSON.stringify(input, null, 2);
        }
      }

      const result = await this.mcp.call(skill.tool, args);
      return result.message;
    }
    return `⚠️ Skill '${skill.name}' 暂无可用实现`;
  }

  private sanitizeToolName(name: string): string {
    if (name === "web-search") return "web_search";
    return `skill_${name.replace(/[^a-zA-Z0-9_]/g, "_")}`;
  }
}

export const registry = new SkillRegistry();
