import assert from "node:assert/strict";
import test from "node:test";
import { formatRunDetails, formatRunList } from "../src/observability/format-runs.js";

test("correction start and verified outcome remain visible in existing run details", async () => {
  const details = await query([record({ postconditions: [{ type: "file_created", path: "note.md" }],
    steps: [
      { sequence: 1, kind: "POSTCONDITION_CHECK", createdAt: at(200), payload: {
        passed: false, correctionAttempt: 1, correctionOutcome: "STARTED", message: "note.md unmet; correction 1/1 started" } },
      { sequence: 2, kind: "POSTCONDITION_CHECK", createdAt: at(700), payload: {
        passed: true, correctionAttempt: 1, correctionOutcome: "SUCCEEDED", message: "Verified creation of note.md; correction 1/1 succeeded" } },
    ],
  })]).get("run-1");
  assert.equal(details?.verification?.status, "PASSED");
  assert.match(formatRunDetails(details!), /correction 1\/1 started/);
  assert.match(formatRunDetails(details!), /correction 1\/1 succeeded/);
});
import { RunQueryService, type RunReader, type RunRecord } from "../src/observability/run-query.js";

const base = new Date("2026-10-06T10:00:00.000Z");
const at = (ms: number) => new Date(base.getTime() + ms);

test("run inspection distinguishes unrequested, pending, failed and passed verification", async () => {
  const conditions = [{ type: "file_created" as const, path: "note.md" }];
  assert.equal((await query([record()]).get("run-1"))?.verification?.status, "NOT_REQUESTED");
  assert.equal((await query([record({ status: "WAITING_FOR_APPROVAL", postconditions: conditions })]).get("run-1"))?.verification?.status, "PENDING");
  assert.equal((await query([record({ status: "FAILED", postconditions: conditions })]).get("run-1"))?.verification?.status, "NOT_RUN");
  assert.equal((await query([record({ status: "RUNNING", recoveryCount: 1, postconditions: conditions, steps: [
    { sequence: 1, kind: "POSTCONDITION_CHECK", createdAt: at(700), payload: { executionAttempt: 1, passed: true } },
  ] })]).get("run-1"))?.verification?.status, "PENDING");
  for (const passed of [true, false]) {
    const details = await query([record({ postconditions: conditions, status: passed ? "COMPLETED" : "FAILED", steps: [
      { sequence: 1, kind: "POSTCONDITION_CHECK", createdAt: at(700), payload: { passed, message: "note.md verification" } },
    ] })]).get("run-1");
    assert.equal(details?.verification?.status, passed ? "PASSED" : "FAILED");
    assert.match(formatRunDetails(details!), new RegExp(`POSTCONDITION_CHECK.*${passed ? "PASS" : "FAIL"}`));
  }
});

function record(overrides: Partial<RunRecord> = {}): RunRecord {
  return {
    id: "run-1", taskId: "task-1", prompt: "Find TODOs", status: "COMPLETED",
    agentName: "repository-explorer", agentVersion: 3, provider: "openai", model: "gpt-test",
    recoveryCount: 0, workerId: null, heartbeatAt: null,
    createdAt: at(0), startedAt: at(100), completedAt: at(800),
    finalAnswer: "The repository has one TODO.", failureReason: null, failureMessage: null,
    steps: [], approvals: [], ...overrides,
  };
}

function query(records: RunRecord[]): RunQueryService {
  const reader: RunReader = {
    async listRecent(limit) { return [...records].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime()).slice(0, limit); },
    async findById(id) { return records.find((run) => run.id === id) ?? null; },
  };
  return new RunQueryService(reader);
}

test("recent runs list is concise, ordered and identifies agent/provider", async () => {
  const runs = await query([
    record(),
    record({ id: "run-2", createdAt: at(1000), status: "FAILED", provider: "ollama", model: "qwen-test" }),
  ]).listRecent(2);
  assert.deepEqual(runs.map((run) => run.id), ["run-2", "run-1"]);
  assert.match(formatRunList(runs), /run-2  FAILED  repository-explorer@3  ollama\/qwen-test/);
  assert.equal(await query([]).get("missing"), null);
});

