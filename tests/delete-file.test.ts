import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { RepositoryTools } from "../src/tools/repository-tools.js";
import { AgentRuntime } from "../src/runtime/agent-runtime.js";
import type { ModelProvider, ModelResponse } from "../src/model/types.js";
import { isReadOnlyRepositoryRun } from "../src/recovery/recover-stale-runs.js";
import { TaskPostconditionVerifier } from "../src/verification/task-postconditions.js";
import { parseTaskInput } from "../src/cli/task-input.js";

class Provider implements ModelProvider {
  constructor(private response: ModelResponse) {}
  async generate() { return this.response; }
}

test("delete_file rejects directories, symlinks, escapes and missing files before invoking sandbox", async t => {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), "foundry-delete-paths-"));
  t.after(() => fs.rm(parent, { recursive: true, force: true }));
  const root = path.join(parent, "workspace");
  await fs.mkdir(root);
  await fs.writeFile(path.join(parent, "outside.txt"), "outside");
  await fs.writeFile(path.join(root, "safe.txt"), "safe");
  await fs.mkdir(path.join(root, "directory"));
  await fs.symlink(parent, path.join(root, "escape"));
  await fs.symlink(path.join(root, "safe.txt"), path.join(root, "link"));
  let calls = 0;
  const tools = await RepositoryTools.create(root, { sandbox: { async execute(request) {
    calls += 1; assert.equal(request.toolName, "delete_file");
    return { path: "safe.txt", deleted: true };
  } } });
  for (const file of [".", "../outside.txt", path.join(parent, "outside.txt"), "directory", "link", "escape/outside.txt", "missing.txt"]) {
    await assert.rejects(tools.execute("delete_file", { path: file }));
  }
  await assert.rejects(tools.execute("delete_file", { path: "safe.txt", recursive: true }));
  assert.equal(calls, 0);
  assert.deepEqual(await tools.execute("delete_file", { path: "safe.txt" }), { path: "safe.txt", deleted: true });
  assert.equal(calls, 1);
  assert.equal(await fs.readFile(path.join(parent, "outside.txt"), "utf8"), "outside");
});

for (const decision of ["APPROVED", "DENIED"] as const) {
  test(`delete_file ${decision} approval controls sandbox execution and deletion verification`, async t => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "foundry-delete-approval-"));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    await fs.writeFile(path.join(root, "demo.txt"), "Delete test fixture");
    let calls = 0;
    const tools = await RepositoryTools.create(root, { sandbox: { async execute(request) {
      calls += 1; assert.deepEqual(request.arguments, { path: "demo.txt" });
      await fs.unlink(path.join(root, "demo.txt")); return { path: "demo.txt", deleted: true };
    } } });
    const options = { tools, toolPolicies: { delete_file: "REQUIRE_APPROVAL" as const }, systemInstructions: "test", maxSteps: 2 };
    const waiting = await new AgentRuntime({ ...options, provider: new Provider({ type: "tool_call", toolCall: { name: "delete_file", arguments: { path: "demo.txt" } } }) }).run("Delete demo.txt");
    assert.equal(waiting.status, "waiting_for_approval");
    assert.equal(calls, 0);
    assert.equal(await fs.readFile(path.join(root, "demo.txt"), "utf8"), "Delete test fixture");
    if (waiting.status !== "waiting_for_approval") throw new Error("Expected approval");
    const results: unknown[] = [];
    await new AgentRuntime({ ...options, provider: new Provider({ type: "final", content: "Finished" }),
      claimApprovalAction: async () => {},
      onTrace(event) { if (event.type === "tool_result") results.push(event); },
    }).run("Delete demo.txt", { ...waiting.action, approvalId: "approval-delete", decision });
    assert.equal(calls, decision === "APPROVED" ? 1 : 0);
    const checks = await new TaskPostconditionVerifier().verify(root, [{ type: "file_deleted", path: "demo.txt" }], results);
    assert.equal(checks[0]?.passed, decision === "APPROVED");
  });
}

test("DENY rejects delete_file without sandbox execution", async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "foundry-delete-denied-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  let calls = 0;
  const tools = await RepositoryTools.create(root, { sandbox: { async execute() { calls += 1; return {}; } } });
  const result = await new AgentRuntime({ tools, provider: new Provider({ type: "tool_call", toolCall: { name: "delete_file", arguments: { path: "demo.txt" } } }),
    toolPolicies: { delete_file: "DENY" }, systemInstructions: "test", maxSteps: 2,
  }).run("Delete demo.txt");
  assert.equal(result.status, "failed");
  if (result.status === "failed") assert.equal(result.reason, "TOOL_PERMISSION_DENIED");
  assert.equal(calls, 0);
});

test("a missing file without a successful delete result does not satisfy deletion", async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "foundry-delete-proof-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const verifier = new TaskPostconditionVerifier();
  assert.equal((await verifier.verify(root, [{ type: "file_deleted", path: "missing.txt" }], []))[0]?.passed, false);
  assert.deepEqual(parseTaskInput(["--expect-deleted-file", "./demo.txt", "Delete demo.txt"]), {
    prompt: "Delete demo.txt", postconditions: [{ type: "file_deleted", path: "demo.txt" }],
  });
});

test("delete-capable runs do not use whole-run automatic recovery", () => {
  assert.equal(isReadOnlyRepositoryRun({ taskId: "task", taskRunId: "run", recoveryCount: 0, agentName: "repository-explorer",
    toolPolicies: { read_file: "ALLOW", delete_file: "REQUIRE_APPROVAL" },
  }), false);
});
