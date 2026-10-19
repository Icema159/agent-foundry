import assert from "node:assert/strict";
import test from "node:test";
import { PrismaExecutionStore } from "../src/persistence/prisma-execution-store.js";

test("Prisma loader restores correction marker, tool evidence and prior denial across approval resume", async () => {
  const history = [
    { kind: "POSTCONDITION_CHECK", payload: { correctionAttempt: 1, correctionOutcome: "STARTED" } },
    { kind: "POSTCONDITION_CHECK", payload: { passed: false } },
    { kind: "TOOL_CALL", payload: { executionAttempt: 1, runtimeStep: 2, toolCall: { name: "create_file" } } },
    { kind: "TOOL_RESULT", payload: { executionAttempt: 1, runtimeStep: 1, name: "read_file", readOnly: true, result: { content: "evidence" } } },
  ];
  const prisma = {
    taskRun: { async findUnique() { return {
      id: "same-run", taskId: "same-task", status: "PENDING", recoveryCount: 0,
      task: { workspaceRoot: "/workspace", prompt: "Create note.md", postconditions: [{ type: "file_created", path: "note.md" }] },
      agentVersion: { agent: { name: "explorer", description: "test" }, version: 6,
        systemInstructions: "test", modelProvider: "fake", modelName: "fake", maxSteps: 8,
        toolPolicies: { create_file: "REQUIRE_APPROVAL" } },
      steps: [{ sequence: 9 }],
      approvals: [{ id: "approved-action", status: "APPROVED", toolName: "create_file",
        validatedArguments: { path: "note.md", content: "exact" }, runtimeStep: 3,
        resumeMessages: [{ role: "system", content: "test" }, { role: "user", content: "Create note.md" },
          { role: "assistant", content: "Done" }, { role: "user", content: '{"code":"POSTCONDITION_UNMET"}' },
          { role: "assistant", content: "", toolCall: { name: "create_file", arguments: { path: "note.md", content: "exact" } } }],
      }],
    }; } },
    step: { async findMany(args: unknown) {
      assert.deepEqual(args, { where: { taskRunId: "same-run", kind: { in: ["TOOL_RESULT", "TOOL_CALL", "POSTCONDITION_CHECK"] } }, select: { kind: true, payload: true } });
      return history;
    } },
    approval: { async count(args: unknown) {
      assert.deepEqual(args, { where: { taskRunId: "same-run", status: "DENIED" } });
      return 1;
    } },
  };
  const store = new PrismaExecutionStore(prisma as unknown as ConstructorParameters<typeof PrismaExecutionStore>[0]);
  const execution = await store.loadExecution("same-run");
  assert.equal(execution.taskRunId, "same-run");
  assert.equal(execution.correctionAttempted, true);
  assert.equal(execution.hadDeniedApproval, true);
  assert.deepEqual(execution.priorToolResults, [history[3]!.payload]);
  assert.deepEqual(execution.priorToolCalls, [history[2]!.payload]);
  assert.equal(execution.nextStepSequence, 10);
  assert.equal(execution.approvalResume?.runtimeStep, 3);
  assert.match(execution.approvalResume!.resumeMessages[3]!.content, /POSTCONDITION_UNMET/);
});
