/**
 * User-home data paths and onboarding helpers.
 *
 * This module manages the agent's real user data under `~/.PetAgent`.
 * It is intentionally separate from the in-project runtime/orchestration layer:
 * - `runtime` should mean the agent scheduler/orchestrator
 * - this file only handles user-home directories, templates, and bootstrap files
 *
 * The structure is intentionally close to OpenClaw:
 *   ~/.PetAgent/
 *     agents/<agentName>/
 *       agent/
 *         AGENTS.md
 *         SOUL.md
 *         USER.md
 *         MEMORY.md
 *         domain_context.md
 *         memory/
 *           daily/
 *           layered/
 *       sessions/
 *         session.sqlite
 *     workspace/<agentName>/
 */
import fs from "fs";
import os from "os";
import path from "path";

export interface UserHomePaths {
  packageRoot: string;
  homeRoot: string;
  petAgentConfigPath: string;
  agentName: string;
  agentRoot: string;
  agentDataDir: string;
  sessionsDir: string;
  sessionDbPath: string;
  workspaceRoot: string;
  workspaceDir: string;
  memoryDir: string;
  dailyDir: string;
  layeredDir: string;
  daemonDir: string;
  soulPath: string;
  userPath: string;
  visibleMemoryPath: string;
  domainContextPath: string;
  agentsFilePath: string;
  sessionSummaryPath: string;
  userProfilePath: string;
  workingStatePath: string;
  retrievalMemoryPath: string;
  daemonManifestPath: string;
}

export interface ResolveUserHomePathsOptions {
  homeRoot?: string;
  agentName?: string;
}

export interface OnboardUserHomeOptions extends ResolveUserHomePathsOptions {
  installDaemon?: boolean;
}

export interface HomeDocuments {
  soul: string;
  user: string;
  memory: string;
  domainContext: string;
}

export interface OnboardUserHomeResult {
  paths: UserHomePaths;
  created: string[];
}

function packageRoot() {
  return path.resolve(process.cwd());
}

function defaultHomeRoot() {
  if (process.env.PET_AGENT_HOME_ROOT?.trim()) {
    return path.resolve(process.env.PET_AGENT_HOME_ROOT.trim());
  }
  return path.join(os.homedir(), ".PetAgent");
}

export function resolveUserHomePaths(options: ResolveUserHomePathsOptions = {}): UserHomePaths {
  const root = packageRoot();
  const homeRoot = path.resolve(options.homeRoot || defaultHomeRoot());
  const agentName = sanitizeSegment(
    options.agentName
    || process.env.PET_AGENT_AGENT_NAME
    || process.env.PET_AGENT_USER_ID
    || "default",
  );
  const agentsRoot = path.join(homeRoot, "agents");
  const agentRoot = path.join(agentsRoot, agentName);
  const agentDataDir = path.join(agentRoot, "agent");
  const memoryDir = path.join(agentDataDir, "memory");
  const layeredDir = path.join(memoryDir, "layered");

  return {
    packageRoot: root,
    homeRoot,
    petAgentConfigPath: path.join(homeRoot, "PetAgent.json"),
    agentName,
    agentRoot,
    agentDataDir,
    sessionsDir: path.join(agentRoot, "sessions"),
    sessionDbPath: path.join(agentRoot, "sessions", "session.sqlite"),
    workspaceRoot: path.join(homeRoot, "workspace"),
    workspaceDir: path.join(homeRoot, "workspace", agentName),
    memoryDir,
    dailyDir: path.join(memoryDir, "daily"),
    layeredDir,
    daemonDir: path.join(homeRoot, "daemon"),
    soulPath: path.join(agentDataDir, "SOUL.md"),
    userPath: path.join(agentDataDir, "USER.md"),
    visibleMemoryPath: path.join(agentDataDir, "MEMORY.md"),
    domainContextPath: path.join(agentDataDir, "domain_context.md"),
    agentsFilePath: path.join(agentDataDir, "AGENTS.md"),
    sessionSummaryPath: path.join(layeredDir, "session_summary.md"),
    userProfilePath: path.join(layeredDir, "user_profile.json"),
    workingStatePath: path.join(layeredDir, "working_state.json"),
    retrievalMemoryPath: path.join(layeredDir, "retrieval_memory.jsonl"),
    daemonManifestPath: path.join(homeRoot, "daemon", `${agentName}.json`),
  };
}

