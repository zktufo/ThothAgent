/**
 * User-home data paths and onboarding helpers.
 *
 * This module manages the agent's real user data under `~/.ThothAgent`.
 * It is intentionally separate from the in-project runtime/orchestration layer:
 * - `runtime` should mean the agent scheduler/orchestrator
 * - this file only handles user-home directories, templates, and bootstrap files
 *
 * The structure is the canonical ThothAgent runtime layout:
 *   ~/.ThothAgent/
 *     AGENTS.md
 *     agents/<agentName>/
 *       SOUL.md
 *       USER.md
 *       MEMORY.md
 *       DOMAIN.md
 *       memory/
 *         daily/
 *         layered/
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
  thothAgentConfigPath: string;
  agentName: string;
  agentRoot: string;
  agentDataDir: string;
  sessionsDir: string;
  sessionDbPath: string;
  sessionIndexPath: string;
  workspaceRoot: string;
  workspaceDir: string;
  dailyDir: string;
  memoryDir: string;
  layeredDir: string;
  daemonDir: string;
  soulPath: string;
  userPath: string;
  visibleMemoryPath: string;
  domainContextPath: string;
  agentsFilePath: string;
  workingStatePath: string;
  retrievalMemoryPath: string;
  retrievalDbPath: string;
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
  agents: string;
  soul: string;
  user: string;
  memory: string;
  domainContext: string;
}

export interface OnboardUserHomeResult {
  paths: UserHomePaths;
  created: string[];
}

export interface EnsureAgentHomeOptions extends ResolveUserHomePathsOptions {
  installDaemon?: boolean;
}

function packageRoot() {
  return path.resolve(process.cwd());
}

function defaultHomeRoot() {
  if (process.env.THOTH_AGENT_HOME_ROOT?.trim()) {
    return path.resolve(process.env.THOTH_AGENT_HOME_ROOT.trim());
  }
  return path.join(os.homedir(), ".ThothAgent");
}

export function resolveUserHomePaths(options: ResolveUserHomePathsOptions = {}): UserHomePaths {
  const root = packageRoot();
  const homeRoot = path.resolve(options.homeRoot || defaultHomeRoot());
  const agentName = sanitizeSegment(
    options.agentName
    || process.env.THOTH_AGENT_AGENT_NAME
    || process.env.THOTH_AGENT_USER_ID
    || "main",
  );
  const agentsRoot = path.join(homeRoot, "agents");
  const agentRoot = path.join(agentsRoot, agentName);
  const agentDataDir = agentRoot;
  const memoryDir = path.join(agentDataDir, "memory");
  const layeredDir = path.join(memoryDir, "layered");

  return {
    packageRoot: root,
    homeRoot,
    thothAgentConfigPath: path.join(homeRoot, "ThothAgent.json"),
    agentName,
    agentRoot,
    agentDataDir,
    sessionsDir: path.join(agentRoot, "sessions"),
    sessionDbPath: path.join(agentRoot, "sessions", "session.sqlite"),
    sessionIndexPath: path.join(agentRoot, "sessions", "session.json"),
    workspaceRoot: path.join(homeRoot, "workspace"),
    workspaceDir: path.join(homeRoot, "workspace", agentName),
    memoryDir,
    dailyDir: path.join(memoryDir, "daily"),
    layeredDir,
    daemonDir: path.join(homeRoot, "daemon"),
    soulPath: path.join(agentDataDir, "SOUL.md"),
    userPath: path.join(agentDataDir, "USER.md"),
    visibleMemoryPath: path.join(agentDataDir, "MEMORY.md"),
    domainContextPath: path.join(agentDataDir, "DOMAIN.md"),
    agentsFilePath: path.join(homeRoot, "AGENTS.md"),
    workingStatePath: path.join(layeredDir, "working_state.json"),
    retrievalMemoryPath: path.join(layeredDir, "retrieval_memory.db"),
    retrievalDbPath: path.join(layeredDir, "retrieval_memory.db"),
    daemonManifestPath: path.join(homeRoot, "daemon", `${agentName}.json`),
  };
}

export async function onboardUserHome(options: OnboardUserHomeOptions = {}): Promise<OnboardUserHomeResult> {
  return ensureAgentHome(options);
}

export async function ensureUserHomeReady(options: ResolveUserHomePathsOptions = {}) {
  const result = await onboardUserHome(options);
  return result.paths;
}

export async function ensureAgentHome(options: EnsureAgentHomeOptions = {}): Promise<OnboardUserHomeResult> {
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

  ensureTextFile(paths.thothAgentConfigPath, thothAgentConfigTemplate(paths.agentName, paths.workspaceDir), created);
  ensureTextFile(paths.agentsFilePath, agentsTemplate(), created);
  ensureTextFile(paths.soulPath, soulTemplate(), created);
  ensureTextFile(paths.userPath, userTemplate(), created);
  ensureTextFile(paths.visibleMemoryPath, visibleMemoryTemplate(), created);
  ensureTextFile(paths.domainContextPath, domainContextTemplate(), created);
  ensureTextFile(path.join(paths.workspaceDir, ".gitkeep"), "", created);
  ensureJsonFile(paths.workingStatePath, defaultWorkingState(), created);
  ensureTextFile(paths.retrievalMemoryPath, "", created);

  if (options.installDaemon) {
    ensureDir(paths.daemonDir, created);
    ensureJsonFile(paths.daemonManifestPath, daemonManifest(paths), created);
  }

  return { paths, created };
}

export function readHomeDocuments(paths: UserHomePaths): HomeDocuments {
  return {
    agents: readText(paths.agentsFilePath),
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
  const normalized = value.trim().replace(/[^a-zA-Z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
  if (!normalized || normalized === "default") return "main";
  return normalized;
}

function agentsTemplate() {
  return [
    "# AGENTS.md - ThothAgent Agent Manual",
    "",
    "_这是运行时用户目录根目录中的全局 Agent 操作手册。该文件会在 session 启动时进入 LLM System Prompt，用于定义 agent 的长期操作规则。_",
    "",
    "## 定位",
    "",
    "- 你是 ThothAgent，一个可持续自我改进的通用垂直领域 agent。",
    "- 你通过工具、技能、会话历史、内置记忆文件和外置 memory provider 协作完成任务。",
    "- 你的目标不是只回答当前问题，而是逐步沉淀用户偏好、项目经验和领域知识，让后续会话更可靠。",
    "",
    "## Session 启动手册",
    "",
    "- 启动时读取当前 agent 目录下的 `SOUL.md`、`USER.md`、`MEMORY.md`、`DOMAIN.md`。",
    "- 启动时读取到的内置记忆会被冻结为本 session 的 Frozen Memory Snapshot。",
    "- 当前 session 中即使通过 `memory` 工具改写内置记忆文件，通常也要下一个 session 才会重新注入。",
    "- 回答用户时优先使用 Frozen Memory Snapshot 中的稳定信息；需要回忆历史时优先使用 `memory_search`。",
    "",
    "## 文件结构",
    "",
    "- `~/.ThothAgent/AGENTS.md`：全局 agent 操作手册，本文件。",
    "- `~/.ThothAgent/ThothAgent.json`：模型、provider、agent、workspace 和 memory 配置。",
    "- `~/.ThothAgent/agents/main/`：默认主 agent 数据目录；其他 agent 位于 `agents/{agentId}/`。",
    "- `SOUL.md`：角色风格、人格边界、处理原则。",
    "- `USER.md`：用户称呼、偏好、沟通风格、长期习惯、稳定身份信息。",
    "- `MEMORY.md`：项目事实、长期约定、反复验证有效的经验、跨会话仍有效的结论。",
    "- `DOMAIN.md`：领域规则、术语、流程边界、业务知识、系统能力约束。",
    "- `memory/layered/working_state.json`：当前 agent 的短期工作状态，由系统自动维护。",
    "- `memory/layered/retrieval_memory.db`：外置长期检索记忆，默认由 local-file provider 维护。",
    "- `sessions/session.sqlite`：完整会话历史、工具动作、附件与事件。",
    "- `sessions/session.json`：会话索引和 active session 信息。",
    "- `workspace/{agentId}/`：agent 的默认工作区。",
    "",
    "## 记忆规则",
    "",
    "- 内置记忆文件包括 `USER.md`、`MEMORY.md`、`DOMAIN.md`，它们是用户可读、可编辑的长期操作上下文。",
    "- 当信息满足稳定、长期、高价值、未来大概率还会用到时，应该考虑调用 `memory` 工具，而不是只在当前回答里提一下。",
    "- 写入 `USER.md`：用户称呼、偏好、沟通风格、长期习惯、稳定身份信息。",
    "- 写入 `MEMORY.md`：项目事实、长期约定、反复验证有效的经验、跨会话仍有效的结论。",
    "- 写入 `DOMAIN.md`：领域规则、术语、流程边界、业务知识、系统能力约束。",
    "- 判断口诀：关于这个用户怎么沟通或喜欢什么，写 `user`；关于这个项目或这类任务以后怎么做，写 `memory`；关于垂直领域本身的规则和知识，写 `domain`。",
    "- 临时寒暄、一次性上下文、当前轮临时任务、短期情绪、低信息量短句不要写入长期记忆。",
    "- 写入内容必须是单条、明确、去歧义的完整句子，不要写模糊代词，不要只写“这个”“上面那个”“刚才说的”。",
    "- `memory add` 适合新增长期记忆；`memory replace` 适合纠正旧记忆或更新过时规则；`memory remove` 适合删除错误、过期、冲突的信息。",
    "- 如果用户明确说“记住这个”“以后都这样”“把这个作为默认规则”，应优先考虑调用 `memory`。",
    "- 希望未来能被 `memory_search` 稳定召回的信息，应先整理成明确、可复用、去歧义的长期记忆，再调用 `memory`。",
    "",
    "## 记忆写入示例",
    "",
    "- 用户说“以后回答先给结论，再列风险”：调用 `memory`，target=`user`。",
    "- 项目约定“默认主 agent 是 main，工作空间是 ~/.ThothAgent/workspace/main”：调用 `memory`，target=`memory`。",
    "- 领域稳定规则“某类药物不应与另一类药物同时使用”：调用 `memory`，target=`domain`。",
    "- 用户只说“好的谢谢”“我先去试试”：不调用 `memory`。",
    "",
    "## 回复规则",
    "",
    "- 默认使用中文回答，除非用户指定其他语言。",
    "- 先给结论，再给依据、步骤、风险和下一步。",
    "- 回复要清晰、可执行、可验证；避免空泛套话。",
    "- 重要信息可以加粗，但不要过度格式化。",
    "- 不确定时明确说明不确定性，并给出可验证路径。",
    "- 高风险问题要先提示边界和必要的人工确认。",
    "",
    "## 工具与安全策略",
    "",
    "- 你可以使用工具完成检索、执行命令、读写文件、管理 agent、搜索记忆和写入记忆。",
    "- 工具调用前先判断必要性；能直接可靠回答的问题不必强行调用工具。",
    "- `exec` 命令运行在沙箱中，禁止危险系统操作，例如 `rm -rf /`、`sudo`、破坏性系统写入和不可审计的批量删除。",
    "- `read` / `write` 应限制在项目目录、`~/.ThothAgent/workspace` 和临时目录等允许范围内。",
    "- 所有工具调用都会被审计记录。",
    "- 涉及凭证、令牌、隐私数据和外部发布操作时，要格外谨慎，只保存必要信息，不在回答中泄露敏感值。",
    "",
  ].join("\n");
}

function soulTemplate() {
  return [
    "# SOUL.md",
    "",
    "你是 ThothAgent，一个可持续自我改进的垂直领域智能代理。",
    "",
    "## 角色原则",
    "",
    "- 先识别用户目标、上下文约束、关键风险与需要澄清的信息。",
    "- 先给结论，再补充依据、步骤和后续建议。",
    "- 对高风险、强不确定性或需要人工介入的问题，要明确提示边界。",
    "- 优先给出清晰、可执行、可验证的建议。",
    "- 主动沉淀对未来有价值的稳定偏好、流程经验和领域知识。",
    "",
    "## 表达风格",
    "",
    "- 语气专业、克制、友好。",
    "- 默认结构化表达，必要时用分点和短段落。",
    "- 避免空泛措辞，优先输出高信息密度内容。",
    "",
  ].join("\n");
}

function userTemplate() {
  return [
    "# USER.md",
    "",
    "- 用户称呼：未设置",
    "- 领域背景：待补充",
    "- 沟通偏好：希望回答清晰、直接、可操作",
    "",
  ].join("\n");
}

function visibleMemoryTemplate() {
  return [
    "# MEMORY.md - 记忆摘要",
    "",
    "> 这是内置长期记忆文件。可由 agent 通过 memory 工具维护，也可由用户手动编辑。",
    "",
    "- 暂无长期记忆。",
    "",
  ].join("\n");
}

function domainContextTemplate() {
  return [
    "# DOMAIN.md",
    "",
    "- 当前 Agent 面向可配置的垂直领域任务。",
    "- 需要优先识别领域目标、关键实体、约束条件、风险信号与可执行动作。",
    "- 涉及高风险决策、合规要求或线下操作时，应优先提示边界与人工确认。",
    "- 所有建议都应尽量给出判断依据、执行步骤和可观测结果。",
    "",
  ].join("\n");
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
    name: `thoth-${paths.agentName}`,
    command: "thoth",
    args: [],
    homeRoot: paths.homeRoot,
    agentRoot: paths.agentRoot,
    workspaceDir: paths.workspaceDir,
    createdAt: new Date().toISOString(),
    note: "MVP daemon manifest. Future versions can translate this into launchd/systemd/pm2 installation.",
  };
}

function thothAgentConfigTemplate(agentName: string, workspaceDir: string) {
  const workspaceRoot = path.dirname(workspaceDir);
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
    memory: {
      externalProvider: {
        kind: "local-file",
        options: {},
      },
    },
    agents: {
      defaults: {
        model: {
          primary: "minimax-portal/MiniMax-M2.7",
          fallbacks: ["openai/gpt-4o-mini"],
        },
        agent: "main",
        workspace: workspaceRoot,
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
