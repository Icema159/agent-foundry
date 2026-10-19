import "dotenv/config";
import { randomUUID } from "node:crypto";
import { Worker, type Job } from "bullmq";
import { Redis } from "ioredis";
import { createRepositoryExplorer } from "./agents/repository-explorer.js";
import { ModelProviderFactory } from "./model/model-provider-factory.js";
import { createPrismaClient, PrismaExecutionStore } from "./persistence/prisma-execution-store.js";
import { AGENT_TASK_QUEUE, type AgentTaskJobData } from "./queue/agent-task-queue.js";
import type { TraceEvent } from "./runtime/agent-runtime.js";
import { RepositoryTools } from "./tools/repository-tools.js";
import { processTaskRun } from "./workers/task-run-processor.js";
import { DockerSandbox } from "./sandbox/docker-sandbox.js";

async function main(): Promise<void> {
  const databaseUrl = requireEnvironment("DATABASE_URL");
  const redisUrl = process.env.REDIS_URL ?? "redis://127.0.0.1:6379";
  const ollamaBaseUrl = process.env.OLLAMA_BASE_URL ?? "http://127.0.0.1:11434";
  const heartbeatIntervalMs = readPositiveInteger("FOUNDRY_HEARTBEAT_INTERVAL_MS", 5_000);
  const sandboxTimeoutMs = readPositiveInteger("FOUNDRY_SANDBOX_TIMEOUT_MS", 10_000);
  const workerId = randomUUID();
  const prisma = createPrismaClient(databaseUrl);
  const store = new PrismaExecutionStore(prisma);
  const providerFactory = new ModelProviderFactory({
    ollamaBaseUrl,
    openAIApiKey: process.env.OPENAI_API_KEY,
  });
  const sandbox = new DockerSandbox({
    image: process.env.FOUNDRY_SANDBOX_IMAGE ?? "agent-foundry-sandbox:phase7",
    timeoutMs: sandboxTimeoutMs,
  });
  const redis = new Redis(redisUrl, { maxRetriesPerRequest: null });
  const worker = new Worker<AgentTaskJobData>(
    AGENT_TASK_QUEUE,
    async (job: Job<AgentTaskJobData>) => {
      const taskRunId = requireTaskRunId(job.data);
      console.log(`Processing task run ${taskRunId}`);
      const result = await processTaskRun({
        taskRunId,
        workerId,
        heartbeatIntervalMs,
        store,
        createRuntime: async (execution, onTrace) => {
          const tools = await RepositoryTools.create(execution.workspaceRoot, { sandbox });
          return createRepositoryExplorer({
            provider: providerFactory.create(
              execution.agent.modelProvider,
              execution.agent.modelName,
            ),
            tools,
            maxSteps: execution.agent.maxSteps,
            toolPolicies: execution.agent.toolPolicies,
            systemInstructions: execution.agent.systemInstructions,
            claimApprovalAction: (approvalId) =>
              store.claimApprovalAction(execution.taskRunId, workerId, approvalId, new Date()),
            onTrace: async (event) => {
              printTrace(taskRunId, event);
              await onTrace(event);
            },
          });
        },
      });
      console.log(`Task run ${taskRunId} ${result.status}`);
      return { taskRunId, status: result.status };
    },
    { connection: redis, concurrency: 1, maxStalledCount: 0 },
  );

  worker.on("error", (error) => {
    console.error(`Worker error: ${error.message}`);
  });
  worker.on("failed", (job, error) => {
    console.error(`Queue job ${job?.id ?? "unknown"} for TaskRun ${job?.data?.taskRunId ?? "unknown"} failed: ${error.message}`);
  });
  console.log(`Worker ${workerId} listening on ${AGENT_TASK_QUEUE}`);

  let closing = false;
  const shutdown = async () => {
    if (closing) return;
    closing = true;
    console.log("Worker shutting down");
    await worker.close();
    await redis.quit();
    await prisma.$disconnect();
  };
  process.once("SIGINT", () => void shutdown());
  process.once("SIGTERM", () => void shutdown());
}

function requireTaskRunId(data: AgentTaskJobData): string {
  if (typeof data?.taskRunId !== "string" || data.taskRunId.trim() === "") {
    throw new Error("Queue job is missing taskRunId");
  }
  return data.taskRunId;
}

function printTrace(taskRunId: string, event: TraceEvent): void {
  if (event.type === "step") console.log(`[${taskRunId}] Step ${event.step}`);
  if (event.type === "tool_requested") {
    console.log(`[${taskRunId}] Tool requested: ${event.toolCall.name}`);
  }
  if (event.type === "final_answer") console.log(`[${taskRunId}] Final answer`);
}

function requireEnvironment(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function readPositiveInteger(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) throw new Error(`${name} must be a positive integer`);
  return value;
}

void main().catch((error: unknown) => {
  console.error(`Worker failed to start: ${errorMessage(error)}`);
  process.exitCode = 1;
});

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