export async function onboardUserHome(options: OnboardUserHomeOptions = {}): Promise<OnboardUserHomeResult> {
  const paths = resolveUserHomePaths(options);
  const created: string[] = [];

  ensureDir(paths.homeRoot, created);
  ensureDir(path.join(paths.homeRoot, "agents"), created);
  ensureDir(paths.agentRoot, created);
  ensureDir(paths.agentDataDir, created);
  ensureDir(paths.sessionsDir, created);
  ensureDir(paths.workspaceRoot, created);
  ensureDir(paths.workspaceDir, created);
  ensureDir(paths.memoryDir, created);
  ensureDir(paths.dailyDir, created);
  ensureDir(paths.layeredDir, created);

  ensureTextFile(paths.petAgentConfigPath, petAgentConfigTemplate(paths.agentName, paths.workspaceDir), created);
  ensureTextFile(paths.agentsFilePath, agentsTemplate(), created);
  ensureTextFile(paths.soulPath, soulTemplate(), created);
  ensureTextFile(paths.userPath, userTemplate(), created);
  ensureTextFile(paths.visibleMemoryPath, visibleMemoryTemplate(), created);
  ensureTextFile(paths.domainContextPath, domainContextTemplate(), created);
  ensureTextFile(path.join(paths.dailyDir, `${todayKey()}.md`), dailyTemplate(todayKey()), created);
  ensureTextFile(path.join(paths.workspaceDir, ".gitkeep"), "", created);
  ensureJsonFile(paths.userProfilePath, defaultUserProfile(), created);
  ensureJsonFile(paths.workingStatePath, defaultWorkingState(), created);
  ensureTextFile(paths.sessionSummaryPath, "# Session Summary\n\n- 暂无摘要。\n", created);
  ensureTextFile(paths.retrievalMemoryPath, "", created);

  if (options.installDaemon) {
    ensureDir(paths.daemonDir, created);
    ensureJsonFile(paths.daemonManifestPath, daemonManifest(paths), created);
  }

  return { paths, created };
}

export async function ensureUserHomeReady(options: ResolveUserHomePathsOptions = {}) {
  const result = await onboardUserHome(options);
  return result.paths;
}

export function readHomeDocuments(paths: UserHomePaths): HomeDocuments {
  return {
    soul: readText(paths.soulPath),
    user: readText(paths.userPath),
    memory: readText(paths.visibleMemoryPath),
    domainContext: readText(paths.domainContextPath),
  };
}

function readText(filePath: string) {
  try {
    return fs.readFileSync(filePath, "utf-8").trim();
  } catch {
    return "";
  }
}

function ensureDir(dirPath: string, created: string[]) {
  if (fs.existsSync(dirPath)) return;
  fs.mkdirSync(dirPath, { recursive: true });
  created.push(dirPath);
}

function ensureTextFile(filePath: string, content: string, created: string[]) {
  if (fs.existsSync(filePath)) return;
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, "utf-8");
  created.push(filePath);
}

function ensureJsonFile(filePath: string, value: unknown, created: string[]) {
  if (fs.existsSync(filePath)) return;
  ensureTextFile(filePath, `${JSON.stringify(value, null, 2)}\n`, created);
}

function sanitizeSegment(value: string) {
  return value.trim().replace(/[^a-zA-Z0-9_-]+/g, "-").replace(/^-+|-+$/g, "") || "default";
}

function todayKey() {
  return new Date().toISOString().slice(0, 10);
}

function agentsTemplate() {
  return [
    "# AGENTS.md - 毛孩子健康顾问工作台",
    "",
    "_这是运行时用户目录中的 Agent 说明。_",
    "",
    "## 每次对话开始前",
    "",
    "1. 读取 `SOUL.md`",
    "2. 读取 `MEMORY.md`",
    "3. 检查 `memory/daily/YYYY-MM-DD.md`（不存在则创建）",
    "",
    "## 记忆文件",
    "",
    "- `SOUL.md`：角色风格与原则",
    "- `USER.md`：当前宠物主人的资料与偏好",
    "- `MEMORY.md`：用户可见记忆摘要",
    "- `domain_context.md`：垂直业务规则与背景",
    "- `memory/layered/*`：结构化分层 memory",
    "- `sessions/session.sqlite`：原始会话、工具动作与附件",
    "",
  ].join("\n");
}

function soulTemplate() {
  return [
    "# SOUL.md",
    "",
    "你是「毛孩子健康顾问」🐾。",
    "",
    "## 角色原则",
    "",
    "- 先理解宠物种类、年龄、症状与持续时间。",
    "- 优先判断紧急程度；呼吸困难、严重出血、抽搐、持续呕吐腹泻等情况要立即建议就医。",
    "- 给出清晰、可执行、温和的建议。",
    "- 明确说明你不是兽医诊断，只做初步建议。",
    "- 用药安全优先，不确定时不要乱推荐。",
    "",
    "## 表达风格",
    "",
    "- 语气温柔、专业、让人安心。",
    "- 适当使用 emoji 和分点。",
    "- 结尾可提醒“如有问题随时问”。",
    "",
  ].join("\n");
}

