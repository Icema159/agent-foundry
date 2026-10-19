import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { OllamaProvider } from "../src/model/ollama-provider.js";
import { AgentRuntime } from "../src/runtime/agent-runtime.js";
import { ToolRegistry } from "../src/tools/tool-registry.js";

function setContextEnvironment(context: TestContext, value: string | undefined): void {
  const previous = process.env.FOUNDRY_OLLAMA_NUM_CTX;
  context.after(() => {
    if (previous === undefined) delete process.env.FOUNDRY_OLLAMA_NUM_CTX;
    else process.env.FOUNDRY_OLLAMA_NUM_CTX = previous;
  });
  if (value === undefined) delete process.env.FOUNDRY_OLLAMA_NUM_CTX;
  else process.env.FOUNDRY_OLLAMA_NUM_CTX = value;
}

for (const [raw, expected] of [[undefined, 16384], ["32768", 32768], ["1", 1], ["9007199254740991", Number.MAX_SAFE_INTEGER]] as const) {
  test(`Ollama context configuration ${raw ?? "unset"} sends num_ctx ${expected}`, async (context) => {
    setContextEnvironment(context, raw);
    const originalFetch = globalThis.fetch;
    context.after(() => { globalThis.fetch = originalFetch; });
    let body: Record<string, unknown> | undefined;
    globalThis.fetch = async (_input, init) => {
      body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response(JSON.stringify({ message: { content: "OK" } }), { status: 200 });
    };
    const provider = new OllamaProvider();
    assert.equal(provider.contextWindowTokens, expected);
    await provider.generate({ messages: [{ role: "user", content: "hello" }], tools: [] });
    assert.deepEqual(body?.options, { num_ctx: expected });
  });
}

test("invalid Ollama context configuration fails when the provider is created", (context) => {
  setContextEnvironment(context, undefined);
  for (const raw of ["", " ", "0", "-1", "1.5", "abc", "NaN", "Infinity", "9007199254740992", "1e3", "0x4000", "123abc"]) {
    process.env.FOUNDRY_OLLAMA_NUM_CTX = raw;
    assert.throws(() => new OllamaProvider(), /FOUNDRY_OLLAMA_NUM_CTX must be a positive safe integer/);
  }
});

test("the second Ollama request preserves the task, tool call, and matching tool result", async (context) => {
  setContextEnvironment(context, "32768");
  const requestBodies: Array<Record<string, unknown>> = [];
  const responses = [
    {
      message: {
        role: "assistant",
        content: "",
        tool_calls: [
          {
            type: "function",
            function: { name: "search_files", arguments: { query: "TODO" } },
          },
        ],
      },
    },
    { message: { role: "assistant", content: "Found one project TODO." } },
  ];
  const originalFetch = globalThis.fetch;
  context.after(() => {
    globalThis.fetch = originalFetch;
  });
  globalThis.fetch = async (_input, init) => {
    requestBodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
    // Changing the environment mid-run must not change this provider's context window.
    process.env.FOUNDRY_OLLAMA_NUM_CTX = "invalid-after-construction";
    const response = responses.shift();
    return new Response(JSON.stringify(response), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };

  const tools = new ToolRegistry([
    {
        name: "search_files",
        description: "Find text",
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
      return { matches: [{ path: "src/app.ts", line: 1, text: "// TODO: fix" }] };
      },
    },
  ]);
  const runtime = new AgentRuntime({
    provider: new OllamaProvider({ model: "test-model", baseUrl: "http://ollama.test" }),
    tools,
    toolPolicies: { search_files: "ALLOW" },
    systemInstructions: "Inspect the repository.",
    maxSteps: 2,
  });

  const result = await runtime.run("Find all TODO comments and summarize them.");

  assert.equal(result.status, "completed");
  assert.equal(requestBodies.length, 2);
  for (const body of requestBodies) {
    assert.deepEqual(body.options, { num_ctx: 32768 });
  }
  assert.deepEqual(requestBodies[1]?.messages, [
    { role: "system", content: "Inspect the repository." },
    { role: "user", content: "Find all TODO comments and summarize them." },
    {
      role: "assistant",
      content: "",
      tool_calls: [
        {
          type: "function",
          function: { name: "search_files", arguments: { query: "TODO" } },
        },
      ],
    },
    {
      role: "tool",
      tool_name: "search_files",
      content: JSON.stringify({
        matches: [{ path: "src/app.ts", line: 1, text: "// TODO: fix" }],
      }),
    },
  ]);
});

test("OllamaProvider normalizes available usage and tolerates missing counts", async (context) => {
  setContextEnvironment(context, undefined);
  const originalFetch = globalThis.fetch;
  context.after(() => { globalThis.fetch = originalFetch; });
  const bodies = [
    { model: "qwen-test", message: { content: "One" }, prompt_eval_count: 12, eval_count: 4 },
    { message: { content: "Two" } },
  ];
  globalThis.fetch = async () => new Response(JSON.stringify(bodies.shift()), { status: 200 });
  const provider = new OllamaProvider({ model: "qwen-test", baseUrl: "http://ollama.test" });
  const request = { messages: [{ role: "user" as const, content: "hello" }], tools: [] };
  assert.deepEqual((await provider.generate(request)).metadata, {
    provider: "ollama", model: "qwen-test",
    usage: { inputTokens: 12, outputTokens: 4, totalTokens: 16 },
  });
  assert.deepEqual((await provider.generate(request)).metadata, { provider: "ollama", model: "qwen-test" });
});
