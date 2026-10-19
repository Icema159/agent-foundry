import assert from "node:assert/strict";
import test from "node:test";
import type { ModelProvider, ModelRequest, ModelResponse } from "../src/model/types.js";
import { AgentRuntime } from "../src/runtime/agent-runtime.js";
import { RepositoryTools } from "../src/tools/repository-tools.js";
import {
  ToolInputError,
  ToolRegistry,
  type RegisteredTool,
} from "../src/tools/tool-registry.js";
import { SandboxError, type Sandbox, type SandboxRequest } from "../src/sandbox/sandbox.js";

class FakeProvider implements ModelProvider {
  private index = 0;
  constructor(private readonly responses: ModelResponse[]) {}
  async generate(_request: ModelRequest): Promise<ModelResponse> {
    const response = this.responses[Math.min(this.index, this.responses.length - 1)];
    this.index += 1;
    if (!response) throw new Error("Fake provider has no response");
    return response;
  }
}

function fakeTool(execute = async () => ({ content: "ok" })): RegisteredTool {
  return {
    name: "read_file",
    description: "test",
    inputSchema: {
      type: "object",
      properties: { path: { type: "string" } },
      required: ["path"],
      additionalProperties: false,
    },
    validate(args: unknown) {
      if (
        typeof args !== "object" ||
        args === null ||
        Array.isArray(args) ||
        typeof (args as Record<string, unknown>).path !== "string"
      ) {
        throw new ToolInputError("path must be a string");
      }
      return args;
    },
    execute,
  };
}

function runtime(
  responses: ModelResponse[],
  maxSteps = 3,
  tools = new ToolRegistry([fakeTool()]),
  toolPolicies: Record<string, "ALLOW" | "DENY" | "REQUIRE_APPROVAL"> = { read_file: "ALLOW" },
): AgentRuntime {
  return new AgentRuntime({
    provider: new FakeProvider(responses),
    tools,
    toolPolicies,
    systemInstructions: "test",
    maxSteps,
  });
}

test("rejects an unknown tool", async () => {
  const result = await runtime([
    { type: "tool_call", toolCall: { name: "delete_file", arguments: {} } },
  ]).run("task");
  assert.equal(result.status, "failed");
  if (result.status === "failed") assert.equal(result.reason, "UNKNOWN_TOOL");
});

test("rejects invalid tool arguments", async () => {
  const result = await runtime([
    { type: "tool_call", toolCall: { name: "read_file", arguments: {} } },
  ]).run("task");
  assert.equal(result.status, "failed");
  if (result.status === "failed") assert.equal(result.reason, "INVALID_TOOL_ARGUMENTS");
});

test("an allowed registered tool executes normally", async () => {
  let executions = 0;
  const tools = new ToolRegistry([
    fakeTool(async () => {
      executions += 1;
      return { content: "ok" };
    }),
  ]);
  const result = await runtime(
    [
      { type: "tool_call", toolCall: { name: "read_file", arguments: { path: "README.md" } } },
      { type: "final", content: "done" },
    ],
    2,
    tools,
    { read_file: "ALLOW" },
  ).run("task");

  assert.equal(result.status, "completed");
  assert.equal(executions, 1);
});

test("a registered but disallowed tool is rejected without executing it", async () => {
  let executions = 0;
  const tools = new ToolRegistry([
    fakeTool(async () => {
      executions += 1;
      return { content: "should not happen" };
    }),
  ]);
  const result = await runtime(
    [{ type: "tool_call", toolCall: { name: "read_file", arguments: { path: "README.md" } } }],
    1,
    tools,
    { read_file: "DENY" },
  ).run("task");

  assert.equal(result.status, "failed");
  if (result.status === "failed") assert.equal(result.reason, "TOOL_PERMISSION_DENIED");
  assert.equal(executions, 0);
});

test("a tool requiring approval returns the exact action without executing it", async () => {
  let executions = 0;
  const tools = new ToolRegistry([
    fakeTool(async () => {
      executions += 1;
      return { content: "should not happen" };
    }),
  ]);
  const result = await runtime(
    [{ type: "tool_call", toolCall: { name: "read_file", arguments: { path: "README.md" } } }],
    2,
    tools,
    { read_file: "REQUIRE_APPROVAL" },
  ).run("task");

  assert.equal(result.status, "waiting_for_approval");
  if (result.status === "waiting_for_approval") {
    assert.equal(result.action.toolName, "read_file");
    assert.deepEqual(result.action.validatedArguments, { path: "README.md" });
    assert.equal(result.action.runtimeStep, 1);
    assert.deepEqual(result.action.resumeMessages.at(-1), {
      role: "assistant",
      content: "",
      toolCall: { name: "read_file", arguments: { path: "README.md" } },
    });
  }
  assert.equal(executions, 0);
});

