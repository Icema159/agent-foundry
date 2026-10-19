import { promises as fs } from "node:fs";
import path from "node:path";

export type TaskPostcondition = { type: "file_created" | "file_deleted"; path: string };
export type PostconditionCheck = {
  condition: TaskPostcondition;
  passed: boolean;
  creationRecorded?: boolean;
  deletionRecorded?: boolean;
  fileExists: boolean;
  message: string;
};

export function parsePostconditions(value: unknown): TaskPostcondition[] {
  if (!Array.isArray(value)) throw new Error("Task postconditions must be an array");
  return value.map((item: unknown) => {
    const condition = object(item);
    if ((condition.type !== "file_created" && condition.type !== "file_deleted") || typeof condition.path !== "string" ||
        Object.keys(condition).some(key => key !== "type" && key !== "path")) {
      throw new Error("Expected file_created or file_deleted postcondition with a workspace-relative path");
    }
    return { type: condition.type, path: normalizeExpectedPath(condition.path) };
  });
}

function normalizeExpectedPath(value: string): string {
  if (!value.trim() || value.includes("\0") || path.isAbsolute(value) || value.split(path.sep).includes("..")) {
    throw new Error("Expected file path must be relative to the workspace without traversal");
  }
  const normalized = path.normalize(value);
  if (normalized === "." || normalized.endsWith(path.sep)) throw new Error("Expected path must name a file");
  return normalized;
}

export class TaskPostconditionVerifier {
  async verify(workspaceRoot: string, conditions: TaskPostcondition[], toolResults: unknown[]): Promise<PostconditionCheck[]> {
    const validated = parsePostconditions(conditions);
    const root = await fs.realpath(workspaceRoot);
    const checks: PostconditionCheck[] = [];
    for (const condition of validated) {
      if (condition.type === "file_deleted") {
        const deletionRecorded = toolResults.some(payload => {
          const event = object(payload);
          const result = object(event.result);
          if (event.name !== "delete_file" || result.deleted !== true || result.error !== undefined || typeof result.path !== "string") return false;
          try { return normalizeExpectedPath(result.path) === condition.path; } catch { return false; }
        });
        let absent = false;
        try {
          const candidate = path.resolve(root, condition.path);
          const parent = await fs.realpath(path.dirname(candidate));
          const relative = path.relative(root, parent);
          if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error("Parent escapes workspace");
          try { await fs.lstat(path.join(parent, path.basename(candidate))); }
          catch (error) { if (object(error).code === "ENOENT") absent = true; else throw error; }
        } catch { /* Cannot verify a missing file through an unsafe or inaccessible parent. */ }
        const passed = deletionRecorded && absent;
        checks.push({ condition, passed, deletionRecorded, fileExists: !absent,
          message: passed ? `Verified deletion of ${condition.path}` : `${condition.path}: ${[
            ...(!deletionRecorded ? ["no successful delete_file result in this TaskRun"] : []),
            ...(!absent ? ["file still exists or absence could not be verified safely"] : []),
          ].join("; ")}`,
        });
        continue;
      }
      const creationRecorded = toolResults.some(payload => {
        const event = object(payload);
        const result = object(event.result);
        if (event.name !== "create_file" || result.created !== true || result.error !== undefined || typeof result.path !== "string") return false;
        try { return normalizeExpectedPath(result.path) === condition.path; } catch { return false; }
      });
      let fileExists = false;
      let problem = "File is missing or is not a regular file inside the workspace";
      try {
        const candidate = path.resolve(root, condition.path);
        const real = await fs.realpath(candidate);
        const relative = path.relative(root, real);
        const inside = relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
        const stat = await fs.lstat(candidate);
        fileExists = inside && stat.isFile() && !stat.isSymbolicLink();
      } catch (error) {
        const code = object(error).code;
        if (code !== "ENOENT" && code !== "ENOTDIR") problem = `File verification failed: ${error instanceof Error ? error.message : String(error)}`;
      }
      const passed = creationRecorded && fileExists;
      checks.push({ condition, passed, creationRecorded, fileExists,
        message: passed ? `Verified creation of ${condition.path}` :
          `${condition.path}: ${[...(!creationRecorded ? ["no successful create_file result in this TaskRun"] : []), ...(!fileExists ? [problem] : [])].join("; ")}`,
      });
    }
    return checks;
  }
}

function object(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? value as Record<string, unknown> : {};
}
