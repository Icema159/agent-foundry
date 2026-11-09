import { Prisma, type PrismaClient } from "../generated/prisma/client.js";
import { authorize, IdentityError, type AuthenticatedContext } from "../identity/identity.js";
import { databaseNow, lockCredential } from "../authorization/credential-lock.js";
import { recheckPinnedAuthorization } from "../authorization/invocation-authorization.js";
import { canonical, text, ValidationError } from "../registry/validation.js";
import { approvalIdentity } from "./approval-binding.js";
import { ExecutorConflict } from "../executor/protocol-errors.js";
import { receiptIdentity, WRITE_MODE } from "../executor/demo-receipt-contract.js";

const approvalInclude={authorization:{include:{binding:true}},externalApproval:{include:{decision:true,consumption:true}},claims:{orderBy:{generation:"desc"},take:1}}as const;
type ApprovalInvocation=Prisma.InvocationGetPayload<{include:typeof approvalInclude}>;

export class ExternalApprovals {
  constructor(private readonly db:PrismaClient){}
  private async transaction<T>(context:AuthenticatedContext,invocationId:string,agentRead:boolean,fn:(tx:Prisma.TransactionClient,inv:ApprovalInvocation)=>Promise<T>){
    const scope=agentRead?"invocation:request":"operator:approve";await authorize(context,scope);
    if(context.principalType!==(agentRead?"AGENT":"OPERATOR"))throw new IdentityError();
    return this.db.$transaction(async tx=>{
      const target=await tx.invocation.findFirst({where:{id:text(invocationId,"invocation ID"),ownerId:context.ownerId,...(agentRead?{agentId:context.agentId!}:{})}});
      if(!target)throw new IdentityError();
      await tx.$queryRaw`SELECT id FROM "ExternalRun" WHERE id=${target.runId} FOR UPDATE`;
      const inv=await tx.invocation.findUniqueOrThrow({where:{id:target.id},include:approvalInclude});
      const ids=[...new Set([context.credentialId,inv.authorization?.credentialId,inv.externalApproval?.decision?.credentialId].filter((id):id is string=>!!id))].sort();
      await tx.$queryRaw`SELECT id FROM "Credential" WHERE id IN (${Prisma.join(ids)}) ORDER BY id FOR UPDATE`;
      await tx.$queryRaw`SELECT id FROM "Principal" WHERE id IN (SELECT "principalId" FROM "Credential" WHERE id IN (${Prisma.join(ids)})) ORDER BY id FOR UPDATE`;
      await lockCredential(tx,context,scope);
      await tx.$queryRaw`SELECT id FROM "Invocation" WHERE id=${inv.id} FOR UPDATE`;
      return fn(tx,inv);
    });
  }
  private async view(tx:Prisma.TransactionClient,inv:ApprovalInvocation){
    const request=inv.externalApproval;if(!request)return null;
    const now=await databaseNow(tx),claim=inv.status==="CLAIMED"?inv.claims[0]:undefined;
    const check=inv.authorization?await recheckPinnedAuthorization(tx,inv,await tx.credential.findUniqueOrThrow({where:{id:inv.authorization.credentialId}}),inv.authorization.digest,claim?{id:claim.id,generation:claim.generation}:undefined,!request.decision):null;
    const status=request.consumption?"CONSUMED":request.decision?.decision==="REJECT"?"REJECTED":request.expiresAt<=now?"EXPIRED":
      !check?.eligible||["REVOKED","DENIED","EXPIRED"].includes(inv.status)?"INVALIDATED":request.decision?"APPROVED":"PENDING_APPROVAL";
    return{id:request.id,status,decision:request.decision?.decision??null,requestDigest:request.digest,expiresAt:request.expiresAt.toISOString(),consumedAt:request.consumption?.createdAt.toISOString()??null,
      executionAllowed:false,canDecide:inv.status==="PENDING_APPROVAL"&&!request.decision&&!!check?.eligible,invalidReason:request.consumption||check?.eligible?null:check?.reason??"AUTHORIZATION_MISMATCH"};
  }
  agentStatus(context:AuthenticatedContext,id:string){return this.transaction(context,id,true,async(tx,inv)=>{
    const v=await this.view(tx,inv);return v?{id:v.id,status:v.status,decision:v.decision,expiresAt:v.expiresAt,consumedAt:v.consumedAt,executionAllowed:false}:null;
  });}
  inspect(context:AuthenticatedContext,id:string){return this.transaction(context,id,false,async(tx,inv)=>{
    const summary=await this.view(tx,inv);
    if(!summary||inv.authorization?.binding.mode!==WRITE_MODE)throw new ValidationError("No supported external approval request");
    const receipt=receiptIdentity(inv.id,inv.authorization.binding.outputResource!);
    return{...summary,invocationId:inv.id,identity:inv.externalApproval!.identity,
      content:receipt.content,operatorDecision:inv.externalApproval!.decision?{actorPrincipalId:inv.externalApproval!.decision.actorPrincipalId,credentialId:inv.externalApproval!.decision.credentialId,createdAt:inv.externalApproval!.decision.createdAt,reason:inv.externalApproval!.decision.reason}:null};
  });}
  decide(context:AuthenticatedContext,id:string,input:{requestDigest:string;requestKey:string;decision:string;reason:string}){
    const args={requestDigest:input.requestDigest,requestKey:text(input.requestKey,"request key",128),decision:input.decision,reason:text(input.reason,"reason",1000)};
    if(!/^[a-f0-9]{64}$/.test(args.requestDigest)||!["APPROVE","REJECT"].includes(args.decision))throw new ValidationError("Invalid external approval decision");
    return this.transaction(context,id,false,async(tx,inv)=>{
      const request=inv.externalApproval;
      if(!request||request.digest!==args.requestDigest||!inv.authorization||inv.authorization.binding.mode!==WRITE_MODE||
        request.digest!==approvalIdentity(inv,inv.authorization.snapshot,inv.authorization.digest,inv.authorization.binding,request.expiresAt).digest)throw new ExecutorConflict("APPROVAL_IDENTITY_MISMATCH");
      const digest=canonical({...args,actorPrincipalId:context.principalId,credentialId:context.credentialId}).digest;
      if(request.decision){if(request.decision.requestDigest!==digest)throw new ExecutorConflict("APPROVAL_DECISION_CONFLICT");return request.decision;}
      const run=await tx.externalRun.findUniqueOrThrow({where:{id:inv.runId}});
      if(inv.status!=="PENDING_APPROVAL"||run.status!=="RUNNING")throw new ExecutorConflict("APPROVAL_NOT_PENDING");
      if(args.decision==="APPROVE"){
        const view=await this.view(tx,inv);if(!view?.canDecide)throw new ExecutorConflict(view?.invalidReason??"APPROVAL_INVALID");
      }
      const {now}=await lockCredential(tx,context,"operator:approve");
      if(args.decision==="APPROVE"&&request.expiresAt<=now)throw new ExecutorConflict("APPROVAL_EXPIRED");
      const decision=await tx.externalApprovalDecision.create({data:{approvalId:request.id,ownerId:context.ownerId,actorPrincipalId:context.principalId,credentialId:context.credentialId,
        requestKey:args.requestKey,requestDigest:digest,decision:args.decision,reason:args.reason,createdAt:now}});
      await tx.invocation.update({where:{id:inv.id},data:{status:args.decision==="APPROVE"?"READY":"REVOKED",reason:args.decision==="APPROVE"?"EXTERNAL_APPROVAL_GRANTED":"EXTERNAL_APPROVAL_REJECTED"}});
      await tx.invocationEvent.create({data:{runId:inv.runId,invocationId:inv.id,actorPrincipalId:context.principalId,kind:args.decision==="APPROVE"?"EXTERNAL_APPROVAL_APPROVED":"EXTERNAL_APPROVAL_REJECTED",
        status:args.decision==="APPROVE"?"READY":"REVOKED",reason:args.decision==="APPROVE"?"EXTERNAL_APPROVAL_GRANTED":"EXTERNAL_APPROVAL_REJECTED",externalApprovalId:request.id}});
      return decision;
    });
  }
}
