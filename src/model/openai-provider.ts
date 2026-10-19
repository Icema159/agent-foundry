import OpenAI from "openai";
import type { ModelMessage, ModelProvider, ModelRequest, ModelResponse, ModelUsage, ToolSchema } from "./types.js";
import { InvalidModelResponseError, ModelProviderError } from "./types.js";

type OpenAIClientLike = {
  responses: {
    create(request: Record<string, unknown>): Promise<unknown>;
  };
};

export type OpenAIProviderOptions = {
  model: string;
  apiKey?: string;
  client?: OpenAIClientLike;
};

export class OpenAIProvider implements ModelProvider {
  private readonly model: string;
  private readonly apiKey: string | undefined;
  private client: OpenAIClientLike | undefined;

  constructor(options: OpenAIProviderOptions) {
    if (!options.model.trim()) throw new Error("OpenAI model name is required");
    this.model = options.model;
    this.apiKey = options.apiKey;
    this.client = options.client;
  }

  async generate(request: ModelRequest): Promise<ModelResponse> {
    try {
      const response = await this.getClient().responses.create({
        model: this.model,
        store: false,
        parallel_tool_calls: false,
        input: request.messages.map(toOpenAIInput),
        tools: request.tools.map(toOpenAITool),
      });
      return normalizeResponse(response, this.model);
    } catch (error) {
      if (error instanceof ModelProviderError) throw error;
      throw normalizeOpenAIError(error);
    }
  }

  private getClient(): OpenAIClientLike {
    this.client ??= new OpenAI({ apiKey: this.apiKey });
    return this.client;
  }
}

function toOpenAIInput(message: ModelMessage): unknown {
  if (message.role === "tool") {
    if (!message.callId) {
      throw new InvalidModelResponseError("OpenAI tool result is missing its call_id");
    }
    return {
      type: "function_call_output",
      call_id: message.callId,
      output: message.content,
    };
  }
  if (message.role === "assistant" && message.toolCall) {
    if (!message.toolCall.id) {
      throw new InvalidModelResponseError("OpenAI assistant tool call is missing its call_id");
    }
    return {
      type: "function_call",
      call_id: message.toolCall.id,
      name: message.toolCall.name,
      arguments: JSON.stringify(message.toolCall.arguments),
    };
  }
  return { role: message.role, content: message.content };
}

function toOpenAITool(tool: ToolSchema): unknown {
  return {
    type: "function",
    name: tool.name,
    description: tool.description,
    parameters: tool.inputSchema,
    strict: true,
  };
}

function normalizeResponse(value: unknown, configuredModel: string): ModelResponse {
  if (typeof value !== "object" || value === null) {
    throw new InvalidModelResponseError("OpenAI returned a non-object response");
  }
  const response = value as Record<string, unknown>;
  const usage = readOpenAIUsage(response.usage);
  const metadata = {
    provider: "openai",
    model: typeof response.model === "string" ? response.model : configuredModel,
    ...(usage ? { usage } : {}),
  };
  const output = response.output;
  if (!Array.isArray(output)) {
    throw new InvalidModelResponseError("OpenAI response did not contain an output array");
  }
  const calls = output.filter(
    (item): item is Record<string, unknown> =>
      typeof item === "object" && item !== null && (item as Record<string, unknown>).type === "function_call",
  );
  if (calls.length > 1) {
    throw new InvalidModelResponseError(
      `Foundry requires exactly one tool call per model response; received ${calls.length}`,
    );
  }
  if (calls.length === 1) {
    const call = calls[0];
    const id = call?.call_id;
    const name = call?.name;
    const rawArguments = call?.arguments;
    if (typeof id !== "string" || !id || typeof name !== "string" || !name) {
      throw new InvalidModelResponseError("OpenAI function call is missing call_id or name");
    }
    if (typeof rawArguments !== "string") {
      throw new InvalidModelResponseError("OpenAI function-call arguments are not a JSON string");
    }
    let args: unknown;
    try {
      args = JSON.parse(rawArguments) as unknown;
    } catch {
      throw new InvalidModelResponseError("OpenAI function-call arguments are not valid JSON");
    }
    return { type: "tool_call", toolCall: { id, name, arguments: args }, metadata };
  }

  const text = response.output_text;
  if (typeof text !== "string" || text.trim() === "") {
    throw new InvalidModelResponseError("OpenAI response contained neither one tool call nor final text");
  }
  return { type: "final", content: text, metadata };
}

function readOpenAIUsage(value: unknown): ModelUsage | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const usage = value as Record<string, unknown>;
  const inputTokens = tokenCount(usage.input_tokens);
  const outputTokens = tokenCount(usage.output_tokens);
  const totalTokens = tokenCount(usage.total_tokens);
  if (inputTokens === undefined && outputTokens === undefined && totalTokens === undefined) return undefined;
  return {
    ...(inputTokens !== undefined ? { inputTokens } : {}),
    ...(outputTokens !== undefined ? { outputTokens } : {}),
    ...(totalTokens !== undefined ? { totalTokens } : {}),
  };
}

function tokenCount(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function normalizeOpenAIError(error: unknown): ModelProviderError {
  const status = readStatus(error);
  const message = error instanceof Error ? error.message : String(error);
  if (/api key/i.test(message)) {
    return new ModelProviderError("MODEL_AUTHENTICATION_FAILED", message);
  }
  if (status === 401 || status === 403) {
    return new ModelProviderError("MODEL_AUTHENTICATION_FAILED", message);
  }
  if (status === 429) return new ModelProviderError("MODEL_RATE_LIMITED", message);
  if (status === undefined || status >= 500) {
    return new ModelProviderError("MODEL_PROVIDER_UNAVAILABLE", message);
  }
  return new ModelProviderError("MODEL_REQUEST_FAILED", message);
}

function readStatus(error: unknown): number | undefined {
  if (typeof error !== "object" || error === null || !("status" in error)) return undefined;
  return typeof error.status === "number" ? error.status : undefined;
}