test("maxSteps stops a looping agent", async () => {
  const result = await runtime(
    [{ type: "tool_call", toolCall: { name: "read_file", arguments: { path: "README.md" } } }],
    2,
  ).run("task");
  assert.deepEqual(result, {
    status: "failed",
    reason: "MAX_STEPS_EXCEEDED",
    message: "Agent did not produce a final answer within 2 steps",
    steps: 2,
  });
});

test("runtime returns a final answer", async () => {
  const result = await runtime([{ type: "final", content: "done" }]).run("task");
  assert.deepEqual(result, { status: "completed", answer: "done", steps: 1 });
});

test("workspace access cannot escape through traversal or a symlink", async (context) => {
  const fs = await import("node:fs/promises");
  const os = await import("node:os");
  const path = await import("node:path");
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), "foundry-tools-"));
  context.after(() => fs.rm(parent, { recursive: true, force: true }));
  const root = path.join(parent, "workspace");
  await fs.mkdir(root);
  await fs.writeFile(path.join(parent, "secret.txt"), "secret", "utf8");
  await fs.symlink(path.join(parent, "secret.txt"), path.join(root, "link.txt"));
  const tools = await RepositoryTools.create(root);

  await assert.rejects(
    () => tools.execute("read_file", { path: "../secret.txt" }),
    ToolInputError,
  );
  await assert.rejects(
    () => tools.execute("read_file", { path: "link.txt" }),
    ToolInputError,
  );
});

test("repository search excludes dependency and generated directories", async (context) => {
  const fs = await import("node:fs/promises");
  const os = await import("node:os");
  const path = await import("node:path");
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "foundry-search-"));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, "src"));
  await fs.mkdir(path.join(root, "node_modules"));
  await fs.mkdir(path.join(root, "dist"));
  await fs.mkdir(path.join(root, ".git"));
  await fs.writeFile(path.join(root, "src", "app.ts"), "// TODO: project work\n", "utf8");
  await fs.writeFile(path.join(root, "node_modules", "dependency.js"), "// TODO: dependency\n", "utf8");
  await fs.writeFile(path.join(root, "dist", "app.js"), "// TODO: generated\n", "utf8");
  await fs.writeFile(path.join(root, ".git", "message"), "TODO internal\n", "utf8");
  const tools = await RepositoryTools.create(root);

  const result = await tools.execute("search_files", { query: "TODO" });
  assert.deepEqual(result, {
    matches: [{ path: "src/app.ts", line: 1, text: "// TODO: project work" }],
  });
});

test("create_file stays inside the workspace and never overwrites", async (context) => {
  const fs = await import("node:fs/promises");
  const os = await import("node:os");
  const path = await import("node:path");
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), "foundry-create-"));
  context.after(() => fs.rm(parent, { recursive: true, force: true }));
  const root = path.join(parent, "workspace");
  await fs.mkdir(root);
  await fs.mkdir(path.join(root, "safe"));
  await fs.symlink(parent, path.join(root, "escape"));
  const requests: SandboxRequest[] = [];
  const sandbox: Sandbox = {
    async execute(request) {
      requests.push(structuredClone(request));
      const args = request.arguments as { path: string; content: string };
      const target = path.join(request.workspaceRoot, args.path);
      await fs.writeFile(target, args.content, { encoding: "utf8", flag: "wx" });
      return { path: args.path, created: true };
    },
  };
  const tools = await RepositoryTools.create(root, { sandbox });

  await tools.execute("create_file", { path: "safe/new.txt", content: "approved\n" });
  assert.equal(await fs.readFile(path.join(root, "safe/new.txt"), "utf8"), "approved\n");
  assert.deepEqual(requests[0], {
    toolName: "create_file",
    arguments: { path: "safe/new.txt", content: "approved\n" },
    workspaceRoot: await fs.realpath(root),
  });
  await assert.rejects(
    () => tools.execute("create_file", { path: "safe/new.txt", content: "overwrite" }),
    /already exists/,
  );
  await assert.rejects(
    () => tools.execute("create_file", { path: "../outside.txt", content: "no" }),
    ToolInputError,
  );
  await assert.rejects(
    () => tools.execute("create_file", { path: "escape/outside.txt", content: "no" }),
    ToolInputError,
  );
});

