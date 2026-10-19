import { ModelProviderError } from "../model/types.js";
import type { ModelMessage, ModelProvider, ModelRequest, ModelResponse, ToolCall } from "../model/types.js";
import type { ModelProviderFailureCode } from "../model/types.js";
import {
  ToolExecutionError,
  ToolInputError,
  type ToolPolicies,
  type ToolRegistry,
} from "../tools/tool-registry.js";
import { SandboxError, type SandboxFailureCode } from "../sandbox/sandbox.js";
import { ContextBudgetGuard, type ContextBudgetDiagnostic } from "./context-budget-guard.js";
import { readContextProtectionConfig, type ContextProtectionConfig } from "./context-protection-config.js";
import { ToolResultLimiter, type ToolResultLimitDiagnostic } from "./tool-result-limiter.js";

export type RuntimeFailureCode =
  | ModelProviderFailureCode
  | "UNKNOWN_TOOL"
  | "INVALID_TOOL_ARGUMENTS"
  | "TOOL_PERMISSION_DENIED"
  | "TOOL_EXECUTION_ERROR"
  | "TASK_POSTCONDITION_FAILED"
  | "CONTEXT_BUDGET_EXCEEDED"
  | SandboxFailureCode
  | "MAX_STEPS_EXCEEDED";

export type RuntimeResult =
  | { status: "completed"; answer: string; steps: number }
  | { status: "failed"; reason: RuntimeFailureCode; message: string; steps: number; answer?: string }
  | { status: "waiting_for_approval"; action: PendingApprovalAction; steps: number };

export type TerminalRuntimeResult = Exclude<RuntimeResult, { status: "waiting_for_approval" }>;

export type FinalAnswerDecision =
  | { status: "verified" }
  | { status: "correct"; feedback: string }
  | { status: "failed"; message: string };
export type FinalAnswerVerifier = (answer: string, step: number) => Promise<FinalAnswerDecision>;

export type PendingApprovalAction = {
  toolName: string;
  validatedArguments: unknown;
  resumeMessages: ModelMessage[];
  runtimeStep: number;
};

export type ApprovalResume = PendingApprovalAction & {
  approvalId: string;
  decision: "APPROVED" | "DENIED";
};

export type TraceEvent =
  | { type: "started" }
  | { type: "step"; step: number }
  | { type: "model_call"; step: number; request: ModelRequest }
  | { type: "model_call_finished"; step: number; durationMs: number; metadata?: ModelResponse["metadata"] }
  | { type: "tool_requested"; step: number; toolCall: ToolCall }
  | { type: "tool_result"; step: number; name: string; result: unknown; readOnly?: boolean; durationMs?: number; outputLimit?: ToolResultLimitDiagnostic }
  | { type: "final_answer"; step: number; answer: string }
  | { type: "completed" }
  | { type: "failed"; step: number; reason: RuntimeFailureCode; message: string; details?: ContextBudgetDiagnostic };

export type AgentRuntimeOptions = {
  provider: ModelProvider;
  tools: ToolRegistry;
  toolPolicies: ToolPolicies;
  systemInstructions: string;
  maxSteps: number;
  contextProtection?: ContextProtectionConfig;
  onTrace?: (event: TraceEvent) => void | Promise<void>;
  claimApprovalAction?: (approvalId: string) => Promise<void>;
};

export class AgentRuntime {
  private readonly budgetGuard: ContextBudgetGuard;
  private readonly resultLimiter: ToolResultLimiter;

  constructor(private readonly options: AgentRuntimeOptions) {
    const config = options.contextProtection ?? readContextProtectionConfig();
    this.budgetGuard = new ContextBudgetGuard(options.provider.contextWindowTokens, config);
    this.resultLimiter = new ToolResultLimiter(config.maxToolResultBytes);
    if (!Number.isInteger(options.maxSteps) || options.maxSteps < 1) {
      throw new Error("maxSteps must be a positive integer");
    }
    for (const [name, policy] of Object.entries(options.toolPolicies)) {
      if (!options.tools.get(name)) throw new Error(`Configured tool is not registered: ${name}`);
      if (!isToolPolicy(policy)) throw new Error(`Invalid policy for tool ${name}: ${String(policy)}`);
    }
  }

