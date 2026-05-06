#!/usr/bin/env node
/**
 * thoth CLI - rich terminal interface for ThothAgent.
 */
import chalk from "chalk";
import fs from "fs";
import http from "http";
import path from "path";
import { spawn } from "child_process";
import { ThothAgent } from "../agent/index.js";
import type { ToolTraceEvent } from "../llm/index.js";
import { ensureUserHomeReady, onboardUserHome } from "../home/index.js";
import { ModelManager } from "../model_manager/index.js";
import { runConfigureWizard } from "./configure_wizard.js";
import { GatewayCliClient, type GatewayConnectionState, type GatewayStreamEvent } from "./gateway_client.js";

const CLI_NAME = "thoth";

const C = {
  dim:     chalk.dim,
  bold:    chalk.bold,
  cyan:    chalk.cyan,
  green:   chalk.green,
  yellow:  chalk.yellow,
  red:     chalk.red,
  blue:    chalk.blue,
  magenta: chalk.magenta,
  white:   chalk.white,
  gray:    chalk.gray,
  muted:   chalk.gray,
};

function readFlagValue(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  if (index === -1) return undefined;
  const value = args[index + 1];
  if (!value || value.startsWith("--")) return undefined;
  return value;
}

function ts() {
  return new Date().toLocaleTimeString("zh-CN", { hour12: false });
}

function terminalWidth() {
  return Math.max(58, Math.min(process.stdout.columns || 100, 140));
}

function rule(char = "─") {
  return C.muted(char.repeat(terminalWidth()));
}

function panel(content: string, opts: { title?: string; borderColor?: string; color?: (s: string) => string } = {}) {
  const { title = "", color = (s: string) => s } = opts;
  const heading = title ? `${C.yellow("◇")} ${C.bold(title)}` : "";
  return [heading, color(content)].filter(Boolean).join("\n");
}

function userPanel(content: string) {
  const width = terminalWidth();
  const bg = chalk.bgHex("#252b33").whiteBright;
  const lines = content.split("\n");
  return lines.map((line) => bg(` ${line}${" ".repeat(Math.max(1, width - line.length - 1))}`)).join("\n");
}

function botPanel(content: string) {
  return content;
}

