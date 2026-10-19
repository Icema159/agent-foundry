import assert from "node:assert/strict";
import test from "node:test";
import { once } from "node:events";
import { createDashboardServer } from "../src/dashboard/server.js";
import type { RunDetails } from "../src/observability/run-query.js";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { RunDetail, Approvals } from "../dashboard/views.js";

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
