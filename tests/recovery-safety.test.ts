import assert from "node:assert/strict";
import test from "node:test";
import { isReadOnlyRepositoryRun, recoverStaleRuns } from "../src/recovery/recover-stale-runs.js";
import type { ToolPolicies } from "../src/tools/tool-registry.js";
import { PrismaExecutionStore } from "../src/persistence/prisma-execution-store.js";
import { RunQueryService, type RunRecord } from "../src/observability/run-query.js";

const reads: ToolPolicies = { list_files: "ALLOW", search_files: "ALLOW", read_file: "ALLOW" };
for (const [name, extra, eligible] of [
  ["read-only tools", {}, true],
  ["create_file REQUIRE_APPROVAL", { create_file: "REQUIRE_APPROVAL" }, false],
  ["create_file ALLOW", { create_file: "ALLOW" }, false],
  ["delete_file REQUIRE_APPROVAL", { delete_file: "REQUIRE_APPROVAL" }, false],
  ["delete_file ALLOW", { delete_file: "ALLOW" }, false],
  ["DENY-only extra capabilities", { create_file: "DENY", delete_file: "DENY", unknown_tool: "DENY" }, true],
  ["unknown ALLOW capability", { unknown_tool: "ALLOW" }, false],
  ["unknown REQUIRE_APPROVAL capability", { unknown_tool: "REQUIRE_APPROVAL" }, false],
] as Array<[string, ToolPolicies, boolean]>) {
  test(`whole-run recovery eligibility: ${name}`, () => {
    assert.equal(isReadOnlyRepositoryRun({
      taskId: "task", taskRunId: "run", recoveryCount: 0,
      agentName: "repository-explorer", toolPolicies: { ...reads, ...extra },
    }), eligible);
  });
}

const cutoff = new Date("2026-10-23T10:00:00Z");
const old = new Date("2026-10-23T09:58:00Z");
type Row = {
  id: string; taskId: string; status: string; workerId: string | null;
  heartbeatAt: Date | null; recoveryCount: number;
  failureReason?: string; failureMessage?: string; completedAt?: Date;
};

// Exercise the production persistence methods and their CAS predicates without
// a database or live tasks. The hook models a transition after the initial read.
function persistenceFixture(policies: ToolPolicies = { ...reads, create_file: "REQUIRE_APPROVAL" }) {
  const row: Row = { id: "run", taskId: "task", status: "RUNNING", workerId: "old-worker", heartbeatAt: old, recoveryCount: 0 };
  const steps: RunRecord["steps"] = [{ sequence: 7, kind: "TOOL_CALL", createdAt: old,
    payload: { toolCall: { name: "create_file", arguments: { path: "ambiguous.txt" } } } }];
  const initialEvidence = structuredClone(steps);
  let beforeUpdate: ((row: Row) => void) | undefined;
  let taskWrites = 0;
  let taskStatus = "RUNNING";
  const transaction = {
    taskRun: {
      async findMany() {
        return [{ ...structuredClone(row), agentVersion: { toolPolicies: policies, agent: { name: "repository-explorer" } } }];
      },
      async findUnique() { return structuredClone(row); },
      async updateMany({ where, data }: { where: Record<string, unknown>; data: Partial<Row> }) {
        assert.equal(where.status, "RUNNING");
        assert.ok(Object.hasOwn(where, "workerId"));
        assert.ok(Object.hasOwn(where, "heartbeatAt"));
        assert.ok(Object.hasOwn(where, "recoveryCount"));
        assert.deepEqual(where.OR, [{ heartbeatAt: null }, { heartbeatAt: { lt: cutoff } }]);
        beforeUpdate?.(row); beforeUpdate = undefined;
        const matches = where.id === row.id && (!where.taskId || where.taskId === row.taskId)
          && where.status === row.status && where.workerId === row.workerId && where.recoveryCount === row.recoveryCount
          && (where.heartbeatAt as Date | null)?.getTime() === row.heartbeatAt?.getTime()
          && (!row.heartbeatAt || row.heartbeatAt < cutoff);
        if (!matches) return { count: 0 };
        Object.assign(row, data);
        return { count: 1 };
      },
    },
    task: { async update({ data }: { data: { status: string } }) { taskWrites++; taskStatus = data.status; } },
    step: {
      async findFirst() { return steps.at(-1); },
      async create({ data }: { data: Omit<RunRecord["steps"][number], "createdAt"> }) {
        steps.push({ ...data, createdAt: new Date() });
      },
    },
  };
  const prisma = { ...transaction, async $transaction<T>(callback: (tx: typeof transaction) => Promise<T>) { return callback(transaction); } };
  const store = new PrismaExecutionStore(prisma as unknown as ConstructorParameters<typeof PrismaExecutionStore>[0]);
  return { row, steps, initialEvidence, store, taskWrites: () => taskWrites, taskStatus: () => taskStatus,
    race: (hook: (row: Row) => void) => { beforeUpdate = hook; } };
}

