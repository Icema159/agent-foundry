import type { Prisma, PrismaClient } from "../generated/prisma/client.js";
import { authorize, IdentityError, type AuthenticatedContext } from "../identity/identity.js";
import { canonical, text, ValidationError } from "../registry/validation.js";
import { lockCredential } from "../authorization/credential-lock.js";
import { ExecutorConflict } from "../executor/protocol-errors.js";
import { reconcilePossibleStart } from "../executor/start-state.js";

export const findingDecisions = ["RETAIN_UNKNOWN", "CONFLICTING_EVIDENCE", "RECOVERY_BLOCKED"] as const;
export type EvidenceRef = { kind: "CLAIM" | "START" | "SESSION" | "REPORT" | "EVENT" | "LEDGER_EXPORT"; id: string };
export type FindingInput = { requestKey: string; basisSequence: string; decision: string; reason: string; evidence: EvidenceRef[] };
const conflict = (code: string) => new ExecutorConflict(code);

/** Trusted operator adapter only. Findings never become execution results or retries. */
export class OperatorReconciliation {
  constructor(private readonly db: PrismaClient) {}
  private async transaction<T>(context: AuthenticatedContext, invocationId: string, fn: (tx: Prisma.TransactionClient) => Promise<T>) {
    await authorize(context,"operator:reconcile");
    if (context.principalType !== "OPERATOR" || context.agentId || context.deploymentId) throw new IdentityError();
    text(invocationId,"invocation ID");
    return this.db.$transaction(async tx=>{
      const inv=await tx.invocation.findFirst({where:{id:invocationId,ownerId:context.ownerId},select:{runId:true}});
      if(!inv)throw new IdentityError();
      await tx.$queryRaw`SELECT id FROM "ExternalRun" WHERE id=${inv.runId} FOR UPDATE`;
      await lockCredential(tx,context,"operator:reconcile");
      await tx.$queryRaw`SELECT id FROM "Invocation" WHERE id=${invocationId} FOR UPDATE`;
      return fn(tx);
    });
  }
  private async view(tx:Prisma.TransactionClient,invocationId:string){
    const inv=await tx.invocation.findUniqueOrThrow({where:{id:invocationId},select:{id:true,ownerId:true,agentId:true,versionId:true,runId:true,deploymentId:true,status:true,reason:true,
      run:{select:{status:true}},authorization:{select:{digest:true,bindingId:true,credentialId:true}},
      claims:{orderBy:{generation:"desc"},take:100,select:{id:true,generation:true,status:true,sessionId:true,credentialId:true,executorPrincipalId:true,leaseExpiresAt:true,startAuthorizedAt:true}},
      start:{select:{id:true,claimId:true,generation:true,sessionId:true,artifactDigest:true,createdAt:true,startDeadline:true,resultDeadline:true,reports:{select:{id:true,digest:true,outcome:true,reason:true,createdAt:true}}}},
      operatorFindings:{orderBy:{basisSequence:"desc"},take:100,select:{id:true,actorPrincipalId:true,credentialId:true,basisSequence:true,decision:true,reason:true,evidence:true,createdAt:true}},
      events:{orderBy:{sequence:"desc"},take:100,select:{sequence:true,kind:true,status:true,reason:true,claimId:true,startId:true,reportId:true,findingId:true,actorPrincipalId:true,createdAt:true}}}});
    const claimCount=await tx.executorClaim.count({where:{invocationId}}),eventCount=await tx.invocationEvent.count({where:{invocationId}}),findingCount=await tx.operatorFinding.count({where:{invocationId}});
    const session=inv.start?await tx.executorSession.findUnique({where:{id:inv.start.sessionId},select:{id:true,generation:true,active:true,artifactDigest:true,ledgerId:true,bindingId:true,expiresAt:true}}):null;
    const ledgerAnchor=session?await tx.executorLedgerAnchor.findUnique({where:{bindingId:session.bindingId},select:{bindingId:true,proofDigest:true,createdAt:true}}):null;
    const c=inv.claims.find(c=>c.id===inv.start?.claimId);
    const credential=c?await tx.credential.findUnique({where:{id:c.credentialId},select:{id:true,principalId:true,revokedAt:true,expiresAt:true}}):null;
    const diagnostics:string[]=[];
    if(["START_AUTHORIZED","UNKNOWN"].includes(inv.status)&&!inv.start)diagnostics.push("NO_COMPLETE_AUTHORIZED_START");
    if(inv.start&&(!c||!c.startAuthorizedAt||c.sessionId!==inv.start.sessionId||c.generation!==inv.start.generation))diagnostics.push("START_CLAIM_CONFLICT");
    if(inv.start?.reports.some(r=>r.outcome==="SUCCEEDED")&&inv.status!=="SUCCEEDED")diagnostics.push("RESULT_STATE_CONFLICT");
    if(inv.status==="SUCCEEDED"&&!inv.start?.reports.some(r=>r.outcome==="SUCCEEDED"))diagnostics.push("SUCCESS_WITHOUT_REPORT");
    if(credential?.revokedAt)diagnostics.push("ORIGINAL_CREDENTIAL_REVOKED");
    return { ...inv, diagnostics, operatorFindings:inv.operatorFindings.map(f=>({...f,basisSequence:f.basisSequence.toString(),verification:"OPERATOR_FINDING_NOT_VERIFIED"})),
      events:inv.events.map(e=>({...e,sequence:e.sequence.toString()})),basisSequence:inv.events[0]?.sequence.toString()??"0",session,ledgerAnchor,executorCredential:credential,
      counts:{claims:claimCount,events:eventCount,findings:findingCount},truncated:claimCount>100||eventCount>100||findingCount>100,
      outcomeVerification:inv.start?.reports.some(r=>r.outcome==="SUCCEEDED")?"EXECUTOR_REPORTED":"UNDETERMINED",
      retryAllowed:false,executionAllowed:false,resultImportAllowed:false,
      safeFollowUp:inv.status==="UNKNOWN"?"INVESTIGATE_AND_RECORD_FINDING":inv.status==="START_AUTHORIZED"?"REFRESH_AFTER_EVIDENCE_CHECK":"INSPECT_PERSISTED_HISTORY" };
  }
  inspect(context:AuthenticatedContext,invocationId:string){return this.transaction(context,invocationId,tx=>this.view(tx,invocationId));}
  refresh(context:AuthenticatedContext,invocationId:string){return this.transaction(context,invocationId,async tx=>{
    const inv=await tx.invocation.findUniqueOrThrow({where:{id:invocationId},include:{authorization:true,claims:{orderBy:{generation:"desc"},take:1}}});
    await reconcilePossibleStart(tx,inv,context);
    return this.view(tx,invocationId);
  });}
  async record(context:AuthenticatedContext,invocationId:string,input:FindingInput){
    const args={requestKey:text(input.requestKey,"request key",128),basisSequence:input.basisSequence,decision:input.decision,reason:text(input.reason,"reason",1000),evidence:input.evidence};
    if(!/^[1-9]\d{0,18}$/.test(args.basisSequence)||BigInt(args.basisSequence)>9223372036854775807n||!findingDecisions.includes(args.decision as any)||!Array.isArray(args.evidence)||args.evidence.length>20)throw new ValidationError("Invalid operator finding");
    for(const ref of args.evidence)if(!ref||Object.keys(ref).some(k=>!["kind","id"].includes(k))||!["CLAIM","START","SESSION","REPORT","EVENT","LEDGER_EXPORT"].includes(ref.kind)||typeof ref.id!=="string"||!/^[A-Za-z0-9_-]{1,128}$/.test(ref.id))throw new ValidationError("Invalid evidence reference");
    const digest=canonical(args).digest;
    return this.transaction(context,invocationId,async tx=>{
      const key={ownerId:context.ownerId,invocationId,requestKey:args.requestKey};
      const previous=await tx.operatorFinding.findUnique({where:{ownerId_invocationId_requestKey:key}});
      if(previous){if(previous.requestDigest!==digest)throw conflict("FINDING_KEY_CONFLICT");return previous;}
      const inv=await tx.invocation.findUniqueOrThrow({where:{id:invocationId},include:{start:true}});
      if(inv.status!=="UNKNOWN")throw conflict("FINDING_REQUIRES_UNKNOWN");
      const latest=await tx.invocationEvent.findFirstOrThrow({where:{invocationId},orderBy:{sequence:"desc"}});
      if(latest.sequence!==BigInt(args.basisSequence))throw conflict("EVIDENCE_CHANGED");
      for(const ref of args.evidence){
        let valid=false;
        if(ref.kind==="CLAIM")valid=!!await tx.executorClaim.findFirst({where:{id:ref.id,invocationId}});
        if(ref.kind==="START")valid=inv.start?.id===ref.id;
        if(ref.kind==="SESSION")valid=!!await tx.executorClaim.findFirst({where:{sessionId:ref.id,invocationId}});
        if(ref.kind==="REPORT")valid=!!await tx.executorReport.findFirst({where:{id:ref.id,start:{invocationId}}});
        if(ref.kind==="EVENT"&&/^[1-9]\d{0,18}$/.test(ref.id))valid=!!await tx.invocationEvent.findFirst({where:{sequence:BigInt(ref.id),invocationId}});
        if(ref.kind==="LEDGER_EXPORT")valid=/^[a-f0-9]{64}$/.test(ref.id);
        if(!valid)throw new IdentityError();
      }
      const finding=await tx.operatorFinding.create({data:{...key,actorPrincipalId:context.principalId,credentialId:context.credentialId,requestDigest:digest,
        basisSequence:BigInt(args.basisSequence),decision:args.decision,reason:args.reason,evidence:args.evidence}});
      await tx.invocationEvent.create({data:{invocationId,runId:inv.runId,actorPrincipalId:context.principalId,kind:"OPERATOR_FINDING",status:"UNKNOWN",reason:"OPERATOR_FINDING_NOT_VERIFIED",findingId:finding.id}});
      return finding;
    });
  }
}
