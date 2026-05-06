/**
 * Harness types — security/resource management layer for tool execution.
 *
 * Defines all shared types used across the harness: policy configuration,
 * execution context, audit entries, and standardised tool results.
 */

/**
 * Security policy that controls tool execution behaviour.
 *
 * All values have safe defaults:
 * - allowedCommands: if set, only these pass (whitelist mode)
 * - blockedCommands: always rejected (blacklist mode)
 * - allowedPaths: if set, only these paths are accessible (whitelist)
 * - blockedPaths: always rejected regardless of whitelist
 */
export interface HarnessPolicy {
  /** If provided, only commands matching these regexps are allowed */
  allowedCommands?: RegExp[];
  /** Commands matching these regexps are always rejected */
  blockedCommands?: RegExp[];
  /** If provided, only paths under these prefixes are accessible */
  allowedPaths?: string[];
  /** Paths matching these prefixes are always blocked */
  blockedPaths?: string[];
  /** Command execution timeout in seconds (default: 30) */
  execTimeout?: number;
  /** Maximum stdout/stderr bytes to capture (default: 1MB) */
  maxOutputSize?: number;
  /** Maximum bytes allowed when writing files (default: 10MB) */
  maxFileSize?: number;
  /** Enable concurrency lock per resource (default: false) */
  resourceLock?: boolean;
  /** Enable SQLite audit trail (default: true) */
  auditLog?: boolean;
}

/**
 * Execution context passed from the agent runtime for every tool call.
 * Carries identity and the effective policy for this invocation.
 */
export interface ExecutionContext {
  agentId: string;
  sessionId: string;
  userInput: string;
  policy: HarnessPolicy;
}

/**
 * Single audit log entry persisted to SQLite.
 */
export interface AuditEntry {
  id: string;
  timestamp: string;
  agentId: string;
  sessionId: string;
  toolName: string;
  input: string;
  success: boolean;
  error?: string;
  duration: number;
}

/**
 * Standardised result object returned by every harness operation.
 * Callers should never throw — errors are captured in `.error`.
 */
export interface ToolResult {
  success: boolean;
  message: string;
  data?: any;
  error?: string;
  duration?: number;
}

/**
 * Default policy applied when no user policy is specified.
 */
export const DEFAULT_POLICY: HarnessPolicy = {
  execTimeout: 30,
  maxOutputSize: 1_048_576, // 1 MB
  maxFileSize: 10_485_760,  // 10 MB
  resourceLock: false,
  auditLog: true,
};
