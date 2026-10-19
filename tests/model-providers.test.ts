import assert from "node:assert/strict";
import test from "node:test";
import { ModelProviderFactory } from "../src/model/model-provider-factory.js";
import { OllamaProvider } from "../src/model/ollama-provider.js";
import { OpenAIProvider } from "../src/model/openai-provider.js";
import { AgentRuntime } from "../src/runtime/agent-runtime.js";
import { ToolRegistry } from "../src/tools/tool-registry.js";
import { RepositoryTools } from "../src/tools/repository-tools.js";

function clientWithResponses(responses: unknown[], requests: Array<Record<string, unknown>> = []) {
  return {
    responses: {
      async create(request: Record<string, unknown>) {
        requests.push(structuredClone(request));
        const response = responses.shift();
        if (!response) throw new Error("No mock OpenAI response");
        return response;
      },
    },
  };
}

const noTools = new ToolRegistry([]);

test("OpenAIProvider normalizes a final answer", async () => {
  const provider = new OpenAIProvider({
    model: "test-model",
    client: clientWithResponses([{ output: [], output_text: "OpenAI final answer" }]),
  });
  const response = await provider.generate({
    messages: [{ role: "user", content: "hello" }],
    tools: [],
  });
  assert.deepEqual(response, { type: "final", content: "OpenAI final answer", metadata: { provider: "openai", model: "test-model" } });
});

test("OpenAIProvider normalizes one function call with structured arguments", async () => {
  const provider = new OpenAIProvider({
    model: "test-model",
    client: clientWithResponses([
      {
        output: [
          {
            type: "function_call",
            call_id: "call-1",
            name: "search_files",
            arguments: '{"query":"TODO"}',
          },
        ],
        output_text: "",
      },
    ]),
  });
  const response = await provider.generate({ messages: [{ role: "user", content: "search" }], tools: [] });
  assert.deepEqual(response, {
    type: "tool_call",
    toolCall: { id: "call-1", name: "search_files", arguments: { query: "TODO" } },
    metadata: { provider: "openai", model: "test-model" },
  });
});

test("OpenAIProvider normalizes reported token usage", async () => {
  const provider = new OpenAIProvider({
    model: "test-model",
    client: clientWithResponses([{ output: [], output_text: "Done", model: "actual-model", usage: { input_tokens: 8, output_tokens: 3, total_tokens: 11 } }]),
  });
  const response = await provider.generate({ messages: [{ role: "user", content: "test" }], tools: [] });
  assert.deepEqual(response.metadata, { provider: "openai", model: "actual-model", usage: { inputTokens: 8, outputTokens: 3, totalTokens: 11 } });
});

test("invalid OpenAI response becomes MODEL_INVALID_RESPONSE", async () => {
  const provider = new OpenAIProvider({
    model: "test-model",
    client: clientWithResponses([{ output: [], output_text: "" }]),
  });
  const runtime = new AgentRuntime({
    provider,
    tools: noTools,
    toolPolicies: {},
    systemInstructions: "test",
    maxSteps: 1,
  });
  const result = await runtime.run("task");
  assert.equal(result.status, "failed");
  if (result.status === "failed") assert.equal(result.reason, "MODEL_INVALID_RESPONSE");
});

test("provider factory resolves Ollama and OpenAI and rejects unknown providers", () => {
  const factory = new ModelProviderFactory({ openAIApiKey: "test-key" });
  assert.ok(factory.create("ollama", "qwen-test") instanceof OllamaProvider);
  assert.ok(factory.create("openai", "openai-test") instanceof OpenAIProvider);
  assert.throws(() => factory.create("unknown", "model"), /Unknown model provider/);
});

test("the same AgentRuntime tool loop works through OpenAIProvider", async () => {
  const requests: Array<Record<string, unknown>> = [];
  const provider = new OpenAIProvider({
    model: "test-model",
    client: clientWithResponses(
      [
        {
          output: [
            {
              type: "function_call",
              call_id: "call-search",
              name: "search_files",
              arguments: '{"query":"TODO"}',
            },
          ],
          output_text: "",
        },
        { output: [], output_text: "Found the TODO." },
      ],
      requests,
    ),
  });
  const tools = new ToolRegistry([
    {
      name: "search_files",
      description: "Search files",
      inputSchema: {
        type: "object",
        properties: { query: { type: "string" } },
        required: ["query"],
        additionalProperties: false,
      },
      validate(args) { return args; },
      async execute() { return { matches: ["src/app.ts"] }; },
    },
  ]);
  const result = await new AgentRuntime({
    provider,
    tools,
    toolPolicies: { search_files: "ALLOW" },
    systemInstructions: "Inspect the repository.",
    maxSteps: 2,
  }).run("Find TODOs");

  assert.equal(result.status, "completed");
  assert.deepEqual((requests[1]?.input as unknown[]).slice(-2), [
    {
      type: "function_call",
      call_id: "call-search",
      name: "search_files",
      arguments: '{"query":"TODO"}',
    },
    {
      type: "function_call_output",
      call_id: "call-search",
      output: JSON.stringify({ matches: ["src/app.ts"] }),
    },
  ]);
});

test("OpenAI authentication and rate-limit errors are normalized", async () => {
  for (const [status, expected] of [
    [401, "MODEL_AUTHENTICATION_FAILED"],
    [429, "MODEL_RATE_LIMITED"],
  ] as const) {
    const provider = new OpenAIProvider({
      model: "test-model",
      client: {
        responses: {
          async create() {
            throw Object.assign(new Error(`HTTP ${status}`), { status });
          },
        },
      },
    });
    await assert.rejects(
      () => provider.generate({ messages: [{ role: "user", content: "test" }], tools: [] }),
      (error: unknown) =>
        typeof error === "object" && error !== null && "code" in error && error.code === expected,
    );
  }
});

test("OpenAI tool calls still pass through approval and the sandbox", async (context) => {
  const fs = await import("node:fs/promises");
  const os = await import("node:os");
  const path = await import("node:path");
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "foundry-openai-approval-"));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  let sandboxCalls = 0;
  const tools = await RepositoryTools.create(root, {
    sandbox: {
      async execute(request) {
        sandboxCalls += 1;
        return { path: (request.arguments as { path: string }).path, created: true };
      },
    },
  });
  const firstProvider = new OpenAIProvider({
    model: "test-model",
    client: clientWithResponses([
      {
        output: [
          {
            type: "function_call",
            call_id: "call-create",
            name: "create_file",
            arguments: '{"path":"openai.txt","content":"approved"}',
          },
        ],
        output_text: "",
      },
    ]),
  });
  const waiting = await new AgentRuntime({
    provider: firstProvider,
    tools,
    toolPolicies: { create_file: "REQUIRE_APPROVAL" },
    systemInstructions: "test",
    maxSteps: 2,
  }).run("create a file");
  assert.equal(waiting.status, "waiting_for_approval");
  assert.equal(sandboxCalls, 0);
  if (waiting.status !== "waiting_for_approval") throw new Error("Expected approval");

  const result = await new AgentRuntime({
    provider: new OpenAIProvider({
      model: "test-model",
      client: clientWithResponses([{ output: [], output_text: "Created after approval." }]),
    }),
    tools,
    toolPolicies: { create_file: "REQUIRE_APPROVAL" },
    systemInstructions: "test",
    maxSteps: 2,
    claimApprovalAction: async () => {},
  }).run("create a file", {
    ...waiting.action,
    approvalId: "approval-openai",
    decision: "APPROVED",
  });
  assert.equal(result.status, "completed");
  assert.equal(sandboxCalls, 1);
});
