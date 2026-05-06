/**
 * L1 command/path sandbox.
 *
 * Validates commands and file paths against whitelist + blacklist rules
 * before they reach the OS. This is a first line of defence — not a
 * full container sandbox, but enough to prevent accidental damage and
 * common injection patterns.
 *
 * Policy inheritance:
 *   1. If allowlist is set → only explicitly allowed items pass
 *   2. Blocklist is always enforced, regardless of allowlist
 *   3. Empty allowlist = "allow everything not blocked"
 */

import path from "path";
import os from "os";
import { DEFAULT_POLICY, type HarnessPolicy } from "./types.js";

/**
 * Default whitelisted commands considered safe for agent use.
 * These cover common file operations, git, npm, and inspection.
 */
const DEFAULT_ALLOWED_COMMANDS = [
  /^git\b/,
  /^npm\b/,
  /^node\b/,
  /^ls\b/,
  /^cat\b/,
  /^pwd\b/,
  /^curl\b/,
  /^echo\b/,
  /^head\b/,
  /^tail\b/,
  /^wc\b/,
  /^find\b/,
  /^grep\b/,
  /^mkdir\b/,
  /^cp\b/,
  /^mv\b/,
  /^touch\b/,
  /^which\b/,
  /^sort\b/,
  /^uniq\b/,
  /^tee\b/,
  /^diff\b/,
  /^file\b/,
  /^printf\b/,
  /^readlink\b/,
  /^realpath\b/,
  /^dirname\b/,
  /^basename\b/,
  /^tr\b/,
  /^cut\b/,
  /^rev\b/,
  /^od\b/,
  /^xxd\b/,
];

/**
 * Commands or patterns that are never allowed — catches known dangerous
 * operations, destructive flags, privilege escalation, and piping to shells.
 */
