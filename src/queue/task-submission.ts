import type { AgentDefinition, ExecutionStore } from "../persistence/execution-store.js";
import type { TaskRunQueue } from "./agent-task-queue.js";
import { parsePostconditions, type TaskPostcondition } from "../verification/task-postconditions.js";

export async function submitTask(options: {
  store: ExecutionStore;
  queue: TaskRunQueue;
  agent: AgentDefinition;
  prompt: string;
  workspaceRoot: string;
  postconditions?: TaskPostcondition[];
  onCreated?: (pending: { taskId: string; taskRunId: string }) => Promise<void>;
}): Promise<{ taskId: string; taskRunId: string; jobId: string }> {
  const postconditions = parsePostconditions(options.postconditions ?? []);
  const resolved = await options.store.resolveAgentVersion(options.agent);
  const pending = await options.store.createPendingExecution(
    resolved.agentId,
    resolved.agentVersionId,
    options.prompt,
    options.workspaceRoot,
    postconditions,
  );
  await options.onCreated?.(pending);
  const job = await options.queue.enqueue(pending.taskRunId);
  return { ...pending, jobId: job.jobId };
}
