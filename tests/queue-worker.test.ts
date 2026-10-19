import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { TaskPostcondition } from "../src/verification/task-postconditions.js";
import { RepositoryTools } from "../src/tools/repository-tools.js";
import type { ModelProvider, ModelRequest, ModelResponse } from "../src/model/types.js";
import type {
  AgentDefinition,
  ApprovalDecision,
  ExecutionStore,
  LoadedExecution,
  PersistedStep,
  PendingApproval,
  RecoveryDecision,
  StaleExecution,
} from "../src/persistence/execution-store.js";
import {
  createAgentTaskJobData,
  type TaskRunQueue,
} from "../src/queue/agent-task-queue.js";
import { submitTask } from "../src/queue/task-submission.js";
import { recoverStaleRuns } from "../src/recovery/recover-stale-runs.js";
import { decideApprovalAndEnqueue } from "../src/approvals/approval-service.js";
import { AgentRuntime, type RuntimeResult, type TraceEvent } from "../src/runtime/agent-runtime.js";
import { ToolRegistry } from "../src/tools/tool-registry.js";
import { SandboxError } from "../src/sandbox/sandbox.js";
import { processTaskRun } from "../src/workers/task-run-processor.js";

type StoredRun = {
  id: string;
  taskId: string;
  agentVersionId: string;
  status: "PENDING" | "RUNNING" | "WAITING_FOR_APPROVAL" | "COMPLETED" | "FAILED";
  finalAnswer: string | null;
  failureReason: string | null;
  workerId: string | null;
  heartbeatAt: Date | null;
  recoveryCount: number;
  steps: PersistedStep[];
};

type StoredApproval = PendingApproval & {
  status: "PENDING" | "APPROVED" | "DENIED";
  resumeMessages: import("../src/model/types.js").ModelMessage[];
  runtimeStep: number;
  consumedAt: Date | null;
};

class MemoryExecutionStore implements ExecutionStore {
  readonly agents = new Map<string, { id: string }>();
  readonly versions = new Map<string, { id: string; definition: AgentDefinition }>();
  readonly tasks = new Map<
    string,
    { id: string; prompt: string; workspaceRoot: string; status: string; postconditions: TaskPostcondition[] }
  >();
  readonly runs = new Map<string, StoredRun>();
  readonly approvals = new Map<string, StoredApproval>();
  readonly calls: string[] = [];

  async resolveAgentVersion(definition: AgentDefinition) {
    const agent = this.agents.get(definition.name) ?? { id: `agent-${this.agents.size + 1}` };
    this.agents.set(definition.name, agent);
    const key = `${agent.id}:${definition.version}`;
    const version = this.versions.get(key) ?? {
      id: `version-${this.versions.size + 1}`,
      definition: structuredClone(definition),
    };
    this.versions.set(key, version);
    return { agentId: agent.id, agentVersionId: version.id };
  }

  async createPendingExecution(
    _agentId: string,
    agentVersionId: string,
    prompt: string,
    workspaceRoot: string,
    postconditions: TaskPostcondition[] = [],
  ) {
    const taskId = `task-${this.tasks.size + 1}`;
    const taskRunId = `run-${this.runs.size + 1}`;
    this.tasks.set(taskId, { id: taskId, prompt, workspaceRoot, postconditions: structuredClone(postconditions), status: "PENDING" });
    this.runs.set(taskRunId, {
      id: taskRunId,
      taskId,
      agentVersionId,
      status: "PENDING",
      finalAnswer: null,
      failureReason: null,
      workerId: null,
      heartbeatAt: null,
      recoveryCount: 0,
      steps: [],
    });
    return { taskId, taskRunId };
  }

  async loadExecution(taskRunId: string): Promise<LoadedExecution> {
    this.calls.push("load");
    const run = this.requireRun(taskRunId);
    const task = this.tasks.get(run.taskId);
    const version = [...this.versions.values()].find((item) => item.id === run.agentVersionId);
    if (!task || !version) throw new Error("Execution data not found");
    const approval = [...this.approvals.values()]
      .filter((item) => item.taskRunId === taskRunId && item.status !== "PENDING" && !item.consumedAt)
      .at(-1);
    return {
      taskId: task.id,
      taskRunId,
      prompt: task.prompt,
      workspaceRoot: task.workspaceRoot,
      postconditions: task.postconditions,
      priorToolResults: run.steps.filter(step => step.kind === "TOOL_RESULT").map(step => step.payload),
      priorToolCalls: run.steps.filter(step => step.kind === "TOOL_CALL").map(step => step.payload),
      correctionAttempted: run.steps.some(step => step.kind === "POSTCONDITION_CHECK"
        && (step.payload as { correctionAttempt?: number }).correctionAttempt === 1),
      hadDeniedApproval: [...this.approvals.values()].some(item => item.taskRunId === taskRunId && item.status === "DENIED"),
      agent: structuredClone(version.definition),
      recoveryCount: run.recoveryCount,
      nextStepSequence: (run.steps.at(-1)?.sequence ?? 0) + 1,
      approvalResume: approval
        ? {
            approvalId: approval.id,
            decision: approval.status === "APPROVED" ? "APPROVED" : "DENIED",
            toolName: approval.toolName,
            validatedArguments: structuredClone(approval.validatedArguments),
            resumeMessages: structuredClone(approval.resumeMessages),
            runtimeStep: approval.runtimeStep,
          }
        : undefined,
    };
  }

  async claimExecution(taskId: string, taskRunId: string, workerId: string, now: Date) {
    this.calls.push("running");
    const run = this.requireRun(taskRunId);
    if (run.status !== "PENDING") throw new Error("Run is not pending");
    run.status = "RUNNING";
    run.workerId = workerId;
    run.heartbeatAt = now;
    const task = this.tasks.get(taskId);
    if (!task) throw new Error("Task not found");
    task.status = "RUNNING";
  }

  async heartbeat(taskRunId: string, workerId: string, now: Date) {
    const run = this.requireRun(taskRunId);
    if (run.status !== "RUNNING" || run.workerId !== workerId) throw new Error("Lease lost");
    run.heartbeatAt = now;
  }

  async appendStep(taskRunId: string, workerId: string, step: PersistedStep) {
    const run = this.requireRun(taskRunId);
    if (run.status !== "RUNNING" || run.workerId !== workerId) throw new Error("Lease lost");
    this.requireRun(taskRunId).steps.push(structuredClone(step));
  }

  async completeModelCall(
    taskRunId: string,
    workerId: string,
    sequence: number,
    durationMs: number,
    metadata?: import("../src/model/types.js").ModelMetadata,
  ) {
    const run = this.requireRun(taskRunId);
    if (run.status !== "RUNNING" || run.workerId !== workerId) throw new Error("Lease lost");
    const step = run.steps.find((item) => item.sequence === sequence);
    if (!step || step.kind !== "MODEL_CALL") throw new Error("Model call step not found");
    step.payload = { ...(step.payload as object), durationMs, ...(metadata ? { model: metadata } : {}) };
  }

