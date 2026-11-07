import { createHash } from "node:crypto";

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export type Effect = "READ_ONLY" | "WRITE" | "DESTRUCTIVE" | "EXTERNAL_WRITE";
export type ToolDescriptor = { name: string; revision: number; description: string; inputSchema: Json; declaredProfile: Effect; handlerId: string };
const effects = new Set(["READ_ONLY", "WRITE", "DESTRUCTIVE", "EXTERNAL_WRITE"]);
export class ValidationError extends Error { constructor(message: string) { super(message); this.name = "ValidationError"; } }
export class RevisionConflict extends Error { constructor() { super("Revision already exists with different content"); this.name = "RevisionConflict"; } }

function json(value: unknown, depth = 0): Json {
  if (depth > 8) throw new ValidationError("JSON nesting exceeds 8");
  if (value === null || typeof value === "boolean" || typeof value === "string") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (Array.isArray(value)) {
    if (value.length > 256) throw new ValidationError("JSON array too large");
    if (Object.keys(value).length !== value.length || Object.getOwnPropertySymbols(value).length) throw new ValidationError("Invalid JSON array");
    return value.map(v => json(v, depth + 1));
  }
  if (typeof value !== "object" || value === null || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw new ValidationError("Expected plain JSON");
  const obj = value as Record<string, unknown>; const keys = Object.keys(obj);
  if (Object.getOwnPropertySymbols(obj).length || Object.getOwnPropertyNames(obj).length !== keys.length) throw new ValidationError("Invalid JSON object");
  if (keys.length > 256 || keys.some(k => ["__proto__", "constructor", "prototype"].includes(k))) throw new ValidationError("Invalid JSON keys");
  const result: Record<string, Json> = Object.create(null) as Record<string, Json>;
  for (const k of keys.sort()) result[k] = json(obj[k], depth + 1);
  return result;
}
export function canonical(value: unknown, maxBytes = 65536): { value: Json; digest: string } {
  const normalized = json(value); const data = JSON.stringify(normalized);
  if (Buffer.byteLength(data) > maxBytes) throw new ValidationError("Payload too large");
  return { value: normalized, digest: createHash("sha256").update(data).digest("hex") };
}
export function positiveInteger(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0 || value > 2147483647) throw new ValidationError("Revision must be a positive integer");
  return value;
}
export function text(value: unknown, label: string, max = 200): string {
  if (typeof value !== "string" || !value.trim() || value.length > max) throw new ValidationError(`Invalid ${label}`);
  return value;
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) throw new ValidationError("Expected object");
  return value as Record<string, unknown>;
}
function exactKeys(obj: Record<string, unknown>, keys: string[]) {
  if (Object.keys(obj).some(k => !keys.includes(k))) throw new ValidationError("Unsupported field");
}
function schema(value: unknown, depth = 0): void {
  if (depth > 6) throw new ValidationError("Schema nesting exceeds 6");
  const s = object(value); exactKeys(s, ["type", "description", "properties", "required", "additionalProperties", "items"]);
  if (s.description !== undefined) text(s.description, "schema description", 2000);
  if (!["object", "array", "string", "number", "integer", "boolean", "null"].includes(s.type as string)) throw new ValidationError("Unsupported schema type");
  if (s.type === "object") {
    if (s.items !== undefined || s.additionalProperties !== false) throw new ValidationError("Objects require additionalProperties=false");
    const props = object(s.properties); const names = Object.keys(props);
    if (names.length > 64 || names.some(n => !n || ["__proto__", "constructor", "prototype"].includes(n))) throw new ValidationError("Invalid schema properties");
    if (s.required !== undefined && (!Array.isArray(s.required) || s.required.some(x => typeof x !== "string" || !names.includes(x)) || new Set(s.required).size !== s.required.length)) throw new ValidationError("Invalid required properties");
    for (const child of Object.values(props)) schema(child, depth + 1);
  } else if (s.type === "array") {
    if (s.properties !== undefined || s.required !== undefined || s.additionalProperties !== undefined || s.items === undefined) throw new ValidationError("Invalid array schema");
    schema(s.items, depth + 1);
  } else if (s.properties !== undefined || s.required !== undefined || s.additionalProperties !== undefined || s.items !== undefined) throw new ValidationError("Invalid primitive schema");
}
export function manifest(value: unknown): { tools: ToolDescriptor[]; digest: string } {
  canonical(value); // Bound and validate the whole input before traversing descriptors.
  const root = object(value); exactKeys(root, ["tools"]);
  if (!Array.isArray(root.tools) || root.tools.length < 1 || root.tools.length > 32) throw new ValidationError("Manifest must contain 1–32 tools");
  const names = new Set<string>();
  const tools = root.tools.map((raw): ToolDescriptor => {
    const tool = object(raw); exactKeys(tool, ["name", "revision", "description", "inputSchema", "declaredProfile", "handlerId"]);
    const name = text(tool.name, "tool name");
    if (!/^[a-zA-Z][a-zA-Z0-9_.-]*$/.test(name) || names.has(name)) throw new ValidationError("Invalid or duplicate tool name"); names.add(name);
    if (!effects.has(tool.declaredProfile as string)) throw new ValidationError("Unknown effect profile");
    schema(tool.inputSchema); if (object(tool.inputSchema).type !== "object") throw new ValidationError("Tool input schema must be an object");
    return { name, revision: positiveInteger(tool.revision), description: text(tool.description, "description", 2000), inputSchema: canonical(tool.inputSchema).value,
      declaredProfile: tool.declaredProfile as Effect, handlerId: text(tool.handlerId, "handler ID") };
  });
  const digest = canonical({ tools }).digest;
  return { tools, digest };
}
