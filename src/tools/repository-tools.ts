import { promises as fs } from "node:fs";
import path from "node:path";
import type { ToolSchema } from "../model/types.js";
import { SandboxError, type Sandbox } from "../sandbox/sandbox.js";
import {
  ToolExecutionError,
  ToolInputError,
  ToolRegistry,
  type RegisteredTool,
} from "./tool-registry.js";

const IGNORED_DIRECTORY_NAMES = new Set([".git", "dist", "node_modules"]);

export { ToolExecutionError, ToolInputError } from "./tool-registry.js";

export const repositoryToolSchemas: ToolSchema[] = [
  {
    name: "list_files",
    description: "Recursively list regular files within the repository workspace.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "search_files",
    description: "Find literal text in UTF-8 repository files and return matching lines.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", minLength: 1, description: "Literal text to find" },
      },
      required: ["query"],
      additionalProperties: false,
    },
  },
  {
    name: "read_file",
    description: "Read one UTF-8 file relative to the repository root. For large files, request a smaller portion using startLine (1-based) and maxLines.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", minLength: 1, description: "Repository-relative file path" },
        startLine: { type: "integer", minimum: 1, description: "First line to read (1-based, default 1)" },
        maxLines: { type: "integer", minimum: 1, description: "Maximum lines to return; omit to read through end of file" },
      },
      required: ["path"],
      additionalProperties: false,
    },
  },
  {
    name: "create_file",
    description: "Create one new UTF-8 file inside the repository without overwriting an existing path.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", minLength: 1, description: "Repository-relative file path" },
        content: { type: "string", description: "Complete UTF-8 file content" },
      },
      required: ["path", "content"],
      additionalProperties: false,
    },
  },
  {
    name: "delete_file",
    description: "Delete exactly one existing regular file inside the repository after human approval. Never delete directories or symlinks. Deletion is permanent.",
    inputSchema: {
      type: "object", properties: { path: { type: "string", minLength: 1, description: "Exact repository-relative file path" } },
      required: ["path"], additionalProperties: false,
    },
  },
];

export class RepositoryTools extends ToolRegistry {
  private constructor(operations: RepositoryOperations, sandbox: Sandbox | undefined) {
    super(createDefinitions(operations, sandbox));
  }

  static async create(
    workspaceRoot: string,
    options: { sandbox?: Sandbox } = {},
  ): Promise<RepositoryTools> {
    const root = await fs.realpath(path.resolve(workspaceRoot));
    const stat = await fs.stat(root);
    if (!stat.isDirectory()) throw new Error("Workspace root must be a directory");
    return new RepositoryTools(new RepositoryOperations(root), options.sandbox);
  }
}

class RepositoryOperations {
  constructor(private readonly root: string) {}

  get workspaceRoot(): string {
    return this.root;
  }

  async listFiles(): Promise<string[]> {
    const files: string[] = [];
    await this.walk(this.root, files);
    return files.sort();
  }

  async searchFiles(query: string): Promise<Array<{ path: string; line: number; text: string }>> {
    const matches: Array<{ path: string; line: number; text: string }> = [];
    for (const relativePath of await this.listFiles()) {
      let content: string;
      try {
        content = await this.readFile(relativePath);
      } catch {
        continue;
      }
      content.split(/\r?\n/).forEach((text, index) => {
        if (text.includes(query)) matches.push({ path: relativePath, line: index + 1, text });
      });
    }
    return matches;
  }

  async readFile(relativePath: string): Promise<string> {
    const absolute = await this.resolveExistingFile(relativePath);
    try {
      return await fs.readFile(absolute, "utf8");
    } catch (error) {
      throw new ToolExecutionError(errorMessage(error));
    }
  }

  async validateCreateFilePath(relativePath: string): Promise<void> {
    if (path.isAbsolute(relativePath)) {
      throw new ToolInputError("File path must be relative to the workspace root");
    }
    const candidate = path.resolve(this.root, relativePath);
    if (!isInside(this.root, candidate)) {
      throw new ToolInputError("File path escapes the workspace root");
    }
    let realParent: string;
    try {
      realParent = await fs.realpath(path.dirname(candidate));
    } catch (error) {
      throw new ToolExecutionError(errorMessage(error));
    }
    if (!isInside(this.root, realParent)) {
      throw new ToolInputError("File path resolves outside the workspace root");
    }
    try {
      await fs.lstat(path.join(realParent, path.basename(candidate)));
      throw new ToolExecutionError("Target file already exists");
    } catch (error) {
      if (isMissingPathError(error)) return;
      if (error instanceof ToolExecutionError) throw error;
      throw new ToolExecutionError(errorMessage(error));
    }
  }

  async validateDeleteFilePath(relativePath: string): Promise<void> {
    if (path.isAbsolute(relativePath) || relativePath.split(path.sep).includes("..")) {
      throw new ToolInputError("File path must be relative without parent traversal");
    }
    const candidate = path.resolve(this.root, relativePath);
    if (candidate === this.root || !isInside(this.root, candidate)) throw new ToolInputError("Cannot delete the workspace root");
    const realParent = await fs.realpath(path.dirname(candidate));
    if (!isInside(this.root, realParent)) throw new ToolInputError("File path resolves outside the workspace root");
    const stat = await fs.lstat(path.join(realParent, path.basename(candidate)));
    if (!stat.isFile() || stat.isSymbolicLink()) throw new ToolInputError("delete_file requires a regular file, not a directory or symlink");
  }

