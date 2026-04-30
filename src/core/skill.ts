/**
 * Skill system - plugin architecture for pet-agent.
 * Supports two formats:
 *   1. skills/skill-name/SKILL.md (directory skill)
 *   2. skills/skill_*.json (JSON manifest)
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

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
}

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

  constructor(manifest: SkillManifest) {
    this.name = manifest.name;
    this.description = manifest.description || "";
    this.commands = manifest.commands || [];
    this.keywords = manifest.keywords || [];
    this.tool = manifest.tool;
    this.toolArgs = manifest.toolArgs || {};
    this.inputSchema = manifest.inputSchema;
    this.enabled = manifest.enabled !== false;
  }

  matches(input: string): boolean {
    const t = input.toLowerCase();
    return (
      this.commands.some((c) => t.includes(c.toLowerCase())) ||
      this.keywords.some((k) => t.includes(k.toLowerCase()))
    );
  }
}

export class SkillRegistry {
  private skills: Skill[] = [];
  private mcp?: import("../core/mcp.js").MCPClient;
  readonly skillsDir: string;

  constructor(skillsDir?: string) {
    this.skillsDir =
      skillsDir ||
      path.resolve(__dirname, "..", "..", "skills");
  }

  setMCP(mcp: import("../core/mcp.js").MCPClient) {
    this.mcp = mcp;
  }

  register(skill: Skill) {
    this.skills.push(skill);
  }

  async loadAll(): Promise<void> {
    this.skills = [];

    // Load from directory
    if (fs.existsSync(this.skillsDir)) {
      for (const item of fs.readdirSync(this.skillsDir)) {
        const itemPath = path.join(this.skillsDir, item);
        const stat = fs.statSync(itemPath);

        if (stat.isDirectory() && fs.existsSync(path.join(itemPath, "SKILL.md"))) {
          this.loadDirSkill(itemPath);
        } else if (item.startsWith("skill_") && item.endsWith(".json")) {
          this.loadJsonSkill(itemPath);
        }
      }
    }

    // Built-in non-duplicates
    const existingNames = new Set(this.skills.map((s) => s.name));
    for (const s of this.builtinSkills()) {
      if (!existingNames.has(s.name)) this.register(s);
    }
  }

  private loadDirSkill(dirPath: string) {
    try {
      const content = fs.readFileSync(path.join(dirPath, "SKILL.md"), "utf-8");
      const manifest = this.parseSkillMd(content, path.basename(dirPath));
      this.register(new Skill(manifest));
    } catch (e) {
      console.error(`[Skill] Failed to load ${dirPath}:`, e);
    }
  }

  private loadJsonSkill(jsonPath: string) {
    try {
      const data = JSON.parse(fs.readFileSync(jsonPath, "utf-8"));
      this.register(new Skill(data));
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

  private sanitizeToolName(name: string): string {
    if (name === "web-search") return "web_search";
    return `skill_${name.replace(/[^a-zA-Z0-9_]/g, "_")}`;
  }

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
}

export const registry = new SkillRegistry();
