import type { ExecutorClaim, Invocation, Prisma } from "../generated/prisma/client.js";

/** Conservative proof for PRE-START metadata only; never establishes an effect outcome. */
export async function provesNoStart(tx: Prisma.TransactionClient, invocation: Invocation, claim?: ExecutorClaim): Promise<boolean> {
  if (!["READY", "CLAIMED"].includes(invocation.status) || claim?.startAuthorizedAt) return false;
  if (invocation.status === "CLAIMED" && (!claim || claim.status !== "ACTIVE" || claim.invocationId !== invocation.id)) return false;
  return !await tx.invocationEvent.findFirst({ where: { invocationId: invocation.id, OR: [
    { status: { in: ["START_AUTHORIZED", "RUNNING", "SUCCEEDED", "FAILED", "UNKNOWN"] } }, { kind: "START_AUTHORIZED" },
  ] }, select: { sequence: true } });
}