  async waitForApproval(
    taskId: string,
    taskRunId: string,
    workerId: string,
    action: import("../src/runtime/agent-runtime.js").PendingApprovalAction,
    step: PersistedStep,
  ) {
    const run = this.requireRun(taskRunId);
    if (run.status !== "RUNNING" || run.workerId !== workerId) throw new Error("Lease lost");
    const id = `approval-${this.approvals.size + 1}`;
    this.approvals.set(id, {
      id,
      taskRunId,
      toolName: action.toolName,
      validatedArguments: structuredClone(action.validatedArguments),
      resumeMessages: structuredClone(action.resumeMessages),
      runtimeStep: action.runtimeStep,
      status: "PENDING",
      requestedAt: new Date(),
      consumedAt: null,
    });
    run.steps.push({
      ...structuredClone(step),
      payload: { ...(step.payload as object), approvalId: id },
    });
    run.status = "WAITING_FOR_APPROVAL";
    run.workerId = null;
    run.heartbeatAt = null;
    const task = this.tasks.get(taskId);
    if (task) task.status = "WAITING_FOR_APPROVAL";
    return { approvalId: id };
  }

  async listPendingApprovals(): Promise<PendingApproval[]> {
    return [...this.approvals.values()]
      .filter((approval) => approval.status === "PENDING")
      .map(({ id, taskRunId, toolName, validatedArguments, requestedAt }) => ({
        id,
        taskRunId,
        toolName,
        validatedArguments,
        requestedAt,
      }));
  }

  async decideApproval(approvalId: string, decision: ApprovalDecision) {
    const approval = this.approvals.get(approvalId);
    if (!approval) throw new Error("Approval not found");
    if (approval.status !== "PENDING") throw new Error("Approval already decided");
    const run = this.requireRun(approval.taskRunId);
    if (run.status !== "WAITING_FOR_APPROVAL") throw new Error("Run is not waiting");
    approval.status = decision;
    run.status = "PENDING";
    const task = this.tasks.get(run.taskId);
    if (task) task.status = "PENDING";
    run.steps.push({
      sequence: (run.steps.at(-1)?.sequence ?? 0) + 1,
      kind: decision === "APPROVED" ? "APPROVAL_APPROVED" : "APPROVAL_DENIED",
      payload: { approvalId, toolName: approval.toolName },
    });
    return { taskRunId: run.id };
  }

  async claimApprovalAction(taskRunId: string, workerId: string, approvalId: string, now: Date) {
    const run = this.requireRun(taskRunId);
    if (run.status !== "RUNNING" || run.workerId !== workerId) throw new Error("Lease lost");
    const approval = this.approvals.get(approvalId);
    if (!approval || approval.taskRunId !== taskRunId || approval.status === "PENDING" || approval.consumedAt) {
      throw new Error("Approval action unavailable");
    }
    approval.consumedAt = now;
  }

  async finishExecution(
    taskId: string,
    taskRunId: string,
    workerId: string,
    result: RuntimeResult,
  ) {
    this.calls.push("finished");
    const run = this.requireRun(taskRunId);
    if (run.status !== "RUNNING" || run.workerId !== workerId) throw new Error("Lease lost");
    run.status = result.status === "completed" ? "COMPLETED" : "FAILED";
    run.finalAnswer = result.status !== "waiting_for_approval" ? result.answer ?? null : null;
    run.failureReason = result.status === "failed" ? result.reason : null;
    const task = this.tasks.get(taskId);
    if (!task) throw new Error("Task not found");
    task.status = run.status;
  }

  async findStaleExecutions(staleBefore: Date): Promise<StaleExecution[]> {
    const result: StaleExecution[] = [];
    for (const run of this.runs.values()) {
      if (run.status !== "RUNNING" || (run.heartbeatAt && run.heartbeatAt >= staleBefore)) continue;
      const version = [...this.versions.values()].find((item) => item.id === run.agentVersionId);
      if (!version) throw new Error("Version not found");
      result.push({
        taskId: run.taskId,
        taskRunId: run.id,
        recoveryCount: run.recoveryCount,
        agentName: version.definition.name,
        toolPolicies: version.definition.toolPolicies,
      });
    }
    return result;
  }

  async recoverStaleExecution(
    taskRunId: string,
    staleBefore: Date,
    maxRecoveries: number,
  ): Promise<RecoveryDecision> {
    const run = this.requireRun(taskRunId);
    if (run.status !== "RUNNING" || (run.heartbeatAt && run.heartbeatAt >= staleBefore)) {
      return { action: "SKIPPED" };
    }
    if (run.recoveryCount >= maxRecoveries) {
      run.status = "FAILED";
      run.failureReason = "RECOVERY_LIMIT_EXCEEDED";
      const task = this.tasks.get(run.taskId);
      if (task) task.status = "FAILED";
      return { action: "FAILED_LIMIT" };
    }
    run.status = "PENDING";
    run.workerId = null;
    run.heartbeatAt = null;
    run.recoveryCount += 1;
    const task = this.tasks.get(run.taskId);
    if (task) task.status = "PENDING";
    return { action: "REQUEUE", recoveryCount: run.recoveryCount };
  }

  async failStaleExecution(taskId: string, taskRunId: string, reason: string) {
    const run = this.requireRun(taskRunId);
    run.status = "FAILED";
    run.failureReason = reason;
    const task = this.tasks.get(taskId);
    if (task) task.status = "FAILED";
  }

  private requireRun(id: string): StoredRun {
    const run = this.runs.get(id);
    if (!run) throw new Error("Run not found");
    return run;
  }
}

class FakeQueue implements TaskRunQueue {
  readonly payloads: Array<{ taskRunId: string }> = [];
  async enqueue(taskRunId: string) {
    this.payloads.push(createAgentTaskJobData(taskRunId));
    return { jobId: `job-${taskRunId}` };
  }
  async close() {}
}

class FakeProvider implements ModelProvider {
  private index = 0;
  readonly requests: ModelRequest[] = [];
  constructor(private readonly responses: ModelResponse[]) {}
  async generate(request: ModelRequest): Promise<ModelResponse> {
    this.requests.push(structuredClone(request));
    const response = this.responses[Math.min(this.index, this.responses.length - 1)];
    this.index += 1;
    if (!response) throw new Error("No response");
    return response;
  }
}

const tools = new ToolRegistry([
  {
    name: "search_files",
    description: "Search",
    inputSchema: {
      type: "object",
      properties: { query: { type: "string" } },
      required: ["query"],
      additionalProperties: false,
    },
    validate(args) {
      return args;
    },
    async execute() {
      return { matches: [] };
    },
  },
]);

const definition: AgentDefinition = {
  name: "repository-explorer",
  description: "test agent",
  version: 3,
  systemInstructions: "test",
  modelProvider: "fake",
  modelName: "fake-model",
  maxSteps: 2,
  toolPolicies: { search_files: "ALLOW" },
};

