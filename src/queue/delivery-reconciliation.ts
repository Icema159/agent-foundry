import { databaseNow } from "../authorization/credential-lock.js";
import type { Prisma, PrismaClient } from "../generated/prisma/client.js";
import { isReadOnlyRepositoryRun } from "../recovery/recover-stale-runs.js";
import type { ToolPolicies } from "../tools/tool-registry.js";
import type { TaskRunQueue } from "./agent-task-queue.js";
import { dispatchTrackedDelivery } from "./task-delivery.js";

const MIN_PENDING_AGE_MS = 30_000;
const owner = "foundry-local-owner";
const referenceAgent = { ownerId: owner, integration: "REFERENCE" } as const;

const runSelect = {
  id: true, taskId: true, status: true, deliveryId: true, startedAt: true,
  completedAt: true, workerId: true, heartbeatAt: true, recoveryCount: true,
  agentVersion: { select: { toolPolicies: true, agent: { select: { name: true } } } },
} satisfies Prisma.TaskRunSelect;

type Run = Prisma.TaskRunGetPayload<{ select: typeof runSelect }>;
type Queue = TaskRunQueue & { inspect(taskRunId: string, deliveryId: string): Promise<string> };

export class DeliveryReconciliation {
  constructor(private readonly db: PrismaClient, private readonly queue: Queue) {}

  async list() {
    return this.db.$queryRaw`
      SELECT r.id AS "taskRunId", r."deliveryId", d.source, d."createdAt" AS "pendingSince"
      FROM "TaskRun" r
      JOIN "AgentVersion" v ON v.id = r."agentVersionId"
      JOIN "Agent" a ON a.id = v."agentId"
      JOIN "TaskRunDelivery" d ON d.id = r."deliveryId" AND d."taskRunId" = r.id
      WHERE a."ownerId" = ${owner} AND a.integration = 'REFERENCE' AND r.status = 'PENDING'
        AND d."createdAt" <= (clock_timestamp() AT TIME ZONE 'UTC') - interval '30 seconds'
      ORDER BY d."createdAt", r.id LIMIT 25`;
  }

  private async read(tx: Prisma.TransactionClient, taskRunId: string) {
    const run = await tx.taskRun.findFirst({
      where: { id: taskRunId, agentVersion: { agent: referenceAgent } }, select: runSelect,
    });
    if (!run) throw new Error("Reference TaskRun not found");
    const delivery = run.deliveryId ? await tx.taskRunDelivery.findFirst({
      where: { id: run.deliveryId, taskRunId }, select: { id: true, source: true, createdAt: true, claimedAt: true },
    }) : null;
    return { run, delivery };
  }

  private async blockReason(tx: Prisma.TransactionClient, run: Run, delivery: Awaited<ReturnType<DeliveryReconciliation["read"]>>["delivery"], now: Date) {
    if (run.status !== "PENDING") return "NOT_PENDING";
    if (!delivery) return "UNTRACKED_DELIVERY";
    if (delivery.claimedAt || run.workerId || run.heartbeatAt || run.completedAt) return "EXECUTION_EVIDENCE";
    if (delivery.source === "APPROVAL") return "APPROVAL_CONTINUATION_REQUIRES_INVESTIGATION";
    if (delivery.source === "SUBMISSION" && (run.startedAt || run.recoveryCount ||
        await tx.step.findFirst({ where: { taskRunId: run.id }, select: { id: true } }) ||
        await tx.approval.findFirst({ where: { taskRunId: run.id }, select: { id: true } }))) return "EXECUTION_EVIDENCE";
    if (delivery.source === "RECOVERY") {
      const { toolPolicies, agent } = run.agentVersion;
      if (!run.recoveryCount || !toolPolicies || typeof toolPolicies !== "object" || Array.isArray(toolPolicies) ||
          !isReadOnlyRepositoryRun({ taskId: run.taskId, taskRunId: run.id, recoveryCount: run.recoveryCount,
            agentName: agent.name, toolPolicies: toolPolicies as ToolPolicies })) return "RECOVERY_NOT_SAFE";
    }
    if (now.getTime() - delivery.createdAt.getTime() < MIN_PENDING_AGE_MS) return "TOO_RECENT";
    return null;
  }

