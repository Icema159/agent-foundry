import { existsSync, readFileSync } from "node:fs";

export function validateLinuxIsolation(input: { platform: string; uid: number; gid: number; container: boolean; status: string; mounts: string }) {
  const root = input.mounts.split("\n").find(line => line.split(" ")[4] === "/");
  if (input.platform !== "linux" || input.uid !== 10001 || input.gid !== 10001 || !input.container ||
    !/^CapEff:\s*0+$/m.test(input.status) || !/^NoNewPrivs:\s*1$/m.test(input.status) || !root?.split(" ")[5]?.split(",").includes("ro"))
    throw new Error("Required container isolation is unavailable; no execution fallback");
}
export function assertLinuxIsolation() {
  validateLinuxIsolation({ platform: process.platform, uid: process.getuid?.() ?? -1, gid: process.getgid?.() ?? -1, container: existsSync("/.dockerenv"),
    status: process.platform === "linux" ? readFileSync("/proc/self/status", "utf8") : "", mounts: process.platform === "linux" ? readFileSync("/proc/self/mountinfo", "utf8") : "" });
}
export function validatePrivateOrigin(raw: string): string {
  const url = new URL(raw);
  if (url.username || url.password || url.search || url.hash || url.pathname !== "/" ||
    !(url.protocol === "https:" || (url.protocol === "http:" && url.hostname === "foundry-api" && url.port === "3002"))) throw new Error("HTTPS or verified private Docker API required");
  return url.origin;
}