  private async walk(directory: string, files: string[]): Promise<void> {
    let entries;
    try {
      entries = await fs.readdir(directory, { withFileTypes: true });
    } catch (error) {
      throw new ToolExecutionError(errorMessage(error));
    }
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory() && IGNORED_DIRECTORY_NAMES.has(entry.name)) continue;
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) await this.walk(absolute, files);
      else if (entry.isFile()) files.push(toPosix(path.relative(this.root, absolute)));
    }
  }

  private async resolveExistingFile(relativePath: string): Promise<string> {
    if (path.isAbsolute(relativePath)) {
      throw new ToolInputError("File path must be relative to the workspace root");
    }
    const candidate = path.resolve(this.root, relativePath);
    if (!isInside(this.root, candidate)) {
      throw new ToolInputError("File path escapes the workspace root");
    }
    let realPath: string;
    try {
      realPath = await fs.realpath(candidate);
    } catch (error) {
      throw new ToolExecutionError(errorMessage(error));
    }
    if (!isInside(this.root, realPath)) {
      throw new ToolInputError("File path resolves outside the workspace root");
    }
    const stat = await fs.stat(realPath);
    if (!stat.isFile()) throw new ToolInputError("Requested path is not a regular file");
    return realPath;
  }
}

function createDefinitions(
  operations: RepositoryOperations,
  sandbox: Sandbox | undefined,
): RegisteredTool[] {
  const [listFiles, searchFiles, readFile, createFile, deleteFile] = repositoryToolSchemas;
  if (!listFiles || !searchFiles || !readFile || !createFile || !deleteFile) {
    throw new Error("Repository tool schemas are incomplete");
  }
  return [
    {
      ...listFiles,
      readOnly: true,
      validate: (args) => assertExactObject(args, []),
      execute: async () => ({ files: await operations.listFiles() }),
    },
    {
      ...searchFiles,
      readOnly: true,
      validate: (args) => {
        const input = assertExactObject(args, ["query"]);
        return { query: requireNonEmptyString(input.query, "query") };
      },
      execute: async (args) => {
        const { query } = args as { query: string };
        return { matches: await operations.searchFiles(query) };
      },
    },
    {
      ...readFile,
      readOnly: true,
      validate: (args) => {
        const input = assertExactObject(args, ["path"], ["startLine", "maxLines"]);
        return { path: requireNonEmptyString(input.path, "path"),
          ...(input.startLine !== undefined ? { startLine: requirePositiveInteger(input.startLine, "startLine") } : {}),
          ...(input.maxLines !== undefined ? { maxLines: requirePositiveInteger(input.maxLines, "maxLines") } : {}) };
      },
      execute: async (args) => {
        const { path: relativePath, startLine, maxLines } = args as { path: string; startLine?: number; maxLines?: number };
        const content = await operations.readFile(relativePath);
        if (startLine === undefined && maxLines === undefined) return { path: relativePath, content };
        const lines = content.match(/[^\n]*\n|[^\n]+$/g) ?? [];
        const start = startLine ?? 1;
        const end = maxLines === undefined ? lines.length : Math.min(lines.length, start - 1 + maxLines);
        return { path: relativePath, content: lines.slice(start - 1, end).join(""),
          startLine: start, endLine: end, totalLines: lines.length,
          complete: start === 1 && end === lines.length };
      },
    },
    {
      ...createFile,
      validate: (args) => {
        const input = assertExactObject(args, ["path", "content"]);
        return {
          path: requireNonEmptyString(input.path, "path"),
          content: requireString(input.content, "content"),
        };
      },
      execute: async (args) => {
        const { path: relativePath, content } = args as { path: string; content: string };
        await operations.validateCreateFilePath(relativePath);
        if (!sandbox) {
          throw new SandboxError("SANDBOX_UNAVAILABLE", "No sandbox is configured for create_file");
        }
        return sandbox.execute({
          toolName: "create_file",
          arguments: { path: relativePath, content },
          workspaceRoot: operations.workspaceRoot,
        });
      },
    },
    {
      ...deleteFile,
      validate: (args) => {
        const input = assertExactObject(args, ["path"]);
        return { path: requireNonEmptyString(input.path, "path") };
      },
      execute: async (args) => {
        const { path: relativePath } = args as { path: string };
        await operations.validateDeleteFilePath(relativePath);
        if (!sandbox) throw new SandboxError("SANDBOX_UNAVAILABLE", "No sandbox is configured for delete_file");
        return sandbox.execute({ toolName: "delete_file", arguments: { path: relativePath }, workspaceRoot: operations.workspaceRoot });
      },
    },
  ];
}

function assertExactObject(value: unknown, keys: string[], optionalKeys: string[] = []): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ToolInputError("Tool arguments must be an object");
  }
  const object = value as Record<string, unknown>;
  const actual = Object.keys(object);
  if (actual.some((key) => !keys.includes(key) && !optionalKeys.includes(key)) || keys.some((key) => !(key in object))) {
    throw new ToolInputError(`Tool arguments must contain exactly: ${keys.join(", ") || "no fields"}`);
  }
  return object;
}

function requireNonEmptyString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new ToolInputError(`${field} must be a non-empty string`);
  }
  return value;
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== "string") throw new ToolInputError(`${field} must be a string`);
  return value;
}

function requirePositiveInteger(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    throw new ToolInputError(`${field} must be a positive safe integer`);
  }
  return value;
}

function isInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative === "" ||
    (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))
  );
}

function toPosix(value: string): string {
  return value.split(path.sep).join("/");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isMissingPathError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
