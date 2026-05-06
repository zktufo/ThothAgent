/**
 * Harness orchestrator — security/resource/audit layer for tool execution.
 *
 * Combines:
 *   - CommandSandbox (L1 command/path validation)
 *   - ResourceLock (concurrency control)
 *   - AuditLogger (SQLite audit trail)
 *
 * Provides three primary methods (exec, readFile, writeFile) plus a generic
 * runWithGuard wrapper for tools that need audit + safety only.
 *
 * All methods return ToolResult — never throw.
 */

import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  type HarnessPolicy,
  type ExecutionContext,
  type ToolResult,
  DEFAULT_POLICY,
} from "./types.js";
import { CommandSandbox } from "./sandbox.js";
import { ResourceLock } from "./lock.js";
import { AuditLogger } from "./audit.js";

export { CommandSandbox } from "./sandbox.js";
export { ResourceLock } from "./lock.js";
export { AuditLogger } from "./audit.js";
export * from "./types.js";

const TEXT_FILE_MAX_BYTES = 512 * 1024; // 512 KB max for a single read

export class ToolHarness {
  private sandbox: CommandSandbox;
  private lock: ResourceLock;
  private audit: AuditLogger | null;
  private policy: HarnessPolicy;

  constructor(policy: HarnessPolicy = {}) {
    this.policy = { ...DEFAULT_POLICY, ...policy };
    this.sandbox = new CommandSandbox(this.policy);
    this.lock = new ResourceLock();
    this.audit = this.policy.auditLog !== false ? new AuditLogger() : null;
  }

  /**
   * Execute a shell command through the sandbox.
   *
   * Flow:
   *   1. Validate command via sandbox
   *   2. Acquire resource lock (if enabled)
   *   3. Spawn child process with timeout + sanitised env
   *   4. Capture stdout/stderr up to maxOutputSize
   *   5. Audit log the result
   */
  async exec(
    command: string,
    ctx: ExecutionContext,
  ): Promise<ToolResult> {
    const startTime = performance.now();

    // Step 1: sandbox validation
    const validation = this.sandbox.validateCommand(command);
    if (!validation.ok) {
      const result: ToolResult = {
        success: false,
        message: `⛔ Command denied: ${validation.reason}`,
        error: validation.reason,
        duration: 0,
      };
      await this.maybeAudit("exec", command, result, ctx);
      return result;
    }

    let release: (() => void) | undefined;

    try {
      // Step 2: optional resource lock
      if (this.policy.resourceLock) {
        release = await this.lock.acquire("exec:" + ctx.sessionId);
      }

      // Step 3: spawn process
      const result = await this.spawnWithTimeout(command, ctx);
      result.duration = Math.round(performance.now() - startTime);

      // Step 5: audit
      await this.maybeAudit("exec", command, result, ctx);
      return result;
    } catch (err: any) {
      const result: ToolResult = {
        success: false,
        message: `⛔ Exec error: ${err.message}`,
        error: err.message,
        duration: Math.round(performance.now() - startTime),
      };
      await this.maybeAudit("exec", command, result, ctx);
      return result;
    } finally {
      release?.();
    }
  }

