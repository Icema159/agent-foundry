import assert from "node:assert/strict";
import test from "node:test";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ModelProvider, ModelRequest, ModelResponse } from "../src/model/types.js";
import { AgentRuntime, type TraceEvent } from "../src/runtime/agent-runtime.js";
import { ContextBudgetGuard } from "../src/runtime/context-budget-guard.js";
import { readContextProtectionConfig } from "../src/runtime/context-protection-config.js";
import { ToolResultLimiter } from "../src/runtime/tool-result-limiter.js";
import { ToolRegistry } from "../src/tools/tool-registry.js";
import { RepositoryTools } from "../src/tools/repository-tools.js";

const config = { maxToolResultBytes: 512, reservedOutputTokens: 100, safetyMarginTokens: 100 };
class FakeProvider implements ModelProvider {
  readonly requests: ModelRequest[] = [];
  constructor(private readonly responses: ModelResponse[], readonly contextWindowTokens?: number) {}
  async generate(request: ModelRequest): Promise<ModelResponse> {
    this.requests.push(structuredClone(request));
    const response = this.responses.shift();
    assert.ok(response, "Unexpected model invocation");
    return response;
  }
}
const call = (name: string, args: unknown = {}): ModelResponse => ({
  type: "tool_call", toolCall: { id: "call-1", name, arguments: args },
});
const final: ModelResponse = { type: "final", content: "Done" };
function runtime(provider: ModelProvider, tools = new ToolRegistry([]), events: TraceEvent[] = [],
  toolPolicies: Record<string, "ALLOW" | "REQUIRE_APPROVAL"> = {}) {
  return new AgentRuntime({ provider, tools, toolPolicies, systemInstructions: "Keep task context",
    maxSteps: 8, contextProtection: config, onTrace: event => { events.push(structuredClone(event)); } });
}

test("small tool output is unchanged; oversized UTF-8 read output returns explicit feedback", () => {
  const limiter = new ToolResultLimiter(512);
  const small = { content: "small" };
  assert.deepEqual(limiter.limit(small, true), { content: JSON.stringify(small) });
  const large = limiter.limit({ content: "ą".repeat(300) }, true);
  assert.equal(large.diagnostic?.code, "TOOL_RESULT_TOO_LARGE");
  assert.equal(large.diagnostic?.limitBytes, 512);
  assert.ok(large.diagnostic!.resultBytes > 512);
  assert.match(large.content, /startLine and maxLines/);
  assert.equal(JSON.parse(large.content).complete, false);
  assert.ok(Buffer.byteLength(large.content) <= 512);
});

test("agent can request bounded file output after oversized read feedback", async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "foundry-context-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const content = Array.from({ length: 100 }, (_, i) => `Line ${i + 1}\r\n`).join("");
  await fs.writeFile(path.join(root, "large.txt"), content);
  const tools = await RepositoryTools.create(root);
  assert.deepEqual(await tools.execute("read_file", { path: "large.txt" }), { path: "large.txt", content });
  const provider = new FakeProvider([
    call("read_file", { path: "large.txt" }),
    call("read_file", { path: "large.txt", startLine: 2, maxLines: 2 }), final,
  ], 16384);
  const events: TraceEvent[] = [];
  assert.equal((await runtime(provider, tools, events, { read_file: "ALLOW" }).run("Read evidence")).status, "completed");
  const tooLarge = provider.requests[1]!.messages.at(-1)!;
  assert.equal(tooLarge.role, "tool");
  assert.equal(JSON.parse(tooLarge.content).code, "TOOL_RESULT_TOO_LARGE");
  const partial = JSON.parse(provider.requests[2]!.messages.at(-1)!.content);
  assert.equal(partial.content, "Line 2\r\nLine 3\r\n");
  assert.equal(partial.complete, false);
  assert.equal(partial.totalLines, 100);
  assert.deepEqual(provider.requests[2]!.messages.slice(0, 2), provider.requests[0]!.messages);
  assert.ok(events.some(e => e.type === "tool_result" && e.outputLimit?.code === "TOOL_RESULT_TOO_LARGE"));
  for (const args of [{ startLine: 0 }, { maxLines: 1.5 }, { startLine: "1" }, { maxLines: null }]) {
    await assert.rejects(tools.execute("read_file", { path: "large.txt", ...args }), /positive safe integer/);
  }
});

