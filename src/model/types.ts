export type ToolSchema = {
  name: string;
  description: string;
  inputSchema: {
    type: "object";
    properties: Record<string, unknown>;
    required?: string[];
    additionalProperties: false;
  };
};

export type ToolCall = {
  id?: string;
  name: string;
  arguments: unknown;
};

export type ModelMessage =
  | { role: "system" | "user"; content: string }
  | { role: "assistant"; content: string; toolCall?: ToolCall }
  | { role: "tool"; name: string; content: string; callId?: string };

export type ModelRequest = {
  messages: ModelMessage[];
  tools: ToolSchema[];
};

export type ModelUsage = {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
};

export type ModelMetadata = {
  provider: string;
  model: string;
  usage?: ModelUsage;
};

export type ModelResponse =
  | { type: "final"; content: string; metadata?: ModelMetadata }
  | { type: "tool_call"; toolCall: ToolCall; metadata?: ModelMetadata };

export interface ModelProvider {
  readonly contextWindowTokens?: number;
  generate(request: ModelRequest): Promise<ModelResponse>;
}

export type ModelProviderFailureCode =
  | "MODEL_PROVIDER_UNAVAILABLE"
  | "MODEL_AUTHENTICATION_FAILED"
  | "MODEL_RATE_LIMITED"
  | "MODEL_INVALID_RESPONSE"
  | "MODEL_REQUEST_FAILED";

export class ModelProviderError extends Error {
  constructor(
    readonly code: ModelProviderFailureCode,
    message: string,
  ) {
    super(message);
    this.name = "ModelProviderError";
  }
}

export class InvalidModelResponseError extends ModelProviderError {
  constructor(message: string) {
    super("MODEL_INVALID_RESPONSE", message);
    this.name = "InvalidModelResponseError";
  }
}
