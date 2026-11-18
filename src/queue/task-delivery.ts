import type { DeliveryOutcome, ExecutionStore, PendingDelivery } from "../persistence/execution-store.js";
import { EnqueueNotSent, type TaskRunQueue } from "./agent-task-queue.js";

export async function dispatchTrackedDelivery(options: {
  pending: Required<PendingDelivery>;
  attemptId: string;
  queue: TaskRunQueue;
  finish: (attemptId: string, outcome: DeliveryOutcome) => Promise<void>;
}): Promise<{ jobId: string }> {
  const { taskRunId, deliveryId } = options.pending;
  let outcome: DeliveryOutcome;
  try {
    const receipt = await options.queue.enqueue(taskRunId, deliveryId);
    outcome = receipt.jobId === deliveryId ? "CONFIRMED" : "ACK_UNKNOWN";
  } catch (error) {
    outcome = error instanceof EnqueueNotSent ? "NOT_SENT" : "ACK_UNKNOWN";
  }
  try {
    await options.finish(options.attemptId, outcome);
  } catch {
    throw new Error(`Delivery for TaskRun ${taskRunId} is UNCONFIRMED; inspect before retrying`);
  }
  if (outcome !== "CONFIRMED") {
    throw new Error(`Delivery for TaskRun ${taskRunId} is ${outcome}; inspect before retrying`);
  }
  return { jobId: deliveryId };
}

export async function deliverTaskRun(
  store: ExecutionStore, queue: TaskRunQueue, pending: PendingDelivery, actor: string,
): Promise<{ jobId: string }> {
  if (!pending.deliveryId) return queue.enqueue(pending.taskRunId);
  if (!store.beginDeliveryAttempt || !store.finishDeliveryAttempt) throw new Error("Delivery store is required");
  let attemptId: string;
  try {
    attemptId = await store.beginDeliveryAttempt(pending.deliveryId, actor);
  } catch {
    throw new Error(`Delivery for TaskRun ${pending.taskRunId} is UNCONFIRMED; inspect before retrying`);
  }
  return dispatchTrackedDelivery({
    pending: { taskRunId: pending.taskRunId, deliveryId: pending.deliveryId },
    attemptId, queue, finish: store.finishDeliveryAttempt.bind(store),
  });
}