test("approved create_file crosses the sandbox once and its result becomes TOOL_RESULT", async (context) => {
  const fs = await import("node:fs/promises");
  const os = await import("node:os");
  const path = await import("node:path");
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "foundry-sandbox-flow-"));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const requests: SandboxRequest[] = [];
  const tools = await RepositoryTools.create(root, {
    sandbox: {
      async execute(request) {
        requests.push(structuredClone(request));
        return { path: "approved.txt", created: true, isolated: true };
      },
    },
  });
  const traces: Array<{ type: string; result?: unknown }> = [];
  const first = new AgentRuntime({
    provider: new FakeProvider([
      {
        type: "tool_call",
        toolCall: { name: "create_file", arguments: { path: "approved.txt", content: "exact" } },
      },
    ]),
    tools,
    toolPolicies: { create_file: "REQUIRE_APPROVAL" },
    systemInstructions: "test",
    maxSteps: 2,
  });
  const waiting = await first.run("create it");
  assert.equal(waiting.status, "waiting_for_approval");
  assert.equal(requests.length, 0);
  if (waiting.status !== "waiting_for_approval") throw new Error("Expected approval");

  const resumed = new AgentRuntime({
    provider: new FakeProvider([{ type: "final", content: "created" }]),
    tools,
    toolPolicies: { create_file: "REQUIRE_APPROVAL" },
    systemInstructions: "test",
    maxSteps: 2,
    claimApprovalAction: async () => {},
    onTrace(event) {
      if (event.type === "tool_result") traces.push({ type: event.type, result: event.result });
    },
  });
  const result = await resumed.run("create it", {
    ...waiting.action,
    approvalId: "approval-1",
    decision: "APPROVED",
  });
  assert.equal(result.status, "completed");
  assert.equal(requests.length, 1);
  assert.deepEqual(requests[0]?.arguments, { path: "approved.txt", content: "exact" });
  assert.deepEqual(traces, [
    { type: "tool_result", result: { path: "approved.txt", created: true, isolated: true } },
  ]);
});

test("denied create_file never invokes the sandbox", async (context) => {
  const fs = await import("node:fs/promises");
  const os = await import("node:os");
  const path = await import("node:path");
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "foundry-sandbox-denied-"));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  let calls = 0;
  const tools = await RepositoryTools.create(root, {
    sandbox: { async execute() { calls += 1; return {}; } },
  });
  const action = {
    approvalId: "approval-denied",
    decision: "DENIED" as const,
    toolName: "create_file",
    validatedArguments: { path: "denied.txt", content: "no" },
    resumeMessages: [
      { role: "system" as const, content: "test" },
      { role: "user" as const, content: "create" },
      {
        role: "assistant" as const,
        content: "",
        toolCall: { name: "create_file", arguments: { path: "denied.txt", content: "no" } },
      },
    ],
    runtimeStep: 1,
  };
  const runtime = new AgentRuntime({
    provider: new FakeProvider([{ type: "final", content: "denied" }]),
    tools,
    toolPolicies: { create_file: "REQUIRE_APPROVAL" },
    systemInstructions: "test",
    maxSteps: 2,
    claimApprovalAction: async () => {},
  });
  const result = await runtime.run("create", action);
  assert.equal(result.status, "completed");
  assert.equal(calls, 0);
});

test("sandbox timeout remains a structured runtime failure", async (context) => {
  const fs = await import("node:fs/promises");
  const os = await import("node:os");
  const path = await import("node:path");
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "foundry-sandbox-timeout-"));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const tools = await RepositoryTools.create(root, {
    sandbox: {
      async execute() {
        throw new SandboxError("SANDBOX_TIMEOUT", "Sandbox exceeded 10ms");
      },
    },
  });
  const result = await new AgentRuntime({
    provider: new FakeProvider([
      { type: "tool_call", toolCall: { name: "create_file", arguments: { path: "x.txt", content: "x" } } },
    ]),
    tools,
    toolPolicies: { create_file: "ALLOW" },
    systemInstructions: "test",
    maxSteps: 1,
  }).run("create");
  assert.equal(result.status, "failed");
  if (result.status === "failed") assert.equal(result.reason, "SANDBOX_TIMEOUT");
});
