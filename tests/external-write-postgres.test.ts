import test from "node:test";import assert from "node:assert/strict";import{randomUUID}from"node:crypto";import{setTimeout as delay}from"node:timers/promises";
import type{AddressInfo}from"node:net";import{createExternalApiServer}from"../src/external-api/server.js";
import{Client}from"pg";import{startFixture}from"./executor-start-fixture.js";import{receiptIdentity}from"../src/executor/demo-receipt-contract.js";
import{ExecutorExecution}from"../src/executor/execution-service.js";import{ExecutorProtocol}from"../src/executor/executor-protocol.js";import{createPrismaClient}from"../src/persistence/prisma-execution-store.js";
const url=process.env.FOUNDRY_113_TEST_DATABASE_URL;
test("isolated PostgreSQL: external approval and controlled WRITE start",{skip:!url},async t=>{
 const parsed=new URL(url!);if(!["127.0.0.1","localhost","::1"].includes(parsed.hostname)||!/^\/foundry_113_test_[a-z0-9]+$/.test(parsed.pathname))throw Error("Dedicated 113 database required");
 async function fixture(ttl=900000){const f=await startFixture(url!,"b".repeat(64),{write:true,approvalTtlMs:ttl});t.after(()=>f.db.$disconnect());return f;}
 async function decide(f:Awaited<ReturnType<typeof fixture>>,id:string,decision="APPROVE",key=randomUUID()){
  const view=await f.approvals.inspect(f.op,id),input={requestDigest:view.requestDigest,requestKey:key,decision,reason:"Isolated test operator reviewed exact action"};return{view,input,decision:await f.approvals.decide(f.op,id,input)};
 }
 async function claimed(f:Awaited<ReturnType<typeof fixture>>,id:string){const s=await f.session(),claim=await f.protocol.claim(f.context,id,randomUUID(),s.id);return{s,claim,input:{sessionId:s.id,generation:claim.generation,requestKey:randomUUID(),artifactDigest:f.identity.artifactDigest,ledgerId:f.identity.ledgerId}};}
 await t.test("WRITE admission creates immutable exact approval; no approval means no claim",async()=>{
  const f=await fixture(),r=await f.request(),view=await f.approvals.inspect(f.op,r.inv.id);
  assert.equal(r.inv.status,"PENDING_APPROVAL");assert.equal(view.status,"PENDING_APPROVAL");assert.equal(view.canDecide,true);assert.equal(view.executionAllowed,false);
  const identity=view.identity as any;assert.equal(identity.action.resource,f.identity.outputResource);assert.equal(identity.action.target,receiptIdentity(r.inv.id,f.identity.outputResource!).path);assert.deepEqual(identity.action.arguments,{});
  assert.equal((await f.protocol.poll(f.context)).offers.length,0);await assert.rejects(f.protocol.claim(f.context,r.inv.id,"unapproved"));
  await assert.rejects(f.db.externalApprovalRequest.update({where:{id:view.id},data:{digest:"a".repeat(64)}}));
 });
 await t.test("agent/executor/wrong owner/missing scope cannot decide; altered request digest fails",async()=>{
  const f=await fixture(),other=await fixture(),r=await f.request(),view=await f.approvals.inspect(f.op,r.inv.id),input={requestDigest:view.requestDigest,requestKey:"denied",decision:"APPROVE",reason:"test"};
  const limited=await f.issuer.issue({principalId:f.op.principalId,scopes:["operator:reconcile"],expiresAt:new Date(Date.now()+60000)});
  for(const context of[f.agentContext,f.context,other.op,await f.auth.authenticate(limited.secret)]){await assert.rejects(f.approvals.inspect(context,r.inv.id));await assert.rejects(f.approvals.decide(context,r.inv.id,input));}
  await assert.rejects(f.approvals.decide(f.op,r.inv.id,{...input,requestDigest:"a".repeat(64)}));
  assert.equal(await f.db.externalApprovalDecision.count({where:{approvalId:view.id}}),0);
 });
 await t.test("duplicate approve is idempotent; concurrent approve/reject cannot overwrite",async()=>{
  const f=await fixture(),r=await f.request(),v=await f.approvals.inspect(f.op,r.inv.id),a={requestDigest:v.requestDigest,requestKey:"one",decision:"APPROVE",reason:"reviewed"};
  const results=await Promise.all([f.approvals.decide(f.op,r.inv.id,a),f.approvals.decide(f.op,r.inv.id,a)]);assert.equal(results[0]!.approvalId,results[1]!.approvalId);
  await assert.rejects(f.approvals.decide(f.op,r.inv.id,{...a,decision:"REJECT"}));
  const f2=await fixture(),r2=await f2.request(),v2=await f2.approvals.inspect(f2.op,r2.inv.id);
  const race=await Promise.allSettled([f2.approvals.decide(f2.op,r2.inv.id,{...a,requestDigest:v2.requestDigest}),f2.approvals.decide(f2.op,r2.inv.id,{...a,requestDigest:v2.requestDigest,decision:"REJECT"})]);assert.equal(race.filter(x=>x.status==="fulfilled").length,1);
 });
 await t.test("approval is not consumed by poll/claim; concurrent start consumes exactly once",async()=>{
  const f=await fixture(),r=await f.request(),approved=await decide(f,r.inv.id),c=await claimed(f,r.inv.id);
  assert.equal(await f.db.externalApprovalConsumption.count({where:{approvalId:approved.view.id}}),0);
  const starts=await Promise.all([f.execution.authorizeStart(f.context,c.claim.id,c.input),f.execution.authorizeStart(f.context,c.claim.id,c.input)]);
  assert.equal(starts.filter(s=>s.startAllowed).length,1);assert.equal(starts[0]!.start.id,starts[1]!.start.id);
  const consumption=await f.db.externalApprovalConsumption.findUniqueOrThrow({where:{approvalId:approved.view.id}});assert.equal(consumption.startId,starts[0]!.start.id);
  await assert.rejects(f.db.externalApprovalConsumption.delete({where:{approvalId:approved.view.id}}));
  await assert.rejects(f.protocol.claim(f.context,r.inv.id,"retry",c.s.id));
  const result=receiptIdentity(r.inv.id,f.identity.outputResource!).result;
  await f.execution.report(f.context,starts[0]!.start.id,{sessionId:c.s.id,generation:c.claim.generation,outcome:"SUCCEEDED",reason:"DEMO_RECEIPT_CREATED",result});
  assert.equal((await f.approvals.agentStatus(f.agentContext,r.inv.id))!.status,"CONSUMED");
 });
 await t.test("rejected request and reject/claim race never create a start",async()=>{
  const f=await fixture(),r=await f.request(),v=await f.approvals.inspect(f.op,r.inv.id),s=await f.session();
  const outcomes=await Promise.allSettled([f.approvals.decide(f.op,r.inv.id,{requestDigest:v.requestDigest,requestKey:"reject",decision:"REJECT",reason:"not permitted"}),f.protocol.claim(f.context,r.inv.id,"race",s.id)]);
  assert.equal(outcomes[0]!.status,"fulfilled");assert.equal(outcomes[1]!.status,"rejected");assert.equal((await f.approvals.agentStatus(f.agentContext,r.inv.id))!.status,"REJECTED");assert.equal(await f.db.executorStart.count({where:{invocationId:r.inv.id}}),0);
 });
 for(const mode of["grant","binding","deployment","agent-credential","operator-credential","executor-credential","expired"]){
  await t.test(`approved action invalidated before start: ${mode}`,async()=>{
   const f=await fixture(mode==="expired"?1000:900000),r=await f.request(),a=await decide(f,r.inv.id),c=await claimed(f,r.inv.id);
   if(mode==="grant")await f.external.revoke(f.op,f.grant.id);
   if(mode==="binding")await f.bindings.revoke(f.op,f.binding.id);
   if(mode==="deployment")await f.db.executorDeployment.update({where:{id:f.deployment.id},data:{environment:"changed-after-approval"}});
   if(mode==="agent-credential")await f.admin.revokeCredential(f.token.credentialId);
   if(mode==="operator-credential")await f.admin.revokeCredential(f.operatorToken.credentialId);
   if(mode==="executor-credential")await f.admin.revokeCredential(f.credential.credentialId);
   if(mode==="expired")await delay(Math.max(0,new Date(a.view.expiresAt).getTime()-Date.now())+20);
   await assert.rejects(f.execution.authorizeStart(f.context,c.claim.id,c.input));assert.equal(await f.db.executorStart.count({where:{invocationId:r.inv.id}}),0);assert.equal(await f.db.externalApprovalConsumption.count({where:{approvalId:a.view.id}}),0);
  });
 }
 await t.test("changed arguments, wrong Invocation/digest/artifact cannot reuse approval",async()=>{
  const f=await fixture(),r=await f.request(),a=await decide(f,r.inv.id),c=await claimed(f,r.inv.id),r2=await f.request();
  await assert.rejects(f.approvals.decide(f.op,r2.inv.id,a.input));
  await assert.rejects(f.db.invocation.update({where:{id:r.inv.id},data:{arguments:{path:"/tmp/escape"}}}));
  await assert.rejects(f.execution.authorizeStart(f.context,c.claim.id,{...c.input,artifactDigest:"a".repeat(64)}));
  await assert.rejects(f.invocations.acceptInvocation(f.agentContext,{runId:r2.run.id,toolId:f.tool.id,deploymentId:f.deployment.id,grantId:f.grant.id,idempotencyKey:"bad-args",arguments:{path:"/outside"}}));
 });
 await t.test("decision and consumption failures rollback state/events atomically",async()=>{
  const f=await fixture(),r=await f.request(),v=await f.approvals.inspect(f.op,r.inv.id);
  await f.db.$executeRawUnsafe(`CREATE FUNCTION reject_external_event() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.kind IN ('EXTERNAL_APPROVAL_APPROVED','EXTERNAL_APPROVAL_CONSUMED') THEN RAISE EXCEPTION 'injected'; END IF; RETURN NEW; END; $$`);
  await f.db.$executeRawUnsafe(`CREATE TRIGGER reject_external_event BEFORE INSERT ON "InvocationEvent" FOR EACH ROW EXECUTE FUNCTION reject_external_event()`);
  try{await assert.rejects(f.approvals.decide(f.op,r.inv.id,{requestDigest:v.requestDigest,requestKey:"rollback",decision:"APPROVE",reason:"test"}));assert.equal((await f.invocations.getInvocation(f.agentContext,r.inv.id)).status,"PENDING_APPROVAL");assert.equal(await f.db.externalApprovalDecision.count({where:{approvalId:v.id}}),0);}
  finally{await f.db.$executeRawUnsafe('DROP TRIGGER reject_external_event ON "InvocationEvent"');}
  await decide(f,r.inv.id);const c=await claimed(f,r.inv.id);
  await f.db.$executeRawUnsafe(`CREATE TRIGGER reject_external_event BEFORE INSERT ON "InvocationEvent" FOR EACH ROW EXECUTE FUNCTION reject_external_event()`);
  try{await assert.rejects(f.execution.authorizeStart(f.context,c.claim.id,c.input));assert.equal(await f.db.executorStart.count({where:{invocationId:r.inv.id}}),0);assert.equal(await f.db.externalApprovalConsumption.count({where:{approvalId:v.id}}),0);assert.equal((await f.invocations.getInvocation(f.agentContext,r.inv.id)).status,"CLAIMED");}
  finally{await f.db.$executeRawUnsafe('DROP TRIGGER reject_external_event ON "InvocationEvent"');await f.db.$executeRawUnsafe('DROP FUNCTION reject_external_event()');}
 });
 await t.test("concurrent approval and claim/start never authorize a pre-approval start",async()=>{
  const f=await fixture(),r=await f.request(),v=await f.approvals.inspect(f.op,r.inv.id),s=await f.session();
  const decision=f.approvals.decide(f.op,r.inv.id,{requestDigest:v.requestDigest,requestKey:"approve-race",decision:"APPROVE",reason:"Exact request reviewed"});
  const attempt=f.protocol.claim(f.context,r.inv.id,"claim-race",s.id).then(claim=>f.execution.authorizeStart(f.context,claim.id,{sessionId:s.id,generation:claim.generation,requestKey:"start-race",artifactDigest:f.identity.artifactDigest,ledgerId:f.identity.ledgerId}));
  const outcomes=await Promise.allSettled([decision,attempt]);assert.equal(outcomes[0]!.status,"fulfilled");
  if(outcomes[1]!.status==="rejected"){const c=await claimed(f,r.inv.id);await f.execution.authorizeStart(f.context,c.claim.id,c.input);}
  const start=await f.db.executorStart.findUniqueOrThrow({where:{invocationId:r.inv.id}}),d=await decision;
  assert.ok(start.createdAt>=d.createdAt);assert.equal(await f.db.externalApprovalConsumption.count({where:{approvalId:v.id}}),1);
 });
 await t.test("expired pending request cannot be approved or renewed, but can be explicitly rejected",async()=>{
  const f=await fixture(1000),r=await f.request(),v=await f.approvals.inspect(f.op,r.inv.id);
  await delay(Math.max(0,new Date(v.expiresAt).getTime()-Date.now())+20);
  const body={requestDigest:v.requestDigest,requestKey:"expired",decision:"APPROVE",reason:"Too late"};
  await assert.rejects(f.approvals.decide(f.op,r.inv.id,body));assert.equal((await f.approvals.agentStatus(f.agentContext,r.inv.id))!.status,"EXPIRED");
  await f.approvals.decide(f.op,r.inv.id,{...body,decision:"REJECT"});assert.equal((await f.invocations.getInvocation(f.agentContext,r.inv.id)).status,"REVOKED");
 });
 await t.test("agent API/history exposes approval status but never approval authority or private operator reason",async()=>{
  const f=await fixture(),r=await f.request(),v=await f.approvals.inspect(f.op,r.inv.id),server=createExternalApiServer({auth:f.auth,invocations:f.invocations,executors:f.protocol,execution:f.execution});
  await new Promise<void>(resolve=>server.listen(0,"127.0.0.1",resolve));const origin=`http://127.0.0.1:${(server.address()as AddressInfo).port}`,headers={authorization:`Bearer ${f.token.secret}`};
  try{
   const pending=await fetch(origin+`/api/v1/external/invocations/${r.inv.id}`,{headers});assert.equal(pending.status,200);const p=await pending.json()as any;assert.equal(p.invocation.approval.status,"PENDING_APPROVAL");assert.equal(p.invocation.approval.executionAllowed,false);assert.equal(p.invocation.approval.canDecide,undefined);
   await f.approvals.decide(f.op,r.inv.id,{requestDigest:v.requestDigest,requestKey:"private",decision:"APPROVE",reason:"PRIVATE_OPERATOR_REASON"});
   const approved=await(await fetch(origin+`/api/v1/external/invocations/${r.inv.id}`,{headers})).json()as any;assert.equal(approved.invocation.approval.status,"APPROVED");assert.equal(approved.invocation.executionAllowed,false);
   const history=await(await fetch(origin+`/api/v1/external/runs/${r.run.id}/history`,{headers})).json()as any;
   assert.ok(history.events.some((e:any)=>e.kind==="EXTERNAL_APPROVAL_APPROVED"&&e.approval.id===v.id));assert.doesNotMatch(JSON.stringify({approved,history}),/PRIVATE_OPERATOR_REASON|requestDigest|credentialId|artifactDigest/);
   const denied=await fetch(origin+`/api/v1/external/invocations/${r.inv.id}/approve`,{method:"POST",headers:{...headers,"content-type":"application/json"},body:"{}"});assert.equal(denied.status,404);
  }finally{await new Promise<void>(resolve=>server.close(()=>resolve()));}
 });
 await t.test("post-start revocation cannot erase authenticated reported WRITE evidence",async()=>{
  const f=await fixture(),r=await f.request();await decide(f,r.inv.id);const c=await claimed(f,r.inv.id),start=await f.execution.authorizeStart(f.context,c.claim.id,c.input);
  await f.external.revoke(f.op,f.grant.id);await f.admin.revokeCredential(f.operatorToken.credentialId);
  await f.execution.report(f.context,start.start.id,{sessionId:c.s.id,generation:c.claim.generation,outcome:"SUCCEEDED",reason:"DEMO_RECEIPT_CREATED",result:receiptIdentity(r.inv.id,f.identity.outputResource!).result});
  assert.equal((await f.invocations.getInvocation(f.agentContext,r.inv.id)).status,"SUCCEEDED");
 });
 await t.test("real grant revocation lock precedes start and leaves approval unconsumed",async()=>{
  const f=await fixture(),r=await f.request(),a=await decide(f,r.inv.id),c=await claimed(f,r.inv.id),holder=new Client({connectionString:url!});
  const tagged=new URL(url!);tagged.searchParams.set("application_name","113-start-revocation");const competing=createPrismaClient(tagged.href),execution=new ExecutorExecution(competing,new ExecutorProtocol(competing),true);
  await holder.connect();let pending:Promise<unknown>|undefined;
  try{await holder.query('BEGIN');await holder.query('UPDATE "CapabilityGrant" SET "revokedAt"=clock_timestamp() WHERE id=$1',[f.grant.id]);
   const result=execution.authorizeStart(f.context,c.claim.id,c.input).then(value=>({value}),error=>({error}));pending=result;let waiting=false;
   for(let n=0;n<200;n++){const q=await f.db.$queryRaw<Array<{waiting:boolean}>>`SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE application_name='113-start-revocation' AND wait_event_type='Lock') AS waiting`;if(q[0]!.waiting){waiting=true;break;}await delay(10);}
   assert.equal(waiting,true);await holder.query('COMMIT');assert.ok('error'in await result);assert.equal(await f.db.externalApprovalConsumption.count({where:{approvalId:a.view.id}}),0);
  }finally{await holder.query('ROLLBACK');if(pending)await Promise.allSettled([pending]);await holder.end();await competing.$disconnect();}
 });
});
