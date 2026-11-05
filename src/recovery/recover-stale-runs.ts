import type { ExecutionStore, StaleExecution } from "../persistence/execution-store.js";
import type { TaskRunQueue } from "../queue/agent-task-queue.js";

const READ_ONLY_REPOSITORY_TOOLS = new Set(["list_files", "search_files", "read_file"]);

export type RecoverySummary = {
  requeued: number;
  failedLimit: number;
  failedUnsafe: number;
  skipped: number;
};

export async function recoverStaleRuns(options: {
  store: ExecutionStore;
  queue: TaskRunQueue;
  now: Date;
  leaseTimeoutMs: number;
  maxRecoveries: number;
  canRecover?: (run: StaleExecution) => boolean;
}): Promise<RecoverySummary> {
  validatePositiveInteger(options.leaseTimeoutMs, "leaseTimeoutMs");
  validateNonNegativeInteger(options.maxRecoveries, "maxRecoveries");
  const staleBefore = new Date(options.now.getTime() - options.leaseTimeoutMs);
  const staleRuns = await options.store.findStaleExecutions(staleBefore);
  const summary: RecoverySummary = {
    requeued: 0,
    failedLimit: 0,
    failedUnsafe: 0,
    skipped: 0,
  };

  for (const run of staleRuns) {
    // Custom policy may restrict recovery further, never enable write replay.
    const safe = isReadOnlyRepositoryRun(run) && (options.canRecover?.(run) ?? true);
    if (!safe) {
      const failed = await options.store.failStaleExecution(
        run.taskId,
        run.taskRunId,
        staleBefore,
        "Whole-run recovery requires a strictly read-only Repository Explorer configuration. Execution was not restarted; prior side-effect outcomes may be unknown. Marking FAILED does not roll back or cancel in-flight actions.",
      );
      if (failed) summary.failedUnsafe += 1;
      else summary.skipped += 1;
      continue;
    }
    const decision = await options.store.recoverStaleExecution(
      run.taskRunId,
      staleBefore,
      options.maxRecoveries,
    );
    if (decision.action === "REQUEUE") {
      // DB and delivery are not atomic. On enqueue errors, propagate the error
      // without overwriting PENDING or a run already claimed by another worker.
      await options.queue.enqueue(run.taskRunId);
      summary.requeued += 1;
    } else if (decision.action === "FAILED_LIMIT") {
      summary.failedLimit += 1;
    } else {
      summary.skipped += 1;
    }
  }
  return summary;
}

export function isReadOnlyRepositoryRun(run: StaleExecution): boolean {
  return (
    run.agentName === "repository-explorer" &&
    Object.entries(run.toolPolicies).every(
      ([toolName, policy]) =>
        policy === "DENY" ||
        (policy === "ALLOW" && READ_ONLY_REPOSITORY_TOOLS.has(toolName)),
    )
  );
}

function validatePositiveInteger(value: number, name: string): void {
  if (!Number.isInteger(value) || value < 1) throw new Error(`${name} must be a positive integer`);
}

function validateNonNegativeInteger(value: number, name: string): void {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${name} must be a non-negative integer`);
  }
}