test("guard includes schemas, UTF-8 content, reserved output and safety margin; unknown limits stay unguarded", () => {
  const request: ModelRequest = { messages: [{ role: "user", content: "ą".repeat(700) }], tools: [] };
  const diagnostic = new ContextBudgetGuard(1800, config).check(request)!;
  assert.equal(diagnostic.inputBudgetTokens, 1600);
  assert.ok(diagnostic.estimatedInputTokens > 1600);
  assert.equal(new ContextBudgetGuard(undefined, config).check(request), undefined);
  const schemas = { messages: [], tools: [{ name: "large", description: "x".repeat(2000), inputSchema: { type: "object" as const, properties: {}, additionalProperties: false as const } }] };
  assert.ok(new ContextBudgetGuard(1800, config).check(schemas));
});

test("oversized initial context fails before any model call and keeps payloads out of failure details", async () => {
  const provider = new FakeProvider([], 1000);
  const events: TraceEvent[] = [];
  const result = await runtime(provider, undefined, events).run("private".repeat(500));
  assert.equal(result.status, "failed");
  if (result.status === "failed") assert.equal(result.reason, "CONTEXT_BUDGET_EXCEEDED");
  assert.equal(provider.requests.length, 0);
  assert.equal(events.some(e => e.type === "model_call"), false);
  const failure = events.find(e => e.type === "failed");
  assert.ok(failure?.type === "failed" && failure.details);
  assert.doesNotMatch(JSON.stringify(failure), /private/);
});

test("individually small tool results cumulatively exceed budget before next model call", async () => {
  let executions = 0;
  const tools = new ToolRegistry([{ name: "read", description: "Read", readOnly: true,
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    validate: args => args, execute: async () => { executions++; return { content: "x".repeat(350) }; },
  }]);
  const provider = new FakeProvider([call("read"), call("read"), call("read"), final], 2500);
  const events: TraceEvent[] = [];
  const result = await runtime(provider, tools, events, { read: "ALLOW" }).run("Read evidence");
  assert.equal(result.status, "failed");
  if (result.status === "failed") assert.equal(result.reason, "CONTEXT_BUDGET_EXCEEDED");
  assert.ok(provider.requests.length >= 1 && provider.requests.length < 4);
  assert.equal(executions, provider.requests.length);
  assert.equal(events.some(e => e.type === "tool_result" && e.outputLimit), false);
});

test("unknown provider context limit preserves model invocation behavior", async () => {
  const provider = new FakeProvider([final]);
  assert.equal((await runtime(provider).run("x".repeat(20000))).status, "completed");
  assert.equal(provider.requests.length, 1);
});

test("approved oversized side-effect result preserves outcome, matching call and executes once", async () => {
  let executions = 0;
  const actual = { created: true, path: "demo.md", output: "x".repeat(2000) };
  const tools = new ToolRegistry([{ name: "write", description: "Write",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    validate: args => args, execute: async () => { executions++; return actual; },
  }]);
  const events: TraceEvent[] = [];
  const first = await runtime(new FakeProvider([call("write")], 16384), tools, events, { write: "REQUIRE_APPROVAL" }).run("Create demo");
  assert.equal(first.status, "waiting_for_approval");
  assert.equal(executions, 0);
  if (first.status !== "waiting_for_approval") return;
  const provider = new FakeProvider([final], 16384);
  const resumed = await runtime(provider, tools, events, { write: "REQUIRE_APPROVAL" }).run("Create demo", {
    ...first.action, approvalId: "approved-1", decision: "APPROVED",
  });
  assert.equal(resumed.status, "completed");
  assert.equal(executions, 1);
  const message = provider.requests[0]!.messages.at(-1)!;
  assert.ok(message.role === "tool" && message.callId === "call-1");
  assert.equal(JSON.parse(message.content).code, "TOOL_RESULT_OUTPUT_OMITTED");
  assert.match(message.content, /Do not repeat/);
  const evidence = events.find(e => e.type === "tool_result");
  assert.ok(evidence?.type === "tool_result");
  assert.deepEqual(evidence.result, actual);
  assert.equal(evidence.outputLimit?.code, "TOOL_RESULT_OUTPUT_OMITTED");
});

