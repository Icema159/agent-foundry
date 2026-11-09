import type { Prisma } from "../generated/prisma/client.js";
import type { AuthenticatedContext } from "../identity/identity.js";
import { databaseNow } from "../authorization/credential-lock.js";
import type { Loaded } from "./executor-protocol.js";

export async function reconcilePossibleStart(tx: Prisma.TransactionClient, invocation: Loaded, context: AuthenticatedContext) {
  if (!["START_AUTHORIZED","READY","CLAIMED"].includes(invocation.status)) return;
  const start = await tx.executorStart.findUnique({ where: { invocationId: invocation.id } }), claim = invocation.claims[0];
  const historical = !!start || !!claim?.startAuthorizedAt || !!await tx.invocationEvent.findFirst({where:{invocationId:invocation.id,
    OR:[{kind:"START_AUTHORIZED"},{status:{in:["START_AUTHORIZED","RUNNING","SUCCEEDED","FAILED","UNKNOWN"]}}]},select:{sequence:true}});
  if (invocation.status !== "START_AUTHORIZED" && !historical) return;
  let reason = "EXECUTION_EVIDENCE_INCOMPLETE";
  if (invocation.status === "START_AUTHORIZED" && start && claim?.startAuthorizedAt && start.claimId === claim.id) {
    await tx.$queryRaw`SELECT id FROM "ExecutorDeployment" WHERE id = ${invocation.deploymentId} FOR UPDATE`;
    const session = await tx.executorSession.findUnique({ where: { id: start.sessionId } });
    const credential = await tx.credential.findUnique({ where: { id: claim.credentialId } });
    const now = await databaseNow(tx);
    if (claim.leaseExpiresAt > now && start.resultDeadline > now && session?.active && session.expiresAt > now && credential && !credential.revokedAt && credential.expiresAt > now) return;
    reason = "EXECUTION_OUTCOME_UNCERTAIN";
  }
  await tx.invocation.update({ where: { id: invocation.id }, data: { status: "UNKNOWN", reason } });
  await tx.invocationEvent.create({ data: { invocationId: invocation.id, runId: invocation.runId, actorPrincipalId: context.principalId,
    kind: "EXECUTION_UNCERTAIN", status: "UNKNOWN", reason, ...(start ? {startId:start.id} : {}),
    ...(claim ? {claimId:claim.id,claimGeneration:claim.generation,leaseExpiresAt:claim.leaseExpiresAt}: {}) } });
}
