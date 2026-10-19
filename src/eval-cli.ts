import "dotenv/config";
import { realpath, stat } from "node:fs/promises";
import { createPrismaClient, PrismaExecutionStore } from "./persistence/prisma-execution-store.js";
import { BullTaskRunQueue } from "./queue/agent-task-queue.js";
import { RunQueryService } from "./observability/run-query.js";
import { PrismaRunReader } from "./observability/prisma-run-reader.js";
import { evalCases, getEvalCase } from "./evals/cases.js";
import { evalAgent } from "./evals/config.js";
import { PrismaEvalStore, comparison } from "./evals/store.js";
import { EvalRunner } from "./evals/runner.js";
import { repositoryExplorerDefaultVersion } from "./agents/repository-explorer.js";

async function main() {
  const [command, id, ...args] = process.argv.slice(2);
  if (command === "list") {
    console.log(JSON.stringify(evalCases, null, 2));
    return;
  }
  if ((command !== "run" && command !== "compare") || !id) throw new Error("Usage: eval EVAL_CASE_ID [--model provider/model@version] (repeat --model to compare)");
  const definition = getEvalCase(id);
  const specs: string[] = [];
  for (let i = 0; i < args.length; i += 2) {
    if (command !== "run" || args[i] !== "--model" || !args[i + 1]) throw new Error("Expected --model provider/model@version");
    specs.push(args[i + 1]!);
  }
  const provider = process.env.FOUNDRY_MODEL_PROVIDER ?? "ollama";
  if (!specs.length) specs.push(`${provider}/${process.env.FOUNDRY_MODEL ?? (provider === "ollama" ? "qwen3.5:9b" : "")}@${process.env.FOUNDRY_AGENT_VERSION ?? repositoryExplorerDefaultVersion(provider)}`);
  const agents = command === "run" ? specs.map(evalAgent) : [];
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required");
  const prisma = createPrismaClient(process.env.DATABASE_URL);
  const evals = new PrismaEvalStore(prisma);
  let queue: BullTaskRunQueue | undefined;
  try {
    if (command === "compare") {
      console.log(JSON.stringify(comparison(await evals.list(id)), null, 2));
      return;
    }
    const root = await realpath(process.env.FOUNDRY_WORKSPACE_ROOT ?? process.cwd());
    if (!(await stat(root)).isDirectory()) throw new Error("Workspace root must be a directory");
    queue = new BullTaskRunQueue(process.env.REDIS_URL ?? "redis://127.0.0.1:6379");
    const runner = new EvalRunner({ store: new PrismaExecutionStore(prisma), queue, evals,
      runs: new RunQueryService(new PrismaRunReader(prisma)) });
    for (const agent of agents) {
      console.log(`Evaluating ${id}: ${agent.modelProvider}/${agent.modelName}@${agent.version}`);
      const outcome = await runner.run(definition, agent, root, Number(process.env.FOUNDRY_EVAL_TIMEOUT_MS ?? 300_000));
      console.log(JSON.stringify(outcome, null, 2));
      if (outcome.result.outcome !== "PASSED") process.exitCode = 1;
    }
  } finally {
    try { await queue?.close(); } finally { await prisma.$disconnect(); }
  }
}
void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