  async run(task: string, resume?: ApprovalResume, verifyFinalAnswer?: FinalAnswerVerifier): Promise<RuntimeResult> {
    const messages: ModelMessage[] = resume
      ? structuredClone(resume.resumeMessages)
      : [
          { role: "system", content: this.options.systemInstructions },
          { role: "user", content: task },
        ];
    await this.trace({ type: "started" });

    let firstStep = 1;
    if (resume) {
      firstStep = resume.runtimeStep;
      const resumed = await this.resumeApproval(resume, messages);
      if (resumed) return resumed;
      firstStep += 1;
    }

    for (let step = firstStep; step <= this.options.maxSteps; step += 1) {
      await this.trace({ type: "step", step });
      let response: ModelResponse;
      const exposed = new Set(
        Object.entries(this.options.toolPolicies)
          .filter(([, policy]) => policy !== "DENY")
          .map(([name]) => name),
      );
      const request = { messages, tools: this.options.tools.schemasFor(exposed) };
      const exceeded = this.budgetGuard.check(request);
      if (exceeded) {
        return this.fail("CONTEXT_BUDGET_EXCEEDED",
          `Estimated request size ${exceeded.estimatedInputTokens} tokens exceeds input budget ${exceeded.inputBudgetTokens} tokens (context window ${exceeded.contextWindowTokens}).`,
          step, exceeded);
      }
      await this.trace({ type: "model_call", step, request });
      const modelStarted = performance.now();
      try {
        response = await this.options.provider.generate(request);
      } catch (error) {
        await this.trace({ type: "model_call_finished", step, durationMs: performance.now() - modelStarted });
        return this.fail(
          error instanceof ModelProviderError ? error.code : "MODEL_REQUEST_FAILED",
          errorMessage(error),
          step,
        );
      }
      await this.trace({
        type: "model_call_finished",
        step,
        durationMs: performance.now() - modelStarted,
        metadata: isModelResponse(response) ? response.metadata : undefined,
      });

      if (!isModelResponse(response)) {
        return this.fail("MODEL_INVALID_RESPONSE", "Provider returned an invalid normalized response", step);
      }
      if (response.type === "final") {
        await this.trace({ type: "final_answer", step, answer: response.content });
        if (verifyFinalAnswer) {
          const decision = await verifyFinalAnswer(response.content, step);
          if (decision.status === "failed") {
            const failed = await this.fail("TASK_POSTCONDITION_FAILED", decision.message, step);
            return { ...failed, answer: response.content };
          }
          if (decision.status === "correct") {
            messages.push({ role: "assistant", content: response.content });
            messages.push({ role: "user", content: decision.feedback });
            continue;
          }
        }
        await this.trace({ type: "completed" });
        return { status: "completed", answer: response.content, steps: step };
      }

      const { name, arguments: args } = response.toolCall;
      await this.trace({ type: "tool_requested", step, toolCall: response.toolCall });
      const tool = this.options.tools.get(name);
      if (!tool) {
        return this.fail("UNKNOWN_TOOL", `Model requested unknown tool: ${name}`, step);
      }

      let validatedArgs: unknown;
      try {
        validatedArgs = tool.validate(args);
      } catch (error) {
        if (error instanceof SandboxError) {
          return this.fail(error.code, error.message, step);
        }
        if (error instanceof ToolInputError) {
          return this.fail("INVALID_TOOL_ARGUMENTS", error.message, step);
        }
        return this.fail("INVALID_TOOL_ARGUMENTS", errorMessage(error), step);
      }
      const policy = this.options.toolPolicies[name] ?? "DENY";
      if (policy === "DENY") {
        return this.fail(
          "TOOL_PERMISSION_DENIED",
          `AgentVersion does not allow tool: ${name}`,
          step,
        );
      }

      if (policy === "REQUIRE_APPROVAL") {
        const resumeMessages = structuredClone(messages);
        resumeMessages.push({
          role: "assistant",
          content: "",
          toolCall: {
            ...(response.toolCall.id ? { id: response.toolCall.id } : {}),
            name,
            arguments: validatedArgs,
          },
        });
        return {
          status: "waiting_for_approval",
          action: { toolName: name, validatedArguments: validatedArgs, resumeMessages, runtimeStep: step },
          steps: step,
        };
      }

      let result: unknown;
      const toolStarted = performance.now();
      try {
        result = await tool.execute(validatedArgs);
      } catch (error) {
        if (error instanceof SandboxError) {
          return this.fail(error.code, error.message, step);
        }
        if (error instanceof ToolInputError) {
          return this.fail("INVALID_TOOL_ARGUMENTS", error.message, step);
        }
        const message = error instanceof ToolExecutionError ? error.message : errorMessage(error);
        return this.fail("TOOL_EXECUTION_ERROR", message, step);
      }

      messages.push({ role: "assistant", content: "", toolCall: response.toolCall });
      await this.appendToolResult(messages, name, result, step, response.toolCall.id,
        performance.now() - toolStarted);
    }

    return this.fail(
      "MAX_STEPS_EXCEEDED",
      `Agent did not produce a final answer within ${this.options.maxSteps} steps`,
      this.options.maxSteps,
    );
  }