async function correctionFixture(t: TestContext, maxSteps = 6) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "foundry-r3-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.writeFile(path.join(root, "seed.txt"), "Read-only evidence");
  const store = new MemoryExecutionStore();
  const queue = new FakeQueue();
  const agent = { ...definition, maxSteps, toolPolicies: { create_file: "REQUIRE_APPROVAL", read_file: "ALLOW" } as const };
  const pending = await submitTask({ store, queue, agent, prompt: "Create note.md", workspaceRoot: root,
    postconditions: [{ type: "file_created", path: "note.md" }],
  });
  let writes = 0;
  const registry = await RepositoryTools.create(root, { sandbox: { async execute(request) {
    const args = request.arguments as { path: string; content: string };
    writes++;
    await fs.writeFile(path.join(root, args.path), args.content, { flag: "wx" });
    return { created: true, path: args.path };
  } } });
  const events: TraceEvent[] = [];
  const providers: FakeProvider[] = [];
  const run = (responses: ModelResponse[], contextWindowTokens?: number) => {
    const provider = Object.assign(new FakeProvider(responses), { contextWindowTokens });
    providers.push(provider);
    const workerId = `worker-${providers.length}`;
    return processTaskRun({ ...pending, workerId, heartbeatIntervalMs: 10000, store,
      createRuntime: async (execution, onTrace) => new AgentRuntime({ provider, tools: registry,
        toolPolicies: execution.agent.toolPolicies, systemInstructions: "test", maxSteps: execution.agent.maxSteps,
        contextProtection: { maxToolResultBytes: 8000, reservedOutputTokens: 100, safetyMarginTokens: 100 },
        claimApprovalAction: id => store.claimApprovalAction(pending.taskRunId, workerId, id, new Date()),
        onTrace: async event => { events.push(structuredClone(event)); await onTrace(event); },
      }),
    });
  };
  return { root, store, queue, pending, registry, providers, events, run, writes: () => writes,
    steps: () => store.runs.get(pending.taskRunId)!.steps,
    checks: () => store.runs.get(pending.taskRunId)!.steps.filter(step => step.kind === "POSTCONDITION_CHECK").map(step => step.payload as Record<string, unknown>),
  };
}

const r3Final = (content = "Done"): ModelResponse => ({ type: "final", content });
const r3Create = (file = "note.md"): ModelResponse => ({ type: "tool_call", toolCall: {
  id: `create-${file}`, name: "create_file", arguments: { path: file, content: "Verified" },
} });

test("R3 false final continues same conversation, requires approval, then verifies and completes", async t => {
  const f = await correctionFixture(t);
  const paused = await f.run([
    { type: "tool_call", toolCall: { id: "read-1", name: "read_file", arguments: { path: "seed.txt" } } },
    r3Final("I created it"), r3Create(),
  ]);
  assert.equal(paused.status, "waiting_for_approval");
  assert.equal(f.writes(), 0);
  assert.equal(f.events.some(e => e.type === "completed"), false);
  assert.equal(f.checks()[0]?.correctionOutcome, "STARTED");
  const requests = f.providers[0]!.requests;
  assert.equal(requests.length, 3);
  const continuation = requests[2]!.messages;
  assert.deepEqual(continuation.slice(0, requests[1]!.messages.length), requests[1]!.messages);
  assert.deepEqual(continuation.at(-2), { role: "assistant", content: "I created it" });
  const feedback = JSON.parse(continuation.at(-1)!.content);
  assert.equal(feedback.code, "POSTCONDITION_UNMET");
  assert.equal(feedback.correctionAttemptsRemaining, 1);
  assert.deepEqual(feedback.checks, [{ expected: { type: "file_created", path: "note.md" }, creationRecorded: false, fileExists: false }]);
  const approval = [...f.store.approvals.values()][0]!;
  assert.equal(approval.taskRunId, f.pending.taskRunId);
  assert.deepEqual(approval.resumeMessages.slice(0, -1), continuation);
  await decideApprovalAndEnqueue({ store: f.store, queue: f.queue, approvalId: approval.id, decision: "APPROVED" });
  assert.equal((await f.store.loadExecution(f.pending.taskRunId)).correctionAttempted, true);
  assert.equal((await f.run([r3Final("Created after approval")])).status, "completed");
  assert.equal(f.writes(), 1);
  assert.equal(f.store.runs.size, 1);
  assert.equal(f.store.runs.get(f.pending.taskRunId)!.status, "COMPLETED");
  assert.equal(f.checks().at(-1)?.correctionOutcome, "SUCCEEDED");
  const resumedMessages = f.providers[1]!.requests[0]!.messages;
  assert.deepEqual(resumedMessages.slice(0, -1), approval.resumeMessages);
  assert.ok(resumedMessages.at(-1)?.role === "tool");
  assert.equal(f.steps().filter(step => step.kind === "TOOL_CALL" && (step.payload as { toolCall: { name: string } }).toolCall.name === "read_file").length, 1);
  assert.deepEqual(f.steps().map(step => step.sequence), f.steps().map((_, i) => i + 1));
  assert.equal(f.events.filter(e => e.type === "completed").length, 1);
});

test("R3 immediately satisfied condition completes without spending correction", async t => {
  const f = await correctionFixture(t);
  assert.equal((await f.run([r3Create()])).status, "waiting_for_approval");
  const approval = [...f.store.approvals.values()][0]!;
  await decideApprovalAndEnqueue({ store: f.store, queue: f.queue, approvalId: approval.id, decision: "APPROVED" });
  assert.equal((await f.run([r3Final()])).status, "completed");
  assert.equal(f.checks().length, 1);
  assert.equal(f.checks()[0]?.correctionAttempt, undefined);
  assert.equal(f.writes(), 1);
});

test("R3 failed correction has only one opportunity and retains postcondition failure code", async t => {
  const f = await correctionFixture(t);
  const result = await f.run([r3Final("First false claim"), r3Final("Still not created"), r3Create()]);
  assert.equal(result.status, "failed");
  if (result.status === "failed") assert.equal(result.reason, "TASK_POSTCONDITION_FAILED");
  assert.equal(f.providers[0]!.requests.length, 2);
  assert.deepEqual(f.checks().map(c => c.correctionOutcome), ["STARTED", "FAILED"]);
  assert.equal(f.writes(), 0);
  assert.equal(f.events.some(e => e.type === "completed"), false);
});

for (const correctedFirst of [false, true]) {
  test(`R3 ${correctedFirst ? "correction " : ""}approval denial forbids further correction`, async t => {
    const f = await correctionFixture(t);
    assert.equal((await f.run(correctedFirst ? [r3Final(), r3Create()] : [r3Create()])).status, "waiting_for_approval");
    const approval = [...f.store.approvals.values()][0]!;
    await decideApprovalAndEnqueue({ store: f.store, queue: f.queue, approvalId: approval.id, decision: "DENIED" });
    assert.equal((await f.store.loadExecution(f.pending.taskRunId)).hadDeniedApproval, true);
    const result = await f.run([r3Final("Denied"), r3Create()]);
    assert.equal(result.status, "failed");
    assert.equal(f.providers[1]!.requests.length, 1);
    assert.equal(f.writes(), 0);
    assert.equal(f.checks().filter(c => c.correctionOutcome === "STARTED").length, correctedFirst ? 1 : 0);
  });
}

