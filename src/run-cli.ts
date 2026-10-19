import "dotenv/config";
import { createPrismaClient } from "./persistence/prisma-execution-store.js";
import { formatRunDetails, formatRunList } from "./observability/format-runs.js";
import { PrismaRunReader } from "./observability/prisma-run-reader.js";
import { RunQueryService } from "./observability/run-query.js";

async function main(): Promise<void> {
  const mode = process.argv[2];
  const taskRunId = process.argv[3];
  if (mode !== "list" && mode !== "show") throw new Error("Usage: npm run runs OR npm run run -- TASK_RUN_ID");
  if (mode === "show" && !taskRunId) throw new Error("Usage: npm run run -- TASK_RUN_ID");
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error("DATABASE_URL is required");
  const prisma = createPrismaClient(databaseUrl);
  try {
    const query = new RunQueryService(new PrismaRunReader(prisma));
    if (mode === "list") {
      console.log(formatRunList(await query.listRecent()));
      return;
    }
    const run = await query.get(taskRunId!);
    if (!run) throw new Error(`TaskRun not found: ${taskRunId}`);
    console.log(formatRunDetails(run));
  } finally {
    await prisma.$disconnect();
  }
}

void main().catch((error: unknown) => {
  console.error(`Run inspection failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
