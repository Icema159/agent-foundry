/** Fixed resource-free handler: no imports, I/O, credentials or dispatch table. */
export function healthPing(args: unknown) {
  if (!args || typeof args !== "object" || Array.isArray(args) || Object.keys(args).length !== 0) throw new Error("Exact empty arguments required");
  return { ok: true, tool: "health_ping", version: 1 };
}
