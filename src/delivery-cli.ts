import "dotenv/config";
import { userInfo } from "node:os";
import { createPrismaClient } from "./persistence/prisma-execution-store.js";
import { BullTaskRunQueue } from "./queue/agent-task-queue.js";
import { DeliveryReconciliation } from "./queue/delivery-reconciliation.js";

async function main() {
  const [mode, taskRunId, ...extra] = process.argv.slice(2);
  const validId = taskRunId && /^[a-zA-Z0-9_-]{1,128}$/.test(taskRunId);
  if (extra.length || (mode === "list" ? taskRunId !== undefined : !["inspect", "reconcile"].includes(mode ?? "") || !validId)) {
    throw new Error("Usage: npm run delivery -- list | inspect TASK_RUN_ID | reconcile TASK_RUN_ID");
  }
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is required");
  const db = createPrismaClient(url);
  const queue = new BullTaskRunQueue(process.env.REDIS_URL ?? "redis://127.0.0.1:6379");
  try {
    const delivery = new DeliveryReconciliation(db, queue);
    const result = mode === "list" ? await delivery.list() : mode === "inspect" ? await delivery.inspect(taskRunId!)
      : await delivery.reconcile(taskRunId!, `local:${userInfo().username}`);
    console.log(JSON.stringify(result, null, 2));
  } finally {
    await Promise.allSettled([queue.close(), db.$disconnect()]);
  }
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "Delivery command failed");
  process.exitCode = 1;
});
