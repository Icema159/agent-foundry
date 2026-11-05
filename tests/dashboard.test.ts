import assert from "node:assert/strict";
import test from "node:test";
import { once } from "node:events";
import { createDashboardServer } from "../src/dashboard/server.js";
import { RunQueryService, type RunDetails, type RunRecord } from "../src/observability/run-query.js";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { RunDetail, Approvals, FinalAnswer } from "../dashboard/views.js";
import { copyAnswer } from "../dashboard/copy-answer.js";

const run: RunDetails = {
  id: "run-1", taskId: "task-1", status: "COMPLETED", agent: "explorer", agentVersion: 3,
  provider: "openai", model: "gpt-test", createdAt: "2026-10-06T10:00:00Z", startedAt: null, completedAt: null,
  prompt: "Find TODOs", recoveryCount: 0, workerId: null, heartbeatAt: null, totalDurationMs: null,
  executionDurationMs: null, finalAnswer: "Real persisted answer <script>", failure: null, approvals: [],
  timeline: [{ sequence: 1, executionAttempt: 1, runtimeStep: 1, timestamp: "2026-10-06T10:00:00Z", type: "MODEL_CALL" }],
};

test("dashboard API delegates reads and approval decisions, handles missing and invalid IDs", async context => {
  const decisions: unknown[] = [];
  const server = createDashboardServer({
    runs: { async listRecent() { return [run]; }, async get(id) { return id === "run-1" ? run : id === "failed" ? { ...run, status: "FAILED", finalAnswer: null, failure: { code: "SANDBOX_TIMEOUT", message: "Timed out" } } : null; } },
    async listApprovals() { return [{ id: "approval-1", taskRunId: "run-1", toolName: "create_file", validatedArguments: { path: "demo.txt" }, requestedAt: new Date() }]; },
    async decideApproval(id, decision) { if (id === "missing") throw new Error("Approval not found: missing"); if (id === "used") throw new Error("Approval was already decided"); decisions.push({ id, decision }); return { taskRunId: "run-1", jobId: "job-1" }; },
  }, "/unused");
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  context.after(() => { server.closeAllConnections(); server.close(); });
  const address = server.address(); assert.ok(address && typeof address !== "string");
  const base = `http://127.0.0.1:${address.port}`;
  assert.equal((await (await fetch(`${base}/api/runs`)).json()).length, 1);
  assert.equal((await (await fetch(`${base}/api/runs/run-1`)).json()).finalAnswer, run.finalAnswer);
  assert.equal((await (await fetch(`${base}/api/runs/failed`)).json()).failure.code, "SANDBOX_TIMEOUT");
  assert.equal((await fetch(`${base}/api/runs/missing`)).status, 404);
  assert.equal((await fetch(`${base}/api/runs/%20`)).status, 400);
  assert.equal((await (await fetch(`${base}/api/approvals`)).json())[0].toolName, "create_file");
  for (const action of ["approve", "deny"]) assert.equal((await fetch(`${base}/api/approvals/approval-1/${action}`, { method: "POST", headers: { "X-Foundry-Dashboard": "1" } })).status, 200);
  assert.deepEqual(decisions, [{ id: "approval-1", decision: "APPROVED" }, { id: "approval-1", decision: "DENIED" }]);
  assert.equal((await fetch(`${base}/api/approvals/missing/approve`, { method: "POST", headers: { "X-Foundry-Dashboard": "1" } })).status, 404);
  assert.equal((await fetch(`${base}/api/approvals/used/approve`, { method: "POST", headers: { "X-Foundry-Dashboard": "1" } })).status, 409);
  assert.equal((await fetch(`${base}/api/approvals/approval-1/approve`, { method: "POST" })).status, 403);
  assert.equal((await fetch(`${base}/api/approvals/approval-1/approve`, { method: "POST", headers: { "X-Foundry-Dashboard": "1", Origin: "https://other.example" } })).status, 403);
});

test("React details render persisted answer, timeline and failures as escaped text", () => {
  const html = renderToStaticMarkup(createElement(RunDetail, { run }));
  assert.match(html, /Real persisted answer &lt;script&gt;/);
  assert.match(html, /MODEL_CALL/); assert.match(html, /Attempt 1/);
  const failure = renderToStaticMarkup(createElement(RunDetail, { run: { ...run, status: "FAILED", finalAnswer: null, failure: { code: "SANDBOX_TIMEOUT", message: "Timed out" } } }));
  assert.match(failure, /SANDBOX_TIMEOUT/);
  const approval = renderToStaticMarkup(createElement(Approvals, { approvals: [{ id: "a1", taskRunId: "r1", toolName: "create_file", validatedArguments: { content: "<script>" }, requestedAt: run.createdAt }], busy: null, decide() {}, open() {} }));
  assert.match(approval, /Approve/); assert.match(approval, /Deny/); assert.match(approval, /&lt;script&gt;/);
});

test("answer copy preserves exact text and handles empty answers, unavailable clipboard and rejected writes", async () => {
  const text = "  # Exact answer\n\n<hello>\n  ";
  const copied: string[] = [];
  const clipboard = { async writeText(value: string) { copied.push(value); } };
  assert.equal(await copyAnswer(text, clipboard), "copied");
  assert.deepEqual(copied, [text]);
  for (const answer of [null, "", "  \n"]) assert.equal(await copyAnswer(answer, clipboard), "empty");
  assert.deepEqual(copied, [text]);
  assert.equal(await copyAnswer(text), "unavailable");
  assert.equal(await copyAnswer(text, { async writeText() { throw new Error("Permission denied"); } }), "failed");
});

