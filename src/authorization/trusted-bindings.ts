import type { PrismaClient } from "../generated/prisma/client.js";
import { authorize, IdentityError, type AuthenticatedContext } from "../identity/identity.js";
import { positiveInteger, text, ValidationError } from "../registry/validation.js";
import { lockCredential } from "./credential-lock.js";
import { deploymentDigest, isDemoReceiptWrite, isResourceFreeReadOnly, RESOURCE_FREE_MODE } from "./resource-binding.js";
import { WRITE_MODE, WRITE_PROFILE, validDemoResource } from "../executor/demo-receipt-contract.js";
import { EXECUTION_PROFILE, HEALTH_HANDLER } from "../executor/execution-contract.js";

/** Trusted local operator composition only. No HTTP configuration or handler execution. */
export class TrustedResourceBindings {
  constructor(private readonly db: PrismaClient) {}
  async approveResourceFree(context: AuthenticatedContext, input: {
    toolId: string; deploymentId: string; revision: number; artifactDigest: string; expiresAt: Date;
    execution?: { profile: string; ledgerId: string };
  }) {
    await authorize(context, "grant:manage");
    if (context.principalType !== "OPERATOR") throw new IdentityError();
    if (Object.keys(input).some(key => !["toolId", "deploymentId", "revision", "artifactDigest", "expiresAt", "execution"].includes(key))) throw new ValidationError("Unsupported binding field");
    const execution = input.execution === undefined ? null : { ...input.execution };
    if (execution && (Object.keys(execution).some(k => !["profile", "ledgerId"].includes(k)) || execution.profile !== EXECUTION_PROFILE || !/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(execution.ledgerId))) throw new ValidationError("Unsupported execution installation");
    const toolId = text(input.toolId, "tool ID"), deploymentId = text(input.deploymentId, "deployment ID");
    const revision = positiveInteger(input.revision), artifactDigest = input.artifactDigest;
    const expiresAt = new Date(input.expiresAt);
    if (!/^[a-f0-9]{64}$/.test(artifactDigest) || !(input.expiresAt instanceof Date) || !Number.isFinite(expiresAt.getTime())) throw new ValidationError("Invalid binding attestation or expiry");
    return this.db.$transaction(async tx => {
      const { now } = await lockCredential(tx, context, "grant:manage");
      if (expiresAt <= now) throw new ValidationError("Binding must expire in the future");
      await tx.$queryRaw`SELECT id FROM "ExecutorDeployment" WHERE id = ${deploymentId} AND "ownerId" = ${context.ownerId} FOR UPDATE`;
      const tool = await tx.toolRevision.findFirst({ where: { id: toolId, ownerId: context.ownerId, manifest: { sealed: true } } });
      const deployment = await tx.executorDeployment.findFirst({ where: { id: deploymentId, ownerId: context.ownerId } });
      if (!tool || !deployment) throw new IdentityError();
      if (!isResourceFreeReadOnly(tool, {})) throw new ValidationError("Only the fixed resource-free READ_ONLY contract is supported");
      if (execution && (tool.name !== "health_ping" || tool.handlerId !== HEALTH_HANDLER)) throw new ValidationError("Only the pinned health_ping handler may execute");
      return tx.trustedResourceBinding.create({ data: { ownerId: context.ownerId, versionId: tool.versionId, toolId, deploymentId,
        revision, mode: RESOURCE_FREE_MODE, artifactDigest, toolDigest: tool.digest, deploymentDigest: deploymentDigest(deployment),
        approvedByPrincipalId: context.principalId, expiresAt, executionProfile: execution?.profile ?? null, ledgerId: execution?.ledgerId ?? null } });
    });
  }
  async approveDemoOutput(context:AuthenticatedContext,input:{toolId:string;deploymentId:string;revision:number;artifactDigest:string;expiresAt:Date;ledgerId:string;outputResource:string}){
    await authorize(context,"grant:manage");if(context.principalType!=="OPERATOR")throw new IdentityError();
    if(Object.keys(input).some(k=>!["toolId","deploymentId","revision","artifactDigest","expiresAt","ledgerId","outputResource"].includes(k)))throw new ValidationError("Unsupported demo binding");
    const toolId=text(input.toolId,"tool ID"),deploymentId=text(input.deploymentId,"deployment ID"),revision=positiveInteger(input.revision);
    if(!validDemoResource(input.outputResource)||!/^([a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12})$/.test(input.ledgerId)||
      !/^[a-f0-9]{64}$/.test(input.artifactDigest)||!(input.expiresAt instanceof Date)||!Number.isFinite(input.expiresAt.getTime()))throw new ValidationError("Invalid demo output installation");
    return this.db.$transaction(async tx=>{
      await lockCredential(tx,context,"grant:manage");
      await tx.$queryRaw`SELECT id FROM "ExecutorDeployment" WHERE id=${deploymentId} AND "ownerId"=${context.ownerId} FOR UPDATE`;
      const tool=await tx.toolRevision.findFirst({where:{id:toolId,ownerId:context.ownerId,manifest:{sealed:true}}}),deployment=await tx.executorDeployment.findFirst({where:{id:deploymentId,ownerId:context.ownerId}});
      if(!tool||!deployment)throw new IdentityError();
      if(!isDemoReceiptWrite(tool,{}))throw new ValidationError("Only the fixed controlled WRITE receipt may use this binding");
      const {now}=await lockCredential(tx,context,"grant:manage");if(input.expiresAt<=now)throw new ValidationError("Binding expired");
      return tx.trustedResourceBinding.create({data:{ownerId:context.ownerId,versionId:tool.versionId,toolId,deploymentId,revision,mode:WRITE_MODE,artifactDigest:input.artifactDigest,
        executionProfile:WRITE_PROFILE,ledgerId:input.ledgerId,outputResource:input.outputResource,toolDigest:tool.digest,deploymentDigest:deploymentDigest(deployment),approvedByPrincipalId:context.principalId,expiresAt:input.expiresAt}});
    });
  }
  async revoke(context: AuthenticatedContext, bindingId: string): Promise<void> {
    await authorize(context, "grant:manage");
    if (context.principalType !== "OPERATOR") throw new IdentityError();
    text(bindingId, "binding ID");
    await this.db.$transaction(async tx => {
      await lockCredential(tx, context, "grant:manage");
      const changed = await tx.trustedResourceBinding.updateMany({ where: { id: bindingId, ownerId: context.ownerId, revokedAt: null }, data: { revokedAt: new Date() } });
      if (changed.count !== 1) throw new IdentityError();
    });
  }
}
