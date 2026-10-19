import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../generated/prisma/client.js";
import type { TerminalRuntimeResult } from "../runtime/agent-runtime.js";
import type { ModelMetadata } from "../model/types.js";
import { parsePostconditions, type TaskPostcondition } from "../verification/task-postconditions.js";
import type {
  AgentDefinition,
  ApprovalDecision,
  ExecutionStore,
  LoadedExecution,
  PendingExecution,
  PendingApproval,
  PersistedStep,
  RecoveryDecision,
  ResolvedAgentVersion,
  StaleExecution,
} from "./execution-store.js";

export function createPrismaClient(connectionString: string): PrismaClient {
  const adapter = new PrismaPg({ connectionString });
  return new PrismaClient({ adapter });
}

export class PrismaExecutionStore implements ExecutionStore {
  constructor(private readonly prisma: PrismaClient) {}

  async resolveAgentVersion(definition: AgentDefinition): Promise<ResolvedAgentVersion> {
    const agent = await this.prisma.agent.upsert({
      where: { name: definition.name },
      update: { description: definition.description },
      create: { name: definition.name, description: definition.description },
    });
    const version = await this.prisma.agentVersion.upsert({
      where: { agentId_version: { agentId: agent.id, version: definition.version } },
      update: {},
      create: {
        agentId: agent.id,
        version: definition.version,
        systemInstructions: definition.systemInstructions,
        modelProvider: definition.modelProvider,
        modelName: definition.modelName,
        maxSteps: definition.maxSteps,
        toolPolicies: definition.toolPolicies,
      },
    });
    if (version.modelProvider !== definition.modelProvider || version.modelName !== definition.modelName) {
      throw new Error(`AgentVersion ${definition.version} already uses ${version.modelProvider}/${version.modelName}; choose a new FOUNDRY_AGENT_VERSION`);
    }
    return { agentId: agent.id, agentVersionId: version.id };
  }

  async createPendingExecution(
    agentId: string,
    agentVersionId: string,
    prompt: string,
    workspaceRoot: string,
    postconditions: TaskPostcondition[] = [],
  ): Promise<PendingExecution> {
    return this.prisma.$transaction(async (transaction) => {
      const task = await transaction.task.create({
        data: { agentId, prompt, workspaceRoot, postconditions: parsePostconditions(postconditions), status: "PENDING" },
      });
      const run = await transaction.taskRun.create({
        data: {
          taskId: task.id,
          agentVersionId,
          status: "PENDING",
        },
      });
      return { taskId: task.id, taskRunId: run.id };
    });
  }