test("R3 completed side effects and legacy unknown evidence prevent correction", async t => {
  const f = await correctionFixture(t);
  assert.equal((await f.run([r3Create("other.md")])).status, "waiting_for_approval");
  const approval = [...f.store.approvals.values()][0]!;
  await decideApprovalAndEnqueue({ store: f.store, queue: f.queue, approvalId: approval.id, decision: "APPROVED" });
  const result = await f.run([r3Final("Wrong file created"), r3Create()]);
  assert.equal(result.status, "failed");
  assert.equal(f.writes(), 1);
  assert.equal(f.providers[1]!.requests.length, 1);
  assert.equal(f.checks()[0]?.correctionAttempt, undefined);
  const legacy = await correctionFixture(t);
  legacy.store.runs.get(legacy.pending.taskRunId)!.steps.push({ sequence: 1, kind: "TOOL_RESULT", payload: { name: "unknown", result: { ok: true } } });
  assert.equal((await legacy.run([r3Final(), r3Create()])).status, "failed");
  assert.equal(legacy.providers[0]!.requests.length, 1);
  const incomplete = await correctionFixture(t);
  incomplete.store.runs.get(incomplete.pending.taskRunId)!.steps.push({ sequence: 1, kind: "TOOL_CALL",
    payload: { executionAttempt: 1, runtimeStep: 1, toolCall: { name: "create_file", arguments: {} } } });
  assert.equal((await incomplete.run([r3Final(), r3Create()])).status, "failed");
  assert.equal(incomplete.providers[0]!.requests.length, 1);
});

test("R3 correction counter survives approved resume even when correction does not satisfy condition", async t => {
  const f = await correctionFixture(t);
  await f.run([r3Final(), r3Create("other.md")]);
  const approval = [...f.store.approvals.values()][0]!;
  await decideApprovalAndEnqueue({ store: f.store, queue: f.queue, approvalId: approval.id, decision: "APPROVED" });
  assert.equal((await f.run([r3Final(), r3Create()])).status, "failed");
  assert.deepEqual(f.checks().map(c => c.correctionOutcome), ["STARTED", "FAILED"]);
  assert.equal(f.providers[1]!.requests.length, 1);
  assert.equal(f.writes(), 1);
});

test("R3 does not reset maxSteps or bypass context budget during correction", async t => {
  const noRoom = await correctionFixture(t, 1);
  const noRoomResult = await noRoom.run([r3Final()]);
  assert.ok(noRoomResult.status === "failed" && noRoomResult.reason === "TASK_POSTCONDITION_FAILED");
  assert.equal(noRoom.checks()[0]?.correctionAttempt, undefined);
  const bounded = await correctionFixture(t, 2);
  const result = await bounded.run([r3Final(), { type: "tool_call", toolCall: { name: "read_file", arguments: { path: "seed.txt" } } }, r3Final()]);
  assert.ok(result.status === "failed" && result.reason === "MAX_STEPS_EXCEEDED");
  assert.equal(bounded.providers[0]!.requests.length, 2);
  assert.equal(bounded.checks().at(-1)?.correctionOutcome, "FAILED");
  const guarded = await correctionFixture(t);
  const request = { messages: [{ role: "system", content: "test" }, { role: "user", content: "Create note.md" }],
    tools: guarded.registry.schemasFor(new Set(["read_file", "create_file"])) };
  const initialEstimate = Buffer.byteLength(JSON.stringify(request)) + 512 + 2 * 96 + 2 * 64;
  const guardedResult = await guarded.run([r3Final(), r3Create()], initialEstimate + 200 + 1);
  assert.ok(guardedResult.status === "failed" && guardedResult.reason === "CONTEXT_BUDGET_EXCEEDED");
  assert.equal(guarded.providers[0]!.requests.length, 1);
  assert.equal(guarded.checks().at(-1)?.correctionOutcome, "FAILED");
});

test("R3 approval resume retains maxSteps and corrections cannot bypass permissions", async t => {
  const bounded = await correctionFixture(t, 2);
  assert.equal((await bounded.run([r3Final(), r3Create()])).status, "waiting_for_approval");
  const approval = [...bounded.store.approvals.values()][0]!;
  assert.equal(approval.runtimeStep, 2);
  await decideApprovalAndEnqueue({ store: bounded.store, queue: bounded.queue, approvalId: approval.id, decision: "APPROVED" });
  const result = await bounded.run([r3Final()]);
  assert.ok(result.status === "failed" && result.reason === "MAX_STEPS_EXCEEDED");
  assert.equal(bounded.providers[1]!.requests.length, 0);
  assert.equal(bounded.writes(), 1);
  assert.deepEqual(bounded.checks().map(c => c.correctionOutcome), ["STARTED", "FAILED"]);
  const denied = await correctionFixture(t);
  const deniedResult = await denied.run([r3Final(), { type: "tool_call", toolCall: { name: "delete_file", arguments: { path: "seed.txt" } } }]);
  assert.ok(deniedResult.status === "failed" && deniedResult.reason === "TOOL_PERMISSION_DENIED");
  assert.equal(await fs.readFile(path.join(denied.root, "seed.txt"), "utf8"), "Read-only evidence");
  assert.equal(denied.checks().at(-1)?.correctionOutcome, "FAILED");
});

test("worker persists context-budget failure and numeric diagnostics without calling model", async () => {
  const store = new MemoryExecutionStore();
  const pending = await createPending(store);
  let modelCalls = 0;
  const result = await processTaskRun({ taskRunId: pending.taskRunId, workerId: "budget-worker", heartbeatIntervalMs: 10000, store,
    createRuntime: async (_execution, onTrace) => new AgentRuntime({
      provider: { contextWindowTokens: 500, async generate() { modelCalls++; return { type: "final", content: "Unexpected" }; } },
      tools, toolPolicies: definition.toolPolicies, systemInstructions: "test", maxSteps: 2, onTrace,
      contextProtection: { maxToolResultBytes: 8000, reservedOutputTokens: 2048, safetyMarginTokens: 1024 },
    }),
  });
  assert.equal(result.status, "failed");
  assert.equal(modelCalls, 0);
  const run = store.runs.get(pending.taskRunId)!;
  assert.equal(run.status, "FAILED");
  assert.equal(run.failureReason, "CONTEXT_BUDGET_EXCEEDED");
  assert.deepEqual(run.steps.map(step => step.kind), ["RUNTIME_FAILURE"]);
  const payload = run.steps[0]!.payload as { reason: string; details: { contextWindowTokens: number; estimatedInputTokens: number; inputBudgetTokens: number } };
  assert.equal(payload.reason, "CONTEXT_BUDGET_EXCEEDED");
  assert.equal(payload.details.contextWindowTokens, 500);
  assert.ok(payload.details.estimatedInputTokens > payload.details.inputBudgetTokens);
});