test("context protection config defaults, overrides and invalid values", t => {
  const names = ["FOUNDRY_TOOL_RESULT_MAX_BYTES", "FOUNDRY_CONTEXT_RESERVED_OUTPUT_TOKENS", "FOUNDRY_CONTEXT_SAFETY_MARGIN_TOKENS"];
  const saved = names.map(name => process.env[name]);
  t.after(() => names.forEach((name, i) => {
    if (saved[i] === undefined) delete process.env[name]; else process.env[name] = saved[i];
  }));
  names.forEach(name => { delete process.env[name]; });
  assert.deepEqual(readContextProtectionConfig(), { maxToolResultBytes: 8000, reservedOutputTokens: 2048, safetyMarginTokens: 1024 });
  process.env.FOUNDRY_TOOL_RESULT_MAX_BYTES = "9000";
  process.env.FOUNDRY_CONTEXT_RESERVED_OUTPUT_TOKENS = "500";
  process.env.FOUNDRY_CONTEXT_SAFETY_MARGIN_TOKENS = "200";
  assert.deepEqual(readContextProtectionConfig(), { maxToolResultBytes: 9000, reservedOutputTokens: 500, safetyMarginTokens: 200 });
  for (const name of names) {
    const valid = process.env[name];
    for (const invalid of ["", " ", "0", "-1", "1.5", "NaN", "Infinity", "9007199254740992"]) {
      process.env[name] = invalid;
      assert.throws(readContextProtectionConfig, new RegExp(name));
    }
    process.env[name] = valid;
  }
  process.env.FOUNDRY_TOOL_RESULT_MAX_BYTES = "511";
  assert.throws(readContextProtectionConfig, /FOUNDRY_TOOL_RESULT_MAX_BYTES/);
});

test("budget guard checks approved resume without repeating or relabeling completed side effects", async () => {
  let executions = 0;
  let claims = 0;
  const actual = { created: true, path: "demo.md", output: "x".repeat(2000) };
  const tools = new ToolRegistry([{ name: "write", description: "Write",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    validate: args => args, execute: async () => { executions++; return actual; },
  }]);
  const paused = await runtime(new FakeProvider([call("write")], 16384), tools, [], { write: "REQUIRE_APPROVAL" }).run("Create demo");
  assert.equal(paused.status, "waiting_for_approval");
  if (paused.status !== "waiting_for_approval") return;
  const provider = new FakeProvider([], 800);
  const events: TraceEvent[] = [];
  const resumed = new AgentRuntime({ provider, tools, toolPolicies: { write: "REQUIRE_APPROVAL" },
    systemInstructions: "Keep task context", maxSteps: 8, contextProtection: config,
    claimApprovalAction: async () => { claims++; },
    onTrace: event => { events.push(structuredClone(event)); },
  });
  const result = await resumed.run("Create demo", { ...paused.action, approvalId: "approved-1", decision: "APPROVED" });
  assert.equal(result.status, "failed");
  if (result.status === "failed") assert.equal(result.reason, "CONTEXT_BUDGET_EXCEEDED");
  assert.equal(claims, 1);
  assert.equal(executions, 1);
  assert.equal(provider.requests.length, 0);
  const evidence = events.find(e => e.type === "tool_result");
  assert.ok(evidence?.type === "tool_result");
  assert.deepEqual(evidence.result, actual);
  assert.equal(evidence.outputLimit?.code, "TOOL_RESULT_OUTPUT_OMITTED");
});