test("complete run reconstructs ordered timeline and displays actual final answer", async () => {
  const run = record({
    steps: [
      { sequence: 5, kind: "FINAL_ANSWER", createdAt: at(700), payload: { executionAttempt: 1, runtimeStep: 2, answer: "The repository has one TODO." } },
      { sequence: 1, kind: "MODEL_CALL", createdAt: at(200), payload: { executionAttempt: 1, runtimeStep: 1, request: { messages: ["large private conversation"] }, durationMs: 91, model: { provider: "openai", model: "gpt-test", usage: { inputTokens: 12, outputTokens: 5, totalTokens: 17 } } } },
      { sequence: 2, kind: "TOOL_CALL", createdAt: at(300), payload: { executionAttempt: 1, runtimeStep: 1, toolCall: { name: "search_files", arguments: { query: "TODO" } } } },
      { sequence: 3, kind: "TOOL_RESULT", createdAt: at(400), payload: { executionAttempt: 1, runtimeStep: 1, name: "search_files", result: { count: 1 }, durationMs: 47 } },
      { sequence: 4, kind: "MODEL_CALL", createdAt: at(600), payload: { executionAttempt: 1, runtimeStep: 2, durationMs: 80, model: { provider: "openai", model: "gpt-test" } } },
    ],
  });
  const details = await query([run]).get("run-1");
  assert.ok(details);
  assert.deepEqual(details.timeline.map((entry) => entry.type), ["MODEL_CALL", "TOOL_CALL", "TOOL_RESULT", "MODEL_CALL", "FINAL_ANSWER"]);
  assert.equal(details.totalDurationMs, 800);
  assert.equal(details.executionDurationMs, 700);
  assert.equal(details.timeline[0]?.durationMs, 91);
  assert.deepEqual(details.timeline[0]?.usage, { inputTokens: 12, outputTokens: 5, totalTokens: 17 });
  assert.equal(details.timeline[2]?.durationMs, 47);
  assert.equal(details.timeline[3]?.usage, undefined);
  const view = formatRunDetails(details);
  assert.match(view, /Final answer:\nThe repository has one TODO\./);
  assert.match(view, /tokens in=12 out=5 total=17/);
  assert.doesNotMatch(view, /large private conversation/);
});

test("approval and recovery attempts remain distinct in timeline", async () => {
  const details = await query([record({
    recoveryCount: 1,
    approvals: [{ id: "approval-1", toolName: "create_file", status: "APPROVED", requestedAt: at(200), decidedAt: at(300) }],
    steps: [
      { sequence: 1, kind: "TOOL_CALL", createdAt: at(100), payload: { executionAttempt: 1, runtimeStep: 1, toolCall: { name: "create_file", arguments: { path: "demo.txt" } } } },
      { sequence: 2, kind: "APPROVAL_REQUIRED", createdAt: at(200), payload: { executionAttempt: 1, runtimeStep: 1, toolName: "create_file", approvalId: "approval-1" } },
      { sequence: 3, kind: "APPROVAL_APPROVED", createdAt: at(300), payload: { approvalId: "approval-1", toolName: "create_file" } },
      { sequence: 4, kind: "TOOL_RESULT", createdAt: at(400), payload: { executionAttempt: 1, runtimeStep: 1, name: "create_file", result: { created: true } } },
      { sequence: 5, kind: "RUNTIME_FAILURE", createdAt: at(500), payload: { executionAttempt: 1, reason: "WORKER_LEASE_EXPIRED", message: "Worker lease expired; whole run will restart", workerId: "worker-1" } },
      { sequence: 6, kind: "MODEL_CALL", createdAt: at(600), payload: { executionAttempt: 2, runtimeStep: 1, durationMs: 20 } },
    ],
  })]).get("run-1");
  assert.ok(details);
  assert.deepEqual(details.timeline.map((entry) => entry.executionAttempt), [1, 1, 1, 1, 1, 2]);
  assert.equal(details.timeline[2]?.approvalId, "approval-1");
  const view = formatRunDetails(details);
  assert.match(view, /Attempt 1/);
  assert.match(view, /Attempt 2/);
  assert.match(view, /WORKER_LEASE_EXPIRED/);
  assert.match(view, /approval=approval-1/);
});

test("failed runs show code, message and last useful events", async () => {
  const details = await query([record({
    status: "FAILED", finalAnswer: null, failureReason: "SANDBOX_TIMEOUT", failureMessage: "Sandbox exceeded 1000 ms",
    steps: [{ sequence: 1, kind: "RUNTIME_FAILURE", createdAt: at(500), payload: { executionAttempt: 1, runtimeStep: 2, reason: "SANDBOX_TIMEOUT", message: "Sandbox exceeded 1000 ms" } }],
  })]).get("run-1");
  assert.ok(details);
  const view = formatRunDetails(details);
  assert.match(view, /Status: FAILED/);
  assert.match(view, /Failure: SANDBOX_TIMEOUT — Sandbox exceeded 1000 ms/);
  assert.match(view, /RUNTIME_FAILURE.*code=SANDBOX_TIMEOUT/);
});
