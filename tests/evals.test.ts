import test from "node:test";
import assert from "node:assert/strict";
import { caseRevision, defineEvalCase, evalCases, getEvalCase } from "../src/evals/cases.js";
import { extractMetrics, scoreEval } from "../src/evals/scorer.js";
import { evalAgent } from "../src/evals/config.js";
import { EvalRunner } from "../src/evals/runner.js";
import { comparison, type EvalRecord, type EvalStore } from "../src/evals/store.js";
import type { RunDetails } from "../src/observability/run-query.js";
import type { ExecutionStore } from "../src/persistence/execution-store.js";
import type { EvalResult } from "../src/evals/scorer.js";
import { PrismaExecutionStore } from "../src/persistence/prisma-execution-store.js";
import type { PrismaClient } from "../src/generated/prisma/client.js";

const definition = getEvalCase("locate-model-provider-factory");
function run(overrides: Partial<RunDetails> = {}): RunDetails {
  return {
    id: "run-1", taskId: "task-1", prompt: definition.prompt, status: "COMPLETED",
    agent: "repository-explorer", agentVersion: 2, provider: "ollama", model: "qwen3.5:9b",
    createdAt: "2026-10-06T00:00:00Z", startedAt: "2026-10-06T00:00:01Z", completedAt: "2026-10-06T00:00:02Z",
    workerId: null, heartbeatAt: null, recoveryCount: 0, totalDurationMs: 2000, executionDurationMs: 1000,
    finalAnswer: "ModelProviderFactory is in src/model/model-provider-factory.ts", failure: null, approvals: [],
    timeline: [
      { sequence: 1, executionAttempt: 1, runtimeStep: 1, timestamp: "now", type: "MODEL_CALL", usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 } },
      { sequence: 2, executionAttempt: 1, runtimeStep: 1, timestamp: "now", type: "TOOL_CALL", toolName: "search_files" },
    ], ...overrides,
  };
}

test("eval definitions validate IDs, text and bounds and preserve stable revisions", () => {
  assert.equal(evalCases.length, 3);
  assert.deepEqual(defineEvalCase(definition), definition);
  assert.equal(caseRevision(definition), caseRevision(structuredClone(definition)));
  assert.notEqual(caseRevision(definition), caseRevision({ ...definition, prompt: "changed" }));
  assert.throws(() => getEvalCase("missing"));
  assert.throws(() => defineEvalCase({ ...definition, id: "bad id" }));
  assert.throws(() => defineEvalCase({ ...definition, assertions: [] }));
  assert.throws(() => defineEvalCase({ ...definition, assertions: [{ type: "answer_contains", text: " " }] }));
  assert.throws(() => defineEvalCase({ ...definition, assertions: [{ type: "tool_calls", tool: "read_file", min: 2, max: 1 }] }));
});

test("completed eval passes final-answer and tool assertions; metrics remain separate", () => {
  const result = scoreEval(definition, run());
  assert.equal(result.outcome, "PASSED");
  assert.equal(result.passedAssertions, 5);
  assert.equal(result.successRate, 1);
  assert.deepEqual(result.metrics?.tokens, { input: 10, output: 5, total: 15 });
  assert.equal(result.metrics?.modelCallCount, 1);
  assert.equal(result.metrics?.toolCallCount, 1);
  assert.equal(result.metrics?.totalDurationMs, 2000);
});

test("completed answer missing expected behavior is not an execution failure", () => {
  const result = scoreEval(definition, run({ finalAnswer: "Babel and TypeScript", timeline: [] }));
  assert.equal(result.outcome, "ASSERTION_FAILED");
  assert.equal(result.passedAssertions, 2);
  assert.equal(result.metrics?.taskRunStatus, "COMPLETED");
  assert.equal(result.assertions[1]?.result, "FAIL");
});

test("failed run preserves runtime failure and recovery count", () => {
  const result = scoreEval(definition, run({ status: "FAILED", recoveryCount: 1, failure: { code: "MODEL_ERROR", message: "unavailable" } }));
  assert.equal(result.outcome, "EXECUTION_FAILED");
  assert.equal(result.metrics?.failureCode, "MODEL_ERROR");
  assert.equal(result.metrics?.recoveryCount, 1);
  assert.equal(result.assertions[4]?.result, "FAIL");
  assert.throws(() => scoreEval(definition, run({ status: "RUNNING" })));
});

test("tool upper bounds, model limits, duration and recovered failure events are checked", () => {
  const custom = defineEvalCase({ ...definition, assertions: [
    { type: "tool_calls", tool: "search_files", max: 0 },
    { type: "max_model_calls", count: 1 }, { type: "max_duration_ms", milliseconds: 1999 },
    { type: "no_runtime_failure" },
  ] });
  const record = run();
  record.timeline.push({ sequence: 3, executionAttempt: 1, runtimeStep: 1, timestamp: "now", type: "RUNTIME_FAILURE" });
  assert.deepEqual(scoreEval(custom, record).assertions.map(a => a.result), ["FAIL", "PASS", "FAIL", "FAIL"]);
});