test("final answer copy control is accessible, hides missing answers and disables empty answers", () => {
  assert.equal(renderToStaticMarkup(createElement(FinalAnswer, { answer: null })), "");
  for (const answer of ["", " \n"]) {
    const html = renderToStaticMarkup(createElement(FinalAnswer, { answer }));
    assert.match(html, /aria-label="Copy final answer" disabled/);
    assert.match(html, /No final answer text available/);
  }
  const html = renderToStaticMarkup(createElement(FinalAnswer, { answer: "  # Markdown\n\nExact text  " }));
  assert.match(html, /role="status"/);
  assert.match(html, /  # Markdown\n\nExact text  /);
  assert.doesNotMatch(html, /disabled/);
});

test("dashboard renders structured R2 metrics, omits missing metrics and leaves normal timelines alone", () => {
  const html = renderToStaticMarkup(createElement(RunDetail, { run: { ...run, timeline: [
    { ...run.timeline[0]!, type: "RUNTIME_FAILURE", failureCode: "CONTEXT_BUDGET_EXCEEDED", contextBudget: {
      contextWindowTokens: 16384, estimatedInputTokens: 14001, inputBudgetTokens: 13312, reservedOutputTokens: 2048, safetyMarginTokens: 1024,
    } },
    { ...run.timeline[0]!, sequence: 2, type: "TOOL_RESULT", toolName: "read_file", failureCode: "TOOL_RESULT_TOO_LARGE", toolResultLimit: { code: "TOOL_RESULT_TOO_LARGE", resultBytes: 19001, limitBytes: 8000 } },
  ] } }));
  for (const text of ["CONTEXT_BUDGET_EXCEEDED", "TOOL_RESULT_TOO_LARGE", "Context window (tokens)", "Estimated request (tokens)", "Available input budget (tokens)", "Reserved output (tokens)", "Safety margin (tokens)", "Actual result size (bytes)", "Maximum result size (bytes)", "16384", "14001", "13312", "2048", "1024", "19001", "8000", "read_file"]) assert.ok(html.includes(text), text);
  const partial = renderToStaticMarkup(createElement(RunDetail, { run: { ...run, timeline: [
    { ...run.timeline[0]!, contextBudget: { inputBudgetTokens: 0 } },
  ] } }));
  assert.match(partial, /Available input budget \(tokens\)/);
  assert.doesNotMatch(partial, /Context window \(tokens\)|16384|undefined|NaN/);
  const normal = renderToStaticMarkup(createElement(RunDetail, { run }));
  assert.doesNotMatch(normal, /Context budget diagnostics|Tool result limit diagnostics/);
});

test("persisted R2 fixtures reach HTTP run details without leaking raw context or tool output", async context => {
  const at = new Date(run.createdAt);
  const record: RunRecord = {
    ...run, createdAt: at, startedAt: null, completedAt: null, heartbeatAt: null, approvals: [],
    agentName: run.agent, failureReason: "CONTEXT_BUDGET_EXCEEDED", failureMessage: "Budget exceeded",
    steps: [
      { sequence: 1, kind: "MODEL_CALL", createdAt: at, payload: { request: { messages: ["PRIVATE_MODEL_CONTEXT"] } } },
      { sequence: 2, kind: "TOOL_RESULT", createdAt: at, payload: { name: "read_file", result: { content: "PRIVATE_TOOL_OUTPUT" }, outputLimit: { code: "TOOL_RESULT_TOO_LARGE", resultBytes: 10001, limitBytes: 8000 } } },
      { sequence: 3, kind: "RUNTIME_FAILURE", createdAt: at, payload: { reason: "CONTEXT_BUDGET_EXCEEDED", details: { contextWindowTokens: 16384, estimatedInputTokens: 15000, inputBudgetTokens: 13312, reservedOutputTokens: 2048, safetyMarginTokens: 1024, secret: "PRIVATE_DETAIL" } } },
    ],
  };
  const server = createDashboardServer({
    runs: new RunQueryService({ async listRecent() { return [record]; }, async findById() { return record; } }),
    async listApprovals() { return []; }, async decideApproval() { throw new Error("Not used"); },
  }, "/unused");
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  context.after(() => { server.closeAllConnections(); server.close(); });
  const address = server.address(); assert.ok(address && typeof address !== "string");
  const response = await fetch(`http://127.0.0.1:${address.port}/api/runs/run-1`);
  assert.equal(response.status, 200);
  const body = await response.json() as RunDetails;
  assert.deepEqual(body.timeline[1]!.toolResultLimit, { code: "TOOL_RESULT_TOO_LARGE", resultBytes: 10001, limitBytes: 8000 });
  assert.deepEqual(body.timeline[2]!.contextBudget, { contextWindowTokens: 16384, estimatedInputTokens: 15000, inputBudgetTokens: 13312, reservedOutputTokens: 2048, safetyMarginTokens: 1024 });
  assert.doesNotMatch(JSON.stringify(body), /PRIVATE_/);
  assert.match(renderToStaticMarkup(createElement(RunDetail, { run: body })), /Tool result limit diagnostics/);
});

test("long run timelines retain every event and render alongside the answer copy control", () => {
  const timeline = Array.from({ length: 300 }, (_, index) => ({ ...run.timeline[0]!, sequence: index + 1, runtimeStep: index + 1 }));
  const html = renderToStaticMarkup(createElement(RunDetail, { run: { ...run, timeline } }));
  assert.equal((html.match(/class="event-number"/g) ?? []).length, 300);
  assert.match(html, /300 events/);
  assert.match(html, /Runtime step 300/);
  assert.match(html, /aria-label="Copy final answer"/);
});
