import "dotenv/config";
import path from "node:path";
import { createDashboardServer } from "./dashboard/server.js";
import { createPrismaClient, PrismaExecutionStore } from "./persistence/prisma-execution-store.js";
import { PrismaRunReader } from "./observability/prisma-run-reader.js";
import { RunQueryService } from "./observability/run-query.js";
import { BullTaskRunQueue } from "./queue/agent-task-queue.js";
import { decideApprovalAndEnqueue } from "./approvals/approval-service.js";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required");
const port = Number(process.env.FOUNDRY_DASHBOARD_PORT ?? 3000);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Invalid dashboard port");
const prisma = createPrismaClient(databaseUrl);
const store = new PrismaExecutionStore(prisma);
const queue = new BullTaskRunQueue(process.env.REDIS_URL ?? "redis://127.0.0.1:6379");
const server = createDashboardServer({
  runs: new RunQueryService(new PrismaRunReader(prisma)),
  listApprovals: () => store.listPendingApprovals(),
  decideApproval: (approvalId, decision) => decideApprovalAndEnqueue({ store, queue, approvalId, decision }),
}, path.resolve("dist/dashboard-public"));
server.listen(port, "127.0.0.1", () => console.log(`Foundry dashboard: http://127.0.0.1:${port}`));
let closing = false;
async function shutdown() {
  if (closing) return;
  closing = true;
  server.close();
  await queue.close();
  await prisma.$disconnect();
}
process.once("SIGINT", () => void shutdown());
process.once("SIGTERM", () => void shutdown());
server.on("error", (error) => { console.error(error.message); void shutdown(); process.exitCode = 1; });
