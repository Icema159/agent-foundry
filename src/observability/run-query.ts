import type { PersistedStepKind } from "../persistence/execution-store.js";
import type { ModelUsage } from "../model/types.js";
import type { TaskPostcondition } from "../verification/task-postconditions.js";

export type RunRecord = {
  id: string;
  taskId: string;
  prompt: string;
  status: string;
  agentName: string;
  agentVersion: number;
  provider: string;
  model: string;
  recoveryCount: number;
  workerId: string | null;
  heartbeatAt: Date | null;
  createdAt: Date;
  startedAt: Date | null;
  completedAt: Date | null;
  finalAnswer: string | null;
  failureReason: string | null;
  failureMessage: string | null;
  steps: Array<{ sequence: number; kind: PersistedStepKind; createdAt: Date; payload: unknown }>;
  approvals: Array<{
    id: string;
    toolName: string;
    status: string;
    requestedAt: Date;
    decidedAt: Date | null;
  }>;
  postconditions?: TaskPostcondition[];
};

export type RunHeader = Pick<RunRecord,
  "id" | "status" | "agentName" | "agentVersion" | "provider" | "model" |
  "createdAt" | "startedAt" | "completedAt"
>;

export interface RunReader {
  listRecent(limit: number): Promise<RunHeader[]>;
  findById(taskRunId: string): Promise<RunRecord | null>;
}

export type RunSummary = {
  id: string;
  status: string;
  agent: string;
  agentVersion: number;
  provider: string;
  model: string;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
};

export type TimelineEntry = {
  sequence: number;
  executionAttempt: number;
  runtimeStep: number | null;
  timestamp: string;
  type: PersistedStepKind;
  toolName?: string;
  argumentsSummary?: string;
  resultSummary?: string;
  approvalId?: string;
  failureCode?: string;
  message?: string;
  workerId?: string;
  answer?: string;
  durationMs?: number;
  provider?: string;
  model?: string;
  usage?: ModelUsage;
  verificationPassed?: boolean;
};

export type RunDetails = RunSummary & {
  verification?: { status: "NOT_REQUESTED" | "PENDING" | "PASSED" | "FAILED" | "NOT_RUN"; conditions: TaskPostcondition[] };
  taskId: string;
  prompt: string;
  recoveryCount: number;
  workerId: string | null;
  heartbeatAt: string | null;
  totalDurationMs: number | null;
  executionDurationMs: number | null;
  finalAnswer: string | null;
  failure: { code: string; message: string | null } | null;
  approvals: Array<{
    id: string;
    toolName: string;
    status: string;
    requestedAt: string;
    decidedAt: string | null;
  }>;
  timeline: TimelineEntry[];
};

export class RunQueryService {
  constructor(private readonly reader: RunReader) {}

