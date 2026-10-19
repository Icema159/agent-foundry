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
  enqueue(taskRunId: string): Promise<{ jobId: string }>;
  close(): Promise<void>;
}

export class BullTaskRunQueue implements TaskRunQueue {
  private readonly connection: Redis;
  private readonly queue: Queue<AgentTaskJobData>;

  constructor(redisUrl: string) {
    this.connection = new Redis(redisUrl, {
      maxRetriesPerRequest: 1,
      enableOfflineQueue: false,
    });
    this.queue = new Queue<AgentTaskJobData>(AGENT_TASK_QUEUE, {
      connection: this.connection,
    });
  }

  async enqueue(taskRunId: string): Promise<{ jobId: string }> {
    const job = await this.queue.add(
      AGENT_TASK_JOB,
      createAgentTaskJobData(taskRunId),
      { attempts: 1 },
    );
    if (!job.id) throw new Error("BullMQ did not return a job id");
    return { jobId: job.id };
  }

  async close(): Promise<void> {
    await this.queue.close();
    await this.connection.quit();
  }
}