function renderMarkdown(text: string): string {
  return text
    // Bold
    .replace(/\*\*(.+?)\*\*/g, C.bold("$1"))
    // Code
    .replace(/`(.+?)`/g, C.cyan("$1"))
    // Headers
    .replace(/^### (.+)$/gm, C.bold.cyan("$1"))
    .replace(/^## (.+)$/gm, C.bold.cyan("$1"))
    .replace(/^# (.+)$/gm, C.bold.cyan("$1"))
    // Lists
    .replace(/^(\d+)\. (.+)$/gm, (_, n, t) => `${C.yellow(n + ".")} ${t}`)
    .replace(/^[-*] (.+)$/gm, (_, t) => `${C.green("•")} ${t}`)
    // Tables (simple)
    .replace(/^\|(.+)\|$/gm, (row) => {
      const cells = row.split("|").filter(Boolean).map(c => c.trim());
      return cells.join(C.muted(" │ "));
    })
    // Dividers
    .replace(/^---+$/gm, C.muted("─".repeat(50)))
    // Escape remaining color tags
    ;
}

async function statusBar(agent: ThothAgent) {
  const u = agent.llm.usage;
  const frac = u.usageFraction;
  const session = await agent.runtime.sessions.getCurrentSession();

  return [
    `· ${C.gray("idl")} ${C.yellow("•")} ${C.yellow("connected")}`,
    `${C.gray(`agent ${agent.runtime.memory.homePaths.agentName}`)} ${C.muted("|")} ${C.gray(`session ${session.sessionKey}`)} ${C.muted("|")} ${C.gray(agent.runtime.lastProviderLabel)} ${C.muted("|")} ${C.gray(`tokens ${Math.floor(u.totalTokens / 1000)}k/${Math.floor(u.maxTokens / 1000)}k (${Math.floor(frac * 100)}%)`)}`,
  ].join("\n");
}

function gatewayStatusBar(status: any, connected: boolean) {
  const runtime = status?.runtime || {};
  const usage = runtime.tokenUsage || {};
  const indexed = runtime.sessionIndex || {};
  const frac = Number(usage.usageFraction || 0);
  const dot = connected ? C.green("•") : C.gray("•");
  const label = connected ? C.green("connected") : C.gray("disconnected");
  return [
    `· ${C.gray("gwy")} ${dot} ${label}`,
    `${C.gray(`agent ${runtime.agentId || "main"}`)} ${C.muted("|")} ${C.gray(`session ${runtime.sessionKey || "-"}`)} ${C.muted("|")} ${C.gray(`index ${indexed.sessionKey || "-"}`)} ${C.muted("|")} ${C.gray(runtime.activeModel || "-")} ${C.muted("|")} ${C.gray(`tokens ${Math.floor((usage.totalTokens || 0) / 1000)}k/${Math.floor((usage.maxTokens || 0) / 1000)}k (${Math.floor(frac * 100)}%)`)}`,
  ].join("\n");
}

function renderHistoryMessages(messages: any[]) {
  for (const message of messages) {
    const content = message.contentSummary || message.content || "";
    if (!content) continue;
    if (message.role === "user") {
      console.log(userPanel(content));
    } else if (message.role === "assistant") {
      console.log(botPanel(renderMarkdown(content)));
    } else if (message.role === "tool") {
      console.log(panel(content, { title: `Tool ${message.toolName || ""}`.trim(), color: (s) => C.muted(s) }));
    }
  }
}

async function runGatewayChat(
  client: GatewayCliClient,
  input: string,
  setEventHandler: (handler: ((event: GatewayStreamEvent) => void) | null) => void,
) {
  const trace: ToolTraceEvent[] = [];
  let timings: Array<{ label: string; elapsed: number }> = [];

  return new Promise<{ text: string; trace: ToolTraceEvent[]; timings: Array<{ label: string; elapsed: number }>; session?: any }>(async (resolve, reject) => {
    let runId = "";
    setEventHandler((event) => {
      if (event.event !== "chat.stream") return;
      const payload = event.payload as any;
      if (!runId || payload.runId !== runId) return;

      if (payload.stream === "tool" && payload.data) {
        trace.push(payload.data as ToolTraceEvent);
        return;
      }

      if (payload.stream === "timing") {
        timings = Array.isArray(payload.data) ? payload.data : [];
        return;
      }

      if (payload.stream === "lifecycle" && payload.phase === "end") {
        setEventHandler(null);
        resolve({
          text: String(payload.text || ""),
          trace,
          timings,
          session: payload.session,
        });
        return;
      }

      if (payload.stream === "lifecycle" && payload.phase === "error") {
        setEventHandler(null);
        reject(new Error(String(payload.error || "gateway chat error")));
      }
    });

    try {
      const accepted = await client.request<any>("chat.send", { message: input, agentId: "main" });
      runId = String(accepted.runId || "");
    } catch (error) {
      setEventHandler(null);
      reject(error);
    }
  });
}

function openBrowser(url: string) {
  const command = process.platform === "darwin"
    ? "open"
    : process.platform === "win32"
      ? "cmd"
      : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  const child = spawn(command, args, {
    detached: true,
    stdio: "ignore",
  });
  child.unref();
}

function isHttpReachable(url: string) {
  return new Promise<boolean>((resolve) => {
    const req = http.get(url, (res) => {
      res.resume();
      resolve(Boolean(res.statusCode && res.statusCode >= 200 && res.statusCode < 500));
    });
    req.setTimeout(500, () => {
      req.destroy();
      resolve(false);
    });
    req.on("error", () => resolve(false));
  });
}

function formatTracePayload(payload?: Record<string, any>): string {
  if (!payload || Object.keys(payload).length === 0) return "{}";
  const compact = JSON.stringify(payload);
  return compact.length <= 64 ? compact : `${compact.slice(0, 63)}…`;
}

function renderCliHelp() {
  const lines = [
    `${C.bold.cyan("△ ThothAgent")} ${C.muted("—")} ${C.white("CLI Command Center")}`,
    "",
    `${C.bold("用法")}`,
    `  ${CLI_NAME} <command> [options]`,
    "",
    `${C.bold("Setup")}`,
    `  ${CLI_NAME} onboard [--install-daemon]`,
    `  ${CLI_NAME} configure`,
    "",
    `${C.bold("Gateway")}`,
    `  ${CLI_NAME} gateway [--host 127.0.0.1] [--port 18889]`,
    `  ${CLI_NAME} dashboard [--host 127.0.0.1] [--port 18889]`,
    "",
    `${C.bold("Model")}`,
    `  ${CLI_NAME} model list`,
    `  ${CLI_NAME} model current`,
    `  ${CLI_NAME} model use <primary> [fallback1,fallback2]`,
    "",
    `${C.bold("Runtime")}`,
    `  ${CLI_NAME} tui`,
    "",
    `${C.bold("说明")}`,
    `  ${CLI_NAME} ${C.muted("默认仅输出帮助，不自动进入 TUI")}`,
    `  ${CLI_NAME} tui ${C.muted("进入交互式终端工作台")}`,
    `  ${CLI_NAME} gateway ${C.muted("仅启动 API gateway 服务")}`,
    `  ${CLI_NAME} dashboard ${C.muted("启动 gateway 并打开 web control-ui")}`,
    "",
    `${C.bold("示例")}`,
    `  ${CLI_NAME} configure`,
    `  ${CLI_NAME} dashboard`,
    `  ${CLI_NAME} model current`,
    `  ${CLI_NAME} tui`,
  ];

  console.log(lines.join("\n"));
}

function tracePanel(events: ToolTraceEvent[]) {
  const header = `${C.magenta.bold("[ Trace ]")}  ${C.muted(ts())}`;
  const lines = events.map((event) => {
    const badge = event.type === "tool_use" ? C.cyan("CALL") : (event.success ? C.green("OK  ") : C.red("ERR "));
    const step = event.step > 0 ? `#${event.step}` : "rule";
    const payload = formatTracePayload(event.input);
    if (event.type === "tool_use") {
      return `${badge} ${C.yellow(step)} ${C.bold(event.toolName)} ${C.muted(payload)}`;
    }
    const summary = event.message ? ` ${C.muted("→")} ${event.message}` : "";
    return `${badge} ${C.yellow(step)} ${C.bold(event.toolName)} ${C.muted(payload)}${summary}`;
  });

  return panel([header, ...lines].join("\n"), {
    title: "Tool Trace",
    borderColor: "magenta",
    color: (s) => s,
  });
}

type SlashCommand = {
  command: string;
  description: string;
};

const SLASH_COMMANDS: SlashCommand[] = [
  { command: "/help", description: "显示帮助信息" },
  { command: "/history", description: "问诊历史记录" },
  { command: "/end", description: "结束当前会话并归档摘要" },
  { command: "/status", description: "连接状态" },
  { command: "/skills", description: "可用技能列表" },
  { command: "/tree", description: "项目文件结构" },
  { command: "/exit", description: "退出程序" },
];

function filterSlashCommands(input: string) {
  const keyword = input.trim().toLowerCase();
  if (!keyword.startsWith("/")) return [];

  return SLASH_COMMANDS.filter(({ command, description }) => {
    const haystack = `${command} ${description}`.toLowerCase();
    return haystack.includes(keyword);
  });
}

function buildSlashMenuTable(commands: SlashCommand[], selectedIndex: number) {
  return commands.map(({ command, description }, index) => {
    const selected = index === selectedIndex;
    const pointer = selected ? C.green("❯") : C.muted(" ");
    const cmd = selected ? C.bold.yellow(command) : C.yellow(command);
    const desc = selected ? C.white(description) : C.muted(description);
    return `${pointer} ${cmd}  ${desc}`;
  }).join("\n");
}

function startThinkingAnimation(label = "thinking") {
  if (!process.stdout.isTTY) {
    return { stop() {} };
  }

  const frames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
  let index = 0;

  const render = () => {
    const frame = frames[index % frames.length];
    process.stdout.write(`\r\x1b[2K${C.cyan(frame)} ${C.muted(label)}`);
    index += 1;
  };

  render();
  const timer = setInterval(render, 80);

  return {
    stop() {
      clearInterval(timer);
      process.stdout.write("\r\x1b[2K");
    },
  };
}

function promptInput(rl: import("readline").Interface) {
  if (!process.stdout.isTTY) {
    rl.prompt();
    return;
  }
  process.stdout.write(`${rule()}\n\n${rule()}\x1b[1A\r`);
  rl.prompt(true);
}

function fileTree(dir: string, prefix = "", isLast = true): string[] {
  const lines: string[] = [];
  try {
    const items = fs.readdirSync(dir).sort();
    items.forEach((item: string, i: number) => {
      if (item.startsWith(".") || item === "node_modules" || item === "dist") return;
      const isLastItem = i === items.length - 1;
      const connector = isLastItem ? "└── " : "├── ";
      const subPrefix = prefix + (isLast ? "    " : "│   ");
      lines.push(`${prefix}${connector}${item}`);
      const itemPath = path.join(dir, item);
      try {
        if (fs.statSync(itemPath).isDirectory()) {
          lines.push(...fileTree(itemPath, subPrefix, true));
        }
      } catch {}
    });
  } catch {}
  return lines;
}

async function main() {
  const args = process.argv.slice(2);
  const homePaths = await ensureUserHomeReady();
  const modelManager = new ModelManager({ homePaths });

  if (args.length === 0 || args[0] === "--help" || args[0] === "-h" || args[0] === "help") {
    renderCliHelp();
    return;
  }

  if (args[0] === "onboard") {
    const installDaemon = args.includes("--install-daemon");
    const result = await onboardUserHome({ installDaemon });
    console.log(`User home ready: ${result.paths.homeRoot}`);
    console.log(`Agent data: ${result.paths.agentDataDir}`);
    console.log(`Workspace: ${result.paths.workspaceDir}`);
    console.log(`Config: ${result.paths.thothAgentConfigPath}`);
    if (installDaemon) {
      console.log(`Daemon manifest: ${result.paths.daemonManifestPath}`);
    }
    console.log(result.created.length
      ? `Created ${result.created.length} paths`
      : "Nothing new created");
    return;
  }

  // ── gateway ────────────────────────────────────────────────
  if (args[0] === "gateway") {
    const portValue = readFlagValue(args, "--port");
    const hostValue = readFlagValue(args, "--host");
    const port = portValue ? (parseInt(portValue, 10) || 18889) : 18889;
    const host = hostValue || "127.0.0.1";
    const { ThothGateway } = await import("../gateway/index.js");
    const gateway = await ThothGateway.create({ port, host });
    gateway.start();
    return;
  }

  // ── dashboard ──────────────────────────────────────────────
  if (args[0] === "dashboard") {
    const portValue = readFlagValue(args, "--port");
    const hostValue = readFlagValue(args, "--host");
    const port = portValue ? (parseInt(portValue, 10) || 18889) : 18889;
    const host = hostValue || "127.0.0.1";
    const browserHost = host === "0.0.0.0" ? "127.0.0.1" : host;
    const url = `http://${browserHost}:${port}`;
    if (await isHttpReachable(url)) {
      openBrowser(url);
      console.log(`Dashboard: ${url}`);
      return;
    }
    const { ThothGateway } = await import("../gateway/index.js");
    const gateway = await ThothGateway.create({ port, host });
    gateway.start();
    setTimeout(() => {
      try {
        openBrowser(url);
        console.log(`Dashboard: ${url}`);
      } catch (error: any) {
        console.log(`Dashboard: ${url}`);
        console.log(C.yellow(`⚠ 浏览器打开失败: ${error?.message || error}`));
      }
    }, 250);
    return;
  }

  // ── configure ───────────────────────────────────────────
  if (args[0] === "configure") {
    const subcommand = args[1];

    if (subcommand === "provider") {
      console.log(C.yellow(`⚠ "${CLI_NAME} configure provider" 已移除，请使用 ${CLI_NAME} configure 交互式配置`));
      return;
    } else {
      // Default: interactive wizard
      await runConfigureWizard(modelManager, homePaths.agentName);
    }
    return;
  }

  if (args[0] === "model") {
    const subcommand = args[1] || "select";

    if (subcommand === "list") {
      const models = modelManager.listModels();
      if (models.length === 0) {
        console.log(C.yellow(`⚠ 还没有配置任何 Model Provider`));
        console.log(C.white(`运行 ${C.bold(`${CLI_NAME} configure`)} 来添加你的第一个模型供应商`));
        return;
      }
      const rows = models
        .map((item) => `${item.route}  ${C.muted(item.modelName)}  ${item.configured ? C.green(item.authMethod === "oauth" ? "oauth" : "configured") : C.red("missing-auth")}`);
      console.log(rows.join("\n"));
      return;
    }

    if (subcommand === "current") {
      const current = modelManager.getAgentModelConfig(homePaths.agentName);
      console.log(`Primary: ${current.primary}`);
      console.log(`Fallbacks: ${(current.fallbacks || []).join(", ") || "(none)"}`);
      console.log(`Config: ${homePaths.thothAgentConfigPath}`);
      return;
    }

    if (subcommand === "select") {
      console.log(C.yellow(`⚠ "model select" 已废弃，请使用 ${CLI_NAME} configure 交互式配置`));
      console.log(C.white(`运行 ${C.bold(`${CLI_NAME} configure`)} 来配置 Model Provider`));
      return;
    }

    if (subcommand === "use") {
      const primary = args[2];
      if (!primary) {
        console.log(C.yellow(`⚠ "model use" 交互模式已废弃，请使用 ${CLI_NAME} configure`));
        return;
      }
      const fallbacks = args[3]
        ? args[3].split(",").map((item) => item.trim()).filter(Boolean)
        : [];
      modelManager.setPrimaryModel(primary, homePaths.agentName);
      modelManager.setFallbackModels(fallbacks, homePaths.agentName);
      console.log(`Updated model route for ${homePaths.agentName}`);
      console.log(`Primary: ${primary}`);
      console.log(`Fallbacks: ${fallbacks.join(", ") || "(none)"}`);
      return;
    }

    console.log(`Usage: ${CLI_NAME} model <select|list|current|use> ...`);
    return;
  }

  // ── tui ────────────────────────────────────────────────────
  if (args[0] === "tui") {
    await startTUI(modelManager, homePaths);
    return;
  }

  // ── 默认：进入 TUI 对话模式 ──────────────────────────────
  console.log(C.red(`未知命令: ${args[0]}`));
  console.log();
  renderCliHelp();
  return;
}

async function startTUI(modelManager: ModelManager, homePaths: import("../home/index.js").UserHomePaths) {
  // ── 空 provider 检测 ──────────────────────────────────────
  const configuredProviders = modelManager.listModels().filter(m => m.configured);
  if (configuredProviders.length === 0) {
    console.log();
    console.log(`${C.bold.cyan("△ ThothAgent")} ${C.cyan("2026.5.06")} ${C.muted("—")} ${C.cyan("Self-Improving Domain Agent Framework")}`);
    console.log();
    console.log(C.yellow(`⚠ 还没有配置任何 Model Provider`));
    console.log(C.white(`请先运行 ${C.bold(`${CLI_NAME} configure`)} 配置你的第一个 AI 模型供应商`));
    console.log();
    console.log(C.gray(`例如:`) + C.cyan(` ${CLI_NAME} configure`));
    console.log();
    return;
  }

  console.log();
  console.log(`${C.bold.cyan("△ ThothAgent")} ${C.cyan("2026.5.06")} ${C.muted("—")} ${C.cyan("Self-Improving Domain Agent Framework")}`);
  console.log();

  const agent = new ThothAgent();
  let gatewayEventHandler: ((event: GatewayStreamEvent) => void) | null = null;
  let gatewayClient: GatewayCliClient | null = null;
  let gatewayConnected = false;
  let rlRef: import("readline").Interface | null = null;
  const seenGatewayMessageIds = new Set<string>();
  const defaultGatewayUrl = process.env.PETAGENT_GATEWAY_URL || "ws://127.0.0.1:18889";

  const ingestGatewayMessages = (messages: any[], opts: { renderNewOnly?: boolean } = {}) => {
    const unseen: any[] = [];
    for (const message of messages) {
      const messageId = String(message?.id || "");
      if (!messageId) continue;
      if (seenGatewayMessageIds.has(messageId)) continue;
      seenGatewayMessageIds.add(messageId);
      unseen.push(message);
    }

    if (!opts.renderNewOnly || unseen.length === 0) return;
    renderHistoryMessages(unseen);
    console.log();
  };

  const handleGatewayConnectionChange = (state: GatewayConnectionState) => {
    gatewayConnected = state === "connected";
    if (!rlRef) return;
    const marker = gatewayConnected ? C.green("connected") : C.gray("disconnected");
    console.log(`${C.muted("[gateway]")} ${marker}`);
    promptInput(rlRef);
  };

  const handleGlobalGatewayEvent = async (event: GatewayStreamEvent) => {
    if (!rlRef) return;

    if (event.event === "chat.stream" && gatewayEventHandler) {
      gatewayEventHandler(event);
      return;
    }

    if (event.event === "session.updated") {
      const payload = event.payload as { sessionKey?: string; sessionId?: string; sessionIndex?: { sessionKey?: string } };
      if (gatewayClient && gatewayConnected) {
        const history = await gatewayClient.request<any>("chat.history", {
          sessionId: payload.sessionId,
          limit: 24,
        }).catch(() => null);
        if (history?.messages?.length) {
          ingestGatewayMessages(history.messages, { renderNewOnly: true });
        }
      }
      console.log(`${C.muted("[gateway]")} ${C.cyan("session synced")} ${C.gray(payload.sessionKey || "-")} ${C.muted("|")} ${C.gray(`index ${payload.sessionIndex?.sessionKey || payload.sessionKey || "-"}`)}`);
      promptInput(rlRef);
      return;
    }
  };

  try {
    gatewayClient = new GatewayCliClient(
      defaultGatewayUrl,
      (event) => {
        void handleGlobalGatewayEvent(event);
      },
      handleGatewayConnectionChange,
    );
    await gatewayClient.connect(500);
  } catch {
    gatewayClient = null;
    gatewayConnected = false;
  }
  const skills = agent.skills.listAll();
  const gatewayStatus = gatewayClient && gatewayConnected
    ? await gatewayClient.request<any>("status").catch(() => null)
    : null;
  const initialSession = gatewayStatus
    ? {
      sessionKey: gatewayStatus.runtime.sessionKey,
      indexedSessionKey: gatewayStatus.runtime.sessionIndex?.sessionKey || gatewayStatus.runtime.sessionKey,
    }
    : await agent.runtime.sessions.getCurrentSession();

  console.log(`${C.yellow(`${CLI_NAME} tui`)} ${C.muted("—")} ${C.yellow(`agent ${homePaths.agentName}`)} ${C.muted("—")} ${C.yellow(`session ${initialSession.sessionKey}`)}`);
  console.log();
  console.log(C.gray(`session ${initialSession.sessionKey}`));
  if ("indexedSessionKey" in initialSession) {
    console.log(C.gray(`session index ${initialSession.indexedSessionKey || "-"}`));
  }
  console.log();
  console.log(`${C.green("✓")} Active model: ${C.bold(gatewayStatus?.runtime?.activeModel || agent.runtime.lastProviderLabel)}`);
  console.log(`${C.green("✓")} Skills loaded: ${skills.length}`);
  console.log(`${C.green("✓")} User data: ${C.muted(homePaths.agentDataDir)}`);
  console.log(`${C.green("✓")} Workspace: ${C.muted(homePaths.workspaceDir)}`);
  console.log(`${C.green("✓")} Config: ${C.muted(homePaths.thothAgentConfigPath)}`);
  if (gatewayClient && gatewayConnected) {
    console.log(`${C.green("✓")} Gateway: ${C.muted(defaultGatewayUrl)}`);
  }
  console.log(skills.map(s => `${C.green("✓")} ${C.cyan(s.commands[0] || s.name)} ${C.muted("—")} ${C.muted(s.description)}`).join("\n"));
  console.log(gatewayClient ? gatewayStatusBar(gatewayStatus, gatewayConnected) : await statusBar(agent));
  console.log();

  if (gatewayClient && gatewayConnected) {
    const history = await gatewayClient.request<any>("chat.history", { limit: 16 }).catch(() => null);
    if (history?.messages?.length) {
      ingestGatewayMessages(history.messages);
      console.log(panel(C.muted(`Loaded ${history.messages.length} messages from gateway history`), { title: "Gateway History", color: (s) => s }));
      renderHistoryMessages(history.messages);
      console.log();
    }
  }

  const readline = await import("readline");
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: " ",
  });
  rlRef = rl;
  readline.emitKeypressEvents(process.stdin, rl);
  if (process.stdin.isTTY) {
    process.stdin.setRawMode(true);
  }

  let slashMenuVisible = false;
  let slashMenuSelectedIndex = 0;

  const hideSlashMenu = () => {
    if (!process.stdout.isTTY || !slashMenuVisible) return;
    process.stdout.write("\x1b[s");
    readline.clearScreenDown(process.stdout);
    process.stdout.write("\x1b[u");
    slashMenuVisible = false;
  };

  const renderSlashMenu = () => {
    if (!process.stdout.isTTY) return;

    const matches = filterSlashCommands(rl.line);
    if (matches.length === 0) {
      hideSlashMenu();
      return;
    }

    slashMenuSelectedIndex = Math.max(0, Math.min(slashMenuSelectedIndex, matches.length - 1));
    const content = buildSlashMenuTable(matches, slashMenuSelectedIndex);

    process.stdout.write("\x1b[s");
    readline.clearScreenDown(process.stdout);
    process.stdout.write(`\n${panel(content, { title: "Commands", borderColor: "yellow", color: (s) => s })}\n`);
    process.stdout.write("\x1b[u");
    slashMenuVisible = true;
  };

  const syncSlashMenu = () => {
    if (!rl.line.trim().startsWith("/")) {
      hideSlashMenu();
      slashMenuSelectedIndex = 0;
      return;
    }

    const matches = filterSlashCommands(rl.line);
    if (matches.length === 0) {
      hideSlashMenu();
      return;
    }

    if (slashMenuSelectedIndex >= matches.length) {
      slashMenuSelectedIndex = 0;
    }
    renderSlashMenu();
  };

  const applySelectedSlashCommand = () => {
    const matches = filterSlashCommands(rl.line);
    const selected = matches[slashMenuSelectedIndex];
    if (!selected) return;

    rl.write(null, { ctrl: true, name: "u" });
    rl.write(selected.command);
    hideSlashMenu();
  };

  process.stdin.on("keypress", (_str, key) => {
    if (!key) return;

    const currentLine = rl.line.trim();
    const isSlashMode = currentLine.startsWith("/");
    const matches = filterSlashCommands(rl.line);

    if (isSlashMode && matches.length > 0) {
      if (key.name === "down") {
        slashMenuSelectedIndex = (slashMenuSelectedIndex + 1) % matches.length;
        renderSlashMenu();
        return;
      }

      if (key.name === "up") {
        slashMenuSelectedIndex = (slashMenuSelectedIndex - 1 + matches.length) % matches.length;
        renderSlashMenu();
        return;
      }

      if (key.name === "tab") {
        applySelectedSlashCommand();
        return;
      }

      if (key.name === "return" && currentLine === "/") {
        applySelectedSlashCommand();
        return;
      }
    }

    setImmediate(syncSlashMenu);
  });

  promptInput(rl);

  rl.on("line", async (line) => {
    let input = line.trim();
    const slashMatches = filterSlashCommands(input);
    if (input === "/" && slashMatches[slashMenuSelectedIndex]) {
      input = slashMatches[slashMenuSelectedIndex].command;
    }

    if (process.stdout.isTTY) {
      process.stdout.write("\x1b[1B\r\x1b[2K");
    }
    console.log();
    hideSlashMenu();
    slashMenuSelectedIndex = 0;

    if (!input) { promptInput(rl); return; }

    // ── /cmd ──────────────────────────────────────────────
    if (["/cmd", "/command", "cmd"].includes(input)) {
      const cmds = [
        [C.yellow("/help"), "显示帮助信息"],
        [C.yellow("/cmd"), "显示所有命令"],
        [C.yellow("/status"), "连接状态和 Token 使用"],
        [C.yellow("/skills"), "已加载的 Skills 列表"],
        [C.yellow("/history"), "问诊历史记录"],
        [C.yellow("/end"), "结束当前会话并归档摘要"],
        [C.yellow("/reset"), "重置当前会话"],
        [C.yellow("/exit"), "退出程序"],
      ];
      console.log(panel(cmds.map(([cmd, desc]) => `${cmd}  ${C.muted(desc)}`).join("\n"), { title: "Commands", borderColor: "cyan", color: (s) => s }));
      console.log();
      promptInput(rl);
      return;
    }


    // ── Slash menu ────────────────────────────────────────
    if (input === "/") {
      console.log(panel(buildSlashMenuTable(SLASH_COMMANDS, 0), { title: "Commands", borderColor: "yellow", color: (s) => s }));
      console.log();
      promptInput(rl);
      return;
    }

    // ── Help ────────────────────────────────────────────────
    if (["help", "帮助", "/help", "/h", "?"].includes(input)) {
      console.log(panel(agent.getHelp(), { borderColor: "cyan", color: (s) => s }));
      console.log();
      promptInput(rl);
      return;
    }

    // ── Exit ───────────────────────────────────────────────
    if (["exit", "quit", "q", "退出", "/exit", "/quit"].includes(input)) {
      console.log(botPanel("👋 再见！祝你的毛孩子健康成长 🐾"));
      rl.close();
      return;
    }

    // ── Status ─────────────────────────────────────────────
    if (["status", "状态", "/status", "/stat"].includes(input)) {
      if (gatewayClient) {
        if (gatewayConnected) {
          const status = await gatewayClient.request<any>("status");
          console.log([
            `${C.blue("Model")}    ${status.runtime.activeModel}`,
            `${C.blue("Route")}    ${status.runtime.modelRoute.primary}`,
            `${C.blue("Gateway")}  ws://${status.gateway.host}:${status.gateway.port} ${C.green("(connected)")}`,
            `${C.blue("Session")}  ${status.runtime.sessionKey}`,
            `${C.blue("Tokens")}   ${status.runtime.tokenUsage.totalTokens} / ${status.runtime.tokenUsage.maxTokens} (${Math.floor((status.runtime.tokenUsage.usageFraction || 0) * 100)}%)`,
            `${C.blue("Clients")}  ${status.clients}`,
          ].join("\n"));
        } else {
          const session = await agent.runtime.sessions.getCurrentSession();
          console.log([
            `${C.blue("Gateway")}  ${defaultGatewayUrl} ${C.gray("(disconnected)")}`,
            `${C.blue("Session")}  ${session.sessionKey}`,
            `${C.blue("Mode")}     local fallback`,
          ].join("\n"));
        }
      } else {
        const u = agent.llm.usage;
        const frac = u.usageFraction;
        const session = await agent.runtime.sessions.getCurrentSession();
        console.log([
          `${C.blue("Model")}    ${agent.llm.model}`,
          `${C.blue("Route")}    ${agent.runtime.lastProviderLabel}`,
          `${C.blue("Base URL")} ${agent.llm.baseUrl}`,
          `${C.blue("Session")}  ${session.sessionKey}`,
          `${C.blue("Tokens")}   ${u.totalTokens} / ${u.maxTokens} (${Math.floor(frac * 100)}%)`,
          `${C.blue("Skills")}   ${agent.skills.listAll().length} loaded`,
        ].join("\n"));
      }
      console.log();
      promptInput(rl);
      return;
    }

    // ── Skills list ────────────────────────────────────────
    if (["skills", "/skills", "/skill", "skills list"].includes(input)) {
      console.log(agent.skills.listAll()
        .map((s) => `${C.yellow(s.commands.join(", ") || s.name)}  ${C.muted(s.description)}`)
        .join("\n"));
      console.log();
      promptInput(rl);
      return;
    }

    // ── History ─────────────────────────────────────────────
    if (["history", "历史", "/history", "/hi"].includes(input)) {
      const hist = gatewayClient && gatewayConnected
        ? (await gatewayClient.request<any>("sessions.list", { limit: 12 })).items
        : await agent.runtime.sessions.listSessions({ limit: 12, status: "all" });
      if (!hist.length) {
        console.log(botPanel("📭 暂无问诊历史记录"));
      } else {
        console.log(hist.map((h: any, i: number) =>
          `${C.cyan(String(i + 1).padStart(2, "0"))} ${C.yellow(h.title || "新会话")} ${C.muted((h.lastActivityAt || "").slice(0, 10))}  ${C.gray(h.sessionKey)} ${C.muted(`[${h.status}]`)}`
        ).join("\n"));
      }
      console.log();
      promptInput(rl);
      return;
    }

    // ── End current business session ──────────────────────
    if (["end", "结束", "/end", "/done", "完成会话"].includes(input)) {
      if (gatewayClient && gatewayConnected) {
        const result = await gatewayClient.request<any>("sessions.patch", { action: "end" });
        console.log(botPanel(
          result.ended
            ? `✅ 会话已结束并归档\nsession: ${result.ended.sessionKey}\n新会话: ${result.next.sessionKey}`
            : `✅ 会话已结束\n新会话: ${result.next.sessionKey}`,
        ));
      } else {
        const extraction = await agent.runtime.endCurrentBusinessSession();
        const next = await agent.runtime.sessions.createChildSession(homePaths.agentName, {
          startedAfterEnd: extraction?.session.id || null,
        });
        await agent.memory.clearSession();
        console.log(botPanel(
          extraction
            ? `✅ 会话已结束并归档\nsession: ${extraction.session.sessionKey}\n新会话: ${next.sessionKey}`
            : `✅ 会话已结束\n新会话: ${next.sessionKey}`,
        ));
      }
      console.log();
      promptInput(rl);
      return;
    }

    // ── Reset ───────────────────────────────────────────────
    if (["reset", "重置", "/reset", "/clear", "清空"].includes(input)) {
      if (gatewayClient && gatewayConnected) {
        const reset = await gatewayClient.request<any>("sessions.patch", { action: "reset" });
        console.log(botPanel(`🔄 会话已重置\n新的 session: ${reset.next.sessionKey}`));
      } else {
        const reset = await agent.runtime.sessions.resetCurrentSession();
        await agent.memory.clearSession();
        console.log(botPanel(`🔄 会话已重置\n新的 session: ${reset.next.sessionKey}`));
      }
      console.log();
      promptInput(rl);
      return;
    }

    // ── Image detection ────────────────────────────────────
    let imagePath: string | undefined;
    let displayInput = input;
    const imgKw = ["图片", "照片", "image", "photo"];
    if (imgKw.some(kw => input.includes(kw))) {
      const parts = input.split(/\s+/);
      for (const part of parts) {
        if (part.startsWith("/") || part.startsWith("./") || part.startsWith("~") || part.startsWith("/Users")) {
          imagePath = part.replace(/^~/, process.env.HOME || "");
          displayInput = input.replace(part, "").trim();
          break;
        }
      }
    }

    // ── Process ────────────────────────────────────────────
    const t0 = Date.now();
    try {
      const preflightGatewayStatus = gatewayClient && gatewayConnected
        ? await gatewayClient.request<any>("status").catch(() => null)
        : null;
      console.log(gatewayClient ? gatewayStatusBar(preflightGatewayStatus, gatewayConnected) : await statusBar(agent));
      console.log();
      const thinking = startThinkingAnimation("thinking");
      const result = await (gatewayClient && gatewayConnected
        ? runGatewayChat(gatewayClient, displayInput, (handler) => { gatewayEventHandler = handler; })
        : agent.thinkWithTrace(displayInput, imagePath))
        .finally(() => thinking.stop());
      const { text: response, trace, timings } = result as any;
      const elapsed = ((Date.now() - t0) / 1000).toFixed(1);

      console.log(userPanel(input));
      if (trace.length > 0) {
        console.log(tracePanel(trace));
      }
      if (timings?.length) {
        const timingLines = timings.map((t: any) => {
          const bar = "█".repeat(Math.max(1, Math.round(t.elapsed / 100)));
          return `${C.gray(t.elapsed.toString().padStart(5))}ms ${bar}${t.label === "total" ? ` ${C.bold("→ total")}` : ` ${t.label}`}`;
        });
        console.log(panel(timingLines.join("\n"), { title: "Timing Breakdown", borderColor: "cyan", color: (s) => s }));
      }
      console.log(botPanel(renderMarkdown(response)));
      console.log();
      if (gatewayClient && gatewayConnected) {
        const status = await gatewayClient.request<any>("status");
        console.log(`  ${C.muted("⏱ " + elapsed + "s | tokens: " + Math.floor((status.runtime.tokenUsage.totalTokens || 0) / 1000) + "k")}`);
      } else {
        console.log(`  ${C.muted("⏱ " + elapsed + "s | tokens: " + Math.floor(agent.llm.usage.totalTokens / 1000) + "k")}`);
      }
      console.log();
      const postGatewayStatus = gatewayClient && gatewayConnected
        ? await gatewayClient.request<any>("status").catch(() => null)
        : null;
      console.log(gatewayClient ? gatewayStatusBar(postGatewayStatus, gatewayConnected) : await statusBar(agent));
    } catch (e: any) {
      console.log(panel(`${C.red("⚠️ 出错:")} ${e.message}`, { borderColor: "red", color: (s) => s }));
      console.log();
    }

    console.log();
    promptInput(rl);
  });

  rl.on("close", () => {
    gatewayClient?.close();
    agent.memory.manager.flushBackgroundTasks()
      .catch(() => {})
      .finally(() => {
        console.log(`${C.muted("\nGoodbye! 🐾")}`);
        process.exit(0);
      });
  });
}

main().catch((e) => {
  console.error(C.red("Fatal:"), e);
  process.exit(1);
});
