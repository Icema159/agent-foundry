import "dotenv/config";
import { createPrismaClient, PrismaExecutionStore } from "./persistence/prisma-execution-store.js";
import { BullTaskRunQueue } from "./queue/agent-task-queue.js";
import { decideApprovalAndEnqueue } from "./approvals/approval-service.js";

async function main(): Promise<void> {
  const command = process.argv[2];
  const databaseUrl = requireEnvironment("DATABASE_URL");
  const prisma = createPrismaClient(databaseUrl);
  const store = new PrismaExecutionStore(prisma);

  try {
    if (command === "list") {
      const approvals = await store.listPendingApprovals();
      if (approvals.length === 0) {
        console.log("No pending approvals");
        return;
      }
      for (const approval of approvals) {
        console.log(JSON.stringify(approval, null, 2));
      }
      return;
    }

    if (command !== "approve" && command !== "deny") {
      throw new Error("Usage: approval-cli <list|approve|deny> [approvalId]");
    }
    const approvalId = process.argv[3]?.trim();
    if (!approvalId) throw new Error(`${command} requires an approvalId`);
    const decision = command === "approve" ? "APPROVED" : "DENIED";
    const queue = new BullTaskRunQueue(process.env.REDIS_URL ?? "redis://127.0.0.1:6379");
    try {
      const result = await decideApprovalAndEnqueue({ store, queue, approvalId, decision });
      console.log(`${decision}: ${approvalId}`);
      console.log(`Task run: ${result.taskRunId}`);
      console.log(`Queue job: ${result.jobId}`);
    } finally {
      await queue.close();
    }
  } finally {
    await prisma.$disconnect();
  }
}

function requireEnvironment(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
