export interface LogActionInput {
  sessionId: string;
  actionType: string;
  toolName?: string;
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