test("unsafe stale run is failed with preserved evidence and visible recovery diagnostics, never enqueued", async () => {
  const f = persistenceFixture();
  const summary = await recoverStaleRuns({ store: f.store, queue: { async enqueue() { assert.fail("Unsafe run was enqueued"); }, async close() {} },
    now: new Date(cutoff.getTime() + 30000), leaseTimeoutMs: 30000, maxRecoveries: 2 });
  assert.deepEqual(summary, { requeued: 0, failedLimit: 0, failedUnsafe: 1, skipped: 0 });
  assert.equal(f.row.status, "FAILED");
  assert.equal(f.taskStatus(), "FAILED");
  assert.equal(f.row.failureReason, "RECOVERY_NOT_SAFE");
  assert.equal(f.row.recoveryCount, 0);
  assert.equal(f.row.workerId, null);
  assert.equal(f.row.heartbeatAt, null);
  assert.ok(f.row.completedAt);
  assert.deepEqual(f.steps.slice(0, 1), f.initialEvidence);
  assert.equal(f.steps.at(-1)?.sequence, 8);
  const details = await new RunQueryService({ async listRecent() { return []; }, async findById() { return {
    ...f.row, agentName: "repository-explorer", agentVersion: 2, provider: "ollama", model: "qwen3.5:9b", prompt: "Create a file",
    createdAt: old, startedAt: old, completedAt: f.row.completedAt!, finalAnswer: null,
    failureReason: f.row.failureReason!, failureMessage: f.row.failureMessage!, steps: f.steps, approvals: [],
  }; } }).get("run");
  assert.equal(details?.status, "FAILED");
  assert.equal(details?.failure?.code, "RECOVERY_NOT_SAFE");
  assert.match(details!.failure!.message!, /outcomes may be unknown/);
  assert.equal(details?.timeline.at(-1)?.failureCode, "RECOVERY_NOT_SAFE");
  assert.equal(details?.timeline.at(-1)?.workerId, "old-worker");
});

for (const status of ["PENDING", "WAITING_FOR_APPROVAL", "COMPLETED", "FAILED"]) {
  test(`unsafe terminalization skips current ${status} state`, async () => {
    const f = persistenceFixture(); f.row.status = status;
    assert.equal(await f.store.failStaleExecution("task", "run", cutoff, "Unsafe"), false);
    assert.equal(f.row.status, status);
    assert.deepEqual(f.steps, f.initialEvidence);
    assert.equal(f.taskWrites(), 0);
  });
}

test("unsafe terminalization skips a healthy heartbeat and rejects mismatched task IDs", async () => {
  const f = persistenceFixture(); f.row.heartbeatAt = cutoff;
  assert.equal(await f.store.failStaleExecution("task", "run", cutoff, "Unsafe"), false);
  f.row.heartbeatAt = old;
  assert.equal(await f.store.failStaleExecution("different-task", "run", cutoff, "Unsafe"), false);
  assert.equal(f.taskWrites(), 0);
});

for (const [name, transition] of [
  ["fresh heartbeat", (r: Row) => { r.heartbeatAt = cutoff; }],
  ["changed stale heartbeat", (r: Row) => { r.heartbeatAt = new Date(old.getTime() + 1); }],
  ["new owner", (r: Row) => { r.workerId = "new-worker"; }],
  ["new recovery generation", (r: Row) => { r.recoveryCount++; }],
  ["approval suspension", (r: Row) => { r.status = "WAITING_FOR_APPROVAL"; }],
  ["completed execution", (r: Row) => { r.status = "COMPLETED"; }],
  ["pending execution", (r: Row) => { r.status = "PENDING"; }],
] as Array<[string, (row: Row) => void]>) {
  for (const operation of ["fail", "requeue", "limit"] as const) {
    test(`recovery ${operation} CAS does not overwrite concurrent ${name}`, async () => {
      const f = persistenceFixture();
      if (operation === "limit") f.row.recoveryCount = 2;
      f.race(transition);
      const result = operation === "fail"
        ? await f.store.failStaleExecution("task", "run", cutoff, "Unsafe")
        : await f.store.recoverStaleExecution("run", cutoff, 2);
      assert.deepEqual(result, operation === "fail" ? false : { action: "SKIPPED" });
      assert.deepEqual(f.steps, f.initialEvidence);
      assert.equal(f.row.failureReason, undefined);
      assert.equal(f.taskWrites(), 0);
    });
  }
}