const DEFAULT_BLOCKED_COMMANDS = [
  /rm\s+-rf\b/,
  /\bsudo\b/,
  /\bsu\b/,
  /chmod\s+777\b/,
  /\bchown\b/,
  /\bpasswd\b/,
  /\bdd\b/,
  /:\(\)\s*\{/,
  /\beval\b/,
  /\bexec\b/,
  /\bsource\b/,
  /\/dev\//,
  /\|\s*bash\b/,
  /\|\s*sh\b/,
  /\|\s*zsh\b/,
  /\bmkfs\b/,
  /\bfdisk\b/,
  /\biptables\b/,
  /\bsystemctl\b/,
  /\bkill\b/,
  /\bkillall\b/,
  /wget\s*\|\s*(bash|sh|zsh)\b/,
  /curl\s+\S+.*\|\s*(bash|sh|zsh)\b/,
  />/,
  />>/,
  /2>/,
  /mkfifo/,
  /mknod/,
  /mount/,
  /umount/,
  /init/,
  /poweroff/,
  /reboot/,
  /shutdown/,
  /halt/,
  /crontab/,
  /at\b/,
  /batch\b/,
  /nohup/,
  /disown/,
  /setuid/,
  /setgid/,
  /capset/,
  /unshare/,
  /nsenter/,
  /swapon/,
  /swapoff/,
  /losetup/,
  /dmsetup/,
  /pvcreate/,
  /vgcreate/,
  /lvcreate/,
  /pvremove/,
  /vgremove/,
  /lvremove/,
  /debugfs/,
  /debug/,
  /strace/,
  /ltrace/,
  /perf/,
  /bpftrace/,
  /ssh\b/,
  /scp\b/,
  /rsync\b/,
  /telnet\b/,
  /nc\b/,
  /ncat\b/,
  /socat/,
  /pg_ctl/,
  /mysql\b/,
  /redis-cli/,
  /mongosh\b/,
  /sqlite3\b/,
];

/**
 * Default path prefixes that are safe for agent file operations.
 */
const DEFAULT_ALLOWED_PATHS = [
  process.cwd(),                    // project directory
  path.resolve(os.homedir(), "clawd"),
  path.resolve(os.homedir(), ".PetAgent", "workspace"),
  "/tmp",
];

/**
 * Sensitive paths that are always blocked from read/write/exec.
 */
const DEFAULT_BLOCKED_PATHS = [
  "/etc",
  "/proc",
  "/sys",
  "/dev",
  "/var",
  "/root",
  "/private",
  path.resolve(os.homedir(), ".ssh"),
  path.resolve(os.homedir(), ".gnupg"),
];

/**
 * File extensions considered safe for read operations (text files).
 */
const TEXT_EXTENSIONS = new Set([
  ".ts", ".js", ".mjs", ".cjs",
  ".json", ".jsonc", ".json5",
  ".md", ".mdx",
  ".txt",
  ".yaml", ".yml",
  ".env", ".env.*",
  ".csv", ".tsv",
  ".html", ".htm", ".xhtml",
  ".css", ".scss", ".less",
  ".xml", ".svg",
  ".toml",
  ".cfg", ".conf", ".config", ".ini",
  ".log",
  ".sql",
  ".graphql", ".gql",
  ".sh", ".bash", ".zsh",
  ".dockerfile", ".dockerignore",
  ".gitignore", ".gitattributes",
  ".editorconfig",
  ".eslintrc*", ".prettierrc*",
  ".babelrc*",
  ".npmrc", ".yarnrc",
  ".nvmrc",
  ".node-version",
]);

/**
 * Binary file extensions that are always blocked from read.
 */
const BINARY_EXTENSIONS = new Set([
  ".png", ".jpg", ".jpeg", ".gif", ".bmp", ".webp", ".ico",
  ".ttf", ".otf", ".woff", ".woff2", ".eot",
  ".o", ".obj", ".a", ".lib", ".dll", ".so", ".dylib", ".class",
  ".zip", ".tar", ".gz", ".bz2", ".xz", ".7z", ".rar",
  ".pdf", ".doc", ".docx", ".xls", ".xlsx", ".ppt", ".pptx",
  ".mp3", ".mp4", ".avi", ".mov", ".mkv", ".wav", ".flac", ".ogg",
  ".exe", ".msi", ".apk", ".dmg", ".deb", ".rpm",
  ".pyc", ".pyo",
  ".woff2",
]);

export class CommandSandbox {
  private allowedCommands: RegExp[];
  private blockedCommands: RegExp[];
  private allowedPaths: string[];
  private blockedPaths: string[];

  constructor(policy: HarnessPolicy) {
    this.allowedCommands = policy.allowedCommands ?? DEFAULT_ALLOWED_COMMANDS;
    this.blockedCommands = policy.blockedCommands ?? DEFAULT_BLOCKED_COMMANDS;
    this.allowedPaths = policy.allowedPaths ?? DEFAULT_ALLOWED_PATHS;
    this.blockedPaths = policy.blockedPaths ?? DEFAULT_BLOCKED_PATHS;
  }

  /**
   * Validate a shell command against the whitelist + blacklist.
   *
   * Steps:
   *   1. Normalise whitespace
   *   2. Check blacklist first (always enforced)
   *   3. If allowedCommands is non-empty, check whitelist
   *   4. Pass
   */
  validateCommand(command: string): { ok: boolean; reason?: string } {
    if (!command || !command.trim()) {
      return { ok: false, reason: "Empty command" };
    }

    const trimmed = command.trim().replace(/\s+/g, " ");

    // Step 1: blocklist — checked first, blocks anything dangerous
    for (const pattern of this.blockedCommands) {
      if (pattern.test(trimmed)) {
        return {
          ok: false,
          reason: `Command blocked by pattern: ${pattern}`,
        };
      }
    }

    // Step 2: if the caller explicitly set a non-empty whitelist, check it
    if (this.allowedCommands.length > 0) {
      const allowed = this.allowedCommands.some((pattern) => pattern.test(trimmed));
      if (!allowed) {
        return {
          ok: false,
          reason: "Command not in allowed list",
        };
      }
    }

    return { ok: true };
  }

  /**
   * Validate a file path for read/write/exec operations.
   *
   * Steps:
   *   1. Resolve to absolute path
   *   2. Check blacklist first
   *   3. If allowedPaths is non-empty, check whitelist
   *   4. Pass
   */
  validatePath(
    targetPath: string,
    operation: "read" | "write" | "exec",
  ): { ok: boolean; reason?: string; resolvedPath?: string } {
    if (!targetPath || !targetPath.trim()) {
      return { ok: false, reason: "Empty path" };
    }

    const resolved = path.resolve(targetPath);

    // Step 1: blocklist — always enforced
    for (const blocked of this.blockedPaths) {
      if (resolved.startsWith(blocked) || resolved === blocked + "/") {
        return {
          ok: false,
          reason: `Path blocked: ${resolved} (matches blocked prefix "${blocked}")`,
        };
      }
    }

    // Step 2: if caller set a non-empty whitelist, check it
    if (this.allowedPaths.length > 0) {
      const allowed = this.allowedPaths.some((prefix) => resolved.startsWith(prefix));
      if (!allowed) {
        return {
          ok: false,
          reason: `Path not in allowed list: ${resolved}`,
        };
      }
    }

    return { ok: true, resolvedPath: resolved };
  }

  /**
   * Check whether a file extension is safe for text reading.
   */
  isTextExtension(filePath: string): boolean {
    const ext = path.extname(filePath).toLowerCase();
    if (TEXT_EXTENSIONS.has(ext)) return true;
    if (BINARY_EXTENSIONS.has(ext)) return false;
    // Unknown extension — assume text (will be checked at read time)
    return true;
  }

  /**
   * Check whether a file extension is definitively binary.
   */
  isBinaryExtension(filePath: string): boolean {
    return BINARY_EXTENSIONS.has(path.extname(filePath).toLowerCase());
  }

  /**
   * Get the default working directory for exec'd commands.
   */
  getProjectDir(): string {
    return process.cwd();
  }
}
