import type { Prisma, PrismaClient } from "../generated/prisma/client.js";
import { IdentityError, type AuthenticatedContext } from "../identity/identity.js";
import { databaseNow, lockCredential } from "../authorization/credential-lock.js";
import { canonical, text, ValidationError } from "../registry/validation.js";
import { generation } from "./protocol-validation.js";
import { ExecutorProtocol } from "./executor-protocol.js";
import { ExecutorConflict } from "./protocol-errors.js";
import { currentSession } from "./runtime-session.js";
import { WRITE_PROFILE, WRITE_HANDLER, WRITE_MODE, validDemoResource, receiptIdentity } from "./demo-receipt-contract.js";
import { EXECUTION_PROFILE, HEALTH_HANDLER, HEALTH_RESULT, reportIdentity, type ReportInput } from "./execution-contract.js";

export type SessionInput = { bindingId: string; sessionKey: string; artifactDigest: string; ledgerId: string; executionProfile: string; ledgerProofDigest: string; outputResource?:string };
export type StartInput = { sessionId: string; generation: number; requestKey: string; artifactDigest: string; ledgerId: string };
const fail = (code: string) => new ExecutorConflict(code);
const uuid = (v: string) => /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(v);

export class ExecutorExecution {
  constructor(private readonly db: PrismaClient, private readonly protocol: ExecutorProtocol, private readonly enabled = false) {}
  async registerSession(context: AuthenticatedContext, input: SessionInput) {
    await this.protocol.executor(context, "executor:session");
    const args = { bindingId: text(input.bindingId, "binding ID"), sessionKey: text(input.sessionKey, "session key"),
      artifactDigest: input.artifactDigest, ledgerId: input.ledgerId, executionProfile: input.executionProfile };
    if (!/^[a-f0-9]{64}$/.test(input.ledgerProofDigest)) throw new ValidationError("Ledger continuity proof required");
    if (!uuid(args.sessionKey) || !uuid(args.ledgerId) || !/^[a-f0-9]{64}$/.test(args.artifactDigest) || ![EXECUTION_PROFILE,WRITE_PROFILE].includes(args.executionProfile) || (args.executionProfile===WRITE_PROFILE&&!validDemoResource(input.outputResource))) throw new ValidationError("Invalid executor installation");
    const digest = canonical({ ...args, ledgerProofDigest: input.ledgerProofDigest, ...(input.outputResource?{outputResource:input.outputResource}:{}) }).digest;
    return this.db.$transaction(async tx => {
      const { credential } = await lockCredential(tx, context, "executor:session");
      if (!["executor:claim", "executor:lease", "executor:start", "executor:report"].every(s => credential.scopes.includes(s))) throw new IdentityError();
      await tx.$queryRaw`SELECT id FROM "ExecutorDeployment" WHERE id = ${context.deploymentId} AND "ownerId" = ${context.ownerId} FOR UPDATE`;
      await tx.$queryRaw`SELECT id FROM "TrustedResourceBinding" WHERE id = ${args.bindingId} AND "ownerId" = ${context.ownerId} FOR UPDATE`;
      const binding = await tx.trustedResourceBinding.findFirst({ where: { id: args.bindingId, ownerId: context.ownerId, deploymentId: context.deploymentId! }, include: { tool: true } });
      const now = await databaseNow(tx);
      if (credential.expiresAt <= now) throw new IdentityError();
      if (!binding || binding.revokedAt || binding.expiresAt <= now || binding.executionProfile !== args.executionProfile || (binding.outputResource??null)!==(input.outputResource??null) || binding.ledgerId !== args.ledgerId ||
        binding.artifactDigest !== args.artifactDigest || !((args.executionProfile===EXECUTION_PROFILE&&binding.tool.handlerId===HEALTH_HANDLER&&binding.tool.name==="health_ping")||(args.executionProfile===WRITE_PROFILE&&binding.tool.handlerId===WRITE_HANDLER&&binding.tool.name==="write_demo_receipt"))) throw fail("INSTALLATION_MISMATCH");
      const anchor = await tx.executorLedgerAnchor.findUnique({ where: { bindingId: binding.id } });
      if (!anchor) {
        // Existing pre-11.2d installations need explicit operator intervention,
        // not a silent trust-on-first-use baseline over possible past execution.
        if (await tx.executorSession.count({ where: { bindingId: binding.id } })) throw fail("LEDGER_BASELINE_REQUIRED");
        await tx.executorLedgerAnchor.create({ data: { bindingId: binding.id, proofDigest: input.ledgerProofDigest } });
      } else if (anchor.proofDigest !== input.ledgerProofDigest) throw fail("LEDGER_CONTINUITY_BROKEN");
      const previous = await tx.executorSession.findUnique({ where: { ownerId_deploymentId_sessionKey: { ownerId: context.ownerId, deploymentId: context.deploymentId!, sessionKey: args.sessionKey } } });
      if (previous) {
        if (previous.requestDigest !== digest || previous.credentialId !== credential.id) throw fail("SESSION_KEY_CONFLICT");
        return previous;
      }
      const last = await tx.executorSession.findFirst({ where: { ownerId: context.ownerId, deploymentId: context.deploymentId! }, orderBy: { generation: "desc" } });
      const next = (last?.generation ?? 0) + 1; generation(next);
      await tx.executorSession.updateMany({ where: { ownerId: context.ownerId, deploymentId: context.deploymentId!, active: true }, data: { active: false } });
      return tx.executorSession.create({ data: { ...args, requestDigest: digest, ownerId: context.ownerId, deploymentId: context.deploymentId!,
        executorPrincipalId: context.principalId, credentialId: credential.id, generation: next,
        expiresAt: new Date(Math.min(credential.expiresAt.getTime(), binding.expiresAt.getTime())) } });
    });
  }
  async recoveryInventory(context: AuthenticatedContext, sessionId: string, proofDigest: string, after?: string) {
    await this.protocol.executor(context, "executor:report");
    if (!/^[a-f0-9]{64}$/.test(proofDigest)) throw new ValidationError("Invalid ledger proof");
    return this.db.$transaction(async tx => {
      await lockCredential(tx, context, "executor:report");
      const session = await currentSession(tx, context, text(sessionId, "session ID"));
      if (!session) throw fail("STALE_SESSION");
      const anchor = await tx.executorLedgerAnchor.findUnique({ where: { bindingId: session.bindingId } });
      if (!anchor || anchor.proofDigest !== proofDigest) throw fail("LEDGER_CONTINUITY_BROKEN");
      const where = { ownerId: context.ownerId, deploymentId: context.deploymentId!, session: { bindingId: session.bindingId } };
      if (after && !await tx.executorClaim.findFirst({ where: { ...where, id: after } })) throw new IdentityError();
      const rows = await tx.executorClaim.findMany({ where: { ...where, ...(after ? { id: { gt: after } } : {}) }, orderBy: { id: "asc" }, take: 101,
        include: { session: true, starts: { include: { reports: { select: { id: true, digest: true, outcome: true } } } } } });
      return { claims: rows.slice(0,100).map(c => ({ id: c.id, invocationId: c.invocationId, generation: c.generation,
        sessionId: c.sessionId!, artifactDigest: c.session!.artifactDigest, status: c.status, reportCredentialCurrent: c.credentialId === context.credentialId,
        start: c.starts[0] ? { id: c.starts[0].id, requestKey: c.starts[0].requestKey, reports: c.starts[0].reports } : null })),
        nextCursor: rows.length > 100 ? rows[99]!.id : null, hasMore: rows.length > 100, executionAllowed: false };
    });
  }
  private async ownedClaim(context: AuthenticatedContext, claimId: string) {
    const claim = await this.db.executorClaim.findFirst({ where: { id: text(claimId, "claim ID"), ownerId: context.ownerId,
      deploymentId: context.deploymentId!, executorPrincipalId: context.principalId, credentialId: context.credentialId } });
    if (!claim) throw new IdentityError();
    return claim;
  }
  private async executionInfo(tx:Prisma.TransactionClient,inv:{id:string;authorization:{bindingId:string}|null}){
    const binding=inv.authorization?await tx.trustedResourceBinding.findUnique({where:{id:inv.authorization.bindingId}}):null;
    return binding?.mode===WRITE_MODE?{profile:WRITE_PROFILE,outputResource:binding.outputResource!,target:receiptIdentity(inv.id,binding.outputResource!).path}:undefined;
  }
  async authorizeStart(context: AuthenticatedContext, claimId: string, input: StartInput) {
    await this.protocol.executor(context, "executor:start"); generation(input.generation);
    const args = { sessionId: text(input.sessionId, "session ID"), generation: input.generation, requestKey: text(input.requestKey, "start request key", 128),
      artifactDigest: input.artifactDigest, ledgerId: input.ledgerId };
    if (!/^[a-f0-9]{64}$/.test(args.artifactDigest) || !uuid(args.ledgerId)) throw new ValidationError("Invalid start identity");
    const requestDigest = canonical(args).digest, owned = await this.ownedClaim(context, claimId);
    return this.protocol.withInvocation(context, owned.invocationId, "executor:start", async (tx, inv, credential, open) => {
      const previous = await tx.executorStart.findUnique({ where: { invocationId: inv.id } });
      if (previous) {
        if (previous.claimId !== owned.id || previous.requestDigest !== requestDigest) return fail("START_IDENTITY_CONFLICT");
        return { start: previous, startAllowed: false, ledgerId: args.ledgerId, execution:await this.executionInfo(tx,inv) };
      }
      if (!this.enabled) return fail("EXECUTION_DISABLED");
      const claim = inv.claims[0];
      if (!open || inv.status !== "CLAIMED" || !claim || claim.id !== owned.id || claim.status !== "ACTIVE" ||
        claim.generation !== args.generation || claim.sessionId !== args.sessionId || claim.startAuthorizedAt || !credential.scopes.includes("executor:claim")) return fail("STALE_CLAIM");
      const check = await this.protocol.pinned(tx, inv);
      if (!check.eligible) return fail("AUTHORIZATION_INVALID");
      const session = await currentSession(tx, context, args.sessionId, inv.authorization?.bindingId);
      const tool = await tx.toolRevision.findUnique({ where: { id: inv.toolId } });
      if (!session || session.artifactDigest !== args.artifactDigest || session.ledgerId !== args.ledgerId || !((session.executionProfile===EXECUTION_PROFILE&&tool?.handlerId===HEALTH_HANDLER&&tool.name==="health_ping")||(session.executionProfile===WRITE_PROFILE&&tool?.handlerId===WRITE_HANDLER&&tool.name==="write_demo_receipt"))) return fail("INSTALLATION_MISMATCH");
      const now = await databaseNow(tx);
      const deadline = new Date(Math.min(now.getTime() + 5000, claim.leaseExpiresAt.getTime(), check.validUntil.getTime(), credential.expiresAt.getTime(), session.expiresAt.getTime()));
      if (deadline <= now) return fail("LEASE_EXPIRED");
      const start = await tx.executorStart.create({ data: { invocationId: inv.id, claimId: claim.id, generation: claim.generation, sessionId: session.id,
        requestKey: args.requestKey, requestDigest, authorizationDigest: claim.authorizationDigest, artifactDigest: args.artifactDigest,
        startDeadline: deadline, resultDeadline: new Date(now.getTime() + 30000), createdAt: now } });
      if(session.executionProfile===WRITE_PROFILE){
        const approval=await tx.externalApprovalRequest.findUniqueOrThrow({where:{invocationId:inv.id}});
        await tx.externalApprovalConsumption.create({data:{approvalId:approval.id,startId:start.id,createdAt:now}});
        await tx.invocationEvent.create({data:{runId:inv.runId,invocationId:inv.id,actorPrincipalId:context.principalId,kind:"EXTERNAL_APPROVAL_CONSUMED",status:"START_AUTHORIZED",reason:"EXTERNAL_APPROVAL_CONSUMED",externalApprovalId:approval.id,startId:start.id}});
      }
      await tx.executorClaim.update({ where: { id: claim.id }, data: { startAuthorizedAt: now } });
      await tx.invocation.update({ where: { id: inv.id }, data: { status: "START_AUTHORIZED", reason: "EXECUTOR_START_AUTHORIZED" } });
      await tx.invocationEvent.create({ data: { invocationId: inv.id, runId: inv.runId, actorPrincipalId: context.principalId,
        kind: "START_AUTHORIZED", status: "START_AUTHORIZED", reason: "EXECUTOR_START_AUTHORIZED", startId: start.id,
        claimId: claim.id, claimGeneration: claim.generation, leaseExpiresAt: claim.leaseExpiresAt } });
      return { start, startAllowed: true, ledgerId: session.ledgerId, execution:await this.executionInfo(tx,inv) };
    });
  }
  async inspectStart(context: AuthenticatedContext, claimId: string) {
    await this.protocol.executor(context, "executor:report");
    const owned = await this.ownedClaim(context, claimId);
    return this.protocol.withInvocation(context, owned.invocationId, "executor:report", async (tx, inv) => {
      const start = await tx.executorStart.findUnique({ where: { invocationId: inv.id } });
      if (start) {
        if (start.claimId !== owned.id) return fail("STALE_CLAIM");
        return { start, claimFenced: true, execution:await this.executionInfo(tx,inv) };
      }
      await tx.$queryRaw`SELECT id FROM "ExecutorDeployment" WHERE id = ${context.deploymentId} FOR UPDATE`;
      const session = owned.sessionId ? await tx.executorSession.findUnique({ where: { id: owned.sessionId } }) : null;
      const claim = await tx.executorClaim.findUniqueOrThrow({ where: { id: owned.id } });
      const now = await databaseNow(tx);
      const claimFenced = !session || !session.active || session.expiresAt <= now || claim.leaseExpiresAt <= now || claim.status !== "ACTIVE" || inv.claims[0]?.id !== claim.id;
      return { start: null, claimFenced, execution:undefined };
    });
  }
  async report(context: AuthenticatedContext, startId: string, input: ReportInput) {
    await this.protocol.executor(context, "executor:report"); generation(input.generation);
    const target = await this.db.executorStart.findFirst({ where: { id: text(startId, "start ID"), claim: { ownerId: context.ownerId,
      deploymentId: context.deploymentId!, executorPrincipalId: context.principalId, credentialId: context.credentialId } }, include:{invocation:{include:{authorization:{include:{binding:true}}}}} });
    if (!target) throw new IdentityError();
    const binding=target.invocation.authorization?.binding,write=binding?.mode===WRITE_MODE?{invocationId:target.invocationId,outputResource:binding.outputResource!}:undefined;
    const payload=reportIdentity(input,write),expected=write?receiptIdentity(write.invocationId,write.outputResource).result:HEALTH_RESULT;
    if (target.sessionId !== input.sessionId || target.generation !== input.generation) throw fail("START_IDENTITY_CONFLICT");
    return this.protocol.withInvocation(context, target.invocationId, "executor:report", async (tx, inv) => {
      const previous = await tx.executorReport.findUnique({ where: { startId_digest: { startId: target.id, digest: payload.digest } } });
      if (previous) return previous;
      const earlier = await tx.executorReport.findFirst({ where: { startId: target.id }, orderBy: { createdAt: "asc" } });
      if (inv.status === "SUCCEEDED" || (earlier && input.outcome === "UNKNOWN")) {
        await tx.invocationEvent.create({ data: { invocationId: inv.id, runId: inv.runId, actorPrincipalId: context.principalId,
          kind: "RESULT_CONFLICT", status: inv.status, reason: "CONFLICTING_EXECUTOR_REPORT", startId: target.id, authorization: { conflictingReportDigest: payload.digest } } });
        return fail("RESULT_CONFLICT");
      }
      if (!["START_AUTHORIZED", "UNKNOWN"].includes(inv.status)) return fail("INVALID_RESULT_STATE");
      const report = await tx.executorReport.create({ data: { startId: target.id, outcome: input.outcome, reason: input.reason,
        ...(input.outcome === "SUCCEEDED" ? { result: expected } : {}), digest: payload.digest } });
      await tx.invocation.update({ where: { id: inv.id }, data: { status: input.outcome, reason: input.reason } });
      await tx.invocationEvent.create({ data: { invocationId: inv.id, runId: inv.runId, actorPrincipalId: context.principalId,
        kind: inv.status === "UNKNOWN" ? "RESULT_RECONCILED" : "RESULT_REPORTED", status: input.outcome, reason: input.reason,
        startId: target.id, reportId: report.id, ...(input.outcome === "SUCCEEDED" ? { executionResult: expected } : {}) } });
      return report;
    });
  }
}