test("worker persists oversized read feedback diagnostics separately from actual tool evidence", async () => {
  const store = new MemoryExecutionStore();
  const pending = await createPending(store);
  const actual = { matches: ["x".repeat(10000)] };
  const registry = new ToolRegistry([{ ...tools.get("search_files")!, readOnly: true, execute: async () => actual }]);
  await processTaskRun({ taskRunId: pending.taskRunId, workerId: "limit-worker", heartbeatIntervalMs: 10000, store,
    createRuntime: async (_execution, onTrace) => new AgentRuntime({
      provider: new FakeProvider([{ type: "tool_call", toolCall: { name: "search_files", arguments: { query: "x" } } }, { type: "final", content: "Result too large" }]),
      tools: registry, toolPolicies: definition.toolPolicies, systemInstructions: "test", maxSteps: 2, onTrace,
      contextProtection: { maxToolResultBytes: 8000, reservedOutputTokens: 2048, safetyMarginTokens: 1024 },
    }),
  });
  const run = store.runs.get(pending.taskRunId)!;
  assert.equal(run.status, "COMPLETED");
  const payload = run.steps.find(step => step.kind === "TOOL_RESULT")!.payload as { result: unknown; outputLimit: { code: string; limitBytes: number } };
  assert.deepEqual(payload.result, actual);
  assert.equal(payload.outputLimit.code, "TOOL_RESULT_TOO_LARGE");
  assert.equal(payload.outputLimit.limitBytes, 8000);
  assert.equal(run.steps.some(step => step.kind === "RUNTIME_FAILURE"), false);
});

test("false file promise receives one correction then fails postconditions and preserves the answer", async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "foundry-promised-file-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  // A pre-existing file alone must not satisfy a creation requirement.
  await fs.writeFile(path.join(root, "note.md"), "Pre-existing");
  const store = new MemoryExecutionStore();
  const pending = await submitTask({ store, queue: new FakeQueue(), agent: definition, prompt: "Create note.md", workspaceRoot: root,
    postconditions: [{ type: "file_created", path: "note.md" }],
  });
  const result = await processTaskRun({ taskRunId: pending.taskRunId, workerId: "worker-check", heartbeatIntervalMs: 10000, store,
    createRuntime: runtimeFactory([{ type: "final", content: "Now I'll create note.md" }]),
  });
  assert.equal(result.status, "failed");
  assert.equal(store.runs.get(pending.taskRunId)?.failureReason, "TASK_POSTCONDITION_FAILED");
  assert.equal(store.runs.get(pending.taskRunId)?.finalAnswer, "Now I'll create note.md");
  const steps = store.runs.get(pending.taskRunId)!.steps;
  assert.deepEqual(steps.map(step => step.kind), ["MODEL_CALL", "FINAL_ANSWER", "POSTCONDITION_CHECK", "MODEL_CALL", "FINAL_ANSWER", "POSTCONDITION_CHECK", "RUNTIME_FAILURE"]);
  assert.match(JSON.stringify(steps.at(-1)?.payload), /no successful create_file/);
  assert.equal(store.tasks.get(pending.taskId)?.status, "FAILED");
});

for (const decision of ["APPROVED", "DENIED"] as const) {
  test(`postconditions survive approval pause and ${decision} resume`, async t => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "foundry-verified-approval-"));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const store = new MemoryExecutionStore();
    const queue = new FakeQueue();
    const pending = await submitTask({ store, queue, agent: { ...definition, maxSteps: 4, toolPolicies: { create_file: "REQUIRE_APPROVAL" } },
      prompt: "Create note.md", workspaceRoot: root, postconditions: [{ type: "file_created", path: "note.md" }],
    });
    let executed = 0;
    const registry = await RepositoryTools.create(root, { sandbox: {
      async execute(request) {
        executed += 1;
        const args = request.arguments as { path: string; content: string };
        await fs.writeFile(path.join(root, args.path), args.content, { flag: "wx" });
        return { path: args.path, created: true, output: "x".repeat(9000) };
      },
    } });
    const process = (workerId: string, responses: ModelResponse[]) => processTaskRun({ taskRunId: pending.taskRunId, workerId, heartbeatIntervalMs: 10000, store,
      createRuntime: async (execution, onTrace) => new AgentRuntime({ provider: new FakeProvider(responses), tools: registry,
        toolPolicies: execution.agent.toolPolicies, systemInstructions: "test", maxSteps: 4, onTrace,
        contextProtection: { maxToolResultBytes: 8000, reservedOutputTokens: 2048, safetyMarginTokens: 1024 },
        claimApprovalAction: id => store.claimApprovalAction(pending.taskRunId, workerId, id, new Date()),
      }),
    });
    const paused = await process("first-worker", [{ type: "tool_call", toolCall: { name: "create_file", arguments: { path: "note.md", content: "Verified" } } }]);
    assert.equal(paused.status, "waiting_for_approval");
    assert.equal(executed, 0);
    assert.equal(store.runs.get(pending.taskRunId)?.steps.some(step => step.kind === "POSTCONDITION_CHECK"), false);
    const approval = [...store.approvals.values()][0]!;
    await decideApprovalAndEnqueue({ store, queue, approvalId: approval.id, decision });
    const result = await process("resumed-worker", [{ type: "final", content: decision === "APPROVED" ? "Created" : "Denied" }]);
    assert.equal(result.status, decision === "APPROVED" ? "completed" : "failed");
    assert.equal(executed, decision === "APPROVED" ? 1 : 0);
    assert.equal(store.runs.get(pending.taskRunId)?.status, decision === "APPROVED" ? "COMPLETED" : "FAILED");
    if (decision === "APPROVED") {
      const evidence = store.runs.get(pending.taskRunId)!.steps.find(step => step.kind === "TOOL_RESULT")!.payload as {
        result: { created: boolean }; outputLimit: { code: string };
      };
      assert.equal(evidence.result.created, true);
      assert.equal(evidence.outputLimit.code, "TOOL_RESULT_OUTPUT_OMITTED");
    }
    const checks = store.runs.get(pending.taskRunId)!.steps.filter(step => step.kind === "POSTCONDITION_CHECK");
    assert.equal(checks.length, 1);
    assert.equal((checks[0]?.payload as { passed: boolean }).passed, decision === "APPROVED");
  });
}

