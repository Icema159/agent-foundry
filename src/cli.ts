import "dotenv/config";
import { promises as fs } from "node:fs";
import path from "node:path";
import { repositoryExplorerInstructions, repositoryExplorerDefaultVersion } from "./agents/repository-explorer.js";
import { createPrismaClient, PrismaExecutionStore } from "./persistence/prisma-execution-store.js";
import { BullTaskRunQueue } from "./queue/agent-task-queue.js";
import { submitTask } from "./queue/task-submission.js";
import { parseTaskInput } from "./cli/task-input.js";

async function main(): Promise<void> {
  const { prompt, postconditions } = parseTaskInput(process.argv.slice(2));

  const databaseUrl = requireEnvironment("DATABASE_URL");
  const redisUrl = process.env.REDIS_URL ?? "redis://127.0.0.1:6379";
  const workspaceRoot = await resolveWorkspaceRoot(
    process.env.FOUNDRY_WORKSPACE_ROOT ?? process.cwd(),
  );
  const modelProvider = process.env.FOUNDRY_MODEL_PROVIDER ?? "ollama";
  const model = resolveModel(modelProvider, process.env.FOUNDRY_MODEL);
  const agentVersion = readPositiveInteger(
    "FOUNDRY_AGENT_VERSION",
    repositoryExplorerDefaultVersion(modelProvider),
  );
  const maxSteps = 8;
  const prisma = createPrismaClient(databaseUrl);
  const queue = new BullTaskRunQueue(redisUrl);

  try {
    const submission = await submitTask({
      store: new PrismaExecutionStore(prisma),
      queue,
      agent: {
        name: "repository-explorer",
        description: "Foundry-owned read-only repository analysis agent",
        version: agentVersion,
        systemInstructions: repositoryExplorerInstructions,
        modelProvider,
        modelName: model,
        maxSteps,
        toolPolicies: {
          list_files: "ALLOW",
          search_files: "ALLOW",
          read_file: "ALLOW",
          create_file: "REQUIRE_APPROVAL",
          delete_file: "REQUIRE_APPROVAL",
        },
      },
      prompt,
      postconditions,
      workspaceRoot,
    });
    console.log("Task submitted");
    console.log(`Task: ${submission.taskId}`);
    console.log(`Task run: ${submission.taskRunId}`);
    console.log(`Queue job: ${submission.jobId}`);
  } finally {
    await queue.close();
    await prisma.$disconnect();
  }
}

async function resolveWorkspaceRoot(configuredPath: string): Promise<string> {
  const root = await fs.realpath(path.resolve(configuredPath));
  if (!(await fs.stat(root)).isDirectory()) throw new Error("Workspace root must be a directory");
  return root;
}

function requireEnvironment(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function resolveModel(provider: string, configuredModel: string | undefined): string {
  if (configuredModel?.trim()) return configuredModel.trim();
  if (provider === "ollama") return "qwen3.5:9b";
  throw new Error(`FOUNDRY_MODEL is required for provider: ${provider}`);
}

function readPositiveInteger(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) throw new Error(`${name} must be a positive integer`);
  return value;
}

void main().catch((error: unknown) => {
  console.error(`Task submission failed: ${errorMessage(error)}`);
  process.exitCode = 1;
});

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
