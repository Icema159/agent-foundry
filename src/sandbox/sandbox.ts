export type SandboxRequest = {
  toolName: string;
  arguments: unknown;
  workspaceRoot: string;
};

export interface Sandbox {
  execute(request: SandboxRequest): Promise<unknown>;
}

export type SandboxFailureCode =
  | "SANDBOX_UNAVAILABLE"
  | "SANDBOX_TIMEOUT"
  | "SANDBOX_EXECUTION_FAILED"
  | "SANDBOX_POLICY_VIOLATION";

export class SandboxError extends Error {
  constructor(
    readonly code: SandboxFailureCode,
    message: string,
  ) {
    super(message);
    this.name = "SandboxError";
  }
}