  async loadExecution(taskRunId: string): Promise<LoadedExecution> {
    const run = await this.prisma.taskRun.findUnique({
      where: { id: taskRunId },
      include: {
        task: true,
        agentVersion: { include: { agent: true } },
        steps: { orderBy: { sequence: "desc" }, take: 1 },
        approvals: {
          where: { status: { in: ["APPROVED", "DENIED"] }, consumedAt: null },
          orderBy: { requestedAt: "desc" },
          take: 1,
        },
      },
    });
    if (!run) throw new Error(`TaskRun not found: ${taskRunId}`);
    if (run.status !== "PENDING") {
      throw new Error(`TaskRun ${taskRunId} is ${run.status}, expected PENDING`);
    }
    if (!run.task.workspaceRoot) {
      throw new Error(`TaskRun ${taskRunId} has no workspace root`);
    }
    const postconditions = parsePostconditions(run.task.postconditions);
    const priorHistory = postconditions.length ? await this.prisma.step.findMany({
      where: { taskRunId, kind: { in: ["TOOL_RESULT", "TOOL_CALL", "POSTCONDITION_CHECK"] } }, select: { kind: true, payload: true },
    }) : [];
    const hadDeniedApproval = postconditions.length ? (await this.prisma.approval.count({
      where: { taskRunId, status: "DENIED" },
    })) > 0 : false;
    return {
      taskId: run.taskId,
      taskRunId: run.id,
      prompt: run.task.prompt,
      workspaceRoot: run.task.workspaceRoot,
      postconditions,
      priorToolResults: priorHistory.filter(step => step.kind === "TOOL_RESULT").map(step => step.payload),
      priorToolCalls: priorHistory.filter(step => step.kind === "TOOL_CALL").map(step => step.payload),
      correctionAttempted: priorHistory.some(step => step.kind === "POSTCONDITION_CHECK"
        && typeof step.payload === "object" && step.payload !== null && !Array.isArray(step.payload)
        && step.payload.correctionAttempt === 1),
      hadDeniedApproval,
      recoveryCount: run.recoveryCount,
      nextStepSequence: (run.steps[0]?.sequence ?? 0) + 1,
      agent: {
        name: run.agentVersion.agent.name,
        description: run.agentVersion.agent.description ?? "",
        version: run.agentVersion.version,
        systemInstructions: run.agentVersion.systemInstructions,
        modelProvider: run.agentVersion.modelProvider,
        modelName: run.agentVersion.modelName,
        maxSteps: run.agentVersion.maxSteps,
        toolPolicies: asToolPolicies(run.agentVersion.toolPolicies),
      },
      approvalResume: run.approvals[0]
        ? {
            approvalId: run.approvals[0].id,
            decision: run.approvals[0].status === "APPROVED" ? "APPROVED" : "DENIED",
            toolName: run.approvals[0].toolName,
            validatedArguments: run.approvals[0].validatedArguments,
            resumeMessages: asModelMessages(run.approvals[0].resumeMessages),
            runtimeStep: run.approvals[0].runtimeStep,
          }
        : undefined,
    };
  }

  async claimExecution(
    taskId: string,
    taskRunId: string,
    workerId: string,
    now: Date,
  ): Promise<void> {
    await this.prisma.$transaction(async (transaction) => {
      const updated = await transaction.taskRun.updateMany({
        where: { id: taskRunId, taskId, status: "PENDING" },
        data: { status: "RUNNING", workerId, heartbeatAt: now, startedAt: now },
      });
      if (updated.count !== 1) {
        throw new Error(`TaskRun ${taskRunId} could not transition from PENDING to RUNNING`);
      }
      await transaction.task.update({
        where: { id: taskId },
        data: { status: "RUNNING" },
      });
    });
  }

  async heartbeat(taskRunId: string, workerId: string, now: Date): Promise<void> {
    const updated = await this.prisma.taskRun.updateMany({
      where: { id: taskRunId, status: "RUNNING", workerId },
      data: { heartbeatAt: now },
    });
    if (updated.count !== 1) throw new Error(`Execution lease lost for TaskRun ${taskRunId}`);
  }

  async appendStep(taskRunId: string, workerId: string, step: PersistedStep): Promise<void> {
    await this.prisma.$transaction(async (transaction) => {
      const owned = await transaction.taskRun.updateMany({
        where: { id: taskRunId, status: "RUNNING", workerId },
        data: { heartbeatAt: new Date() },
      });
      if (owned.count !== 1) throw new Error(`Execution lease lost for TaskRun ${taskRunId}`);
      await transaction.step.create({
        data: {
          taskRunId,
          sequence: step.sequence,
          kind: step.kind,
          payload: toJson(step.payload),
        },
      });
    });
  }

  async completeModelCall(
    taskRunId: string,
    workerId: string,
    sequence: number,
    durationMs: number,
    metadata?: ModelMetadata,
  ): Promise<void> {
    await this.prisma.$transaction(async (transaction) => {
      const owned = await transaction.taskRun.updateMany({
        where: { id: taskRunId, status: "RUNNING", workerId },
        data: { heartbeatAt: new Date() },
      });
      if (owned.count !== 1) throw new Error(`Execution lease lost for TaskRun ${taskRunId}`);
      const step = await transaction.step.findUniqueOrThrow({
        where: { taskRunId_sequence: { taskRunId, sequence } },
      });
      if (step.kind !== "MODEL_CALL") throw new Error(`Step ${sequence} is not a model call`);
      await transaction.step.update({
        where: { id: step.id },
        data: {
          payload: toJson({
            ...(step.payload as object),
            durationMs,
            ...(metadata ? { model: metadata } : {}),
          }),
        },
      });
    });
  }

