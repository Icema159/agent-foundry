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
    const safe = options.canRecover?.(run) ?? isReadOnlyRepositoryRun(run);
    if (!safe) {
      await options.store.failStaleExecution(
        run.taskId,
        run.taskRunId,
        "Whole-run recovery is only enabled for the read-only Repository Explorer agent",
      );
      summary.failedUnsafe += 1;
      continue;
    }
    const decision = await options.store.recoverStaleExecution(
      run.taskRunId,
      staleBefore,
      options.maxRecoveries,
    );
    if (decision.action === "REQUEUE") {
      try {
        await options.queue.enqueue(run.taskRunId);
        summary.requeued += 1;
      } catch (error) {
        await options.store.failStaleExecution(
          run.taskId,
          run.taskRunId,
          `Recovery enqueue failed: ${errorMessage(error)}`,
        );
        throw error;
      }
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
        (policy === "ALLOW" && READ_ONLY_REPOSITORY_TOOLS.has(toolName)) ||
        (policy === "REQUIRE_APPROVAL" && toolName === "create_file"),
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

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
