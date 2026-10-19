import type { ApprovalDecision, ExecutionStore } from "../persistence/execution-store.js";
import type { TaskRunQueue } from "../queue/agent-task-queue.js";

export async function decideApprovalAndEnqueue(options: {
  store: ExecutionStore;
  queue: TaskRunQueue;
  approvalId: string;
  decision: ApprovalDecision;
}): Promise<{ taskRunId: string; jobId: string }> {
  const decision = await options.store.decideApproval(options.approvalId, options.decision);
  const job = await options.queue.enqueue(decision.taskRunId);
  return { taskRunId: decision.taskRunId, jobId: job.jobId };
}
