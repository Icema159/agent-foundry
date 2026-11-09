import { ExecutorConflict } from "./protocol-errors.js";
import { currentSession } from "./runtime-session.js";
import { reconcilePossibleStart } from "./start-state.js";
import { Prisma, type Credential, type ExecutorClaim, type Invocation, type PrismaClient } from "../generated/prisma/client.js";
import { authorize, IdentityError, type AuthenticatedContext } from "../identity/identity.js";
import { databaseNow, lockCredential } from "../authorization/credential-lock.js";
import { recheckPinnedAuthorization } from "../authorization/invocation-authorization.js";
import { text } from "../registry/validation.js";
import { generation, executorLeaseMs, pollLimit } from "./protocol-validation.js";
import { provesNoStart } from "./claim-proof.js";

export type ExecutorScope = "executor:claim" | "executor:lease" | "executor:session" | "executor:start" | "executor:report";
export type Loaded = Prisma.InvocationGetPayload<{ include: { authorization: true; claims: true } }>;
export { ExecutorConflict } from "./protocol-errors.js";
const conflict = (code: string) => new ExecutorConflict(code);

/** Claim metadata only: no dispatch, handler, start permit, result or reference queue. */
export class ExecutorProtocol {
  private readonly leaseMs: number;
  constructor(private readonly db: PrismaClient, options: { leaseMs?: number } = {}) {
    this.leaseMs = executorLeaseMs(options.leaseMs === undefined ? undefined : String(options.leaseMs));
  }
  async executor(context: AuthenticatedContext, scope: ExecutorScope) {
    await authorize(context, scope);
    if (context.principalType !== "EXECUTOR" || !context.deploymentId || context.agentId) throw new IdentityError();
    if (!await this.db.executorDeployment.findFirst({ where: { id: context.deploymentId, ownerId: context.ownerId } })) throw new IdentityError();
  }
  async withInvocation<T>(context: AuthenticatedContext, invocationId: string, scope: ExecutorScope,
    fn: (tx: Prisma.TransactionClient, invocation: Loaded, executor: Credential, open: boolean) => Promise<T | ExecutorConflict>): Promise<T> {
    const result = await this.db.$transaction(async tx => {
      const target = await tx.invocation.findFirst({ where: { id: invocationId, ownerId: context.ownerId, deploymentId: context.deploymentId! }, select: { runId: true } });
      if (!target) throw new IdentityError();
      const runs = await tx.$queryRaw<Array<{ status: string }>>`SELECT status FROM "ExternalRun" WHERE id = ${target.runId} AND "ownerId" = ${context.ownerId} FOR UPDATE`;
      if (!runs[0]) throw new IdentityError();
      const invocation = await tx.invocation.findUniqueOrThrow({ where: { id: invocationId }, include: { authorization: true, claims: { orderBy: { generation: "desc" }, take: 1 } } });
      const approval=await tx.externalApprovalRequest.findUnique({where:{invocationId},select:{decision:{select:{credentialId:true}}}});
      const ids = [...new Set([approval?.decision?.credentialId,context.credentialId, invocation.authorization?.credentialId, invocation.claims[0]?.credentialId].filter((id): id is string => !!id))].sort();
      // All protocol operations acquire both actors' credentials/principals in a
      // deterministic order BEFORE grant/deployment/binding locks.
      await tx.$queryRaw`SELECT id FROM "Credential" WHERE id IN (${Prisma.join(ids)}) ORDER BY id FOR UPDATE`;
      await tx.$queryRaw`SELECT id FROM "Principal" WHERE id IN (SELECT "principalId" FROM "Credential" WHERE id IN (${Prisma.join(ids)})) ORDER BY id FOR UPDATE`;
      const { credential } = await lockCredential(tx, context, scope);
      await tx.$queryRaw`SELECT id FROM "Invocation" WHERE id = ${invocationId} FOR UPDATE`;
      return fn(tx, invocation, credential, runs[0].status === "RUNNING");
    });
    // Returning an error from the transaction preserves a real expiration or
    // revocation event; throwing here does not roll that reconciliation back.
    if (result instanceof ExecutorConflict) throw result;
    return result;
  }
  async pinned(tx: Prisma.TransactionClient, invocation: Loaded) {
    const saved = invocation.authorization;
    const requester = saved ? await tx.credential.findUnique({ where: { id: saved.credentialId } }) : null;
    if (!saved || !requester) return { eligible: false, startAllowed: false, reason: "AUTHORIZATION_MISMATCH" } as const;
    const claim = invocation.status === "CLAIMED" ? invocation.claims[0] : undefined;
    return recheckPinnedAuthorization(tx, invocation, requester, saved.digest, claim ? { id: claim.id, generation: claim.generation } : undefined);
  }
  private async claimantValid(tx: Prisma.TransactionClient, claim: ExecutorClaim, now: Date): Promise<boolean> {
    const credential = await tx.credential.findUnique({ where: { id: claim.credentialId }, include: { principal: true } });
    const p = credential?.principal;
    const session = claim.sessionId ? await tx.executorSession.findUnique({ where: { id: claim.sessionId } }) : null;
    if (claim.sessionId && (!session?.active || session.expiresAt <= now)) return false;
    return !!credential && !credential.revokedAt && credential.expiresAt > now && credential.scopes.includes("executor:claim") &&
      p?.type === "EXECUTOR" && p.id === claim.executorPrincipalId && p.ownerId === claim.ownerId && p.deploymentId === claim.deploymentId && p.agentId === null;
  }
  private async end(tx: Prisma.TransactionClient, invocation: Loaded, claim: ExecutorClaim, context: AuthenticatedContext,
    status: "RELEASED" | "EXPIRED" | "REVOKED", ready: boolean, reason: string) {
    if (!await provesNoStart(tx, invocation, claim)) return conflict("START_BOUNDARY_UNRESOLVED");
    const now = await databaseNow(tx);
    const changed = await tx.executorClaim.updateMany({ where: { id: claim.id, generation: claim.generation, status: "ACTIVE", startAuthorizedAt: null }, data: { status, closedAt: now } });
    if (changed.count !== 1) throw conflict("STALE_CLAIM");
    const next = ready ? "READY" : "REVOKED";
    await tx.invocation.update({ where: { id: invocation.id }, data: { status: next, reason } });
    await tx.invocationEvent.create({ data: { runId: invocation.runId, invocationId: invocation.id, actorPrincipalId: context.principalId,
      kind: `CLAIM_${status}`, status: next, reason, claimId: claim.id, claimGeneration: claim.generation, leaseExpiresAt: claim.leaseExpiresAt } });
    return tx.executorClaim.findUniqueOrThrow({ where: { id: claim.id } });
  }
  private async reconcile(tx: Prisma.TransactionClient, invocation: Loaded, context: AuthenticatedContext, open: boolean) {
    if (invocation.status === "START_AUTHORIZED") return reconcilePossibleStart(tx, invocation, context);
    const claim = invocation.claims[0];
    if (invocation.status !== "CLAIMED" || !claim || claim.status !== "ACTIVE" || !await provesNoStart(tx, invocation, claim)) return;
    const check = await this.pinned(tx, invocation), now = await databaseNow(tx);
    const expired = claim.leaseExpiresAt <= now;
    const claimant = await this.claimantValid(tx, claim, now);
    if (!expired && claimant && check.eligible && open) return;
    return this.end(tx, invocation, claim, context, expired ? "EXPIRED" : "REVOKED", open && check.eligible,
      !open || !check.eligible ? "AUTHORIZATION_REVOKED" : expired ? "CLAIM_LEASE_EXPIRED" : "EXECUTOR_CREDENTIAL_REVOKED");
  }
  async poll(context: AuthenticatedContext, limit: number = 10, sessionId?: string) {
    await this.executor(context, "executor:claim"); limit = pollLimit(limit);
    // Bounded on-demand reconciliation, entirely from durable state.
    const active = await this.db.executorClaim.findMany({ where: { ownerId: context.ownerId, deploymentId: context.deploymentId!, status: "ACTIVE", invocation: { status: { in: ["CLAIMED", "START_AUTHORIZED"] } } },
      orderBy: [{ leaseExpiresAt: "asc" }, { id: "asc" }], take: 10, select: { invocationId: true } });
    for (const claim of active) await this.withInvocation(context, claim.invocationId, "executor:claim", (tx, inv, _cred, open) => this.reconcile(tx, inv, context, open));
    const candidates = await this.db.invocation.findMany({ where: { ownerId: context.ownerId, deploymentId: context.deploymentId!, status: "READY", run: { status: "RUNNING" } },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }], take: 30, select: { id: true } });
    const offers: Array<{ invocationId: string; runId: string; versionId: string; toolId: string; executionAllowed: false }> = [];
    for (const candidate of candidates) {
      const offer = await this.withInvocation(context, candidate.id, "executor:claim", async (tx, inv, _cred, open) => {
        if (!open || inv.status !== "READY" || !(await this.pinned(tx, inv)).eligible) return null;
        if (sessionId && !await currentSession(tx, context, sessionId, inv.authorization?.bindingId)) return null;
        return { invocationId: inv.id, runId: inv.runId, versionId: inv.versionId, toolId: inv.toolId, executionAllowed: false as const };
      });
      if (offer) offers.push(offer);
      if (offers.length === limit) break;
    }
    return { offers, startAllowed: false as const };
  }
  async claim(context: AuthenticatedContext, invocationId: string, requestKey: string, sessionId?: string) {
    await this.executor(context, "executor:claim");
    invocationId = text(invocationId, "invocation ID"); requestKey = text(requestKey, "claim request key", 128);
    return this.withInvocation(context, invocationId, "executor:claim", async (tx, initial, credential, open) => {
      const previous = await tx.executorClaim.findUnique({ where: { ownerId_executorPrincipalId_requestKey: {
        ownerId: context.ownerId, executorPrincipalId: context.principalId, requestKey } } });
      if (previous && (previous.invocationId !== initial.id || previous.credentialId !== credential.id || previous.sessionId !== (sessionId ?? null))) return conflict("CLAIM_KEY_CONFLICT");
      await this.reconcile(tx, initial, context, open);
      const invocation = await tx.invocation.findUniqueOrThrow({ where: { id: initial.id }, include: { authorization: true, claims: { orderBy: { generation: "desc" }, take: 1 } } });
      if (previous) {
        const current = invocation.claims[0];
        if (!current || current.id !== previous.id || current.status !== "ACTIVE" || invocation.status !== "CLAIMED") return conflict("STALE_CLAIM");
        const check = await this.pinned(tx, invocation), now = await databaseNow(tx);
        if (!open || !check.eligible || current.leaseExpiresAt <= now) return conflict("AUTHORIZATION_INVALID");
        if (sessionId && !await currentSession(tx, context, sessionId, invocation.authorization?.bindingId)) return conflict("STALE_SESSION");
        return current;
      }
      if (!open || invocation.status !== "READY") return conflict("NOT_CLAIMABLE");
      const check = await this.pinned(tx, invocation);
      if (!check.eligible || !invocation.authorization) return conflict("AUTHORIZATION_INVALID");
      if (sessionId && !await currentSession(tx, context, sessionId, invocation.authorization.bindingId)) return conflict("STALE_SESSION");
      const now = await databaseNow(tx);
      const leaseExpiresAt = new Date(Math.min(now.getTime() + this.leaseMs, check.validUntil.getTime(), credential.expiresAt.getTime()));
      if (leaseExpiresAt <= now) throw new IdentityError();
      const nextGeneration = (invocation.claims[0]?.generation ?? 0) + 1;
      if (nextGeneration > 2147483647) return conflict("GENERATION_EXHAUSTED");
      const claim = await tx.executorClaim.create({ data: { ownerId: context.ownerId, runId: invocation.runId, invocationId,
        deploymentId: context.deploymentId!, executorPrincipalId: context.principalId, credentialId: credential.id,
        requestKey, authorizationDigest: invocation.authorization.digest, generation: nextGeneration, leaseExpiresAt, sessionId: sessionId ?? null } });
      await tx.invocation.update({ where: { id: invocationId }, data: { status: "CLAIMED", reason: "EXECUTOR_CLAIMED" } });
      await tx.invocationEvent.create({ data: { runId: invocation.runId, invocationId, actorPrincipalId: context.principalId,
        kind: "CLAIMED", status: "CLAIMED", reason: "EXECUTOR_CLAIMED", claimId: claim.id, claimGeneration: claim.generation, leaseExpiresAt } });
      return claim;
    });
  }
  private async ownedClaim(context: AuthenticatedContext, claimId: string) {
    const claim = await this.db.executorClaim.findFirst({ where: { id: text(claimId, "claim ID"), ownerId: context.ownerId,
      deploymentId: context.deploymentId!, executorPrincipalId: context.principalId, credentialId: context.credentialId } });
    if (!claim) throw new IdentityError();
    return claim;
  }
  async inspect(context: AuthenticatedContext, claimId: string) {
    await this.executor(context, "executor:lease");
    const owned = await this.ownedClaim(context, claimId);
    return this.withInvocation(context, owned.invocationId, "executor:lease", async (tx, inv, _cred, open) => {
      const claim = await tx.executorClaim.findUniqueOrThrow({ where: { id: owned.id } });
      const now = await databaseNow(tx);
      const current = open && inv.status === "CLAIMED" && claim.status === "ACTIVE" && inv.claims[0]?.id === claim.id &&
        claim.leaseExpiresAt > now && await this.claimantValid(tx, claim, now) && (await this.pinned(tx, inv)).eligible;
      return { claim, current, startAllowed: false as const };
    });
  }
  async renew(context: AuthenticatedContext, claimId: string, fencingGeneration: number, sessionId?: string) {
    return this.changeLease(context, claimId, generation(fencingGeneration), false, sessionId);
  }
  async release(context: AuthenticatedContext, claimId: string, fencingGeneration: number, sessionId?: string) {
    return this.changeLease(context, claimId, generation(fencingGeneration), true, sessionId);
  }
  private async changeLease(context: AuthenticatedContext, claimId: string, fencingGeneration: number, release: boolean, sessionId?: string) {
    await this.executor(context, "executor:lease");
    const owned = await this.ownedClaim(context, claimId);
    return this.withInvocation(context, owned.invocationId, "executor:lease", async (tx, inv, credential, open) => {
      const claim = await tx.executorClaim.findUniqueOrThrow({ where: { id: owned.id } });
      if (claim.generation !== fencingGeneration) return conflict("STALE_CLAIM");
      if (claim.sessionId !== (sessionId ?? null)) return conflict("STALE_SESSION");
      if (inv.claims[0]?.id !== claim.id) return conflict("STALE_CLAIM");
      if (release && claim.status === "RELEASED") return claim;
      if (claim.status !== "ACTIVE") return conflict("STALE_CLAIM");
      if (!await provesNoStart(tx, inv, claim)) return conflict("START_BOUNDARY_UNRESOLVED");
      await this.reconcile(tx, inv, context, open);
      const current = await tx.executorClaim.findUniqueOrThrow({ where: { id: claim.id } });
      if (current.status !== "ACTIVE") return conflict(current.status === "EXPIRED" ? "LEASE_EXPIRED" : "AUTHORIZATION_INVALID");
      const check = await this.pinned(tx, inv), now = await databaseNow(tx);
      if (!check.eligible || !open) return conflict("AUTHORIZATION_INVALID");
      if (sessionId && !await currentSession(tx, context, sessionId, inv.authorization?.bindingId)) return conflict("STALE_SESSION");
      if (current.leaseExpiresAt <= now) {
        await this.end(tx, inv, current, context, "EXPIRED", true, "CLAIM_LEASE_EXPIRED");
        return conflict("LEASE_EXPIRED");
      }
      if (release) return this.end(tx, inv, current, context, "RELEASED", true, "EXECUTOR_RELEASED");
      const leaseExpiresAt = new Date(Math.min(now.getTime() + this.leaseMs, check.validUntil.getTime(), credential.expiresAt.getTime()));
      if (leaseExpiresAt <= now) throw new IdentityError();
      const renewed = await tx.executorClaim.update({ where: { id: claim.id }, data: { leaseExpiresAt } });
      await tx.invocationEvent.create({ data: { runId: inv.runId, invocationId: inv.id, actorPrincipalId: context.principalId,
        kind: "CLAIM_RENEWED", status: "CLAIMED", reason: "EXECUTOR_RENEWED", claimId: claim.id, claimGeneration: claim.generation, leaseExpiresAt } });
      return renewed;
    });
  }
}