test("missing or partial token usage is unknown, never silently zero or partial totals", () => {
  const record = run();
  record.timeline.push({ sequence: 3, executionAttempt: 1, runtimeStep: 2, timestamp: "now", type: "MODEL_CALL", usage: { inputTokens: 7 } });
  assert.deepEqual(extractMetrics(record).tokens, { input: 17, output: null, total: null });
  assert.deepEqual(extractMetrics(run({ timeline: [] })).tokens, { input: null, output: null, total: null });
});

test("model configurations require concrete provider/model/version and preserve model identity", () => {
  assert.equal(evalAgent("openai/gpt-6-sol@3").modelName, "gpt-6-sol");
  assert.equal(evalAgent("ollama/qwen3.5:9b@2").version, 2);
  assert.throws(() => evalAgent("openai/gpt-6-sol"));
  assert.throws(() => evalAgent("unknown/model@1"));
});

test("immutable AgentVersion cannot silently substitute another model during eval submission", async () => {
  const prisma = {
    agent: { async upsert() { return { id: "agent-1" }; } },
    agentVersion: { async upsert() { return { id: "version-2", modelProvider: "ollama", modelName: "qwen3.5:9b" }; } },
  } as unknown as PrismaClient;
  const store = new PrismaExecutionStore(prisma);
  assert.deepEqual(await store.resolveAgentVersion(evalAgent("ollama/qwen3.5:9b@2")), { agentId: "agent-1", agentVersionId: "version-2" });
  await assert.rejects(store.resolveAgentVersion(evalAgent("openai/gpt-6-sol@2")), /already uses ollama\/qwen3.5:9b/);
});

function harness(options: { queueError?: boolean; pending?: boolean } = {}) {
  const events: string[] = [];
  const saved: EvalResult[] = [];
  let clock = 0;
  const store = {
    async resolveAgentVersion(agent: ReturnType<typeof evalAgent>) {
      events.push(`version:${agent.modelProvider}/${agent.modelName}`);
      return { agentId: "agent-1", agentVersionId: "version-2" };
    },
    async createPendingExecution(_agent: string, version: string, prompt: string) {
      assert.equal(version, "version-2"); assert.equal(prompt, definition.prompt);
      events.push("pending"); return { taskId: "task-1", taskRunId: "run-1" };
    },
  } as unknown as ExecutionStore;
  const evals: EvalStore = {
    async create(value, taskRunId) { assert.deepEqual(value, definition); assert.equal(taskRunId, "run-1"); events.push("eval-created"); return "eval-1"; },
    async finish(id, result) { assert.equal(id, "eval-1"); saved.push(result); events.push("saved"); },
    async list() { return []; },
  };
  const runner = new EvalRunner({ store, evals,
    queue: { async enqueue(id) { assert.equal(id, "run-1"); events.push("enqueued"); if (options.queueError) throw new Error("Redis unavailable"); return { jobId: "job-1" }; }, async close() {} },
    runs: { async get(id) { assert.equal(id, "run-1"); events.push("queried"); return run(options.pending ? { status: "PENDING" } : {}); } },
    now: () => clock, sleep: async (ms) => { clock += ms; },
  });
  return { runner, saved, events };
}

test("eval runner submits normal task, registers before enqueue, queries persisted execution and saves score", async () => {
  const { runner, saved, events } = harness();
  const result = await runner.run(definition, evalAgent("ollama/qwen3.5:9b@2"), "/workspace");
  assert.equal(result.taskRunId, "run-1"); assert.equal(saved[0]?.outcome, "PASSED");
  assert.deepEqual(events, ["version:ollama/qwen3.5:9b", "pending", "eval-created", "enqueued", "queried", "saved"]);
});

test("eval wait timeout is persisted separately and does not cancel the task", async () => {
  const { runner, saved } = harness({ pending: true });
  await runner.run(definition, evalAgent("ollama/qwen3.5:9b@2"), "/workspace", 2);
  assert.equal(saved[0]?.outcome, "TIMED_OUT"); assert.equal(saved[0]?.successRate, null);
  assert.equal(saved[0]?.metrics?.taskRunStatus, "PENDING");
});

test("enqueue infrastructure failure remains linked to its real TaskRun", async () => {
  const { runner, saved } = harness({ queueError: true });
  const result = await runner.run(definition, evalAgent("ollama/qwen3.5:9b@2"), "/workspace");
  assert.equal(result.taskRunId, "run-1"); assert.equal(saved[0]?.outcome, "INFRASTRUCTURE_FAILED");
  assert.equal(saved[0]?.message, "Redis unavailable");
});

test("comparison preserves both models and separates changed case definitions", () => {
  const record: EvalRecord = { id: "eval-1", caseId: definition.id, caseRevision: caseRevision(definition), taskRunId: "run-1", provider: "ollama", model: "qwen3.5:9b", agentVersion: 2, createdAt: "now", result: scoreEval(definition, run()) };
  const result = comparison([record, { ...record, id: "eval-2", provider: "openai", model: "gpt-6-sol", agentVersion: 3 }, { ...record, caseRevision: "changed" }]);
  assert.equal(Object.keys(result).length, 2);
  assert.deepEqual(result[record.caseRevision]?.map(r => r.provider), ["ollama", "openai"]);
});
