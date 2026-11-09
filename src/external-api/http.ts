import type { IncomingMessage, ServerResponse } from "node:http";

const MAX_BODY_BYTES = 65536;
const MAX_RESPONSE_BYTES = 131072;
export class HttpError extends Error { constructor(readonly status: number, readonly code: string, message: string) { super(message); } }
export const bad = () => new HttpError(400, "INVALID_REQUEST", "Invalid request");
export function id(value: unknown): string {
  if (typeof value !== "string" || !/^[a-zA-Z0-9_-]{1,128}$/.test(value)) throw bad();
  return value;
}
export function bodyObject(value: unknown, allowed: string[], required: string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw bad();
  const obj = value as Record<string, unknown>, keys = Object.keys(obj);
  if (keys.some(k => !allowed.includes(k)) || required.some(k => !Object.hasOwn(obj, k))) throw bad();
  return obj;
}
export async function jsonBody(req: IncomingMessage): Promise<unknown> {
  if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(req.headers["content-type"] ?? "")) throw new HttpError(415, "UNSUPPORTED_MEDIA_TYPE", "Content-Type must be application/json");
  if (req.headers["content-encoding"] && req.headers["content-encoding"] !== "identity") throw new HttpError(415, "UNSUPPORTED_MEDIA_TYPE", "Content encoding is not supported");
  const declared = req.headers["content-length"];
  if (declared && (!/^\d+$/.test(declared) || Number(declared) > MAX_BODY_BYTES)) { req.resume(); throw new HttpError(413, "PAYLOAD_TOO_LARGE", "Request body is too large"); }
  return new Promise((resolve, reject) => {
    let size = 0, failed = false; const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => {
      if (failed) return;
      size += chunk.length;
      if (size > MAX_BODY_BYTES) { failed = true; chunks.length = 0; reject(new HttpError(413, "PAYLOAD_TOO_LARGE", "Request body is too large")); return; }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (failed) return;
      try { resolve(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks))) as unknown); } catch { reject(bad()); }
    });
    req.on("aborted", () => { if (!failed) { failed = true; reject(bad()); } });
    req.on("error", () => { if (!failed) { failed = true; reject(bad()); } });
  });
}
export function send(res: ServerResponse, status: number, value: unknown): void {
  let json = JSON.stringify(value);
  if (Buffer.byteLength(json) > MAX_RESPONSE_BYTES) { status = 503; json = JSON.stringify({ error: { code: "RESPONSE_LIMIT", message: "Response exceeds the configured limit" } }); }
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
  res.end(json);
}
