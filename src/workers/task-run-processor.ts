import type {
  ExecutionStore,
  LoadedExecution,
  PersistedStep,
} from "../persistence/execution-store.js";
import type { RuntimeResult, TraceEvent } from "../runtime/agent-runtime.js";
import type { ApprovalResume, FinalAnswerVerifier } from "../runtime/agent-runtime.js";
import { TaskPostconditionVerifier } from "../verification/task-postconditions.js";

export type WorkerRuntimeFactory = (
  execution: LoadedExecution,
  onTrace: (event: TraceEvent) => Promise<void>,
) => Promise<{ run(task: string, resume?: ApprovalResume, verifyFinalAnswer?: FinalAnswerVerifier): Promise<RuntimeResult> }>;

export async function processTaskRun(options: {
  taskRunId: string;
  workerId: string;
  heartbeatIntervalMs: number;
  store: ExecutionStore;
  createRuntime: WorkerRuntimeFactory;
}): Promise<RuntimeResult> {
  const execution = await options.store.loadExecution(options.taskRunId);
  await options.store.claimExecution(
    execution.taskId,
    execution.taskRunId,
    options.workerId,
    new Date(),
  );
  const heartbeat = new ExecutionHeartbeat(options.heartbeatIntervalMs, () =>
    options.store.heartbeat(execution.taskRunId, options.workerId, new Date()),
  );
  let sequence = execution.nextStepSequence - 1;
  let modelCallSequence: number | null = null;
  const toolResults = [...(execution.priorToolResults ?? [])];
  const toolCalls = [...(execution.priorToolCalls ?? [])];
  const postconditions = execution.postconditions ?? [];
  let correctionAttempted = execution.correctionAttempted === true;
  let correctionOutcomeRecorded = false;
  const runtime = await options.createRuntime(execution, async (event) => {
    if (event.type === "model_call_finished") {
      if (modelCallSequence === null) throw new Error("Model call completion has no persisted start step");
      await options.store.completeModelCall(
        execution.taskRunId,
        options.workerId,
        modelCallSequence,
        event.durationMs,
        event.metadata,
      );
      return;
    }
    const step = toPersistedStep(event, sequence + 1, execution.recoveryCount + 1);
    if (!step) return;
    sequence = step.sequence;
    await options.store.appendStep(execution.taskRunId, options.workerId, step);
    if (step.kind === "TOOL_RESULT") toolResults.push(step.payload);
    if (step.kind === "TOOL_CALL") toolCalls.push(step.payload);
    if (event.type === "model_call") modelCallSequence = step.sequence;
  });
  heartbeat.start();
  let result: RuntimeResult;
  try {
    const verifyFinalAnswer: FinalAnswerVerifier | undefined = postconditions.length ? async (_answer, runtimeStep) => {
      let checks;
      let verificationError: string | undefined;
      try {
        checks = await new TaskPostconditionVerifier().verify(execution.workspaceRoot, postconditions, toolResults);
      } catch (error) {
        verificationError = `Postcondition verification failed: ${error instanceof Error ? error.message : String(error)}`;
      }
      const passed = !verificationError && checks !== undefined && checks.every(check => check.passed);
      const message = verificationError ?? checks!.map(check => check.message).join("; ");
      const denied = execution.hadDeniedApproval === true || execution.approvalResume?.decision === "DENIED"
        || toolResults.some(payload => object(object(payload).result).error === "TOOL_APPROVAL_DENIED");
      // Unknown/legacy result metadata cannot prove read-only execution. A returned
      // write result is conservatively unsafe even if it does not claim success.
      const safe = (!execution.approvalResume || execution.priorToolResults !== undefined)
        && !denied && toolResults.every(payload => object(payload).readOnly === true)
        && toolCalls.every(payload => {
          const call = object(payload);
          if (!Number.isSafeInteger(call.executionAttempt) || !Number.isSafeInteger(call.runtimeStep)
            || typeof object(call.toolCall).name !== "string") return false;
          return toolResults.some(result => {
            const recorded = object(result);
            return recorded.executionAttempt === call.executionAttempt
              && recorded.runtimeStep === call.runtimeStep
              && recorded.name === object(call.toolCall).name;
          });
        });
      const canCorrect = !passed && !verificationError && !correctionAttempted && safe && runtimeStep < execution.agent.maxSteps;
      const correctionOutcome = correctionAttempted ? (passed ? "SUCCEEDED" : "FAILED") : canCorrect ? "STARTED" : undefined;
      await options.store.appendStep(execution.taskRunId, options.workerId, {
        sequence: ++sequence, kind: "POSTCONDITION_CHECK",
        payload: { executionAttempt: execution.recoveryCount + 1, conditions: execution.postconditions,
          runtimeStep, passed, checks: checks ?? [],
          ...(correctionOutcome ? { correctionAttempt: 1, correctionOutcome } : {}),
          message: correctionOutcome ? `${message}; correction 1/1 ${correctionOutcome.toLowerCase()}` : message },
      });
      if (correctionAttempted) correctionOutcomeRecorded = true;
      if (passed) return { status: "verified" };
      if (canCorrect) {
        // The durable STARTED marker is committed under the lease before the
        // runtime receives feedback or makes another model/tool call.
        correctionAttempted = true;
        return { status: "correct", feedback: JSON.stringify({
          code: "POSTCONDITION_UNMET", correctionAttemptsRemaining: 1,
          checks: checks!.filter(check => !check.passed).map(check => ({
            expected: check.condition,
            ...(check.creationRecorded !== undefined ? { creationRecorded: check.creationRecorded } : {}),
            ...(check.deletionRecorded !== undefined ? { deletionRecorded: check.deletionRecorded } : {}),
            fileExists: check.fileExists,
          })),
        }) };
      }
      return { status: "failed", message };
    } : undefined;
    result = await runtime.run(execution.prompt, execution.approvalResume, verifyFinalAnswer);
    if (result.status === "failed" && correctionAttempted && !correctionOutcomeRecorded) {
      await options.store.appendStep(execution.taskRunId, options.workerId, {
        sequence: ++sequence, kind: "POSTCONDITION_CHECK",
        payload: { executionAttempt: execution.recoveryCount + 1, runtimeStep: result.steps,
          passed: false, verificationPerformed: false, correctionAttempt: 1, correctionOutcome: "FAILED",
          message: `Correction 1/1 failed: ${result.reason}. No final verification was reached.` },
      });
    }
  } finally {
    await heartbeat.stop();
  }
  if (result.status === "waiting_for_approval") {
    await options.store.waitForApproval(
      execution.taskId,
      execution.taskRunId,
      options.workerId,
      result.action,
      {
        sequence: sequence + 1,
        kind: "APPROVAL_REQUIRED",
        payload: {
          executionAttempt: execution.recoveryCount + 1,
          runtimeStep: result.action.runtimeStep,
          toolName: result.action.toolName,
          validatedArguments: result.action.validatedArguments,
        },
      },
    );
  } else {
    await options.store.finishExecution(
      execution.taskId,
      execution.taskRunId,
      options.workerId,
      result,
    );
  }
  return result;
}