  async waitForApproval(
    taskId: string,
    taskRunId: string,
    workerId: string,
    action: import("../runtime/agent-runtime.js").PendingApprovalAction,
    step: PersistedStep,
  ): Promise<{ approvalId: string }> {
    return this.prisma.$transaction(async (transaction) => {
      const moved = await transaction.taskRun.updateMany({
        where: { id: taskRunId, taskId, status: "RUNNING", workerId },
        data: { status: "WAITING_FOR_APPROVAL", workerId: null, heartbeatAt: null },
      });
      if (moved.count !== 1) throw new Error(`Execution lease lost for TaskRun ${taskRunId}`);
      const approval = await transaction.approval.create({
        data: {
          taskRunId,
          toolName: action.toolName,
          validatedArguments: toJson(action.validatedArguments),
          resumeMessages: toJson(action.resumeMessages),
          runtimeStep: action.runtimeStep,
        },
      });
      await transaction.step.create({
        data: {
          taskRunId,
          sequence: step.sequence,
          kind: step.kind,
          payload: toJson({ ...(step.payload as object), approvalId: approval.id }),
        },
      });
      await transaction.task.update({
        where: { id: taskId },
        data: { status: "WAITING_FOR_APPROVAL" },
      });
      return { approvalId: approval.id };
    });
  }

  async listPendingApprovals(): Promise<PendingApproval[]> {
    return this.prisma.approval.findMany({
      where: { status: "PENDING" },
      orderBy: { requestedAt: "asc" },
      select: {
        id: true,
        taskRunId: true,
        toolName: true,
        validatedArguments: true,
        requestedAt: true,
      },
    });
  }

  async decideApproval(
    approvalId: string,
    decision: ApprovalDecision,
  ): Promise<{ taskRunId: string }> {
    return this.prisma.$transaction(async (transaction) => {
      const approval = await transaction.approval.findUnique({
        where: { id: approvalId },
        include: { taskRun: { select: { taskId: true, status: true } } },
      });
      if (!approval) throw new Error(`Approval not found: ${approvalId}`);
      if (approval.status !== "PENDING") {
        throw new Error(`Approval ${approvalId} was already decided as ${approval.status}`);
      }
      if (approval.taskRun.status !== "WAITING_FOR_APPROVAL") {
        throw new Error(`TaskRun ${approval.taskRunId} is not waiting for approval`);
      }
      const decided = await transaction.approval.updateMany({
        where: { id: approvalId, status: "PENDING" },
        data: { status: decision, decidedAt: new Date() },
      });
      if (decided.count !== 1) throw new Error(`Approval ${approvalId} was already decided`);
      const moved = await transaction.taskRun.updateMany({
        where: { id: approval.taskRunId, status: "WAITING_FOR_APPROVAL" },
        data: { status: "PENDING", workerId: null, heartbeatAt: null },
      });
      if (moved.count !== 1) throw new Error(`TaskRun ${approval.taskRunId} is no longer waiting`);
      await transaction.task.update({
        where: { id: approval.taskRun.taskId },
        data: { status: "PENDING" },
      });
      const latest = await transaction.step.findFirst({
        where: { taskRunId: approval.taskRunId },
        orderBy: { sequence: "desc" },
        select: { sequence: true },
      });
      const run = await transaction.taskRun.findUniqueOrThrow({
        where: { id: approval.taskRunId },
        select: { recoveryCount: true },
      });
      await transaction.step.create({
        data: {
          taskRunId: approval.taskRunId,
          sequence: (latest?.sequence ?? 0) + 1,
          kind: decision === "APPROVED" ? "APPROVAL_APPROVED" : "APPROVAL_DENIED",
          payload: {
            approvalId,
            toolName: approval.toolName,
            executionAttempt: run.recoveryCount + 1,
          },
        },
      });
      return { taskRunId: approval.taskRunId };
    });
  }