  /**
   * Read a file through the sandbox with size + extension checks.
   *
   * Flow:
   *   1. Validate path via sandbox
   *   2. Check file size + extension
   *   3. Acquire resource lock (if enabled)
   *   4. Read content (respecting offset/limit)
   *   5. Audit
   */
  async readFile(
    filePath: string,
    ctx: ExecutionContext,
    options?: { offset?: number; limit?: number },
  ): Promise<ToolResult> {
    const startTime = performance.now();

    // Step 1: validate path
    const validation = this.sandbox.validatePath(filePath, "read");
    if (!validation.ok) {
      const result: ToolResult = {
        success: false,
        message: `⛔ Read denied: ${validation.reason}`,
        error: validation.reason,
        duration: 0,
      };
      await this.maybeAudit("read", filePath, result, ctx);
      return result;
    }

    const resolved = validation.resolvedPath!;
    let release: (() => void) | undefined;

    try {
      // Step 2: check file existence and size
      let stat: fs.Stats;
      try {
        stat = fs.statSync(resolved);
      } catch {
        const result: ToolResult = {
          success: false,
          message: `⛔ File not found: ${resolved}`,
          error: "FILE_NOT_FOUND",
          duration: 0,
        };
        await this.maybeAudit("read", filePath, result, ctx);
        return result;
      }

      if (!stat.isFile()) {
        const result: ToolResult = {
          success: false,
          message: `⛔ Not a file: ${resolved}`,
          error: "NOT_A_FILE",
          duration: 0,
        };
        await this.maybeAudit("read", filePath, result, ctx);
        return result;
      }

      // Block binary extensions
      if (this.sandbox.isBinaryExtension(resolved)) {
        const result: ToolResult = {
          success: false,
          message: `⛔ Cannot read binary file: ${path.extname(resolved)}`,
          error: "BINARY_FILE",
          duration: 0,
        };
        await this.maybeAudit("read", filePath, result, ctx);
        return result;
      }

      // Check file size
      const maxSize = this.policy.maxFileSize ?? DEFAULT_POLICY.maxFileSize!;
      if (stat.size > maxSize) {
        const result: ToolResult = {
          success: false,
          message: `⛔ File too large (${stat.size} bytes, max ${maxSize})`,
          error: "FILE_TOO_LARGE",
          duration: 0,
        };
        await this.maybeAudit("read", filePath, result, ctx);
        return result;
      }

      // Step 3: acquire lock
      if (this.policy.resourceLock) {
        release = await this.lock.acquire("read:" + resolved);
      }

      // Step 4: read content
      let content: string;
      try {
        content = fs.readFileSync(resolved, "utf-8");
      } catch (err: any) {
        const result: ToolResult = {
          success: false,
          message: `⛔ Read error: ${err.message}`,
          error: err.message,
          duration: Math.round(performance.now() - startTime),
        };
        await this.maybeAudit("read", filePath, result, ctx);
        return result;
      }

      // Apply offset/limit
      const lines = content.split("\n");
      const offset = (options?.offset ?? 1) - 1; // Convert to 0-indexed
      const limit = options?.limit ?? lines.length;
      const selected = lines.slice(offset, offset + limit).join("\n");

      const result: ToolResult = {
        success: true,
        message: `✅ Read ${resolved} (${selected.length} chars)`,
        data: { content: selected, totalLines: lines.length, totalSize: stat.size },
        duration: Math.round(performance.now() - startTime),
      };

      await this.maybeAudit("read", filePath, result, ctx);
      return result;
    } catch (err: any) {
      const result: ToolResult = {
        success: false,
        message: `⛔ Read error: ${err.message}`,
        error: err.message,
        duration: Math.round(performance.now() - startTime),
      };
      await this.maybeAudit("read", filePath, result, ctx);
      return result;
    } finally {
      release?.();
    }
  }

  /**
   * Write content to a file through the sandbox.
   *
   * Flow:
   *   1. Validate path via sandbox
   *   2. Check content size
   *   3. Acquire resource lock (if enabled)
   *   4. mkdir -p parent directory
   *   5. Write (or append)
   *   6. Audit
   */
  async writeFile(
    filePath: string,
    content: string,
    ctx: ExecutionContext,
    options?: { append?: boolean },
  ): Promise<ToolResult> {
    const startTime = performance.now();

    // Step 1: validate path
    const validation = this.sandbox.validatePath(filePath, "write");
    if (!validation.ok) {
      const result: ToolResult = {
        success: false,
        message: `⛔ Write denied: ${validation.reason}`,
        error: validation.reason,
        duration: 0,
      };
      await this.maybeAudit("write", filePath, result, ctx);
      return result;
    }

    const resolved = validation.resolvedPath!;
    let release: (() => void) | undefined;

    try {
      // Step 2: check content size
      const maxSize = this.policy.maxFileSize ?? DEFAULT_POLICY.maxFileSize!;
      const byteSize = Buffer.byteLength(content, "utf-8");
      if (byteSize > maxSize) {
        const result: ToolResult = {
          success: false,
          message: `⛔ Content too large (${byteSize} bytes, max ${maxSize})`,
          error: "CONTENT_TOO_LARGE",
          duration: 0,
        };
        await this.maybeAudit("write", filePath, result, ctx);
        return result;
      }

      // Step 3: acquire lock
      if (this.policy.resourceLock) {
        release = await this.lock.acquire("write:" + resolved);
      }

      // Step 4: ensure parent directory exists
      try {
        fs.mkdirSync(path.dirname(resolved), { recursive: true });
      } catch (err: any) {
        const result: ToolResult = {
          success: false,
          message: `⛔ Cannot create directory: ${err.message}`,
          error: err.message,
          duration: Math.round(performance.now() - startTime),
        };
        await this.maybeAudit("write", filePath, result, ctx);
        return result;
      }

      // Step 5: write content
      try {
        if (options?.append) {
          fs.appendFileSync(resolved, content, "utf-8");
        } else {
          fs.writeFileSync(resolved, content, "utf-8");
        }
      } catch (err: any) {
        const result: ToolResult = {
          success: false,
          message: `⛔ Write error: ${err.message}`,
          error: err.message,
          duration: Math.round(performance.now() - startTime),
        };
        await this.maybeAudit("write", filePath, result, ctx);
        return result;
      }

      const result: ToolResult = {
        success: true,
        message: `✅ Wrote ${byteSize} bytes to ${resolved}`,
        data: { path: resolved, size: byteSize },
        duration: Math.round(performance.now() - startTime),
      };

      await this.maybeAudit("write", filePath, result, ctx);
      return result;
    } catch (err: any) {
      const result: ToolResult = {
        success: false,
        message: `⛔ Write error: ${err.message}`,
        error: err.message,
        duration: Math.round(performance.now() - startTime),
      };
      await this.maybeAudit("write", filePath, result, ctx);
      return result;
    } finally {
      release?.();
    }
  }

