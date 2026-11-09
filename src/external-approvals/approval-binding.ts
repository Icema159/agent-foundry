import type { Invocation, Prisma, TrustedResourceBinding } from "../generated/prisma/client.js";
import { canonical } from "../registry/validation.js";
import { receiptIdentity, WRITE_MODE } from "../executor/demo-receipt-contract.js";
export function approvalIdentity(inv:Invocation,snapshot:unknown,authorizationDigest:string,binding:TrustedResourceBinding,expiresAt:Date){
  if(binding.mode!==WRITE_MODE||!binding.outputResource)throw Error("Unsupported external approval");
  const receipt=receiptIdentity(inv.id,binding.outputResource);
  return canonical({format:1,invocationId:inv.id,ownerId:inv.ownerId,authorizationDigest,authorization:snapshot,
    action:{tool:"write_demo_receipt",arguments:inv.arguments,resource:binding.outputResource,target:receipt.path,contentDigest:receipt.result.contentDigest,overwrite:false},
    risk:"WRITE",expiresAt:expiresAt.toISOString()});
}
export async function checkExternalApproval(tx:Prisma.TransactionClient,inv:Invocation,saved:{digest:string;snapshot:unknown},binding:TrustedResourceBinding,now:Date,requireDecision:boolean){
  const request=await tx.externalApprovalRequest.findUnique({where:{invocationId:inv.id},include:{decision:true,consumption:true}});
  if(!request||request.ownerId!==inv.ownerId||request.authorizationDigest!==saved.digest||request.digest!==canonical(request.identity).digest||
    request.digest!==approvalIdentity(inv,saved.snapshot,saved.digest,binding,request.expiresAt).digest)return{valid:false,reason:"APPROVAL_BINDING_MISMATCH"}as const;
  if(request.expiresAt<=now)return{valid:false,reason:"APPROVAL_EXPIRED"}as const;
  if(!requireDecision)return{valid:true,request,validUntil:request.expiresAt}as const;
  if(request.decision?.decision!=="APPROVE"||request.consumption)return{valid:false,reason:"APPROVAL_REQUIRED_OR_CONSUMED"}as const;
  const c=await tx.credential.findUnique({where:{id:request.decision.credentialId},include:{principal:true}});
  if(!c||c.revokedAt||c.expiresAt<=now||!c.scopes.includes("operator:approve")||c.principal.type!=="OPERATOR"||c.principal.ownerId!==inv.ownerId||c.principalId!==request.decision.actorPrincipalId)
    return{valid:false,reason:"APPROVAL_ACTOR_INVALID"}as const;
  return{valid:true,request,validUntil:new Date(Math.min(request.expiresAt.getTime(),c.expiresAt.getTime()))}as const;
}
