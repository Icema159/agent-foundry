import { promises as fs } from "node:fs";
import path from "node:path";

const WORKSPACE_ROOT = "/workspace";

type Request = { toolName?: unknown; arguments?: unknown };

async function main(): Promise<void> {
  const request = JSON.parse(await readStdin()) as Request;
  if (request.toolName !== "create_file" && request.toolName !== "delete_file") {
    return fail("SANDBOX_POLICY_VIOLATION", "Tool is not available in this sandbox");
  }
  const deleting = request.toolName === "delete_file";
  const args = exactObject(request.arguments, deleting ? ["path"] : ["path", "content"]);
  const relativePath = nonEmptyString(args.path, "path");
  const content = deleting ? undefined : stringValue(args.content, "content");
  if (path.isAbsolute(relativePath)) {
    return fail("SANDBOX_POLICY_VIOLATION", "File path must be relative to /workspace");
  }
  const candidate = path.resolve(WORKSPACE_ROOT, relativePath);
  if (deleting && (candidate === WORKSPACE_ROOT || relativePath.split(path.sep).includes(".."))) {
    return fail("SANDBOX_POLICY_VIOLATION", "Cannot delete the workspace root or use parent traversal");
  }
  if (!isInside(WORKSPACE_ROOT, candidate)) {
    return fail("SANDBOX_POLICY_VIOLATION", "File path escapes /workspace");
  }
  let realParent: string;
  try {
    realParent = await fs.realpath(path.dirname(candidate));
  } catch (error) {
    return fail("SANDBOX_EXECUTION_FAILED", errorMessage(error));
  }
  if (!isInside(WORKSPACE_ROOT, realParent)) {
    return fail("SANDBOX_POLICY_VIOLATION", "File path resolves outside /workspace");
  }
  const target = path.join(realParent, path.basename(candidate));
  if (deleting) {
    try {
      const stat = await fs.lstat(target);
      if (!stat.isFile() || stat.isSymbolicLink()) return fail("SANDBOX_POLICY_VIOLATION", "delete_file requires a regular file, not a directory or symlink");
      await fs.unlink(target);
    } catch (error) {
      return fail("SANDBOX_EXECUTION_FAILED", errorMessage(error));
    }
    process.stdout.write(JSON.stringify({ ok: true, result: { path: relativePath, deleted: true } }));
    return;
  }
  try {
    await fs.writeFile(target, content!, { encoding: "utf8", flag: "wx" });
  } catch (error) {
    return fail("SANDBOX_EXECUTION_FAILED", errorMessage(error));
  }
  process.stdout.write(JSON.stringify({ ok: true, result: { path: relativePath, created: true } }));
}

function exactObject(value: unknown, keys: string[]): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Tool arguments must be an object");
  }
  const object = value as Record<string, unknown>;
  if (Object.keys(object).some((key) => !keys.includes(key)) || keys.some((key) => !(key in object))) {
    throw new Error(`Tool arguments must contain exactly: ${keys.join(", ")}`);
  }
  return object;
}

function nonEmptyString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") throw new Error(`${field} must be non-empty`);
  return value;
}

function stringValue(value: unknown, field: string): string {
  if (typeof value !== "string") throw new Error(`${field} must be a string`);
  return value;
}

function isInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function fail(code: "SANDBOX_EXECUTION_FAILED" | "SANDBOX_POLICY_VIOLATION", message: string): void {
  process.stdout.write(JSON.stringify({ ok: false, code, message }));
  process.exitCode = 1;
}

function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    let input = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk: string) => {
      input += chunk;
      if (input.length > 1_000_000) reject(new Error("Sandbox request is too large"));
    });
    process.stdin.on("end", () => resolve(input));
    process.stdin.on("error", reject);
  });
}

void main().catch((error: unknown) => fail("SANDBOX_POLICY_VIOLATION", errorMessage(error)));

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
