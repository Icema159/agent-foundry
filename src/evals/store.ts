import type { PrismaClient } from "../generated/prisma/client.js";
import type { EvalCase } from "./cases.js";
import { caseRevision } from "./cases.js";
import type { EvalResult } from "./scorer.js";

export type EvalRecord = {
  id: string; caseId: string; caseRevision: string; taskRunId: string;
  provider: string; model: string; agentVersion: number;
  createdAt: string; result: EvalResult | null;
};

export interface EvalStore {
  create(definition: EvalCase, taskRunId: string): Promise<string>;
  finish(id: string, result: EvalResult): Promise<void>;
  list(caseId: string): Promise<EvalRecord[]>;
}

export class PrismaEvalStore implements EvalStore {
  constructor(private readonly prisma: PrismaClient) {}
  async create(definition: EvalCase, taskRunId: string): Promise<string> {
    const record = await this.prisma.evalRun.create({ data: {
      caseId: definition.id, caseRevision: caseRevision(definition),
      caseDefinition: JSON.parse(JSON.stringify(definition)), taskRunId,
    } });
    return record.id;
  }
  async finish(id: string, result: EvalResult): Promise<void> {
    await this.prisma.evalRun.update({ where: { id }, data: {
      result: JSON.parse(JSON.stringify(result)), completedAt: new Date(),
    } });
  }
  async list(caseId: string): Promise<EvalRecord[]> {
    const records = await this.prisma.evalRun.findMany({ where: { caseId },
      orderBy: { createdAt: "desc" }, take: 100,
      include: { taskRun: { include: { agentVersion: true } } },
    });
    return records.map((record) => ({
      id: record.id, caseId: record.caseId, caseRevision: record.caseRevision,
      taskRunId: record.taskRunId, createdAt: record.createdAt.toISOString(),
      provider: record.taskRun.agentVersion.modelProvider,
      model: record.taskRun.agentVersion.modelName,
      agentVersion: record.taskRun.agentVersion.version,
      result: record.result as EvalResult | null,
    }));
  }
}

// Different definition revisions are never silently combined into a benchmark.
export function comparison(records: EvalRecord[]): Record<string, EvalRecord[]> {
  const groups: Record<string, EvalRecord[]> = {};
  for (const record of records) (groups[record.caseRevision] ??= []).push(record);
  return groups;
}