function userTemplate() {
  return [
    "# USER.md",
    "",
    "- 用户称呼：未设置",
    "- 宠物信息：待补充",
    "- 沟通偏好：希望回答清晰、直接、可操作",
    "",
  ].join("\n");
}

function visibleMemoryTemplate() {
  return [
    "# MEMORY.md - 记忆摘要",
    "",
    "> 这是面向用户可见的记忆摘要，会随着对话自动整理更新。",
    "",
    "## 用户画像",
    "- 暂无稳定画像。",
    "",
    "## 当前会话摘要",
    "- 暂无会话摘要。",
    "",
    "## 近期重要记忆",
    "- 暂无长期记忆。",
    "",
  ].join("\n");
}

function domainContextTemplate() {
  return [
    "# Domain Context",
    "",
    "- 当前 Agent 服务于宠物健康咨询场景。",
    "- 需要优先收集宠物种类、年龄、体重、症状、持续时间和精神食欲情况。",
    "- 涉及紧急风险时，优先建议线下就医，不要拖延。",
    "- 所有建议都应强调用药安全与观察指标。",
    "",
  ].join("\n");
}

function dailyTemplate(dateKey: string) {
  return `# ${dateKey} 日志\n\n`;
}

function defaultUserProfile() {
  return {
    preferences: {
      answerStyle: "direct",
      responseLength: "concise",
      formatting: ["bullet points"],
    },
    traits: [],
    stableFacts: {},
  };
}

function defaultWorkingState() {
  return {
    status: "idle",
    turnCount: 0,
    vars: {},
  };
}

function daemonManifest(paths: UserHomePaths) {
  return {
    name: `petagent-${paths.agentName}`,
    command: "petagent",
    args: [],
    homeRoot: paths.homeRoot,
    agentRoot: paths.agentRoot,
    workspaceDir: paths.workspaceDir,
    createdAt: new Date().toISOString(),
    note: "MVP daemon manifest. Future versions can translate this into launchd/systemd/pm2 installation.",
  };
}

function petAgentConfigTemplate(agentName: string, workspaceDir: string) {
  return `${JSON.stringify({
    meta: {
      version: "1.0.0",
      lastTouchedAt: new Date().toISOString(),
    },
    models: {
      mode: "merge",
      providers: {
        "minimax-portal": {
          baseUrl: "https://api.minimaxi.com/anthropic",
          apiKey: "",
          authMethod: "apiKey",
          oauth: {
            enabled: false,
            accessToken: "",
            refreshToken: "",
            accountId: "",
            accountLabel: "",
          },
          api: "anthropic-messages",
          models: [
            {
              id: "MiniMax-M2.7",
              name: "MiniMax M2.7",
              api: "anthropic-messages",
              reasoning: true,
              input: ["text"],
              contextWindow: 200000,
              maxTokens: 8192,
            },
          ],
        },
        openai: {
          baseUrl: "https://api.openai.com/v1",
          apiKey: "",
          authMethod: "apiKey",
          oauth: {
            enabled: false,
            accessToken: "",
            refreshToken: "",
            accountId: "",
            accountLabel: "",
          },
          api: "openai-completions",
          models: [
            {
              id: "gpt-4o-mini",
              name: "GPT-4o Mini",
              api: "openai-completions",
              reasoning: false,
              input: ["text", "image"],
              contextWindow: 128000,
              maxTokens: 16384,
            },
          ],
        },
        deepseek: {
          baseUrl: "https://api.deepseek.com/v1",
          apiKey: "",
          authMethod: "apiKey",
          oauth: {
            enabled: false,
            accessToken: "",
            refreshToken: "",
            accountId: "",
            accountLabel: "",
          },
          api: "openai-completions",
          models: [
            {
              id: "deepseek-chat",
              name: "DeepSeek Chat",
              api: "openai-completions",
              reasoning: false,
              input: ["text"],
              contextWindow: 64000,
              maxTokens: 8192,
            },
            {
              id: "deepseek-reasoner",
              name: "DeepSeek Reasoner",
              api: "openai-completions",
              reasoning: true,
              input: ["text"],
              contextWindow: 64000,
              maxTokens: 8192,
            },
          ],
        },
      },
    },
    agents: {
      defaults: {
        model: {
          primary: "minimax-portal/MiniMax-M2.7",
          fallbacks: ["openai/gpt-4o-mini"],
        },
        workspace: workspaceDir,
        compaction: {
          mode: "safeguard",
        },
      },
      list: [
        {
          id: agentName,
          name: agentName,
          workspace: workspaceDir,
          agentDir: "",
          model: {
            primary: "minimax-portal/MiniMax-M2.7",
            fallbacks: ["openai/gpt-4o-mini"],
          },
        },
      ],
    },
  }, null, 2)}\n`;
}