  async listRecent(limit = 20): Promise<RunSummary[]> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error("Run list limit must be 1–100");
    return (await this.reader.listRecent(limit)).map(toSummary);
  }

  async get(taskRunId: string): Promise<RunDetails | null> {
    const record = await this.reader.findById(taskRunId);
    if (!record) return null;
    let lastAttempt = 1;
    const timeline = [...record.steps]
      .sort((a, b) => a.sequence - b.sequence)
      .map((step): TimelineEntry => {
        const payload = object(step.payload);
        const attempt = positiveInteger(payload.executionAttempt) ?? lastAttempt;
        lastAttempt = attempt;
        const runtimeStep = positiveInteger(payload.runtimeStep) ?? null;
        const model = object(payload.model);
        const toolCall = object(payload.toolCall);
        const entry: TimelineEntry = {
          sequence: step.sequence,
          executionAttempt: attempt,
          runtimeStep,
          timestamp: step.createdAt.toISOString(),
          type: step.kind,
        };
        if (step.kind === "MODEL_CALL") {
          entry.provider = string(model.provider) ?? record.provider;
          entry.model = string(model.model) ?? record.model;
          entry.usage = usage(model.usage);
        }
        if (step.kind === "TOOL_CALL") {
          entry.toolName = string(toolCall.name);
          entry.argumentsSummary = summary(toolCall.arguments, "arguments");
        }
        if (step.kind === "TOOL_RESULT") {
          entry.toolName = string(payload.name);
          entry.resultSummary = summary(payload.result, "result");
        }
        if (step.kind.startsWith("APPROVAL_")) {
          entry.toolName = string(payload.toolName);
          entry.approvalId = string(payload.approvalId);
          if (step.kind === "APPROVAL_REQUIRED") {
            entry.argumentsSummary = summary(payload.validatedArguments, "arguments");
          }
        }
        if (step.kind === "RUNTIME_FAILURE") {
          entry.failureCode = string(payload.reason);
          entry.message = string(payload.message);
          entry.workerId = string(payload.workerId);
        }
        if (step.kind === "FINAL_ANSWER") entry.answer = string(payload.answer);
        if (step.kind === "POSTCONDITION_CHECK") {
          entry.verificationPassed = payload.passed === true;
          entry.message = `${payload.passed === true ? "PASS" : "FAIL"}: ${string(payload.message) ?? "Postcondition check"}`;
        }
        if (isDuration(payload.durationMs)) entry.durationMs = payload.durationMs;
        return entry;
      });
    const conditions = record.postconditions ?? [];
    const check = [...timeline].reverse().find(entry => entry.type === "POSTCONDITION_CHECK" && entry.executionAttempt === record.recoveryCount + 1);
    return {
      ...toSummary(record),
      verification: { conditions, status: !conditions.length ? "NOT_REQUESTED" : check ?
        (check.verificationPassed ? "PASSED" : "FAILED") :
        (["COMPLETED", "FAILED"].includes(record.status) ? "NOT_RUN" : "PENDING") },
      taskId: record.taskId,
      prompt: record.prompt,
      recoveryCount: record.recoveryCount,
      workerId: record.workerId,
      heartbeatAt: record.heartbeatAt?.toISOString() ?? null,
      totalDurationMs: duration(record.createdAt, record.completedAt),
      executionDurationMs: duration(record.startedAt, record.completedAt),
      finalAnswer: record.finalAnswer,
      failure: record.failureReason
        ? { code: record.failureReason, message: record.failureMessage }
        : null,
      approvals: record.approvals.map((approval) => ({
        id: approval.id,
        toolName: approval.toolName,
        status: approval.status,
        requestedAt: approval.requestedAt.toISOString(),
        decidedAt: approval.decidedAt?.toISOString() ?? null,
      })),
      timeline,
    };
  }
}

function toSummary(record: RunHeader): RunSummary {
  return {
    id: record.id,
    status: record.status,
    agent: record.agentName,
    agentVersion: record.agentVersion,
    provider: record.provider,
    model: record.model,
    createdAt: record.createdAt.toISOString(),
    startedAt: record.startedAt?.toISOString() ?? null,
    completedAt: record.completedAt?.toISOString() ?? null,
  };
}

function object(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function string(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function positiveInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

function isDuration(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function duration(start: Date | null, end: Date | null): number | null {
  return start && end ? Math.max(0, end.getTime() - start.getTime()) : null;
}

function summary(value: unknown, kind: "arguments" | "result"): string {
  const raw = object(value);
  const safe = Object.fromEntries(Object.entries(raw).map(([key, item]) => {
    if (kind === "arguments" && (key === "path" || key === "query") && typeof item === "string") {
      return [key, item.slice(0, 100)];
    }
    if (typeof item === "string") return [key, `<${item.length} characters>`];
    if (Array.isArray(item)) return [key, `<${item.length} items>`];
    if (typeof item === "object" && item !== null) return [key, "<object>"];
    return [key, item];
  }));
  const text = JSON.stringify(safe);
  return text.length <= 240 ? text : `${text.slice(0, 237)}...`;
}

function usage(value: unknown): ModelUsage | undefined {
  const raw = object(value);
  const result: ModelUsage = {};
  for (const key of ["inputTokens", "outputTokens", "totalTokens"] as const) {
    const count = raw[key];
    if (typeof count === "number" && Number.isSafeInteger(count) && count >= 0) result[key] = count;
  }
  return Object.keys(result).length ? result : undefined;
}
