import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, copyFileSync, writeFileSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { AddressInfo } from "node:net";
import { startFixture } from "./executor-start-fixture.js";
import { OperatorReconciliation } from "../src/reconciliation/operator-service.js";
import { createExternalApiServer } from "../src/external-api/server.js";
import { initializeLedger, StartLedger } from "../src/executor-runtime/ledger.js";
import { exportLedgerEvidence } from "../src/executor-runtime/ledger-evidence.js";
import { IsolatedExecutorRuntime } from "../src/executor-runtime/runtime.js";
import { HttpExecutorClient } from "../src/executor-runtime/api-client.js";
import { HEALTH_RESULT } from "../src/executor/execution-contract.js";

const url=process.env.FOUNDRY_112D_TEST_DATABASE_URL;
test("isolated PostgreSQL: operator findings and ledger continuity",{skip:!url},async t=>{
 const parsed=new URL(url!);if(!["localhost","127.0.0.1","::1"].includes(parsed.hostname)||!/^\/foundry_112d_test_[a-z0-9]+$/.test(parsed.pathname))throw Error("Dedicated 112d database required");
 async function fixture(){const f=await startFixture(url!);t.after(()=>f.db.$disconnect());return {...f,operator:new OperatorReconciliation(f.db)};}
 async function unknown(f:Awaited<ReturnType<typeof fixture>>){const c=await f.claimed(),s=await f.execution.authorizeStart(f.context,c.claim.id,c.input);await f.execution.report(f.context,s.start.id,{sessionId:c.s.id,generation:c.claim.generation,outcome:"UNKNOWN",reason:"EXECUTOR_RESTART_UNCERTAIN"});return {...c,start:s.start};}
 await t.test("owner-scoped evidence inspection exposes identities, not arguments or verifiers",async()=>{
  const f=await fixture(),c=await unknown(f),view=await f.operator.inspect(f.op,c.inv.id);
  assert.equal(view.status,"UNKNOWN");assert.equal(view.start!.id,c.start.id);assert.equal(view.session!.id,c.s.id);assert.equal(view.retryAllowed,false);assert.equal(view.resultImportAllowed,false);
  assert.doesNotMatch(JSON.stringify(view),/verifier|"arguments"|af_/);
 });
 await t.test("agent, executor, wrong owner, missing scope and revoked operator are denied",async()=>{
  const f=await fixture(),other=await fixture(),c=await unknown(f);
  for(const context of [f.agentContext,f.context,other.op])await assert.rejects(f.operator.inspect(context,c.inv.id));
  const limited=await f.issuer.issue({principalId:f.op.principalId,scopes:["grant:manage"],expiresAt:new Date(Date.now()+60000)});
  await assert.rejects(f.operator.inspect(await f.auth.authenticate(limited.secret),c.inv.id));
  await f.admin.revokeCredential(f.operatorToken.credentialId);await assert.rejects(f.operator.inspect(f.op,c.inv.id));
 });
 await t.test("findings are idempotent, append-only, retain UNKNOWN and cannot authorize execution",async()=>{
  const f=await fixture(),c=await unknown(f),view=await f.operator.inspect(f.op,c.inv.id);
  const input={requestKey:randomUUID(),basisSequence:view.basisSequence,decision:"RETAIN_UNKNOWN",reason:"Handler completion cannot be established",evidence:[{kind:"START" as const,id:c.start.id}]};
  const reports=await Promise.all([f.operator.record(f.op,c.inv.id,input),f.operator.record(f.op,c.inv.id,input)]);
  assert.equal(reports[0]!.id,reports[1]!.id);assert.equal((await f.invocations.getInvocation(f.agentContext,c.inv.id)).status,"UNKNOWN");
  assert.equal(await f.db.invocationEvent.count({where:{invocationId:c.inv.id,kind:"OPERATOR_FINDING"}}),1);
  await assert.rejects(f.operator.record(f.op,c.inv.id,{...input,reason:"changed"}));
  await assert.rejects(f.operator.record(f.op,c.inv.id,{...input,decision:"MARK_SUCCESS"}));
  await assert.rejects(f.db.operatorFinding.update({where:{id:reports[0]!.id},data:{reason:"rewrite"}}));
  await assert.rejects(f.db.operatorFinding.delete({where:{id:reports[0]!.id}}));
  assert.equal((await f.protocol.poll(f.context)).offers.length,0);await assert.rejects(f.protocol.claim(f.context,c.inv.id,"retry",c.s.id));
 });
 await t.test("incompatible concurrent findings have one winner; later findings need fresh evidence cursor",async()=>{
  const f=await fixture(),c=await unknown(f),view=await f.operator.inspect(f.op,c.inv.id);
  const base={basisSequence:view.basisSequence,reason:"Investigated durable records",evidence:[]};
  const outcomes=await Promise.allSettled([f.operator.record(f.op,c.inv.id,{...base,requestKey:"one",decision:"RETAIN_UNKNOWN"}),f.operator.record(f.op,c.inv.id,{...base,requestKey:"two",decision:"RECOVERY_BLOCKED"})]);
  assert.equal(outcomes.filter(r=>r.status==="fulfilled").length,1);
  const current=await f.operator.inspect(f.op,c.inv.id);await f.operator.record(f.op,c.inv.id,{...base,basisSequence:current.basisSequence,requestKey:"followup",decision:"CONFLICTING_EVIDENCE"});
  assert.equal(await f.db.operatorFinding.count({where:{invocationId:c.inv.id}}),2);
 });
 await t.test("cross-invocation evidence and non-UNKNOWN resolutions are rejected",async()=>{
  const f=await fixture(),c=await unknown(f),other=await fixture(),foreign=await unknown(other),view=await f.operator.inspect(f.op,c.inv.id);
  await assert.rejects(f.operator.record(f.op,c.inv.id,{requestKey:"foreign",basisSequence:view.basisSequence,decision:"RETAIN_UNKNOWN",reason:"wrong evidence",evidence:[{kind:"START",id:foreign.start.id}]}));
  const ready=await f.request();await assert.rejects(f.operator.record(f.op,ready.inv.id,{requestKey:"ready",basisSequence:"1",decision:"RETAIN_UNKNOWN",reason:"not unknown",evidence:[]}));
 });
 await t.test("finding and event commit atomically",async()=>{
  const f=await fixture(),c=await unknown(f),view=await f.operator.inspect(f.op,c.inv.id);
  await f.db.$executeRawUnsafe(`CREATE FUNCTION reject_finding_event() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.kind='OPERATOR_FINDING' THEN RAISE EXCEPTION 'test failure'; END IF; RETURN NEW; END; $$`);
  await f.db.$executeRawUnsafe(`CREATE TRIGGER reject_finding_event BEFORE INSERT ON "InvocationEvent" FOR EACH ROW EXECUTE FUNCTION reject_finding_event()`);
  try{await assert.rejects(f.operator.record(f.op,c.inv.id,{requestKey:"rollback",basisSequence:view.basisSequence,decision:"RETAIN_UNKNOWN",reason:"rollback",evidence:[]}));assert.equal(await f.db.operatorFinding.count({where:{invocationId:c.inv.id}}),0);}
  finally{await f.db.$executeRawUnsafe('DROP TRIGGER reject_finding_event ON "InvocationEvent"');await f.db.$executeRawUnsafe('DROP FUNCTION reject_finding_event()');}
 });
 await t.test("revoked executor remains revoked: operator refresh records uncertainty, never imports success",async()=>{
  const f=await fixture(),c=await f.claimed(),s=await f.execution.authorizeStart(f.context,c.claim.id,c.input);await f.admin.revokeCredential(f.credential.credentialId);
  await assert.rejects(f.execution.report(f.context,s.start.id,{sessionId:c.s.id,generation:c.claim.generation,outcome:"SUCCEEDED",reason:"HEALTH_PING_RETURNED",result:HEALTH_RESULT}));
  const view=await f.operator.refresh(f.op,c.inv.id);assert.equal(view.status,"UNKNOWN");assert.ok(view.executorCredential!.revokedAt);assert.equal(view.resultImportAllowed,false);
  await f.operator.record(f.op,c.inv.id,{requestKey:"blocked",basisSequence:view.basisSequence,decision:"RECOVERY_BLOCKED",reason:"Revoked original credential; preserve local result",evidence:[{kind:"START",id:s.start.id}]});
  assert.equal(await f.db.executorReport.count({where:{startId:s.start.id}}),0);
 });
 for(const mode of ["valid","stale-empty","stale-before-result","reinitialized","missing-server-claim","mismatched-generation","ack-tampered","conflicting-result","outage","revoked-pending"]){
  await t.test(`HTTP/SQLite recovery gate: ${mode}`,async()=>{
   const f=await fixture(),r=await f.request(),dir=mkdtempSync(join(tmpdir(),"foundry112d-")),file=join(dir,"ledger.sqlite"),snapshot=join(dir,"snapshot.sqlite");initializeLedger(file,f.identity);copyFileSync(file,snapshot);
   let ledger=new StartLedger(file,f.identity),calls=0;
   const server=createExternalApiServer({auth:f.auth,invocations:f.invocations,executors:f.protocol,execution:f.execution});await new Promise<void>(resolve=>server.listen(0,"127.0.0.1",resolve));
   const api=new HttpExecutorClient(`http://127.0.0.1:${(server.address()as AddressInfo).port}`,f.credential.secret);
   try{
    const runtime=new IsolatedExecutorRuntime(ledger,api,()=>{},point=>{
      if(mode==="revoked-pending"&&point==="after_result_persisted")throw Error("crash before submission");
    },()=>{calls++;return HEALTH_RESULT;});
    await runtime.initialize();
    if(mode==="revoked-pending"){await assert.rejects(runtime.tick());await f.admin.revokeCredential(f.credential.credentialId);}
    else await runtime.tick();
    ledger.close();
    if(mode==="stale-empty")copyFileSync(snapshot,file);
    if(mode==="reinitialized"){rmSync(file);initializeLedger(file,f.identity);}
    ledger=new StartLedger(file,f.identity);
    if(mode==="stale-before-result"){
      // Test-only damage: rewinding a valid file's row preserves its incarnation but loses committed result evidence.
      const {DatabaseSync}=await import("node:sqlite"),damaged=new DatabaseSync(file);damaged.exec("UPDATE attempts SET state='START_INTENT',report=NULL,ack=NULL");damaged.close();
    }
    if(["mismatched-generation","ack-tampered","conflicting-result"].includes(mode)){
      const {DatabaseSync}=await import("node:sqlite"),damaged=new DatabaseSync(file);
      if(mode==="mismatched-generation")damaged.exec("UPDATE attempts SET generation=generation+1");
      if(mode==="ack-tampered")damaged.exec("UPDATE attempts SET ack='{}'");
      if(mode==="conflicting-result"){
        const row=damaged.prepare("SELECT claimId,report FROM attempts").get()as any,body=JSON.parse(row.report);delete body.result;body.outcome="UNKNOWN";body.reason="START_RESPONSE_LOST";
        damaged.prepare("UPDATE attempts SET report=? WHERE claimId=?").run(JSON.stringify(body),row.claimId);
      }
      damaged.close();
    }
    if(mode==="missing-server-claim"){
      // Additional local claim without an authoritative DB record: restoration/integrity conflict.
      ledger.prepare({id:"orphan",invocationId:"orphan",generation:1},"orphan-session");
    }
    const client=mode==="outage"?{call:async()=>{throw Error("API unavailable");}}:api;
    const restarted=new IsolatedExecutorRuntime(ledger,client,()=>{},()=>{},()=>{calls++;return HEALTH_RESULT;});
    if(mode==="valid"){await restarted.initialize();assert.equal(await restarted.tick(),false);assert.equal(ledger.unfinished().length,0);}
    else await assert.rejects(restarted.initialize());
    assert.equal(calls,1);assert.equal(await f.db.executorStart.count({where:{invocationId:r.inv.id}}),1);
    const exported=exportLedgerEvidence(file);assert.equal(exported.verification,"LOCAL_EXPORT_NOT_INDEPENDENTLY_VERIFIED");assert.doesNotMatch(JSON.stringify(exported),/af_|credential|verifier/);
   }finally{ledger.close();await new Promise<void>(resolve=>server.close(()=>resolve()));rmSync(dir,{recursive:true});}
  });
 }
 await t.test("agent history exposes finding identity without private operator reason or local evidence payload",async()=>{
  const f=await fixture(),c=await unknown(f),view=await f.operator.inspect(f.op,c.inv.id);
  const finding=await f.operator.record(f.op,c.inv.id,{requestKey:"safe-history",basisSequence:view.basisSequence,decision:"RETAIN_UNKNOWN",reason:"PRIVATE_OPERATOR_REASON",evidence:[{kind:"LEDGER_EXPORT",id:"a".repeat(64)}]});
  const server=createExternalApiServer({auth:f.auth,invocations:f.invocations,executors:f.protocol,execution:f.execution});await new Promise<void>(resolve=>server.listen(0,"127.0.0.1",resolve));
  try{const response=await fetch(`http://127.0.0.1:${(server.address()as AddressInfo).port}/api/v1/external/runs/${c.run.id}/history`,{headers:{authorization:`Bearer ${f.token.secret}`}});
   assert.equal(response.status,200);const body=await response.json()as any;assert.equal(body.events.at(-1).finding.id,finding.id);assert.equal(body.events.at(-1).finding.verification,"OPERATOR_FINDING_NOT_VERIFIED");
   assert.doesNotMatch(JSON.stringify(body),/PRIVATE_OPERATOR_REASON|LEDGER_EXPORT|credentialId|verifier/);
  }finally{await new Promise<void>(resolve=>server.close(()=>resolve()));}
 });
 await t.test("incomplete possible-start history becomes UNKNOWN without fabricating an outcome",async()=>{
  const f=await fixture(),c=await f.claimed();
  await f.db.invocationEvent.create({data:{invocationId:c.inv.id,runId:c.run.id,actorPrincipalId:f.context.principalId,kind:"START_AUTHORIZED",status:"START_AUTHORIZED",reason:"DAMAGED_HISTORY_TEST_FIXTURE"}});
  const refreshed=await f.operator.refresh(f.op,c.inv.id);assert.equal(refreshed.status,"UNKNOWN");assert.ok(refreshed.diagnostics.includes("NO_COMPLETE_AUTHORIZED_START"));
  assert.equal(await f.db.executorStart.count({where:{invocationId:c.inv.id}}),0);assert.equal((await f.protocol.poll(f.context)).offers.length,0);
 });
 await t.test("legacy session history cannot silently acquire a newly initialized continuity baseline",async()=>{
  const f=await fixture();
  await f.db.executorSession.create({data:{ownerId:f.owner.id,deploymentId:f.deployment.id,executorPrincipalId:f.context.principalId,credentialId:f.credential.credentialId,
    bindingId:f.binding.id,sessionKey:randomUUID(),requestDigest:"b".repeat(64),artifactDigest:f.identity.artifactDigest,ledgerId:f.identity.ledgerId,executionProfile:"docker-health-ping-v1",generation:1,expiresAt:new Date(Date.now()+60000)}});
  await assert.rejects(f.session(),error=>!!error&&typeof error==="object"&&"code"in error&&error.code==="LEDGER_BASELINE_REQUIRED");
  assert.equal(await f.db.executorLedgerAnchor.count({where:{bindingId:f.binding.id}}),0);
 });
 await t.test("operator CLI authenticates a protected credential file and records a finding",async()=>{
  const f=await fixture(),c=await unknown(f),dir=mkdtempSync(join(tmpdir(),"foundry-operator-cli-")),file=join(dir,"operator-token");
  writeFileSync(file,f.operatorToken.secret,{mode:0o600});
  const env={...process.env,DATABASE_URL:url!,FOUNDRY_OPERATOR_CREDENTIAL_FILE:file};
  const cli=(args:string[])=>spawnSync(process.execPath,["dist/src/reconciliation-cli.js",...args],{env,encoding:"utf8",timeout:15000});
  try{
   const inspected=cli(["inspect",c.inv.id]);assert.equal(inspected.status,0,inspected.stderr);const view=JSON.parse(inspected.stdout);assert.equal(view.status,"UNKNOWN");
   const recorded=cli(["record",c.inv.id,"--request-key","cli-record","--basis-sequence",view.basisSequence,"--decision","RETAIN_UNKNOWN","--reason","CLI evidence review"]);
   assert.equal(recorded.status,0,recorded.stderr);assert.equal(JSON.parse(recorded.stdout).decision,"RETAIN_UNKNOWN");
   assert.equal(cli(["record",c.inv.id,"--mark-success","true"]).status,1);
   chmodSync(file,0o644);assert.equal(cli(["inspect",c.inv.id]).status,1);
   assert.equal((await f.invocations.getInvocation(f.agentContext,c.inv.id)).status,"UNKNOWN");
  }finally{rmSync(dir,{recursive:true});}
 });
 await t.test("continuity proof is immutable and scoped recovery cursors cannot escape a binding",async()=>{
  const f=await fixture(),c=await f.claimed(),other=await fixture(),foreign=await other.claimed();
  await assert.rejects(f.execution.recoveryInventory(f.context,c.s.id,"c".repeat(64),foreign.claim.id));
  await assert.rejects(f.db.executorLedgerAnchor.update({where:{bindingId:f.binding.id},data:{proofDigest:"a".repeat(64)}}));
  const inventory=await f.execution.recoveryInventory(f.context,c.s.id,"c".repeat(64));assert.equal(inventory.claims[0]!.id,c.claim.id);
 });
});