test("verification reloads file creation evidence from an earlier approval segment", async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "foundry-persisted-proof-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.writeFile(path.join(root, "note.md"), "Created earlier in this run");
  const store = new MemoryExecutionStore();
  const pending = await submitTask({ store, queue: new FakeQueue(), agent: definition, prompt: "Create note.md", workspaceRoot: root,
    postconditions: [{ type: "file_created", path: "note.md" }],
  });
  store.runs.get(pending.taskRunId)!.steps.push({ sequence: 1, kind: "TOOL_RESULT", payload: { name: "create_file", result: { path: "note.md", created: true } } });
  const result = await processTaskRun({ taskRunId: pending.taskRunId, workerId: "new-worker", heartbeatIntervalMs: 10000, store,
    createRuntime: runtimeFactory([{ type: "final", content: "Finished" }]),
  });
  assert.equal(result.status, "completed");
  assert.equal(store.runs.get(pending.taskRunId)?.steps.at(-1)?.kind, "POSTCONDITION_CHECK");
});

test("delete_file persists approval, sandbox result and successful deletion verification before completion", async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "foundry-persisted-delete-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.writeFile(path.join(root, "demo.txt"), "fixture");
  const store = new MemoryExecutionStore();
  const queue = new FakeQueue();
  const pending = await submitTask({ store, queue, agent: { ...definition, toolPolicies: { delete_file: "REQUIRE_APPROVAL" } },
    prompt: "Delete demo.txt", workspaceRoot: root, postconditions: [{ type: "file_deleted", path: "demo.txt" }],
  });
  const registry = await RepositoryTools.create(root, { sandbox: { async execute() {
    await fs.unlink(path.join(root, "demo.txt")); return { path: "demo.txt", deleted: true };
  } } });
  const process = (workerId: string, response: ModelResponse) => processTaskRun({ taskRunId: pending.taskRunId, workerId, heartbeatIntervalMs: 10000, store,
    createRuntime: async (execution, onTrace) => new AgentRuntime({ tools: registry, provider: new FakeProvider([response]),
      toolPolicies: execution.agent.toolPolicies, systemInstructions: "test", maxSteps: 2, onTrace,
      claimApprovalAction: id => store.claimApprovalAction(pending.taskRunId, workerId, id, new Date()),
    }),
  });
  assert.equal((await process("first", { type: "tool_call", toolCall: { name: "delete_file", arguments: { path: "demo.txt" } } })).status, "waiting_for_approval");
  assert.equal(await fs.readFile(path.join(root, "demo.txt"), "utf8"), "fixture");
  await decideApprovalAndEnqueue({ store, queue, approvalId: [...store.approvals.values()][0]!.id, decision: "APPROVED" });
  assert.equal((await process("second", { type: "final", content: "Deleted" })).status, "completed");
  const run = store.runs.get(pending.taskRunId)!;
  assert.equal(run.status, "COMPLETED");
  assert.ok(run.steps.some(step => step.kind === "TOOL_RESULT" && (step.payload as { name: string }).name === "delete_file"));
  assert.equal(run.steps.at(-1)?.kind, "POSTCONDITION_CHECK");
  assert.equal((run.steps.at(-1)?.payload as { passed: boolean }).passed, true);
});

function runtimeFactory(responses: ModelResponse[]) {
  return async (_execution: LoadedExecution, onTrace: (event: TraceEvent) => Promise<void>) =>
    new AgentRuntime({
      provider: new FakeProvider(responses),
      tools,
      toolPolicies: _execution.agent.toolPolicies,
      systemInstructions: definition.systemInstructions,
      maxSteps: definition.maxSteps,
      onTrace,
    });
}

async function createPending(store: MemoryExecutionStore) {
  const resolved = await store.resolveAgentVersion(definition);
  return store.createPendingExecution(
    resolved.agentId,
    resolved.agentVersionId,
    "find TODOs",
    "/workspace",
  );
}

test("submission creates a PENDING TaskRun and enqueues only taskRunId", async () => {
  const store = new MemoryExecutionStore();
  const queue = new FakeQueue();
  const result = await submitTask({
    store,
    queue,
    agent: definition,
    prompt: "find TODOs",
    workspaceRoot: "/workspace",
  });

  assert.equal(store.runs.get(result.taskRunId)?.status, "PENDING");
  assert.equal(store.tasks.get(result.taskId)?.status, "PENDING");
  assert.deepEqual(queue.payloads, [{ taskRunId: result.taskRunId }]);
  assert.deepEqual(Object.keys(queue.payloads[0] ?? {}), ["taskRunId"]);
});

test("worker loads the run, marks RUNNING, and finishes successful execution as COMPLETED", async () => {
  const store = new MemoryExecutionStore();
  const pending = await createPending(store);
  const result = await processTaskRun({
    taskRunId: pending.taskRunId,
    workerId: "worker-1",
    heartbeatIntervalMs: 10_000,
    store,
    createRuntime: async (execution, onTrace) => {
      assert.deepEqual(store.calls, ["load", "running"]);
      assert.equal(execution.prompt, "find TODOs");
      assert.equal(store.runs.get(pending.taskRunId)?.status, "RUNNING");
      return runtimeFactory([
        { type: "tool_call", toolCall: { name: "search_files", arguments: { query: "TODO" } }, metadata: { provider: "fake", model: "fake-model", usage: { inputTokens: 10, outputTokens: 2, totalTokens: 12 } } },
        { type: "final", content: "No TODOs." },
      ])(execution, onTrace);
    },
  });

  const run = store.runs.get(pending.taskRunId);
  assert.equal(result.status, "completed");
  assert.equal(run?.status, "COMPLETED");
  assert.equal(run?.finalAnswer, "No TODOs.");
  assert.deepEqual(run?.steps.map((step) => step.kind), [
    "MODEL_CALL",
    "TOOL_CALL",
    "TOOL_RESULT",
    "MODEL_CALL",
    "FINAL_ANSWER",
  ]);
  const firstModelCall = run?.steps[0]?.payload as Record<string, unknown>;
  assert.equal(typeof firstModelCall.durationMs, "number");
  assert.deepEqual(firstModelCall.model, { provider: "fake", model: "fake-model", usage: { inputTokens: 10, outputTokens: 2, totalTokens: 12 } });
  assert.equal(typeof (run?.steps[2]?.payload as Record<string, unknown>).durationMs, "number");
});

test("model call start is persisted before waiting for provider response", async () => {
  const store = new MemoryExecutionStore();
  const pending = await createPending(store);
  let reportStarted: (() => void) | undefined;
  let finishModel: ((response: ModelResponse) => void) | undefined;
  const started = new Promise<void>((resolve) => { reportStarted = resolve; });
  const response = new Promise<ModelResponse>((resolve) => { finishModel = resolve; });
  const running = processTaskRun({
    taskRunId: pending.taskRunId,
    workerId: "worker-1",
    heartbeatIntervalMs: 10_000,
    store,
    createRuntime: async (execution, onTrace) => new AgentRuntime({
      provider: { async generate() { reportStarted?.(); return response; } },
      tools,
      toolPolicies: execution.agent.toolPolicies,
      systemInstructions: execution.agent.systemInstructions,
      maxSteps: execution.agent.maxSteps,
      onTrace,
    }),
  });
  await started;
  assert.deepEqual(store.runs.get(pending.taskRunId)?.steps.map((step) => step.kind), ["MODEL_CALL"]);
  finishModel?.({ type: "final", content: "done" });
  assert.equal((await running).status, "completed");
});

