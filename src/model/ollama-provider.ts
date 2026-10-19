import type {
  ModelMessage,
  ModelProvider,
  ModelRequest,
  ModelResponse,
  ModelUsage,
  ToolSchema,
} from "./types.js";
import { InvalidModelResponseError } from "./types.js";
import { ModelProviderError } from "./types.js";

type OllamaToolCall = {
  id?: unknown;
  function?: { name?: unknown; arguments?: unknown };
};

type OllamaResponse = {
  model?: unknown;
  prompt_eval_count?: unknown;
  eval_count?: unknown;
  message?: {
    content?: unknown;
    tool_calls?: unknown;
  };
};

export type OllamaProviderOptions = {
  model?: string;
  baseUrl?: string;
};

export class OllamaProvider implements ModelProvider {
  private readonly model: string;
  private readonly baseUrl: string;
  readonly contextWindowTokens: number;

  constructor(options: OllamaProviderOptions = {}) {
    this.model = options.model ?? "qwen3.5:9b";
    this.baseUrl = (options.baseUrl ?? "http://127.0.0.1:11434").replace(/\/$/, "");
    this.contextWindowTokens = readContextWindow(process.env.FOUNDRY_OLLAMA_NUM_CTX);
  }

  async generate(request: ModelRequest): Promise<ModelResponse> {
    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}/api/chat`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: this.model,
          stream: false,
          think: false,
          options: { num_ctx: this.contextWindowTokens },
          messages: request.messages.map(toOllamaMessage),
          tools: request.tools.map(toOllamaTool),
        }),
      });
    } catch (error) {
      throw new ModelProviderError("MODEL_PROVIDER_UNAVAILABLE", errorMessage(error));
    }

    if (!response.ok) {
      throw new ModelProviderError(
        response.status === 429 ? "MODEL_RATE_LIMITED" : "MODEL_REQUEST_FAILED",
        `Ollama returned HTTP ${response.status}: ${await response.text()}`,
      );
    }

    const body = (await response.json()) as OllamaResponse;
    const message = body.message;
    const usage = readOllamaUsage(body);
    const metadata = {
      provider: "ollama",
      model: typeof body.model === "string" ? body.model : this.model,
      ...(usage ? { usage } : {}),
    };
    if (!message) {
      throw new InvalidModelResponseError("Ollama response did not contain a message");
    }

    const toolCalls = message.tool_calls;
    if (toolCalls !== undefined) {
      if (!Array.isArray(toolCalls) || toolCalls.length !== 1) {
        throw new InvalidModelResponseError(
          `Phase 1 requires exactly one tool call per model response; received ${Array.isArray(toolCalls) ? toolCalls.length : "a non-array value"}`,
        );
      }
      return { ...normalizeToolCall(toolCalls[0] as OllamaToolCall), metadata };
    }

    if (typeof message.content !== "string" || message.content.trim() === "") {
      throw new InvalidModelResponseError(
        "Ollama response contained neither one tool call nor a final answer",
      );
    }

    return { type: "final", content: message.content, metadata };
  }
}

function readContextWindow(raw: string | undefined): number {
  if (raw === undefined) return 16384;
  const value = Number(raw);
  if (!/^\d+$/.test(raw.trim()) || !Number.isSafeInteger(value) || value < 1) {
    throw new Error("FOUNDRY_OLLAMA_NUM_CTX must be a positive safe integer (default when unset: 16384)");
  }
  return value;
}

function readOllamaUsage(body: OllamaResponse): ModelUsage | undefined {
  const inputTokens = tokenCount(body.prompt_eval_count);
  const outputTokens = tokenCount(body.eval_count);
  if (inputTokens === undefined && outputTokens === undefined) return undefined;
  return {
    ...(inputTokens !== undefined ? { inputTokens } : {}),
    ...(outputTokens !== undefined ? { outputTokens } : {}),
    ...(inputTokens !== undefined && outputTokens !== undefined
      ? { totalTokens: inputTokens + outputTokens }
      : {}),
  };
}

function tokenCount(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function toOllamaTool(tool: ToolSchema): unknown {
  return {
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.inputSchema,
    },
  };
}

function toOllamaMessage(message: ModelMessage): unknown {
  if (message.role === "tool") {
    return { role: "tool", tool_name: message.name, content: message.content };
  }
  if (message.role === "assistant" && message.toolCall) {
    return {
      role: "assistant",
      content: message.content,
      tool_calls: [
        {
          type: "function",
          function: {
            name: message.toolCall.name,
            arguments: message.toolCall.arguments,
          },
        },
      ],
    };
  }
  return { role: message.role, content: message.content };
}

function normalizeToolCall(call: OllamaToolCall): ModelResponse {
  const name = call.function?.name;
  let args = call.function?.arguments;
  if (typeof name !== "string" || name.trim() === "") {
    throw new InvalidModelResponseError("Tool call is missing a valid function name");
  }
  if (typeof args === "string") {
    try {
      args = JSON.parse(args) as unknown;
    } catch {
      throw new InvalidModelResponseError("Tool arguments are not valid JSON");
    }
  }
  return {
    type: "tool_call",
    toolCall: { ...(typeof call.id === "string" ? { id: call.id } : {}), name, arguments: args },
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
