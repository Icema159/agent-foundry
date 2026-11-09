import "dotenv/config";
import { createExternalApiServer } from "./external-api/server.js";
import { CredentialAuthenticator } from "./identity/identity.js";
import { PrismaIdentityStore } from "./identity/prisma-identity-store.js";
import { InvocationService } from "./invocation/invocation-service.js";
import { createPrismaClient } from "./persistence/prisma-execution-store.js";
import { ExecutorProtocol } from "./executor/executor-protocol.js";
import { executorLeaseMs } from "./executor/protocol-validation.js";
import { ExecutorExecution } from "./executor/execution-service.js";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required");
const portText = process.env.FOUNDRY_EXTERNAL_API_PORT ?? "3002";
if (!/^[1-9]\d{0,4}$/.test(portText) || Number(portText) > 65535) throw new Error("Invalid external API port");
const prisma = createPrismaClient(databaseUrl);
const protocol = new ExecutorProtocol(prisma, { leaseMs: executorLeaseMs(process.env.FOUNDRY_EXECUTOR_LEASE_MS) });
if (process.env.FOUNDRY_ISOLATED_EXECUTION_ENABLED !== undefined && !["true", "false"].includes(process.env.FOUNDRY_ISOLATED_EXECUTION_ENABLED)) throw new Error("Invalid FOUNDRY_ISOLATED_EXECUTION_ENABLED");
const server = createExternalApiServer({ auth: new CredentialAuthenticator(new PrismaIdentityStore(prisma)), invocations: new InvocationService(prisma),
  executors: protocol, execution: new ExecutorExecution(prisma, protocol, process.env.FOUNDRY_ISOLATED_EXECUTION_ENABLED === "true") });
server.listen(Number(portText), "127.0.0.1", () => console.log(`Foundry external API: http://127.0.0.1:${portText}`));
let closing = false;
async function shutdown() {
  if (closing) return;
  closing = true;
  await new Promise<void>(resolve => server.close(() => resolve()));
  await prisma.$disconnect();
}
process.once("SIGINT", () => { void shutdown(); });
process.once("SIGTERM", () => { void shutdown(); });
server.on("error", () => { console.error("External API server failed"); void shutdown(); process.exitCode = 1; });