test("scanner reports skipped rather than failedUnsafe when heartbeat wins the race", async () => {
  const f = persistenceFixture(); f.race(row => { row.heartbeatAt = cutoff; });
  const summary = await recoverStaleRuns({ store: f.store, queue: { async enqueue() { assert.fail("Should not enqueue"); }, async close() {} },
    now: new Date(cutoff.getTime() + 30000), leaseTimeoutMs: 30000, maxRecoveries: 2 });
  assert.deepEqual(summary, { requeued: 0, failedLimit: 0, failedUnsafe: 0, skipped: 1 });
  assert.equal(f.row.status, "RUNNING");
});

test("custom recovery policy cannot broaden eligibility to write-capable runs", async () => {
  const f = persistenceFixture();
  const result = await recoverStaleRuns({ store: f.store, canRecover: () => true,
    queue: { async enqueue() { assert.fail("Write recovery was enabled"); }, async close() {} },
    now: new Date(cutoff.getTime() + 30000), leaseTimeoutMs: 30000, maxRecoveries: 2 });
  assert.equal(result.failedUnsafe, 1);
});

test("failed recovery delivery does not overwrite a newly claimed execution", async () => {
  const f = persistenceFixture(reads);
  await assert.rejects(recoverStaleRuns({ store: f.store,
    queue: { async enqueue() {
      f.row.status = "RUNNING"; f.row.workerId = "new-worker"; f.row.heartbeatAt = new Date();
      throw new Error("Delivery outcome unknown");
    }, async close() {} },
    now: new Date(cutoff.getTime() + 30000), leaseTimeoutMs: 30000, maxRecoveries: 2 }), /Delivery outcome unknown/);
  assert.equal(f.row.status, "RUNNING");
  assert.equal(f.row.workerId, "new-worker");
  assert.equal(f.steps.length, 2);
  assert.equal(f.row.failureReason, null);
});

test("only one concurrent unsafe terminalization records a failure Step", async () => {
  const f = persistenceFixture();
  const results = await Promise.all([
    f.store.failStaleExecution("task", "run", cutoff, "Unsafe"),
    f.store.failStaleExecution("task", "run", cutoff, "Unsafe"),
  ]);
  assert.deepEqual(results, [true, false]);
  assert.equal(f.steps.length, 2);
  assert.equal(f.taskWrites(), 1);
});

test("unsafe RUNNING execution with missing heartbeat is terminalized without inventing an outcome", async () => {
  const f = persistenceFixture(); f.row.heartbeatAt = null;
  assert.equal(await f.store.failStaleExecution("task", "run", cutoff, "Prior outcome unknown"), true);
  assert.equal(f.row.status, "FAILED");
  assert.equal(f.row.failureMessage, "Prior outcome unknown");
  assert.deepEqual(f.steps.slice(0, 1), f.initialEvidence);
});

test("Prisma approval consumption remains durable and cannot be reused by a later owner", async () => {
  let owner = "worker-1";
  const approval = { id: "approved", taskRunId: "run", status: "APPROVED", consumedAt: null as Date | null };
  const tx = {
    taskRun: { async updateMany({ where }: { where: Record<string, unknown> }) {
      assert.equal(where.id, "run"); assert.equal(where.status, "RUNNING");
      return { count: where.workerId === owner ? 1 : 0 };
    } },
    approval: { async updateMany({ where, data }: { where: Record<string, unknown>; data: { consumedAt: Date } }) {
      assert.deepEqual(where, { id: "approved", taskRunId: "run", status: { in: ["APPROVED", "DENIED"] }, consumedAt: null });
      if (approval.consumedAt !== null) return { count: 0 };
      approval.consumedAt = data.consumedAt;
      return { count: 1 };
    } },
  };
  const prisma = { async $transaction<T>(callback: (transaction: typeof tx) => Promise<T>) { return callback(tx); } };
  const store = new PrismaExecutionStore(prisma as unknown as ConstructorParameters<typeof PrismaExecutionStore>[0]);
  await store.claimApprovalAction("run", owner, "approved", old);
  assert.equal(approval.consumedAt, old);
  await assert.rejects(() => store.claimApprovalAction("run", owner, "approved", cutoff), /unavailable/);
  owner = "worker-2";
  await assert.rejects(() => store.claimApprovalAction("run", owner, "approved", cutoff), /unavailable/);
  await assert.rejects(() => store.claimApprovalAction("run", "worker-1", "approved", cutoff), /lease lost/);
  assert.equal(approval.consumedAt, old);
});