  async claimApprovalAction(
    taskRunId: string,
    workerId: string,
    approvalId: string,
    now: Date,
  ): Promise<void> {
    await this.prisma.$transaction(async (transaction) => {
      const owned = await transaction.taskRun.updateMany({
        where: { id: taskRunId, status: "RUNNING", workerId },
        data: { heartbeatAt: now },
      });
      if (owned.count !== 1) throw new Error(`Execution lease lost for TaskRun ${taskRunId}`);
      const claimed = await transaction.approval.updateMany({
        where: {
          id: approvalId,
          taskRunId,
          status: { in: ["APPROVED", "DENIED"] },
          consumedAt: null,
        },
        data: { consumedAt: now },
      });
      if (claimed.count !== 1) throw new Error(`Approval action ${approvalId} is unavailable`);
    });
  }

  async finishExecution(
    taskId: string,
    taskRunId: string,
    workerId: string,
    result: TerminalRuntimeResult,
  ): Promise<void> {
    const completed = result.status === "completed";
    await this.prisma.$transaction(async (transaction) => {
      const updated = await transaction.taskRun.updateMany({
        where: { id: taskRunId, taskId, status: "RUNNING", workerId },
        data: {
          status: completed ? "COMPLETED" : "FAILED",
          finalAnswer: result.answer ?? null,
          failureReason: completed ? null : result.reason,
          failureMessage: completed ? null : result.message,
          completedAt: new Date(),
          workerId: null,
          heartbeatAt: null,
        },
      });
      if (updated.count !== 1) throw new Error(`Execution lease lost for TaskRun ${taskRunId}`);
      await transaction.task.update({
        where: { id: taskId },
        data: { status: completed ? "COMPLETED" : "FAILED" },
      });
    });
  }

  async findStaleExecutions(staleBefore: Date): Promise<StaleExecution[]> {
    const runs = await this.prisma.taskRun.findMany({
      where: {
        status: "RUNNING",
        OR: [{ heartbeatAt: null }, { heartbeatAt: { lt: staleBefore } }],
      },
      include: { agentVersion: { include: { agent: true } } },
      orderBy: { createdAt: "asc" },
    });
    return runs.map((run) => ({
      taskId: run.taskId,
      taskRunId: run.id,
      recoveryCount: run.recoveryCount,
      agentName: run.agentVersion.agent.name,
      toolPolicies: asToolPolicies(run.agentVersion.toolPolicies),
    }));
  }

