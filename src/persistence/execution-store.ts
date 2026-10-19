import type {
  ApprovalResume,
  PendingApprovalAction,
  RuntimeResult,
  TerminalRuntimeResult,
} from "../runtime/agent-runtime.js";
import type { ToolPolicies } from "../tools/tool-registry.js";
import type { ModelMetadata } from "../model/types.js";
import type { TaskPostcondition } from "../verification/task-postconditions.js";

export type AgentDefinition = {
  name: string;
  description: string;
  version: number;
  systemInstructions: string;
  modelProvider: string;
  modelName: string;
  maxSteps: number;
  toolPolicies: ToolPolicies;
};

export type ResolvedAgentVersion = {
  agentId: string;
  agentVersionId: string;
};

export type PendingExecution = {
  taskId: string;
  taskRunId: string;
};

export type LoadedExecution = PendingExecution & {
  prompt: string;
  workspaceRoot: string;
  agent: AgentDefinition;
  recoveryCount: number;
  nextStepSequence: number;
  approvalResume?: ApprovalResume;
  postconditions?: TaskPostcondition[];
  priorToolResults?: unknown[];
  priorToolCalls?: unknown[];
  correctionAttempted?: boolean;
  hadDeniedApproval?: boolean;
};

export type StaleExecution = {
  taskId: string;
  taskRunId: string;
  recoveryCount: number;
  agentName: string;
  toolPolicies: ToolPolicies;
};

export type RecoveryDecision =
  | { action: "REQUEUE"; recoveryCount: number }
  | { action: "FAILED_LIMIT" }
  | { action: "SKIPPED" };

export type PersistedStepKind =
  | "MODEL_CALL"
  | "TOOL_CALL"
  | "TOOL_RESULT"
  | "FINAL_ANSWER"
  | "POSTCONDITION_CHECK"
  | "RUNTIME_FAILURE"
  | "APPROVAL_REQUIRED"
  | "APPROVAL_APPROVED"
  | "APPROVAL_DENIED";

export type PendingApproval = {
  id: string;
  taskRunId: string;
  toolName: string;
  validatedArguments: unknown;
  requestedAt: Date;
};

export type ApprovalDecision = "APPROVED" | "DENIED";

export type PersistedStep = {
  sequence: number;
  kind: PersistedStepKind;
  payload: unknown;
};

export interface ExecutionStore {
  resolveAgentVersion(definition: AgentDefinition): Promise<ResolvedAgentVersion>;
  createPendingExecution(
    agentId: string,
    agentVersionId: string,
    prompt: string,
    workspaceRoot: string,
    postconditions?: TaskPostcondition[],
  ): Promise<PendingExecution>;
  loadExecution(taskRunId: string): Promise<LoadedExecution>;
  claimExecution(taskId: string, taskRunId: string, workerId: string, now: Date): Promise<void>;
  heartbeat(taskRunId: string, workerId: string, now: Date): Promise<void>;
  appendStep(taskRunId: string, workerId: string, step: PersistedStep): Promise<void>;
  completeModelCall(
    taskRunId: string,
    workerId: string,
    sequence: number,
    durationMs: number,
    metadata?: ModelMetadata,
  ): Promise<void>;
  waitForApproval(
    taskId: string,
    taskRunId: string,
    workerId: string,
    action: PendingApprovalAction,
    step: PersistedStep,
  ): Promise<{ approvalId: string }>;
  listPendingApprovals(): Promise<PendingApproval[]>;
  decideApproval(approvalId: string, decision: ApprovalDecision): Promise<{ taskRunId: string }>;
  claimApprovalAction(
    taskRunId: string,
    workerId: string,
    approvalId: string,
    now: Date,
  ): Promise<void>;
  finishExecution(
    taskId: string,
    taskRunId: string,
    workerId: string,
    result: TerminalRuntimeResult,
  ): Promise<void>;
  findStaleExecutions(staleBefore: Date): Promise<StaleExecution[]>;
  recoverStaleExecution(
    taskRunId: string,
    staleBefore: Date,
    maxRecoveries: number,
  ): Promise<RecoveryDecision>;
  failStaleExecution(taskId: string, taskRunId: string, reason: string): Promise<void>;
}
