import type { AgentDefinition, ExecutionStore } from "../persistence/execution-store.js";
import type { TaskRunQueue } from "../queue/agent-task-queue.js";
import { submitTask } from "../queue/task-submission.js";
import type { RunDetails } from "../observability/run-query.js";
import { defineEvalCase, type EvalCase } from "./cases.js";
import { incompleteResult, scoreEval, type EvalResult } from "./scorer.js";
import type { EvalStore } from "./store.js";

export class EvalRunner {
  constructor(private readonly dependencies: {
    store: ExecutionStore; queue: TaskRunQueue; evals: EvalStore;
    runs: { get(id: string): Promise<RunDetails | null> };
    now?: () => number; sleep?: (milliseconds: number) => Promise<void>;
  }) {}

  async run(definition: EvalCase, agent: AgentDefinition, workspaceRoot: string, timeoutMs = 300_000) {
    const evalCase = defineEvalCase(definition);
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) throw new Error("Eval timeout must be a positive integer");
    const now = this.dependencies.now ?? Date.now;
    const sleep = this.dependencies.sleep ?? ((ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
    let evalRunId: string | null = null;
    let taskRunId: string | null = null;
    let latest: RunDetails | null = null;
    let result: EvalResult;
    try {
      await submitTask({ ...this.dependencies, agent, prompt: evalCase.prompt, workspaceRoot,
        onCreated: async (pending) => {
          taskRunId = pending.taskRunId;
          evalRunId = await this.dependencies.evals.create(evalCase, pending.taskRunId);
        },
      });
      const deadline = now() + timeoutMs;
      for (;;) {
        latest = await this.dependencies.runs.get(taskRunId!);
        if (!latest) throw new Error(`TaskRun not found: ${taskRunId}`);
        if (latest.status === "COMPLETED" || latest.status === "FAILED") {
          result = scoreEval(evalCase, latest);
          break;
        }
        if (now() >= deadline) {
          result = incompleteResult(evalCase, "TIMED_OUT", "Eval wait expired; TaskRun was not cancelled and may still finish.", latest);
          break;
        }
        await sleep(Math.min(1000, deadline - now()));
      }
    } catch (error) {
      result = incompleteResult(evalCase, "INFRASTRUCTURE_FAILED", error instanceof Error ? error.message : String(error), latest);
    }
    if (evalRunId) await this.dependencies.evals.finish(evalRunId, result);
    return { evalRunId, taskRunId, result };
  }
}
