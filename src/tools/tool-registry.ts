import type { ToolSchema } from "../model/types.js";

export class ToolInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ToolInputError";
  }
}

export class ToolExecutionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ToolExecutionError";
  }
}

export type RegisteredTool = ToolSchema & {
  // Unknown tools default to potentially side-effecting for output limiting.
  readOnly?: boolean;
  validate(args: unknown): unknown;
  execute(validatedArgs: unknown): Promise<unknown>;
};

export type ToolPermissionPolicy = "ALLOW" | "DENY" | "REQUIRE_APPROVAL";
export type ToolPolicies = Record<string, ToolPermissionPolicy>;

export class ToolRegistry {
  readonly schemas: ToolSchema[];
  private readonly tools: Map<string, RegisteredTool>;

  constructor(definitions: RegisteredTool[]) {
    this.tools = new Map();
    for (const definition of definitions) {
      if (this.tools.has(definition.name)) {
        throw new Error(`Duplicate tool registration: ${definition.name}`);
      }
      this.tools.set(definition.name, definition);
    }
    this.schemas = definitions.map(({ name, description, inputSchema }) => ({
      name,
      description,
      inputSchema,
    }));
  }

  get(name: string): RegisteredTool | undefined {
    return this.tools.get(name);
  }

  schemasFor(allowedToolNames: ReadonlySet<string>): ToolSchema[] {
    return this.schemas.filter((schema) => allowedToolNames.has(schema.name));
  }

  async execute(name: string, args: unknown): Promise<unknown> {
    const tool = this.tools.get(name);
    if (!tool) throw new Error(`Unknown tool: ${name}`);
    return tool.execute(tool.validate(args));
  }
}
