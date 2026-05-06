export interface LogActionInput {
  sessionId: string;
  actionType: string;
  toolName?: string;
  /** ReAct step 序号（第几步调用），用于 trace 多步调用链路 */
  step?: number;
  resourceType?: string;
  resourceId?: string;
  inputJson?: Record<string, unknown>;
  outputStatus?: string;
  outputSummary?: string;
  artifactId?: string;
  approvedBy?: string;
  createdAt?: string;
  metadata?: Record<string, unknown>;
}