test("worker persists runtime failure as FAILED", async () => {
  const store = new MemoryExecutionStore();
  const pending = await createPending(store);
  const result = await processTaskRun({
    taskRunId: pending.taskRunId,
    workerId: "worker-1",
    heartbeatIntervalMs: 10_000,
    store,
    createRuntime: runtimeFactory([
      { type: "tool_call", toolCall: { name: "search_files", arguments: { query: "TODO" } } },
    ]),
  });

  const run = store.runs.get(pending.taskRunId);
  assert.equal(result.status, "failed");
  assert.equal(run?.status, "FAILED");
  assert.equal(run?.failureReason, "MAX_STEPS_EXCEEDED");
  assert.equal(run?.steps.at(-1)?.kind, "RUNTIME_FAILURE");
});

test("worker persists a structured sandbox failure", async () => {
  const store = new MemoryExecutionStore();
  const pending = await createPending(store);
  const sandboxTools = new ToolRegistry([
    {
      name: "search_files",
      description: "test sandboxed tool",
      inputSchema: {
        type: "object",
        properties: { query: { type: "string" } },
        required: ["query"],
        additionalProperties: false,
      },
      validate(args) { return args; },
      async execute() {
        throw new SandboxError("SANDBOX_UNAVAILABLE", "Docker daemon is unavailable");
      },
    },
  ]);
  const result = await processTaskRun({
    taskRunId: pending.taskRunId,
    workerId: "worker-sandbox",
    heartbeatIntervalMs: 10_000,
    store,
    createRuntime: async (execution, onTrace) =>
      new AgentRuntime({
        provider: new FakeProvider([
          { type: "tool_call", toolCall: { name: "search_files", arguments: { query: "x" } } },
        ]),
        tools: sandboxTools,
        toolPolicies: execution.agent.toolPolicies,
        systemInstructions: execution.agent.systemInstructions,
        maxSteps: execution.agent.maxSteps,
        onTrace,
      }),
  });
  assert.equal(result.status, "failed");
  assert.equal(store.runs.get(pending.taskRunId)?.failureReason, "SANDBOX_UNAVAILABLE");
  assert.equal(store.runs.get(pending.taskRunId)?.steps.at(-1)?.kind, "RUNTIME_FAILURE");
});

test("worker persists a permission denial and never calls the denied executor", async () => {
  const store = new MemoryExecutionStore();
  const deniedDefinition: AgentDefinition = {
    ...definition,
    version: 4,
    toolPolicies: { search_files: "DENY" },
  };
  const resolved = await store.resolveAgentVersion(deniedDefinition);
  const pending = await store.createPendingExecution(
    resolved.agentId,
    resolved.agentVersionId,
    "search for secrets",
    "/workspace",
  );
  let executions = 0;
  const deniedTools = new ToolRegistry([
    {
      name: "search_files",
      description: "Search",
      inputSchema: {
        type: "object",
        properties: { query: { type: "string" } },
        required: ["query"],
        additionalProperties: false,
      },
      validate(args) {
        return args;
      },
      async execute() {
        executions += 1;
        return { matches: [] };
      },
    },
  ]);

  const result = await processTaskRun({
    taskRunId: pending.taskRunId,
    workerId: "worker-1",
    heartbeatIntervalMs: 10_000,
    store,
    createRuntime: async (execution, onTrace) =>
      new AgentRuntime({
        provider: new FakeProvider([
          {
            type: "tool_call",
            toolCall: { name: "search_files", arguments: { query: "secret" } },
          },
        ]),
        tools: deniedTools,
        toolPolicies: execution.agent.toolPolicies,
        systemInstructions: execution.agent.systemInstructions,
        maxSteps: execution.agent.maxSteps,
        onTrace,
      }),
  });

  const run = store.runs.get(pending.taskRunId);
  assert.equal(result.status, "failed");
  assert.equal(run?.status, "FAILED");
  assert.equal(run?.failureReason, "TOOL_PERMISSION_DENIED");
  assert.equal(run?.steps.at(-1)?.kind, "RUNTIME_FAILURE");
  assert.deepEqual(run?.steps.at(-1)?.payload, {
    executionAttempt: 1,
    runtimeStep: 1,
    reason: "TOOL_PERMISSION_DENIED",
    message: "AgentVersion does not allow tool: search_files",
  });
  assert.equal(executions, 0);
});

async function runUntilApproval(
  store: MemoryExecutionStore,
  executions: { count: number },
) {
  const approvalDefinition: AgentDefinition = {
    ...definition,
    version: 6,
    toolPolicies: { search_files: "REQUIRE_APPROVAL" },
  };
  const resolved = await store.resolveAgentVersion(approvalDefinition);
  const pending = await store.createPendingExecution(
    resolved.agentId,
    resolved.agentVersionId,
    "search after approval",
    "/workspace",
  );
  const approvalTools = new ToolRegistry([
    {
      name: "search_files",
      description: "Search",
      inputSchema: {
        type: "object",
        properties: { query: { type: "string" } },
        required: ["query"],
        additionalProperties: false,
      },
      validate(args) {
        return args;
      },
      async execute(args) {
        executions.count += 1;
        return { matches: [], exactArguments: args };
      },
    },
  ]);
  const result = await processTaskRun({
    taskRunId: pending.taskRunId,
    workerId: "worker-approval-1",
    heartbeatIntervalMs: 10_000,
    store,
    createRuntime: async (execution, onTrace) =>
      new AgentRuntime({
        provider: new FakeProvider([
          {
            type: "tool_call",
            toolCall: { name: "search_files", arguments: { query: "exact" } },
          },
        ]),
        tools: approvalTools,
        toolPolicies: execution.agent.toolPolicies,
        systemInstructions: execution.agent.systemInstructions,
        maxSteps: execution.agent.maxSteps,
        onTrace,
      }),
  });
  assert.equal(result.status, "waiting_for_approval");
  const approval = [...store.approvals.values()].at(-1);
  if (!approval) throw new Error("Approval was not created");
  return { pending, approval, approvalTools };
}

