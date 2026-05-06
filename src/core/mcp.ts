/**
 * MCP client - calls MCP tools via mcporter subprocess.
 */
import { spawn } from "child_process";
import fs from "fs";
import path from "path";
import os from "os";
import { resolveUserHomePaths } from "../home/index.js";

const MCPORTER_BIN = path.join(
  os.homedir(),
  ".nvm/versions/node/v22.22.0/bin/mcporter"
);
const DEFAULT_CONFIG = path.join(
  resolveUserHomePaths().workspaceDir,
  "config",
  "mcporter.json",
);

export interface ToolResult {
  success: boolean;
  data?: any;
  error?: string;
  message: string;
}

export interface MCPTool {
  name: string;
  description?: string;
  inputSchema?: any;
}

export class MCPClient {
  private configPath: string;
  private toolCache: MCPTool[] = [];

  constructor(configPath?: string) {
    this.configPath = configPath || DEFAULT_CONFIG;
  }

  /**
   * Call an MCP tool by name (e.g. "minimax.understand_image").
   */
  async call(tool: string, args: Record<string, any> = {}): Promise<ToolResult> {
    const [provider, toolName] = tool.includes(".")
      ? tool.split(".", 2)
      : ["", tool];

    const fullTool = provider ? `${provider}.${toolName}` : tool;

    return new Promise((resolve) => {
      const proc = spawn(MCPORTER_BIN, [
        "--config", this.configPath,
        "call", fullTool,
        "--args", JSON.stringify(args),
      ], {
        timeout: 60_000,
        stdio: ["ignore", "pipe", "pipe"],
      });

      let stdout = "";
      let stderr = "";

      proc.stdout?.on("data", (d) => { stdout += d.toString(); });
      proc.stderr?.on("data", (d) => { stderr += d.toString(); });

      proc.on("close", (code) => {
        if (code !== 0) {
          resolve({
            success: false,
            error: stderr || `Exit code ${code}`,
            message: `⚠️ 工具调用失败 (${code})`,
          });
          return;
        }

        try {
          const output = JSON.parse(stdout);
          if (output.error) {
            resolve({ success: false, error: output.error, message: `⚠️ ${output.error}` });
            return;
          }
          const data = output.result ?? output.data ?? output.text ?? output;
          const msg = typeof data === "string" ? data : JSON.stringify(data, null, 2);
          resolve({ success: true, data, message: msg });
        } catch {
          resolve({ success: true, data: stdout, message: stdout });
        }
      });

      proc.on("error", (e) => {
        resolve({ success: false, error: e.message, message: `⚠️ ${e.message}` });
      });

      // Timeout
      setTimeout(() => {
        proc.kill();
        resolve({ success: false, error: "Timeout", message: "⏰ 工具调用超时" });
      }, 60_000);
    });
  }

  /**
   * List available MCP tools.
   */
  async listTools(): Promise<MCPTool[]> {
    if (this.toolCache.length > 0) return this.toolCache;

    return new Promise((resolve) => {
      const proc = spawn(MCPORTER_BIN, ["--config", this.configPath, "list"], {
        timeout: 15_000,
        stdio: ["ignore", "pipe", "pipe"],
      });

      let stdout = "";
      proc.stdout?.on("data", (d) => { stdout += d.toString(); });

      proc.on("close", () => {
        try {
          const data = JSON.parse(stdout);
          this.toolCache = data.tools || [];
          resolve(this.toolCache);
        } catch {
          resolve([]);
        }
      });

      proc.on("error", () => resolve([]));
      setTimeout(() => { proc.kill(); resolve([]); }, 15_000);
    });
  }
}