function toPersistedStep(
  event: TraceEvent,
  sequence: number,
  executionAttempt: number,
): PersistedStep | null {
  switch (event.type) {
    case "model_call":
      return {
        sequence,
        kind: "MODEL_CALL",
        payload: {
          executionAttempt,
          runtimeStep: event.step,
          request: event.request,
        },
      };
    case "tool_requested":
      return {
        sequence,
        kind: "TOOL_CALL",
        payload: { executionAttempt, runtimeStep: event.step, toolCall: event.toolCall },
      };
    case "tool_result":
      return {
        sequence,
        kind: "TOOL_RESULT",
        payload: { executionAttempt, runtimeStep: event.step, name: event.name, result: event.result, readOnly: event.readOnly === true, ...(event.durationMs !== undefined ? { durationMs: event.durationMs } : {}), ...(event.outputLimit ? { outputLimit: event.outputLimit } : {}) },
      };
    case "final_answer":
      return {
        sequence,
        kind: "FINAL_ANSWER",
        payload: { executionAttempt, runtimeStep: event.step, answer: event.answer },
      };
    case "failed":
      return {
        sequence,
        kind: "RUNTIME_FAILURE",
        payload: {
          executionAttempt,
          runtimeStep: event.step,
          reason: event.reason,
          message: event.message,
          ...(event.details ? { details: event.details } : {}),
        },
      };
    default:
      return null;
  }
}

function object(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

class ExecutionHeartbeat {
  private timer: NodeJS.Timeout | undefined;
  private pending: Promise<void> = Promise.resolve();
  private failure: unknown;

  constructor(
    private readonly intervalMs: number,
    private readonly beat: () => Promise<void>,
  ) {
    if (!Number.isInteger(intervalMs) || intervalMs < 1) {
      throw new Error("heartbeatIntervalMs must be a positive integer");
    }
  }

  start(): void {
    this.timer = setInterval(() => {
      this.pending = this.pending.then(this.beat).catch((error: unknown) => {
        this.failure = error;
      });
    }, this.intervalMs);
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    await this.pending;
    if (this.failure) throw this.failure;
  }
}
