import type { Prisma } from "../generated/prisma/client.js";
import { IdentityError, requireScope, type AuthenticatedContext, type Scope } from "../identity/identity.js";

export async function databaseNow(tx: Prisma.TransactionClient): Promise<Date> {
  // Prisma dates use UTC timestamp semantics; do not depend on the server timezone.
  const rows = await tx.$queryRaw<Array<{ now: Date }>>`SELECT clock_timestamp() AT TIME ZONE 'UTC' AS now`;
  return rows[0]!.now;
}

/** Revocation updates take the same credential row lock. Time is read after waiting. */
export async function lockCredential(tx: Prisma.TransactionClient, context: AuthenticatedContext, scope: Scope) {
  requireScope(context, scope);
  await tx.$queryRaw`SELECT id FROM "Credential" WHERE id = ${context.credentialId} FOR UPDATE`;
  await tx.$queryRaw`SELECT id FROM "Principal" WHERE id = ${context.principalId} FOR UPDATE`;
  const credential = await tx.credential.findUnique({ where: { id: context.credentialId }, include: { principal: true } });
  const now = await databaseNow(tx);
  const p = credential?.principal;
  if (!credential || credential.revokedAt || credential.expiresAt <= now! || !credential.scopes.includes(scope) ||
      !p || p.id !== context.principalId || p.ownerId !== context.ownerId || p.type !== context.principalType ||
      p.agentId !== context.agentId || p.deploymentId !== context.deploymentId) throw new IdentityError();
  if (p.type === "AGENT" && !await tx.agent.findFirst({ where: { id: p.agentId!, ownerId: p.ownerId, integration: "EXTERNAL" } })) throw new IdentityError();
  return { credential, now: now! };
}
