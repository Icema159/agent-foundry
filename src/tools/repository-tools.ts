import { constants, promises as fs, type BigIntStats } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import path from "node:path";
import { EXACT_LINE_COUNT_BYTES, REPOSITORY_CONTENT_BYTES, scanRepositoryText } from "./repository-text.js";
import type { ToolSchema } from "../model/types.js";
import { SandboxError, type Sandbox } from "../sandbox/sandbox.js";
import {
  ToolExecutionError,
  ToolInputError,
  ToolRegistry,
  type RegisteredTool,
} from "./tool-registry.js";

const HIDDEN_PATH_COMPONENTS = new Set([
  ".git", "dist", "node_modules",
  ".ssh", ".aws", ".azure", ".kube", ".docker", ".gnupg", ".gcloud",
  ".oci", ".terraform", ".vault", ".secrets", ".credentials",
  ".envrc", ".npmrc", ".yarnrc", ".yarnrc.yml", ".netrc", "_netrc", ".pypirc",
  ".git-credentials", ".gitconfig", ".gitmodules", ".gh", ".vault-token",
  ".pgpass", ".my.cnf", ".htpasswd", ".dockercfg", "kubeconfig",
  "credentials", "credentials.json", "secrets.json", "tokens.json",
  "auth.json", "htpasswd", "application_default_credentials.json",
]);

function isHiddenPath(relativePath: string): boolean {
  const parts = relativePath.split(path.sep).map(part => part.normalize("NFKC").toLowerCase());
  return parts.some((part, index) =>
    HIDDEN_PATH_COMPONENTS.has(part) ||
    (parts[index - 1] === ".config" && ["gcloud", "gh", "stripe", "doctl"].includes(part)) ||
    /^\.env(?:\.|$)/.test(part) ||
    /^id_(?:rsa|dsa|ecdsa|ed25519)(?:_sk)?$/.test(part) ||
    /^(?:service[-_]account|client[-_]secret)(?:[-_][^.]*)?\.json$/.test(part) ||
    /\.(?:env|pem|key|p12|pfx|ppk|jks|keystore|kdbx|tfstate)(?:\.backup)?$/.test(part));
}

const unavailableFile = () => new ToolInputError("Requested repository file is unavailable");

export { ToolExecutionError, ToolInputError } from "./tool-registry.js";