  async recoverStaleExecution(
    taskRunId: string,
    staleBefore: Date,
    maxRecoveries: number,
  ): Promise<RecoveryDecision> {
    return this.prisma.$transaction(async (transaction) => {
      const run = await transaction.taskRun.findUnique({
        where: { id: taskRunId },
        select: { id: true, taskId: true, status: true, heartbeatAt: true, recoveryCount: true, workerId: true },
      });
      if (!run || run.status !== "RUNNING" || (run.heartbeatAt && run.heartbeatAt >= staleBefore)) {
        return { action: "SKIPPED" };
      }
      const staleWhere = {
        id: run.id,
        status: "RUNNING" as const,
        recoveryCount: run.recoveryCount,
        OR: [{ heartbeatAt: null }, { heartbeatAt: { lt: staleBefore } }],
      };
      if (run.recoveryCount >= maxRecoveries) {
        const failed = await transaction.taskRun.updateMany({
          where: staleWhere,
          data: {
            status: "FAILED",
            failureReason: "RECOVERY_LIMIT_EXCEEDED",
            failureMessage: `Run exceeded ${maxRecoveries} whole-run recoveries`,
            completedAt: new Date(),
          },
        });
        if (failed.count !== 1) return { action: "SKIPPED" };
        const latest = await transaction.step.findFirst({ where: { taskRunId }, orderBy: { sequence: "desc" }, select: { sequence: true } });
        await transaction.step.create({ data: {
          taskRunId, sequence: (latest?.sequence ?? 0) + 1, kind: "RUNTIME_FAILURE",
          payload: { executionAttempt: run.recoveryCount + 1, runtimeStep: null, reason: "RECOVERY_LIMIT_EXCEEDED", message: `Run exceeded ${maxRecoveries} whole-run recoveries`, workerId: run.workerId },
        } });
        await transaction.task.update({
          where: { id: run.taskId },
          data: { status: "FAILED" },
        });
        return { action: "FAILED_LIMIT" };
      }
      const recoveryCount = run.recoveryCount + 1;
      const recovered = await transaction.taskRun.updateMany({
        where: staleWhere,
        data: {
          status: "PENDING",
          workerId: null,
          heartbeatAt: null,
          recoveryCount,
          failureReason: null,
          failureMessage: null,
          completedAt: null,
        },
      });
      if (recovered.count !== 1) return { action: "SKIPPED" };
      const latest = await transaction.step.findFirst({ where: { taskRunId }, orderBy: { sequence: "desc" }, select: { sequence: true } });
      await transaction.step.create({ data: {
        taskRunId, sequence: (latest?.sequence ?? 0) + 1, kind: "RUNTIME_FAILURE",
        payload: { executionAttempt: run.recoveryCount + 1, runtimeStep: null, reason: "WORKER_LEASE_EXPIRED", message: "Worker lease expired; whole run will restart", workerId: run.workerId },
      } });
      await transaction.task.update({
        where: { id: run.taskId },
        data: { status: "PENDING" },
      });
      return { action: "REQUEUE", recoveryCount };
    });
  }

  async failStaleExecution(taskId: string, taskRunId: string, reason: string): Promise<void> {
    await this.prisma.$transaction(async (transaction) => {
      const run = await transaction.taskRun.update({
        where: { id: taskRunId },
        data: {
          status: "FAILED",
          failureReason: "RECOVERY_NOT_SAFE",
          failureMessage: reason,
          completedAt: new Date(),
        },
      });
      const latest = await transaction.step.findFirst({ where: { taskRunId }, orderBy: { sequence: "desc" }, select: { sequence: true } });
      await transaction.step.create({ data: {
        taskRunId, sequence: (latest?.sequence ?? 0) + 1, kind: "RUNTIME_FAILURE",
        payload: { executionAttempt: run.recoveryCount + 1, runtimeStep: null, reason: "RECOVERY_NOT_SAFE", message: reason, workerId: run.workerId },
      } });
      await transaction.task.update({ where: { id: taskId }, data: { status: "FAILED" } });
    });
  }
}

function toJson(value: unknown): object {
  return JSON.parse(JSON.stringify(value)) as object;
}

function asToolPolicies(value: unknown): import("../tools/tool-registry.js").ToolPolicies {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("AgentVersion toolPolicies must be an object");
  }
  const entries = Object.entries(value);
  if (entries.some(([, policy]) => !["ALLOW", "DENY", "REQUIRE_APPROVAL"].includes(String(policy)))) {
    throw new Error("AgentVersion contains an invalid tool policy");
  }
  return Object.fromEntries(entries) as import("../tools/tool-registry.js").ToolPolicies;
}

function asModelMessages(value: unknown): import("../model/types.js").ModelMessage[] {
  if (!Array.isArray(value)) throw new Error("Approval resumeMessages must be an array");
  return value as import("../model/types.js").ModelMessage[];
}
