import type { RunDetails } from "../observability/run-query.js";
import type { EvalAssertion, EvalCase } from "./cases.js";

export type EvalOutcome = "PASSED" | "ASSERTION_FAILED" | "EXECUTION_FAILED" | "TIMED_OUT" | "INFRASTRUCTURE_FAILED";
export type EvalMetrics = {
  taskRunStatus: string;
  totalDurationMs: number | null;
  executionDurationMs: number | null;
  modelCallCount: number;
  toolCallCount: number;
  recoveryCount: number;
  failureCode: string | null;
  tokens: { input: number | null; output: number | null; total: number | null };
  callsWithUsage: number;
};
export type AssertionResult = { assertion: EvalAssertion; result: "PASS" | "FAIL"; actual: string };
export type EvalResult = {
  outcome: EvalOutcome;
  assertions: AssertionResult[];
  passedAssertions: number;
  totalAssertions: number;
  successRate: number | null;
  metrics: EvalMetrics | null;
  message: string | null;
};

export function extractMetrics(run: RunDetails): EvalMetrics {
  const calls = run.timeline.filter(event => event.type === "MODEL_CALL");
  const tokenSum = (field: "inputTokens" | "outputTokens" | "totalTokens") => {
    if (calls.length === 0 || calls.some(call => call.usage?.[field] === undefined)) return null;
    return calls.reduce((sum, call) => sum + call.usage![field]!, 0);
  };
  return {
    taskRunStatus: run.status,
    totalDurationMs: run.totalDurationMs,
    executionDurationMs: run.executionDurationMs,
    modelCallCount: calls.length,
    toolCallCount: run.timeline.filter(event => event.type === "TOOL_CALL").length,
    recoveryCount: run.recoveryCount,
    failureCode: run.failure?.code ?? null,
    tokens: { input: tokenSum("inputTokens"), output: tokenSum("outputTokens"), total: tokenSum("totalTokens") },
    callsWithUsage: calls.filter(call => call.usage !== undefined).length,
  };
}

export function scoreEval(evalCase: EvalCase, run: RunDetails): EvalResult {
  if (!["COMPLETED", "FAILED"].includes(run.status)) throw new Error(`Cannot score non-terminal TaskRun: ${run.status}`);
  const metrics = extractMetrics(run);
  const assertions = evalCase.assertions.map(assertion => check(assertion, run, metrics));
  const passedAssertions = assertions.filter(item => item.result === "PASS").length;
  return {
    outcome: run.status === "FAILED" ? "EXECUTION_FAILED" : passedAssertions === assertions.length ? "PASSED" : "ASSERTION_FAILED",
    assertions, passedAssertions, totalAssertions: assertions.length,
    successRate: passedAssertions / assertions.length,
    metrics, message: run.failure?.message ?? null,
  };
}

export function incompleteResult(evalCase: EvalCase, outcome: "TIMED_OUT" | "INFRASTRUCTURE_FAILED", message: string, run: RunDetails | null): EvalResult {
  return { outcome, message, assertions: [], passedAssertions: 0, totalAssertions: evalCase.assertions.length, successRate: null, metrics: run ? extractMetrics(run) : null };
}

function check(assertion: EvalAssertion, run: RunDetails, metrics: EvalMetrics): AssertionResult {
  let pass: boolean;
  let actual: string;
  switch (assertion.type) {
    case "completed": pass = run.status === "COMPLETED"; actual = run.status; break;
    case "answer_contains":
      pass = (run.finalAnswer ?? "").toLowerCase().includes(assertion.text.toLowerCase());
      actual = pass ? `Found: ${assertion.text}` : `Missing: ${assertion.text}`;
      break;
    case "tool_calls": {
      const count = run.timeline.filter(event => event.type === "TOOL_CALL" && event.toolName === assertion.tool).length;
      pass = count >= (assertion.min ?? 0) && count <= (assertion.max ?? Infinity);
      actual = `${assertion.tool}: ${count} calls`; break;
    }
    case "no_runtime_failure": {
      const failures = run.timeline.filter(event => event.type === "RUNTIME_FAILURE").length;
      pass = run.status !== "FAILED" && failures === 0;
      actual = `${failures} failure events; status ${run.status}`; break;
    }
    case "max_model_calls": pass = metrics.modelCallCount <= assertion.count; actual = `${metrics.modelCallCount} model calls`; break;
    case "max_duration_ms":
      pass = metrics.totalDurationMs !== null && metrics.totalDurationMs <= assertion.milliseconds;
      actual = metrics.totalDurationMs === null ? "Duration unavailable" : `${metrics.totalDurationMs} ms (submission to completion)`;
      break;
  }
  return { assertion, result: pass ? "PASS" : "FAIL", actual };
}