export const repositoryToolSchemas: ToolSchema[] = [
  {
    name: "list_files",
    description: "Recursively list regular files within the repository workspace.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "search_files",
    description: "Find literal text in UTF-8 repository files. When complete is false, scan or output limits prevented a complete search.",
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
    description: "Read one UTF-8 repository file. For large files, use startLine (1-based) and maxLines. A missing totalLines on a range means the file length was not determined. Check truncationReason for scan or output limits.",
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

  async searchFiles(query: string) {
    const matches: Array<{ path: string; line: number; text: string }> = [];
    let outputBytes = 0;
    let incomplete = false;
    for (const relativePath of await this.listFiles()) {
      const fileMatches: typeof matches = [];
      let fileBytes = 0;
      let skippedLine = false;
      let exhaustedOutput = false;
      try {
        const scan = await this.withVisibleFile(relativePath, (file, size) =>
          scanRepositoryText(file, size, (line, _bytes, content) => {
            if (content === undefined) {
              skippedLine = true;
              return;
            }
            const text = content.endsWith("\n") ? content.slice(0, content.endsWith("\r\n") ? -2 : -1) : content;
            if (!text.includes(query)) return;
            const match = { path: relativePath, line, text };
            const matchBytes = Buffer.byteLength(JSON.stringify(match)) + 1;
            if (outputBytes + fileBytes + matchBytes > REPOSITORY_CONTENT_BYTES) {
              exhaustedOutput = true;
              return false;
            }
            fileMatches.push(match);
            fileBytes += matchBytes;
          }));
        incomplete ||= !scan.eof || skippedLine || exhaustedOutput;
      } catch {
        continue;
      }
      for (const match of fileMatches) matches.push(match);
      outputBytes += fileBytes;
      if (exhaustedOutput) break;
    }
    return { matches, ...(incomplete ? { complete: false } : {}) };
  }

  async readFile(relativePath: string, startLine?: number, maxLines?: number) {
    const start = startLine ?? 1;
    const parts: string[] = [];
    let returnedLines = 0;
    let outputBytes = 0;
    let exhaustedOutput = false;
    const scan = await this.withVisibleFile(relativePath, (file, size) => {
      const countToEnd = size <= BigInt(EXACT_LINE_COUNT_BYTES);
      return scanRepositoryText(file, size, (line, bytes, text) => {
        if (line < start) return;
        if (!exhaustedOutput && (maxLines === undefined || returnedLines < maxLines)) {
          // JSON escaping can increase the size of the model-visible content.
          const encodedBytes = text === undefined ? bytes : Buffer.byteLength(JSON.stringify(text)) - 2;
          if (text === undefined || outputBytes + encodedBytes > REPOSITORY_CONTENT_BYTES) {
            exhaustedOutput = true;
          } else {
            parts.push(text);
            outputBytes += encodedBytes;
            returnedLines++;
          }
        }
        if (!countToEnd && (exhaustedOutput || returnedLines === maxLines)) return false;
      });
    });
    const content = parts.join("");
    const truncationReason = exhaustedOutput ? "OUTPUT_LIMIT" : scan.scanLimited ? "SCAN_LIMIT" : undefined;
    if (startLine === undefined && maxLines === undefined && !truncationReason) return { path: relativePath, content };
    return {
      path: relativePath, content, startLine: start,
      endLine: returnedLines ? start + returnedLines - 1 : scan.eof && scan.lines < start ? scan.lines : null,
      ...(scan.eof ? { totalLines: scan.lines } : {}),
      complete: start === 1 && scan.eof && returnedLines === scan.lines && !truncationReason,
      ...(truncationReason ? { truncationReason } : {}),
    };
  }

  private async withVisibleFile<T>(relativePath: string, read: (file: FileHandle, size: bigint) => Promise<T>): Promise<T> {
    try {
      const { absolute, stat } = await this.resolveVisiblePath(relativePath, "file");
      const file = await fs.open(absolute, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      try {
        const opened = await file.stat({ bigint: true });
        const current = await this.resolveVisiblePath(relativePath, "file");
        if (!sameFile(stat, opened) || !sameFile(current.stat, opened)) throw unavailableFile();
        const result = await read(file, opened.size);
        const finalPath = await this.resolveVisiblePath(relativePath, "file");
        if (!sameFile(opened, finalPath.stat) || !sameFile(opened, await file.stat({ bigint: true }))) throw unavailableFile();
        return result;
      } finally {
        await file.close();
      }
    } catch (error) {
      if (error instanceof ToolInputError) throw error;
      throw unavailableFile();
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
    } catch {
      throw new ToolExecutionError("Repository directory is unavailable");
    }
    for (const entry of entries) {
      if (!entry.isDirectory() && !entry.isFile()) continue;
      const relative = path.relative(this.root, path.join(directory, entry.name));
      const kind = entry.isDirectory() ? "directory" : "file";
      let absolute: string;
      try {
        ({ absolute } = await this.resolveVisiblePath(relative, kind));
      } catch {
        continue;
      }
      if (kind === "directory") await this.walk(absolute, files);
      else files.push(toPosix(relative));
    }
  }

  private async resolveVisiblePath(relativePath: string, kind: "file" | "directory") {
    if (path.isAbsolute(relativePath)) throw unavailableFile();
    const candidate = path.resolve(this.root, relativePath);
    const relative = path.relative(this.root, candidate);
    if (!relative || !isInside(this.root, candidate) || isHiddenPath(relative)) throw unavailableFile();

    // Reject links at every component, including aliases through a symlinked directory.
    const components = relative.split(path.sep);
    let parent = this.root;
    for (const component of components.slice(0, -1)) {
      parent = path.join(parent, component);
      if (!(await fs.lstat(parent)).isDirectory()) throw unavailableFile();
    }
    const stat = await fs.lstat(candidate, { bigint: true });
    if (kind === "file" ? !stat.isFile() || stat.nlink !== 1n : !stat.isDirectory()) throw unavailableFile();

    const absolute = await fs.realpath(candidate);
    if (absolute !== candidate || !isInside(this.root, absolute) || isHiddenPath(path.relative(this.root, absolute))) {
      throw unavailableFile();
    }
    return { absolute, stat };
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
        return operations.searchFiles(query);
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
        return operations.readFile(relativePath, startLine, maxLines);
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

function sameFile(expected: BigIntStats, actual: BigIntStats): boolean {
  return actual.isFile() && actual.nlink === 1n &&
    expected.dev === actual.dev && expected.ino === actual.ino &&
    expected.size === actual.size && expected.mtimeNs === actual.mtimeNs && expected.ctimeNs === actual.ctimeNs;
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
