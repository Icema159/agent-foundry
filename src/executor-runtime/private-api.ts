import { readFileSync } from "node:fs";
import { createPrismaClient } from "../persistence/prisma-execution-store.js";
import { CredentialAuthenticator } from "../identity/identity.js";
import { PrismaIdentityStore } from "../identity/prisma-identity-store.js";
import { InvocationService } from "../invocation/invocation-service.js";
import { ExecutorProtocol } from "../executor/executor-protocol.js";
import { ExecutorExecution } from "../executor/execution-service.js";
import { createExternalApiServer } from "../external-api/server.js";
import { assertLinuxIsolation } from "./isolation.js";

async function main() {
  assertLinuxIsolation();
  if (process.env.FOUNDRY_PRIVATE_API !== "1") throw new Error("Private container API requires explicit configuration");
  const db = createPrismaClient(readFileSync("/api-secrets/database-url", "utf8").trim());
  const protocol = new ExecutorProtocol(db);
  const server = createExternalApiServer({ auth: new CredentialAuthenticator(new PrismaIdentityStore(db)), invocations: new InvocationService(db), executors: protocol, execution: new ExecutorExecution(db, protocol, true) });
  let stopping = false;
  async function stop() {
    if (stopping) return;
    stopping = true;
    await new Promise<void>(resolve => server.close(() => resolve()));
    await db.$disconnect();
  }
  server.on("error", () => { console.error("Private API server failed"); process.exitCode = 1; void stop().catch(() => {}); });
  process.once("SIGTERM", () => { void stop(); }); process.once("SIGINT", () => { void stop(); });
  server.listen(3002, "0.0.0.0", () => console.log("Private container-only API ready; no host port may be published"));
}
void main().catch(() => { console.error("Private API startup failed"); process.exitCode = 1; });