  async inspect(taskRunId: string) {
    const { run, delivery } = await this.read(this.db, taskRunId);
    const attempts = delivery ? await this.db.taskRunDeliveryAttempt.findMany({
      where: { deliveryId: delivery.id }, orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: 10,
      select: { id: true, actor: true, manual: true, outcome: true, createdAt: true, finishedAt: true },
    }) : [];
    const now = await databaseNow(this.db);
    let queueState = "untracked";
    if (delivery) {
      try { queueState = await this.queue.inspect(taskRunId, delivery.id); }
      catch { queueState = "unavailable"; }
    }
    const pendingAgeThresholdReached = run.status === "PENDING" && !!delivery && now.getTime() - delivery.createdAt.getTime() >= MIN_PENDING_AGE_MS;
    return { taskRunId, status: run.status, delivery, attempts, queueState,
      latestOutcome: delivery ? attempts[0]?.outcome ?? "UNCONFIRMED" : null, pendingAgeThresholdReached,
      stalePendingWithoutJob: pendingAgeThresholdReached && queueState === "missing",
      blockReason: await this.blockReason(this.db, run, delivery, now) };
  }

  async reconcile(taskRunId: string, actor: string) {
    if (!actor.trim() || actor.length > 128) throw new Error("Operator identity is required");
    const observed = await this.inspect(taskRunId);
    if (observed.blockReason) return { action: "BLOCKED", reason: observed.blockReason, observation: observed } as const;
    if (observed.queueState !== "missing") return { action: "BLOCKED", reason: "QUEUE_NOT_CONFIRMED_MISSING", observation: observed } as const;

    const reservation = await this.db.$transaction(async tx => {
      // Same row acquired by the worker's conditional PENDING -> RUNNING update.
      const locked = await tx.$queryRaw<Array<{ id: string }>>`SELECT r.id FROM "TaskRun" r
        JOIN "AgentVersion" v ON v.id = r."agentVersionId"
        JOIN "Agent" a ON a.id = v."agentId"
        WHERE r.id = ${taskRunId} AND a."ownerId" = ${owner} AND a.integration = 'REFERENCE' FOR UPDATE OF r`;
      if (!locked.length) return { blocked: "RUN_UNAVAILABLE" } as const;
      const { run, delivery } = await this.read(tx, taskRunId);
      if (!delivery || delivery.id !== observed.delivery?.id) return { blocked: "DELIVERY_CHANGED" } as const;
      const now = await databaseNow(tx);
      const reason = await this.blockReason(tx, run, delivery, now);
      if (reason) return { blocked: reason } as const;
      const recent = await tx.taskRunDeliveryAttempt.findFirst({
        where: { deliveryId: delivery.id, createdAt: { gt: new Date(now.getTime() - MIN_PENDING_AGE_MS) } },
        select: { id: true },
      });
      if (recent) return { blocked: "RECENT_DELIVERY_ATTEMPT" } as const;
      const attempt = await tx.taskRunDeliveryAttempt.create({
        data: { deliveryId: delivery.id, actor, manual: true, createdAt: now }, select: { id: true },
      });
      return { deliveryId: delivery.id, attemptId: attempt.id } as const;
    });
    if ("blocked" in reservation) return { action: "BLOCKED", reason: reservation.blocked } as const;

    // The reservation survives a caller crash. Redis I/O runs outside the row lock.
    // A worker winning after reservation is still fenced by the same delivery ID.
    const job = await dispatchTrackedDelivery({
      pending: { taskRunId, deliveryId: reservation.deliveryId }, attemptId: reservation.attemptId, queue: this.queue,
      finish: async (id, outcome) => {
        await this.db.taskRunDeliveryAttempt.update({ where: { id }, data: { outcome, finishedAt: new Date() } });
      },
    });
    return { action: "ENQUEUED", jobId: job.jobId, attemptId: reservation.attemptId } as const;
  }
}