test("approval persists the exact action, waits without a lease, and approved resume executes once", async () => {
  const store = new MemoryExecutionStore();
  const queue = new FakeQueue();
  const executions = { count: 0 };
  const { pending, approval, approvalTools } = await runUntilApproval(store, executions);
  const waiting = store.runs.get(pending.taskRunId);
  assert.equal(waiting?.status, "WAITING_FOR_APPROVAL");
  assert.equal(waiting?.workerId, null);
  assert.equal(waiting?.heartbeatAt, null);
  assert.equal(executions.count, 0);
  assert.equal(approval.toolName, "search_files");
  assert.deepEqual(approval.validatedArguments, { query: "exact" });
  assert.equal(waiting?.steps.at(-1)?.kind, "APPROVAL_REQUIRED");

  const decided = await decideApprovalAndEnqueue({
    store,
    queue,
    approvalId: approval.id,
    decision: "APPROVED",
  });
  assert.equal(decided.taskRunId, pending.taskRunId);
  assert.deepEqual(queue.payloads, [{ taskRunId: pending.taskRunId }]);
  assert.equal(store.runs.get(pending.taskRunId)?.steps.at(-1)?.kind, "APPROVAL_APPROVED");
  await assert.rejects(() => store.decideApproval(approval.id, "APPROVED"), /already decided/);

  const result = await processTaskRun({
    taskRunId: pending.taskRunId,
    workerId: "worker-approval-2",
    heartbeatIntervalMs: 10_000,
    store,
    createRuntime: async (execution, onTrace) =>
      new AgentRuntime({
        provider: new FakeProvider([{ type: "final", content: "approved action completed" }]),
        tools: approvalTools,
        toolPolicies: execution.agent.toolPolicies,
        systemInstructions: execution.agent.systemInstructions,
        maxSteps: execution.agent.maxSteps,
        onTrace,
        claimApprovalAction: (approvalId) =>
          store.claimApprovalAction(execution.taskRunId, "worker-approval-2", approvalId, new Date()),
      }),
  });
  assert.equal(result.status, "completed");
  assert.equal(executions.count, 1);
  assert.equal(store.runs.get(pending.taskRunId)?.status, "COMPLETED");
  assert.ok(store.runs.get(pending.taskRunId)?.steps.some((step) => step.kind === "TOOL_RESULT"));
});

test("denied approval never executes and feeds a deterministic denial result to the model", async () => {
  const store = new MemoryExecutionStore();
  const executions = { count: 0 };
  const { pending, approval, approvalTools } = await runUntilApproval(store, executions);
  await store.decideApproval(approval.id, "DENIED");

  const result = await processTaskRun({
    taskRunId: pending.taskRunId,
    workerId: "worker-denied",
    heartbeatIntervalMs: 10_000,
    store,
    createRuntime: async (execution, onTrace) =>
      new AgentRuntime({
        provider: new FakeProvider([{ type: "final", content: "The action was denied." }]),
        tools: approvalTools,
        toolPolicies: execution.agent.toolPolicies,
        systemInstructions: execution.agent.systemInstructions,
        maxSteps: execution.agent.maxSteps,
        onTrace,
        claimApprovalAction: (approvalId) =>
          store.claimApprovalAction(execution.taskRunId, "worker-denied", approvalId, new Date()),
      }),
  });
  assert.equal(result.status, "completed");
  assert.equal(executions.count, 0);
  assert.equal(store.runs.get(pending.taskRunId)?.steps.at(-3)?.kind, "TOOL_RESULT");
});

test("waiting runs are not stale and an old worker cannot claim an approved action", async () => {
  const store = new MemoryExecutionStore();
  const executions = { count: 0 };
  const { pending, approval } = await runUntilApproval(store, executions);
  const stale = await store.findStaleExecutions(new Date(Date.now() + 60_000));
  assert.deepEqual(stale, []);
  await store.decideApproval(approval.id, "APPROVED");
  const loaded = await store.loadExecution(pending.taskRunId);
  await store.claimExecution(loaded.taskId, loaded.taskRunId, "new-worker", new Date());
  await assert.rejects(
    () => store.claimApprovalAction(pending.taskRunId, "old-worker", approval.id, new Date()),
    /Lease lost/,
  );
  assert.equal(executions.count, 0);
});

test("an active heartbeat keeps a RUNNING run healthy", async () => {
  const store = new MemoryExecutionStore();
  const queue = new FakeQueue();
  const pending = await createPending(store);
  const now = new Date("2026-09-29T12:00:00.000Z");
  await store.claimExecution(pending.taskId, pending.taskRunId, "worker-1", now);
  await store.heartbeat(pending.taskRunId, "worker-1", now);

  const summary = await recoverStaleRuns({
    store,
    queue,
    now,
    leaseTimeoutMs: 30_000,
    maxRecoveries: 2,
  });

  assert.equal(summary.requeued, 0);
  assert.equal(store.runs.get(pending.taskRunId)?.status, "RUNNING");
  assert.deepEqual(queue.payloads, []);
});

test("a stale heartbeat is detected and the run is requeued", async () => {
  const store = new MemoryExecutionStore();
  const queue = new FakeQueue();
  const pending = await createPending(store);
  const staleHeartbeat = new Date("2026-09-29T11:58:00.000Z");
  const now = new Date("2026-09-29T12:00:00.000Z");
  await store.claimExecution(pending.taskId, pending.taskRunId, "dead-worker", staleHeartbeat);

  const stale = await store.findStaleExecutions(new Date(now.getTime() - 30_000));
  assert.deepEqual(stale.map((run) => run.taskRunId), [pending.taskRunId]);

  const summary = await recoverStaleRuns({
    store,
    queue,
    now,
    leaseTimeoutMs: 30_000,
    maxRecoveries: 2,
  });

  const run = store.runs.get(pending.taskRunId);
  assert.equal(summary.requeued, 1);
  assert.equal(run?.status, "PENDING");
  assert.equal(run?.recoveryCount, 1);
  assert.equal(run?.workerId, null);
  assert.deepEqual(queue.payloads, [{ taskRunId: pending.taskRunId }]);
});

test("the recovery limit is enforced", async () => {
  const store = new MemoryExecutionStore();
  const queue = new FakeQueue();
  const pending = await createPending(store);
  await store.claimExecution(
    pending.taskId,
    pending.taskRunId,
    "dead-worker",
    new Date("2026-09-29T11:58:00.000Z"),
  );
  const run = store.runs.get(pending.taskRunId);
  if (!run) throw new Error("Run not found");
  run.recoveryCount = 2;

  const summary = await recoverStaleRuns({
    store,
    queue,
    now: new Date("2026-09-29T12:00:00.000Z"),
    leaseTimeoutMs: 30_000,
    maxRecoveries: 2,
  });

  assert.equal(summary.failedLimit, 1);
  assert.equal(run.status, "FAILED");
  assert.equal(run.failureReason, "RECOVERY_LIMIT_EXCEEDED");
  assert.deepEqual(queue.payloads, []);
});

test("a completed run is never recovered", async () => {
  const store = new MemoryExecutionStore();
  const queue = new FakeQueue();
  const pending = await createPending(store);
  const old = new Date("2026-09-29T11:58:00.000Z");
  await store.claimExecution(pending.taskId, pending.taskRunId, "worker-1", old);
  await store.finishExecution(pending.taskId, pending.taskRunId, "worker-1", {
    status: "completed",
    answer: "done",
    steps: 1,
  });

  const summary = await recoverStaleRuns({
    store,
    queue,
    now: new Date("2026-09-29T12:00:00.000Z"),
    leaseTimeoutMs: 30_000,
    maxRecoveries: 2,
  });

  assert.equal(summary.requeued, 0);
  assert.equal(store.runs.get(pending.taskRunId)?.status, "COMPLETED");
  assert.deepEqual(queue.payloads, []);
});