  private async resumeApproval(
    resume: ApprovalResume,
    messages: ModelMessage[],
  ): Promise<RuntimeResult | null> {
    const tool = this.options.tools.get(resume.toolName);
    if (!tool) return this.fail("UNKNOWN_TOOL", `Approved tool is no longer registered: ${resume.toolName}`, resume.runtimeStep);

    try {
      await this.options.claimApprovalAction?.(resume.approvalId);
    } catch (error) {
      return this.fail("TOOL_EXECUTION_ERROR", errorMessage(error), resume.runtimeStep);
    }

    if (resume.decision === "DENIED") {
      const result = { error: "TOOL_APPROVAL_DENIED", tool: resume.toolName };
      await this.appendToolResult(messages, resume.toolName, result, resume.runtimeStep, lastToolCallId(messages));
      return null;
    }

    const toolStarted = performance.now();
    try {
      const result = await tool.execute(resume.validatedArguments);
      await this.appendToolResult(messages, resume.toolName, result, resume.runtimeStep,
        lastToolCallId(messages), performance.now() - toolStarted);
      return null;
    } catch (error) {
      if (error instanceof SandboxError) {
        return this.fail(error.code, error.message, resume.runtimeStep);
      }
      const message = error instanceof ToolExecutionError ? error.message : errorMessage(error);
      return this.fail("TOOL_EXECUTION_ERROR", message, resume.runtimeStep);
    }
  }

  private async appendToolResult(
    messages: ModelMessage[], name: string, result: unknown, step: number,
    callId?: string, durationMs?: number,
  ): Promise<void> {
    const limited = this.resultLimiter.limit(result, this.options.tools.get(name)?.readOnly === true);
    // Durable evidence keeps the actual execution result, not model-visible feedback.
    await this.trace({ type: "tool_result", step, name, result, durationMs,
      readOnly: this.options.tools.get(name)?.readOnly === true,
      ...(limited.diagnostic ? { outputLimit: limited.diagnostic } : {}) });
    messages.push({ role: "tool", name, content: limited.content, ...(callId ? { callId } : {}) });
  }

  private async fail(reason: RuntimeFailureCode, message: string, steps: number, details?: ContextBudgetDiagnostic): Promise<Extract<RuntimeResult, { status: "failed" }>> {
    await this.trace({ type: "failed", step: steps, reason, message, ...(details ? { details } : {}) });
    return { status: "failed", reason, message, steps };
  }

  private async trace(event: TraceEvent): Promise<void> {
    await this.options.onTrace?.(event);
  }
}

function isToolPolicy(value: string): value is "ALLOW" | "DENY" | "REQUIRE_APPROVAL" {
  return value === "ALLOW" || value === "DENY" || value === "REQUIRE_APPROVAL";
}

function isModelResponse(value: unknown): value is ModelResponse {
  if (typeof value !== "object" || value === null) return false;
  const response = value as Record<string, unknown>;
  if (response.type === "final") {
    return typeof response.content === "string" && response.content.trim() !== "";
  }
  if (response.type !== "tool_call" || typeof response.toolCall !== "object" || response.toolCall === null) {
    return false;
  }
  const call = response.toolCall as Record<string, unknown>;
  return typeof call.name === "string" && call.name.trim() !== "" && "arguments" in call;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function lastToolCallId(messages: ModelMessage[]): string | undefined {
  const message = messages.at(-1);
  return message?.role === "assistant" ? message.toolCall?.id : undefined;
}