  /**
   * Generic guard wrapper for existing tools (memory, memory_search, etc.).
   *
   * Does NOT apply sandbox validation — it assumes the wrapped tool has
   * internal safety. It DOES add:
   *   - Duration tracking
   *   - Audit logging
   *   - Error capture (never throw)
   */
  async runWithGuard(
    toolName: string,
    fn: () => Promise<ToolResult>,
    ctx: ExecutionContext,
  ): Promise<ToolResult> {
    const startTime = performance.now();

    try {
      const result = await fn();
      result.duration = Math.round(performance.now() - startTime);
      await this.maybeAudit(toolName, JSON.stringify(ctx.userInput).slice(0, 500), result, ctx);
      return result;
    } catch (err: any) {
      const result: ToolResult = {
        success: false,
        message: `⛔ Tool error: ${err.message}`,
        error: err.message,
        duration: Math.round(performance.now() - startTime),
      };
      await this.maybeAudit(toolName, JSON.stringify(ctx.userInput).slice(0, 500), result, ctx);
      return result;
    }
  }

  /**
   * Update the security policy at runtime (creates a new sandbox).
   */
  updatePolicy(policy: Partial<HarnessPolicy>): void {
    this.policy = { ...DEFAULT_POLICY, ...policy };
    this.sandbox = new CommandSandbox(this.policy);
    if (this.policy.auditLog === false && this.audit) {
      this.audit.close();
      this.audit = null;
    } else if (this.policy.auditLog !== false && !this.audit) {
      this.audit = new AuditLogger();
    }
  }

  // ---- private helpers ----

  /**
   * Spawn a child process with timeout, path whitelisting, and output limits.
   */
  private spawnWithTimeout(
    command: string,
    ctx: ExecutionContext,
  ): Promise<ToolResult> {
    return new Promise((resolve) => {
      const timeoutSec = this.policy.execTimeout ?? DEFAULT_POLICY.execTimeout!;
      const maxOutput = this.policy.maxOutputSize ?? DEFAULT_POLICY.maxOutputSize!;

      const child = spawn(command, [], {
        shell: true,
        cwd: this.sandbox.getProjectDir(),
        env: {
          PATH: "/usr/bin:/bin:/usr/local/bin",
          HOME: os.homedir(),
        },
        timeout: timeoutSec * 1000,
        stdio: ["ignore", "pipe", "pipe"],
      });

      let stdout = "";
      let stderr = "";
      let timedOut = false;

      const timer = setTimeout(() => {
        timedOut = true;
        child.kill("SIGTERM");
        // Give it a moment, then SIGKILL
        setTimeout(() => {
          try { child.kill("SIGKILL"); } catch { /* already dead */ }
        }, 2000);
      }, timeoutSec * 1000);

      child.stdout?.on("data", (chunk: Buffer) => {
        if (stdout.length < maxOutput) {
          stdout += chunk.toString("utf-8").slice(0, maxOutput - stdout.length);
        }
      });

      child.stderr?.on("data", (chunk: Buffer) => {
        if (stderr.length < maxOutput) {
          stderr += chunk.toString("utf-8").slice(0, maxOutput - stderr.length);
        }
      });

      child.on("error", (err) => {
        clearTimeout(timer);
        resolve({
          success: false,
          message: `⛔ Process error: ${err.message}`,
          error: err.message,
        });
      });

      child.on("exit", (code, signal) => {
        clearTimeout(timer);

        if (timedOut) {
          resolve({
            success: false,
            message: `⛔ Command timed out after ${timeoutSec}s`,
            error: "TIMEOUT",
          });
          return;
        }

        if (signal) {
          resolve({
            success: false,
            message: `⛔ Process killed by signal ${signal}`,
            error: `SIGNAL:${signal}`,
          });
          return;
        }

        const exitCode = code ?? -1;
        const output = stdout.slice(0, maxOutput);
        const errOutput = stderr.length > 0 ? `\nSTDERR:\n${stderr.slice(0, maxOutput / 2)}` : "";

        resolve({
          success: exitCode === 0,
          message: output + errOutput,
          data: {
            exitCode,
            stdout: output,
            stderr: stderr.slice(0, maxOutput / 2),
          },
          error: exitCode !== 0 ? `Exit code ${exitCode}` : undefined,
        });
      });
    });
  }

  /**
   * Conditionally write to the audit log based on policy settings.
   */
  private async maybeAudit(
    toolName: string,
    input: string,
    result: ToolResult,
    ctx: ExecutionContext,
  ): Promise<void> {
    if (this.audit) {
      await this.audit.log({
        agentId: ctx.agentId,
        sessionId: ctx.sessionId,
        toolName,
        input: input.length > 4096 ? input.slice(0, 4096) + "…" : input,
        success: result.success,
        error: result.error,
        duration: result.duration ?? 0,
      });
    }
  }
}
