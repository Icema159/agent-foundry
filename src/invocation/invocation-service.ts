import { approvalIdentity } from "../external-approvals/approval-binding.js";
import { ExternalApprovals } from "../external-approvals/external-approvals.js";
import { WRITE_MODE } from "../executor/demo-receipt-contract.js";
import { randomUUID } from "node:crypto";
import { Prisma, type PrismaClient } from "../generated/prisma/client.js";
import { authorize, IdentityError, type AuthenticatedContext, type Scope } from "../identity/identity.js";
import { canonical, text, ValidationError } from "../registry/validation.js";
import { validateArguments } from "./argument-validation.js";
import { databaseNow, lockCredential } from "../authorization/credential-lock.js";
import { authorizationSnapshot, evaluateAuthorization, recheckPinnedAuthorization } from "../authorization/invocation-authorization.js";
import { grantDigest } from "../authorization/resource-binding.js";

export class InvocationConflict extends Error { constructor(message: string) { super(message); this.name = "InvocationConflict"; } }
const active = ["REQUESTED", "READY", "PENDING_APPROVAL", "CLAIMED", "START_AUTHORIZED", "RUNNING", "UNKNOWN"] as const;
type Request = { runId: string; idempotencyKey: string; toolId: string; deploymentId: string; grantId?: string; arguments: unknown };
async function agent(context: AuthenticatedContext, scope: Scope): Promise<string> {
  await authorize(context, scope);
  if (context.principalType !== "AGENT" || !context.agentId) throw new IdentityError();
  return context.agentId;
}

