import "dotenv/config";
import { createPrismaClient, PrismaExecutionStore } from "./persistence/prisma-execution-store.js";
import { BullTaskRunQueue } from "./queue/agent-task-queue.js";
import { recoverStaleRuns } from "./recovery/recover-stale-runs.js";

async function main(): Promise<void> {
  const databaseUrl = requireEnvironment("DATABASE_URL");
  const redisUrl = process.env.REDIS_URL ?? "redis://127.0.0.1:6379";
  const leaseTimeoutMs = readInteger("FOUNDRY_LEASE_TIMEOUT_MS", 30_000);
  const maxRecoveries = readInteger("FOUNDRY_MAX_RECOVERIES", 2);
  const prisma = createPrismaClient(databaseUrl);
  const queue = new BullTaskRunQueue(redisUrl);
  try {
    const summary = await recoverStaleRuns({
      store: new PrismaExecutionStore(prisma),
      queue,
      now: new Date(),
      leaseTimeoutMs,
      maxRecoveries,
    });
    console.log(JSON.stringify(summary, null, 2));
  } finally {
    await queue.close();
    await prisma.$disconnect();
  }
}

function requireEnvironment(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function readInteger(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value)) throw new Error(`${name} must be an integer`);
  return value;
}

void main().catch((error: unknown) => {
  console.error(`Recovery failed: ${errorMessage(error)}`);
  process.exitCode = 1;
});

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
