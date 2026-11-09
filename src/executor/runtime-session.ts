import type { Prisma } from "../generated/prisma/client.js";
import type { AuthenticatedContext } from "../identity/identity.js";
import { databaseNow } from "../authorization/credential-lock.js";
import { WRITE_PROFILE } from "./demo-receipt-contract.js";
import { EXECUTION_PROFILE } from "./execution-contract.js";

/** Caller holds actor/policy locks; the deployment lock orders session replacement. */
export async function currentSession(tx: Prisma.TransactionClient, context: AuthenticatedContext, sessionId: string, bindingId?: string) {
  await tx.$queryRaw`SELECT id FROM "ExecutorDeployment" WHERE id = ${context.deploymentId} AND "ownerId" = ${context.ownerId} FOR UPDATE`;
  await tx.$queryRaw`SELECT id FROM "ExecutorSession" WHERE id = ${sessionId} AND "ownerId" = ${context.ownerId} FOR UPDATE`;
  const session = await tx.executorSession.findFirst({ where: { id: sessionId, ownerId: context.ownerId, deploymentId: context.deploymentId!,
    executorPrincipalId: context.principalId, credentialId: context.credentialId, active: true } });
  const now = await databaseNow(tx);
  if (!session || session.expiresAt <= now || ![EXECUTION_PROFILE,WRITE_PROFILE].includes(session.executionProfile) || (bindingId && session.bindingId !== bindingId)) return null;
  const binding = await tx.trustedResourceBinding.findUnique({ where: { id: session.bindingId } });
  if (!binding || binding.revokedAt || binding.expiresAt <= now || binding.ownerId !== context.ownerId || binding.deploymentId !== context.deploymentId ||
    binding.executionProfile !== session.executionProfile || binding.ledgerId !== session.ledgerId || binding.artifactDigest !== session.artifactDigest) return null;
  return session;
}