/** External control plane only. No reference queue/runtime or physical handler execution. */
export class InvocationService {
  constructor(private readonly db: PrismaClient, private readonly approvalTtlMs = 900000) {
    if(!Number.isSafeInteger(approvalTtlMs)||approvalTtlMs<1000||approvalTtlMs>900000)throw new ValidationError("Invalid external approval TTL");
  }
  async approvalStatus(context:AuthenticatedContext,id:string){
    const agentId=await agent(context,"invocation:request");
    const inv=await this.db.invocation.findFirst({where:{id,ownerId:context.ownerId,agentId},select:{externalApproval:{select:{id:true}}}});
    if(!inv)throw new IdentityError();
    return inv.externalApproval?new ExternalApprovals(this.db).agentStatus(context,id):null;
  }
  async openRun(context: AuthenticatedContext, versionId: string) {
    const agentId = await agent(context, "run:manage"); text(versionId, "version ID");
    const version = await this.db.externalAgentVersion.findFirst({ where: { id: versionId, ownerId: context.ownerId, agentId } });
    if (!version) throw new IdentityError();
    return this.db.externalRun.create({ data: { id: `ext_${randomUUID()}`, ownerId: context.ownerId, agentId, versionId } });
  }
  async acceptInvocation(context: AuthenticatedContext, request: Request) {
    const agentId = await agent(context, "invocation:request");
    const runId = text(request.runId, "run ID"), key = text(request.idempotencyKey, "idempotency key", 128);
    const toolId = text(request.toolId, "tool ID"), deploymentId = text(request.deploymentId, "deployment ID");
    const grantId = request.grantId === undefined ? null : text(request.grantId, "grant ID");
    // Canonicalize before the lock; no identity/scope fields are accepted from input.
    const args = canonical(request.arguments).value;
    const fingerprint = canonical({ toolId, deploymentId, grantId, arguments: args }).digest;
    return this.db.$transaction(async tx => {
      const runs = await tx.$queryRaw<Array<{ id: string; ownerId: string; agentId: string; versionId: string; status: string }>>`
        SELECT id, "ownerId", "agentId", "versionId", status FROM "ExternalRun"
        WHERE id = ${runId} AND "ownerId" = ${context.ownerId} AND "agentId" = ${agentId} FOR UPDATE`;
      const run = runs[0]; if (!run) throw new IdentityError();
      const { credential } = await lockCredential(tx, context, "invocation:request");
      const previous = await tx.invocation.findUnique({ where: { ownerId_runId_idempotencyKey: { ownerId: context.ownerId, runId, idempotencyKey: key } } });
      if (previous) {
        if (previous.fingerprint !== fingerprint) throw new InvocationConflict("Idempotency key already used with different request");
        return previous;
      }
      if (run.status !== "RUNNING") throw new InvocationConflict("External run is closed");
      if (await tx.invocation.findFirst({ where: { runId, status: { in: [...active] } }, select: { id: true } })) throw new InvocationConflict("External run already has an active invocation");
      const tool = await tx.toolRevision.findFirst({ where: { id: toolId, ownerId: context.ownerId, versionId: run.versionId, manifest: { sealed: true } }, include: { manifest: { include: { version: true } } } });
      if (!tool) throw new IdentityError();
      const validated = validateArguments(tool.inputSchema, args);
      if (grantId) await tx.$queryRaw`SELECT id FROM "CapabilityGrant" WHERE id = ${grantId} AND "ownerId" = ${context.ownerId}
        AND "versionId" = ${run.versionId} AND "toolId" = ${toolId} AND "deploymentId" = ${deploymentId} FOR UPDATE`;
      const grant = grantId ? await tx.capabilityGrant.findFirst({ where: { id: grantId, ownerId: context.ownerId, versionId: run.versionId,
        toolId, deploymentId } }) : null;
      await tx.$queryRaw`SELECT id FROM "ExecutorDeployment" WHERE id = ${deploymentId} AND "ownerId" = ${context.ownerId} FOR UPDATE`;
      const deployment = await tx.executorDeployment.findFirst({ where: { id: deploymentId, ownerId: context.ownerId } });
      if (!deployment) throw new IdentityError();
      const decision = await evaluateAuthorization(tx, tool, deployment, grant, validated);
      // Expiry may have passed while waiting for a policy/binding lock.
      await lockCredential(tx, context, "invocation:request");
      const { status, reason } = decision;
      const invocation = await tx.invocation.create({ data: { ownerId: context.ownerId, agentId, versionId: run.versionId, runId,
        toolId, deploymentId, grantId: grant?.id ?? null, idempotencyKey: key, arguments: validated as Prisma.InputJsonValue, fingerprint, status, reason } });
      const snapshot = decision.binding && grant && (status === "READY" || status === "PENDING_APPROVAL") ?
        authorizationSnapshot(invocation, tool, deployment, grant, decision.binding, credential, decision.executionPolicy) : null;
      if (snapshot && decision.binding) await tx.invocationAuthorization.create({ data: { invocationId: invocation.id, runId,
        bindingId: decision.binding.id, credentialId: credential.id, snapshot: snapshot.value as Prisma.InputJsonValue, digest: snapshot.digest } });
      let externalApprovalId:string|undefined;
      if(snapshot&&decision.binding?.mode===WRITE_MODE&&status==="PENDING_APPROVAL"){
        const now=await databaseNow(tx),expiresAt=new Date(Math.min(now.getTime()+this.approvalTtlMs,decision.binding.expiresAt.getTime(),credential.expiresAt.getTime()));
        const identity=approvalIdentity(invocation,snapshot.value,snapshot.digest,decision.binding,expiresAt);
        const approval=await tx.externalApprovalRequest.create({data:{invocationId:invocation.id,ownerId:context.ownerId,authorizationDigest:snapshot.digest,identity:identity.value as Prisma.InputJsonValue,digest:identity.digest,expiresAt}});
        externalApprovalId=approval.id;
      }
      await tx.invocationEvent.create({ data: { runId, invocationId: invocation.id, actorPrincipalId: context.principalId,
        kind: "AUTHORIZATION_DECISION", status, reason, ...(externalApprovalId?{externalApprovalId}:{}), authorization: { requestFingerprint: fingerprint,
          grantId: grant?.id ?? null, policyRevision: grant?.id ?? null, grantDigest: grant ? grantDigest(grant) : null,
          bindingId: decision.binding?.id ?? null, bindingRevision: decision.binding?.revision ?? null,
          executionPolicy: decision.executionPolicy, authorizationDigest: snapshot?.digest ?? null } } });
      return invocation;
    });
  }
  /** Internal inspection only; never a permit or a public start/claim transition. */
  async inspectStartEligibility(context: AuthenticatedContext, invocationId: string, expectedDigest: string) {
    const agentId = await agent(context, "invocation:request");
    text(invocationId, "invocation ID"); text(expectedDigest, "authorization digest");
    return this.db.$transaction(async tx => {
      const found = await tx.invocation.findFirst({ where: { id: invocationId, ownerId: context.ownerId, agentId } });
      if (!found) throw new IdentityError();
      const runs = await tx.$queryRaw<Array<{ status: string }>>`SELECT status FROM "ExternalRun" WHERE id = ${found.runId}
        AND "ownerId" = ${context.ownerId} AND "agentId" = ${agentId} FOR UPDATE`;
      const approval=await tx.externalApprovalRequest.findUnique({where:{invocationId},include:{decision:true}});
      const ids=[...new Set([context.credentialId,approval?.decision?.credentialId].filter((id):id is string=>!!id))].sort();
      await tx.$queryRaw`SELECT id FROM "Credential" WHERE id IN (${Prisma.join(ids)}) ORDER BY id FOR UPDATE`;
      await tx.$queryRaw`SELECT id FROM "Principal" WHERE id IN (SELECT "principalId" FROM "Credential" WHERE id IN (${Prisma.join(ids)})) ORDER BY id FOR UPDATE`;
      const { credential } = await lockCredential(tx, context, "invocation:request");
      await tx.$queryRaw`SELECT id FROM "Invocation" WHERE id = ${invocationId} FOR UPDATE`;
      const invocation = await tx.invocation.findUniqueOrThrow({ where: { id: invocationId } });
      if (runs[0]?.status !== "RUNNING") return { eligible: false, startAllowed: false, reason: "RUN_CLOSED" } as const;
      return recheckPinnedAuthorization(tx, invocation, credential, expectedDigest);
    });
  }
  async cancelBlocked(context: AuthenticatedContext, runId: string, invocationId: string) {
    const agentId = await agent(context, "invocation:request");
    text(runId, "run ID"); text(invocationId, "invocation ID");
    return this.db.$transaction(async tx => {
      const runs = await tx.$queryRaw<Array<{ id: string; status: string }>>`SELECT id, status FROM "ExternalRun" WHERE id = ${runId} AND "ownerId" = ${context.ownerId} AND "agentId" = ${agentId} FOR UPDATE`;
      if (!runs[0]) throw new IdentityError();
      if (runs[0].status !== "RUNNING") throw new InvocationConflict("External run is closed");
      const updated = await tx.invocation.updateMany({ where: { id: invocationId, runId, ownerId: context.ownerId, status: "REQUESTED", reason: "RESOURCE_BINDING_UNVERIFIED" },
        data: { status: "REVOKED", reason: "AGENT_CANCELLED" } });
      if (updated.count !== 1) throw new InvocationConflict("Invalid invocation transition");
      await tx.invocationEvent.create({ data: { runId, invocationId, actorPrincipalId: context.principalId, kind: "CANCELLED", status: "REVOKED", reason: "AGENT_CANCELLED" } });
      return tx.invocation.findUniqueOrThrow({ where: { id: invocationId } });
    });
  }
  async closeRun(context: AuthenticatedContext, runId: string) {
    const agentId = await agent(context, "run:manage");
    text(runId, "run ID");
    return this.db.$transaction(async tx => {
      const runs = await tx.$queryRaw<Array<{ id: string; status: string }>>`SELECT id, status FROM "ExternalRun" WHERE id = ${runId} AND "ownerId" = ${context.ownerId} AND "agentId" = ${agentId} FOR UPDATE`;
      if (!runs[0]) throw new IdentityError();
      if (runs[0].status === "COMPLETED") return tx.externalRun.findUniqueOrThrow({ where: { id: runId } });
      if (await tx.invocation.findFirst({ where: { runId, status: { in: [...active] } }, select: { id: true } })) throw new InvocationConflict("External run has an unresolved invocation");
      return tx.externalRun.update({ where: { id: runId }, data: { status: "COMPLETED", completedAt: new Date() } });
    });
  }
  async getRun(context: AuthenticatedContext, runId: string) {
    const agentId = await agent(context, "run:manage");
    text(runId, "run ID");
    const run = await this.db.externalRun.findFirst({ where: { id: runId, ownerId: context.ownerId, agentId } });
    if (!run) throw new IdentityError();
    return run;
  }
  async getInvocation(context: AuthenticatedContext, invocationId: string) {
    const agentId = await agent(context, "invocation:request");
    text(invocationId, "invocation ID");
    const invocation = await this.db.invocation.findFirst({ where: { id: invocationId, ownerId: context.ownerId, agentId } });
    if (!invocation) throw new IdentityError();
    return invocation;
  }
  async historyPage(context: AuthenticatedContext, runId: string, after = 0n, limit = 50) {
    const agentId = await agent(context, "invocation:request");
    text(runId, "run ID");
    if (typeof after !== "bigint" || after < 0n || after > 9223372036854775807n || !Number.isInteger(limit) || limit < 1 || limit > 100) throw new InvocationConflict("Invalid history cursor");
    const run = await this.db.externalRun.findFirst({ where: { id: runId, ownerId: context.ownerId, agentId }, select: { id: true } });
    if (!run) throw new IdentityError();
    if (after !== 0n && !await this.db.invocationEvent.findFirst({ where: { runId, sequence: after }, select: { sequence: true } })) throw new InvocationConflict("Invalid history cursor");
    const events = await this.db.invocationEvent.findMany({ where: { runId, sequence: { gt: after } }, orderBy: { sequence: "asc" }, take: limit + 1 });
    return { events: events.slice(0, limit), hasMore: events.length > limit };
  }
  async history(context: AuthenticatedContext, runId: string, after = 0n, limit = 50) {
    const agentId = await agent(context, "invocation:request");
    text(runId, "run ID");
    if (typeof after !== "bigint" || after < 0n || !Number.isInteger(limit) || limit < 1 || limit > 100) throw new InvocationConflict("Invalid history cursor");
    const run = await this.db.externalRun.findFirst({ where: { id: runId, ownerId: context.ownerId, agentId }, select: { id: true } });
    if (!run) throw new IdentityError();
    return this.db.invocationEvent.findMany({ where: { runId, sequence: { gt: after } }, orderBy: { sequence: "asc" }, take: limit });
  }
}
