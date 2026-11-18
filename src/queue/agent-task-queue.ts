import { Queue } from "bullmq";
import { Redis } from "ioredis";

export const AGENT_TASK_QUEUE = "agent-task-execution";
export const AGENT_TASK_JOB = "execute-task-run";

export type AgentTaskJobData = {
  taskRunId: string;
};

export function createAgentTaskJobData(taskRunId: string): AgentTaskJobData {
  return { taskRunId };
}

export interface TaskRunQueue {
  enqueue(taskRunId: string, deliveryId?: string): Promise<{ jobId: string }>;
  close(): Promise<void>;
}

export class EnqueueNotSent extends Error {
  constructor() { super("Redis was unavailable before enqueue"); }
}

const QUEUE_TIMEOUT_MS = 3000;
async function bounded<T>(operation: Promise<T>): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([operation, new Promise<never>((_, reject) => {
      timeout = setTimeout(() => reject(new Error("Queue operation timed out")), QUEUE_TIMEOUT_MS);
    })]);
  } finally {
    clearTimeout(timeout);
  }
}

export class BullTaskRunQueue implements TaskRunQueue {
  private readonly connection: Redis;
  private readonly queue: Queue<AgentTaskJobData>;

  constructor(redisUrl: string) {
    this.connection = new Redis(redisUrl, {
      maxRetriesPerRequest: 1,
      enableOfflineQueue: false,
      commandTimeout: QUEUE_TIMEOUT_MS,
    });
    this.queue = new Queue<AgentTaskJobData>(AGENT_TASK_QUEUE, {
      connection: this.connection,
    });
    // Queue methods surface bounded errors to callers, which record sanitized evidence.
    this.queue.on("error", () => {});
  }

  async enqueue(taskRunId: string, deliveryId?: string): Promise<{ jobId: string }> {
    try {
      await bounded(this.queue.waitUntilReady());
      if (this.connection.status !== "ready") throw new EnqueueNotSent();
    } catch {
      throw new EnqueueNotSent();
    }
    const job = await bounded(this.queue.add(
      AGENT_TASK_JOB,
      createAgentTaskJobData(taskRunId),
      { attempts: 1, ...(deliveryId ? { jobId: deliveryId } : {}) },
    ));
    if (!job.id) throw new Error("BullMQ did not return a job id");
    return { jobId: job.id };
  }

  async inspect(taskRunId: string, deliveryId: string): Promise<string> {
    return bounded((async () => {
      const job = await this.queue.getJob(deliveryId);
      if (!job) return "missing";
      if (job.name !== AGENT_TASK_JOB || job.data.taskRunId !== taskRunId) return "identity-mismatch";
      // If the job disappears between reads, retain evidence that it existed.
      const state = await job.getState();
      return state === "unknown" ? "observed-then-unknown" : state;
    })());
  }

  async close(): Promise<void> {
    this.connection.disconnect();
    await this.queue.close();
  }
}
