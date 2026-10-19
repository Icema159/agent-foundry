import type { PrismaClient } from "../generated/prisma/client.js";
import type { PersistedStepKind } from "../persistence/execution-store.js";
import type { RunHeader, RunReader, RunRecord } from "./run-query.js";
import { parsePostconditions } from "../verification/task-postconditions.js";

const include = {
  task: { select: { prompt: true, postconditions: true } },
  agentVersion: {
    select: {
      version: true,
      modelProvider: true,
      modelName: true,
      agent: { select: { name: true } },
    },
  },
  steps: {
    orderBy: { sequence: "asc" as const },
    select: { sequence: true, kind: true, createdAt: true, payload: true },
  },
  approvals: {
    orderBy: { requestedAt: "asc" as const },
    select: { id: true, toolName: true, status: true, requestedAt: true, decidedAt: true },
  },
};

type QueryRun = {
  id: string;
  taskId: string;
  status: string;
  recoveryCount: number;
  workerId: string | null;
  heartbeatAt: Date | null;
  createdAt: Date;
  startedAt: Date | null;
  completedAt: Date | null;
  finalAnswer: string | null;
  failureReason: string | null;
  failureMessage: string | null;
  task: { prompt: string; postconditions: unknown };
  agentVersion: {
    version: number;
    modelProvider: string;
    modelName: string;
    agent: { name: string };
  };
  steps: Array<{ sequence: number; kind: PersistedStepKind; createdAt: Date; payload: unknown }>;
  approvals: Array<{
    id: string;
    toolName: string;
    status: string;
    requestedAt: Date;
    decidedAt: Date | null;
  }>;
};

export class PrismaRunReader implements RunReader {
  constructor(private readonly prisma: PrismaClient) {}

  async listRecent(limit: number): Promise<RunHeader[]> {
    const runs = await this.prisma.taskRun.findMany({
      orderBy: { createdAt: "desc" },
      take: limit,
      select: {
        id: true, status: true, createdAt: true, startedAt: true, completedAt: true,
        agentVersion: {
          select: {
            version: true, modelProvider: true, modelName: true,
            agent: { select: { name: true } },
          },
        },
      },
    });
    return runs.map((run) => ({
      id: run.id,
      status: run.status,
      agentName: run.agentVersion.agent.name,
      agentVersion: run.agentVersion.version,
      provider: run.agentVersion.modelProvider,
      model: run.agentVersion.modelName,
      createdAt: run.createdAt,
      startedAt: run.startedAt,
      completedAt: run.completedAt,
    }));
  }

  async findById(taskRunId: string): Promise<RunRecord | null> {
    const run = await this.prisma.taskRun.findUnique({ where: { id: taskRunId }, include });
    return run ? toRecord(run) : null;
  }
}

function toRecord(run: QueryRun): RunRecord {
  return {
    id: run.id,
    taskId: run.taskId,
    prompt: run.task.prompt,
    postconditions: parsePostconditions(run.task.postconditions),
    status: run.status,
    agentName: run.agentVersion.agent.name,
    agentVersion: run.agentVersion.version,
    provider: run.agentVersion.modelProvider,
    model: run.agentVersion.modelName,
    recoveryCount: run.recoveryCount,
    workerId: run.workerId,
    heartbeatAt: run.heartbeatAt,
    createdAt: run.createdAt,
    startedAt: run.startedAt,
    completedAt: run.completedAt,
    finalAnswer: run.finalAnswer,
    failureReason: run.failureReason,
    failureMessage: run.failureMessage,
    steps: run.steps,
    approvals: run.approvals,
  };
}
