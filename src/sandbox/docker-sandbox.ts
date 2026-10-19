import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { SandboxError, type Sandbox, type SandboxRequest } from "./sandbox.js";

export type DockerSandboxOptions = {
  image?: string;
  timeoutMs?: number;
  memory?: string;
  cpus?: string;
  pidsLimit?: number;
};

export class DockerSandbox implements Sandbox {
  private readonly image: string;
  private readonly timeoutMs: number;
  private readonly memory: string;
  private readonly cpus: string;
  private readonly pidsLimit: number;

  constructor(options: DockerSandboxOptions = {}) {
    this.image = options.image ?? "agent-foundry-sandbox:phase7";
    this.timeoutMs = options.timeoutMs ?? 10_000;
    this.memory = options.memory ?? "128m";
    this.cpus = options.cpus ?? "0.5";
    this.pidsLimit = options.pidsLimit ?? 64;
    if (!Number.isInteger(this.timeoutMs) || this.timeoutMs < 1) {
      throw new Error("Sandbox timeoutMs must be a positive integer");
    }
  }

  async execute(request: SandboxRequest): Promise<unknown> {
    const workspaceRoot = await fs.realpath(path.resolve(request.workspaceRoot));
    const containerName = `foundry-sandbox-${randomUUID()}`;
    const args = [
      "run",
      "--rm",
      "-i",
      "--name",
      containerName,
      "--network",
      "none",
      "--read-only",
      "--cap-drop",
      "ALL",
      "--security-opt",
      "no-new-privileges:true",
      "--memory",
      this.memory,
      "--cpus",
      this.cpus,
      "--pids-limit",
      String(this.pidsLimit),
      "--tmpfs",
      "/tmp:rw,noexec,nosuid,size=16m",
      "--mount",
      `type=bind,src=${workspaceRoot},dst=/workspace`,
      this.image,
    ];

    return new Promise((resolve, reject) => {
      const child = spawn("docker", args, { stdio: ["pipe", "pipe", "pipe"] });
      let stdout = "";
      let stderr = "";
      let settled = false;
      const finish = (callback: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        callback();
      };
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        void removeContainer(containerName);
        finish(() => reject(new SandboxError("SANDBOX_TIMEOUT", `Sandbox exceeded ${this.timeoutMs}ms`)));
      }, this.timeoutMs);

      child.once("error", (error) => {
        finish(() => reject(new SandboxError("SANDBOX_UNAVAILABLE", error.message)));
      });
      child.stdout.on("data", (chunk: Buffer) => {
        stdout += chunk.toString("utf8");
        if (stdout.length > 1_000_000) child.kill("SIGKILL");
      });
      child.stderr.on("data", (chunk: Buffer) => {
        stderr += chunk.toString("utf8");
        if (stderr.length > 1_000_000) child.kill("SIGKILL");
      });
      child.once("close", (code) => {
        finish(() => {
          const parsed = parseOutput(stdout);
          if (code !== 0 || !parsed.ok) {
            const failureCode = parsed.code ?? classifyDockerFailure(stderr);
            reject(
              new SandboxError(
                failureCode,
                parsed.message ?? (stderr.trim() || `Sandbox exited with code ${code}`),
              ),
            );
            return;
          }
          resolve(parsed.result);
        });
      });
      child.stdin.end(JSON.stringify({ toolName: request.toolName, arguments: request.arguments }));
    });
  }
}

type RunnerOutput = {
  ok: boolean;
  result?: unknown;
  code?: "SANDBOX_EXECUTION_FAILED" | "SANDBOX_POLICY_VIOLATION";
  message?: string;
};

function parseOutput(stdout: string): RunnerOutput {
  try {
    const value = JSON.parse(stdout) as RunnerOutput;
    if (typeof value.ok !== "boolean") throw new Error("missing ok");
    return value;
  } catch {
    return { ok: false, code: "SANDBOX_EXECUTION_FAILED", message: "Sandbox returned invalid output" };
  }
}

function classifyDockerFailure(stderr: string): "SANDBOX_UNAVAILABLE" | "SANDBOX_EXECUTION_FAILED" {
  return /cannot connect|daemon|no such image/i.test(stderr)
    ? "SANDBOX_UNAVAILABLE"
    : "SANDBOX_EXECUTION_FAILED";
}

async function removeContainer(name: string): Promise<void> {
  await new Promise<void>((resolve) => {
    const cleanup = spawn("docker", ["rm", "-f", name], { stdio: "ignore" });
    cleanup.once("error", () => resolve());
    cleanup.once("close", () => resolve());
  });
}
