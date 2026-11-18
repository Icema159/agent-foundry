import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { Queue, Worker } from "bullmq";
import { Redis } from "ioredis";
import { decideApprovalAndEnqueue } from "../src/approvals/approval-service.js";
import { createPrismaClient, PrismaExecutionStore } from "../src/persistence/prisma-execution-store.js";
import { AGENT_TASK_QUEUE, AGENT_TASK_JOB, BullTaskRunQueue, EnqueueNotSent, type AgentTaskJobData } from "../src/queue/agent-task-queue.js";
import { DeliveryReconciliation } from "../src/queue/delivery-reconciliation.js";
import { submitTask } from "../src/queue/task-submission.js";
import { recoverStaleRuns } from "../src/recovery/recover-stale-runs.js";

const dbUrl = process.env.FOUNDRY_DELIVERY_TEST_DATABASE_URL;
const redisUrl = process.env.FOUNDRY_DELIVERY_TEST_REDIS_URL;

test("isolated PostgreSQL and Redis: reference delivery safety", { skip: !dbUrl || !redisUrl }, async t => {
  const dbTarget = new URL(dbUrl!), redisTarget = new URL(redisUrl!);
  const offlinePort = Number(process.env.FOUNDRY_DELIVERY_OFFLINE_REDIS_PORT);
  if (dbTarget.hostname !== "127.0.0.1" || !/^\/foundry_delivery_test_[a-z0-9]+$/.test(dbTarget.pathname) ||
      redisTarget.protocol !== "redis:" || redisTarget.hostname !== "127.0.0.1" || !redisTarget.port ||
      Number(redisTarget.port) <= 6379 || !Number.isInteger(offlinePort) || offlinePort <= 6379 ||
      offlinePort > 65535 || offlinePort === Number(redisTarget.port)) throw new Error("Dedicated PostgreSQL and Redis fixtures required");
  const db = createPrismaClient(dbUrl!), store = new PrismaExecutionStore(db), queue = new BullTaskRunQueue(redisUrl!);
  const observer = new Redis(redisUrl!);
  const rawQueue = new Queue<AgentTaskJobData>(AGENT_TASK_QUEUE, { connection: observer });
  t.after(async () => {
    await Promise.allSettled([db.$disconnect(), queue.close(), rawQueue.close()]);
    observer.disconnect();
  });
  const delivery = new DeliveryReconciliation(db, queue);
  const configurations = {
    read: { read_file: "ALLOW" as const }, write: { create_file: "REQUIRE_APPROVAL" as const },
  };
  const agent = (mode: keyof typeof configurations) => ({
    name: "repository-explorer", description: "isolated delivery test", version: mode === "read" ? 71 : 72,
    systemInstructions: "fixture", modelProvider: "ollama", modelName: "fixture", maxSteps: 4, toolPolicies: configurations[mode],
  });
  async function pending(mode: keyof typeof configurations = "read") {
    const version = await store.resolveAgentVersion(agent(mode));
    return store.createPendingExecution(version.agentId, version.agentVersionId, "fixture", "/tmp");
  }
  async function age(deliveryId: string) {
    const old = new Date(Date.now() - 120000);
    await db.taskRunDelivery.update({ where: { id: deliveryId }, data: { createdAt: old } });
    await db.taskRunDeliveryAttempt.updateMany({ where: { deliveryId }, data: { createdAt: old } });
  }
  const notSent = { close: async () => {}, enqueue: async () => { throw new EnqueueNotSent(); } };
  const localActor = "local:fixture-operator";

  await t.test("DB commit survives real Redis outage, then concurrent reconciliation enqueues one job", async () => {
    const offline = new BullTaskRunQueue(`redis://127.0.0.1:${offlinePort}`);
    let taskRunId = "";
    try {
      await assert.rejects(submitTask({ store, queue: offline, agent: agent("write"), prompt: "fixture", workspaceRoot: "/tmp",
        onCreated: async run => { taskRunId = run.taskRunId; } }), /NOT_SENT/);
    } finally {
      await offline.close();
    }
    const before = await delivery.inspect(taskRunId);
    assert.equal(before.status, "PENDING");
    assert.equal(before.attempts[0]?.outcome, "NOT_SENT");
    assert.equal(before.delivery?.claimedAt, null);
    const deliveryId = before.delivery!.id;
    await age(deliveryId);
    const stale = await delivery.inspect(taskRunId);
    assert.equal(stale.stalePendingWithoutJob, true);
    assert.deepEqual(await delivery.list(), [
      { taskRunId, deliveryId, source: "SUBMISSION", pendingSince: stale.delivery!.createdAt },
    ]);
    // Both operators must observe the missing job before either can reserve delivery.
    let inspections = 0;
    let releaseInspections!: () => void;
    const bothInspected = new Promise<void>(resolve => { releaseInspections = resolve; });
    const concurrent = new DeliveryReconciliation(db, {
      close: () => queue.close(),
      enqueue: (runId, id) => queue.enqueue(runId, id),
      inspect: async (runId, id) => {
        const state = await queue.inspect(runId, id);
        if (++inspections === 2) releaseInspections();
        await bothInspected;
        return state;
      },
    });
    const outcomes = await Promise.all([concurrent.reconcile(taskRunId, localActor), concurrent.reconcile(taskRunId, localActor)]);
    assert.equal(outcomes.filter(r => r.action === "ENQUEUED").length, 1);
    assert.ok(outcomes.some(r => r.action === "BLOCKED" && r.reason === "RECENT_DELIVERY_ATTEMPT"));
    assert.equal(await db.taskRunDeliveryAttempt.count({ where: { deliveryId, actor: localActor, manual: true, outcome: "CONFIRMED" } }), 1);
    const observed = await delivery.inspect(taskRunId);
    assert.equal(observed.queueState, "waiting");
    assert.equal(observed.stalePendingWithoutJob, false);
    assert.equal((await delivery.reconcile(taskRunId, localActor)).action, "BLOCKED");
    const job = await rawQueue.getJob(deliveryId);
    assert.deepEqual(job?.data, { taskRunId });

    let release!: () => void;
    const barrier = new Promise<void>(resolve => { release = resolve; });
    let entered!: () => void;
    const processing = new Promise<void>(resolve => { entered = resolve; });
    const workerRedis = new Redis(redisUrl!, { maxRetriesPerRequest: null });
    const worker = new Worker<AgentTaskJobData>(AGENT_TASK_QUEUE, async job => {
      const run = await store.loadExecution(job.data.taskRunId);
      await store.claimExecution(run.taskId, run.taskRunId, "delivery-test-worker", new Date(), job.id);
      entered();
      await barrier;
      await store.finishExecution(run.taskId, run.taskRunId, "delivery-test-worker", { status: "completed", answer: "fixture", steps: 0 });
    }, { connection: workerRedis });
    const completed = new Promise<void>((resolve, reject) => {
      worker.once("completed", () => resolve());
      worker.once("failed", (_job, error) => reject(error));
      worker.once("error", reject);
    });
    void completed.catch(() => {});
    try {
      await Promise.race([processing, completed]);
      const active = await delivery.inspect(taskRunId);
      assert.equal(active.status, "RUNNING"); assert.equal(active.queueState, "active");
      assert.ok(active.delivery?.claimedAt);
      assert.equal((await delivery.reconcile(taskRunId, localActor)).action, "BLOCKED");
      release();
      await completed;
      const finished = await delivery.inspect(taskRunId);
      assert.equal(finished.status, "COMPLETED"); assert.equal(finished.queueState, "completed");
    } finally {
      release();
      await worker.close();
      workerRedis.disconnect();
    }
  });

  await t.test("real Redis accepted enqueue but producer lost the acknowledgement", async () => {
    let taskRunId = "";
    await assert.rejects(submitTask({ store, agent: agent("read"), prompt: "fixture", workspaceRoot: "/tmp",
      onCreated: async run => { taskRunId = run.taskRunId; },
      queue: { close: async () => {}, enqueue: async (id, deliveryId) => {
        await queue.enqueue(id, deliveryId);
        throw new Error("injected response loss after real Redis committed");
      } } }), /ACK_UNKNOWN/);
    const seen = await delivery.inspect(taskRunId);
    assert.equal(seen.attempts[0]?.outcome, "ACK_UNKNOWN");
    assert.equal(seen.queueState, "waiting");
    await age(seen.delivery!.id);
    assert.equal((await delivery.reconcile(taskRunId, localActor)).action, "BLOCKED");
    await queue.enqueue(taskRunId, seen.delivery!.id);
    assert.equal((await rawQueue.getJobs(["waiting"])).filter(job => job.data.taskRunId === taskRunId).length, 1);
  });

  await t.test("a delayed Redis job is not missing delivery", async () => {
    const run = await pending();
    await age(run.deliveryId);
    await rawQueue.add(AGENT_TASK_JOB, { taskRunId: run.taskRunId }, { jobId: run.deliveryId, delay: 60000 });
    assert.equal((await delivery.inspect(run.taskRunId)).queueState, "delayed");
    assert.equal((await delivery.reconcile(run.taskRunId, localActor)).action, "BLOCKED");
    assert.equal(await db.taskRunDeliveryAttempt.count({ where: { deliveryId: run.deliveryId } }), 0);
  });

  await t.test("a worker winning after Redis inspection blocks reservation", async () => {
    const run = await pending();
    await age(run.deliveryId);
    let enqueueCount = 0;
    const racing = new DeliveryReconciliation(db, {
      close: async () => {},
      enqueue: async () => { enqueueCount++; throw new Error("must not enqueue"); },
      inspect: async (taskRunId, id) => {
        const result = await queue.inspect(taskRunId, id);
        await queue.enqueue(taskRunId, id);
        await store.claimExecution(run.taskId, taskRunId, "claim-winner", new Date(), id);
        return result;
      },
    });
    assert.deepEqual(await racing.reconcile(run.taskRunId, localActor), { action: "BLOCKED", reason: "NOT_PENDING" });
    assert.equal(enqueueCount, 0);
    assert.equal(await db.taskRunDeliveryAttempt.count({ where: { deliveryId: run.deliveryId } }), 0);
    await assert.rejects(store.claimExecution(run.taskId, run.taskRunId, "duplicate", new Date(), run.deliveryId));
    await store.finishExecution(run.taskId, run.taskRunId, "claim-winner", { status: "completed", steps: 0, answer: "fixture" });
  });

  await t.test("missing jobs with execution evidence or legacy delivery stay blocked", async () => {
    const run = await pending("write");
    await age(run.deliveryId);
    await db.taskRun.update({ where: { id: run.taskRunId }, data: { startedAt: new Date() } });
    assert.equal((await delivery.inspect(run.taskRunId)).queueState, "missing");
    assert.equal((await delivery.inspect(run.taskRunId)).blockReason, "EXECUTION_EVIDENCE");
    assert.equal((await delivery.reconcile(run.taskRunId, localActor)).action, "BLOCKED");
    await db.taskRun.update({ where: { id: run.taskRunId }, data: { deliveryId: null } });
    assert.equal((await delivery.inspect(run.taskRunId)).blockReason, "UNTRACKED_DELIVERY");
    assert.equal((await delivery.reconcile(run.taskRunId, localActor)).action, "BLOCKED");
    await assert.rejects(delivery.inspect(`ext_${randomUUID()}`), /Reference TaskRun not found/);
    assert.equal(await db.taskRunDeliveryAttempt.count({ where: { deliveryId: run.deliveryId } }), 0);
  });

  await t.test("read-only recovery can redeliver; previous job and unsafe recovery are fenced", async () => {
    const run = await pending();
    const old = new Date(Date.now() - 120000);
    await store.claimExecution(run.taskId, run.taskRunId, "stale", old, run.deliveryId);
    await assert.rejects(recoverStaleRuns({ store, queue: notSent, now: new Date(), leaseTimeoutMs: 30000, maxRecoveries: 2 }), /NOT_SENT/);
    const recovered = await delivery.inspect(run.taskRunId);
    assert.equal(recovered.delivery?.source, "RECOVERY");
    assert.notEqual(recovered.delivery?.id, run.deliveryId);
    const id = recovered.delivery!.id;
    await age(id);
    await assert.rejects(store.claimExecution(run.taskId, run.taskRunId, "old-job", new Date(), run.deliveryId));
    assert.equal((await delivery.reconcile(run.taskRunId, localActor)).action, "ENQUEUED");
    assert.equal(await queue.inspect(run.taskRunId, id), "waiting");

    const unsafe = await pending("write");
    await store.claimExecution(unsafe.taskId, unsafe.taskRunId, "stale", old, unsafe.deliveryId);
    const summary = await recoverStaleRuns({ store, queue, now: new Date(), leaseTimeoutMs: 30000, maxRecoveries: 2 });
    assert.equal(summary.failedUnsafe, 1); assert.equal(summary.requeued, 0);
    assert.equal((await delivery.inspect(unsafe.taskRunId)).status, "FAILED");
    assert.equal((await delivery.reconcile(unsafe.taskRunId, localActor)).action, "BLOCKED");
  });

  await t.test("approval continuation receives a new delivery ID while manual replay remains blocked", async () => {
    const run = await pending("write");
    await store.claimExecution(run.taskId, run.taskRunId, "approval-worker", new Date(), run.deliveryId);
    const { approvalId } = await store.waitForApproval(run.taskId, run.taskRunId, "approval-worker",
      { toolName: "create_file", validatedArguments: { path: "fixture" }, resumeMessages: [], runtimeStep: 1 },
      { sequence: 1, kind: "APPROVAL_REQUIRED", payload: {} });
    await assert.rejects(decideApprovalAndEnqueue({ store, queue: notSent, approvalId, decision: "APPROVED" }), /NOT_SENT/);
    const resume = await delivery.inspect(run.taskRunId);
    assert.equal(resume.delivery?.source, "APPROVAL");
    assert.notEqual(resume.delivery?.id, run.deliveryId);
    await age(resume.delivery!.id);
    assert.equal((await delivery.inspect(run.taskRunId)).blockReason, "APPROVAL_CONTINUATION_REQUIRES_INVESTIGATION");
    assert.equal((await delivery.reconcile(run.taskRunId, localActor)).action, "BLOCKED");
    await assert.rejects(store.claimExecution(run.taskId, run.taskRunId, "old-job", new Date(), run.deliveryId));
    assert.equal((await db.approval.findUniqueOrThrow({ where: { id: approvalId } })).consumedAt, null);
  });
});
