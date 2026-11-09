import assert from "node:assert/strict";
import test from "node:test";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import { Client } from "pg";
import { startFixture } from "./executor-start-fixture.js";
import { ExecutorExecution } from "../src/executor/execution-service.js";
import { HEALTH_RESULT } from "../src/executor/execution-contract.js";
import { createExternalApiServer } from "../src/external-api/server.js";
import { HttpExecutorClient } from "../src/executor-runtime/api-client.js";
import { initializeLedger, StartLedger } from "../src/executor-runtime/ledger.js";
import { IsolatedExecutorRuntime } from "../src/executor-runtime/runtime.js";
import { createPrismaClient } from "../src/persistence/prisma-execution-store.js";
import { ExecutorProtocol } from "../src/executor/executor-protocol.js";

const url = process.env.FOUNDRY_112C_TEST_DATABASE_URL;
test("isolated PostgreSQL: durable isolated start and report protocol", { skip: !url }, async t => {
  const parsed = new URL(url!);
  if (!["127.0.0.1","localhost","::1"].includes(parsed.hostname) || !/^\/foundry_112c_test_[a-z0-9]+$/.test(parsed.pathname)) throw new Error("Dedicated 112c database required");
  async function fixture() { const f = await startFixture(url!); t.after(() => f.db.$disconnect()); return f; }
  const success = (input: { sessionId: string; generation: number }) => ({ sessionId: input.sessionId, generation: input.generation, outcome: "SUCCEEDED" as const, reason: "HEALTH_PING_RETURNED", result: HEALTH_RESULT });
  await t.test("concurrent starts commit one immutable identity and return only one permit", async () => {
    const f = await fixture(), c = await f.claimed();
    const starts = await Promise.all([f.execution.authorizeStart(f.context,c.claim.id,c.input),f.execution.authorizeStart(f.context,c.claim.id,c.input)]);
    assert.equal(starts.filter(s=>s.startAllowed).length,1); assert.equal(starts[0]!.start.id, starts[1]!.start.id);
    assert.equal(await f.db.executorStart.count({where:{invocationId:c.inv.id}}),1);
    assert.equal((await f.db.executorClaim.findUniqueOrThrow({where:{id:c.claim.id}})).startAuthorizedAt?.toISOString(),starts[0]!.start.createdAt.toISOString());
    await assert.rejects(f.execution.authorizeStart(f.context,c.claim.id,{...c.input,requestKey:randomUUID()}));
    await assert.rejects(f.protocol.release(f.context,c.claim.id,c.claim.generation,c.s.id));
    await assert.rejects(f.db.executorStart.delete({where:{id:starts[0]!.start.id}}));
  });
  await t.test("disabled execution, wrong identity, old session and revoked policy fail closed", async () => {
    for(const mode of ["disabled","artifact","generation","session","grant","binding","credential","requester"]) {
      const f=await fixture(), c=await f.claimed();
      if(mode==="grant")await f.external.revoke(f.op,f.grant.id);
      if(mode==="binding")await f.bindings.revoke(f.op,f.binding.id);
      if(mode==="credential")await f.admin.revokeCredential(f.credential.credentialId);
      if(mode==="requester")await f.admin.revokeCredential(f.token.credentialId);
      if(mode==="session")await f.session();
      const input={...c.input,...(mode==="artifact"?{artifactDigest:"a".repeat(64)}:{}),...(mode==="generation"?{generation:99}:{})};
      const execution=mode==="disabled"?new ExecutorExecution(f.db,f.protocol):f.execution;
      await assert.rejects(execution.authorizeStart(f.context,c.claim.id,input),mode);
      assert.equal(await f.db.executorStart.count({where:{invocationId:c.inv.id}}),0,mode);
    }
  });
  await t.test("approval-required, wrong handler/deployment and expired leases cannot start", async()=>{
    for(const reviewed of ["WRITE","DESTRUCTIVE","EXTERNAL_WRITE"] as const){
      const f=await startFixture(url!,"b".repeat(64),{reviewed});t.after(()=>f.db.$disconnect());
      const r=await f.request(),session=await f.session();assert.equal(r.inv.status,"PENDING_APPROVAL");
      assert.equal((await f.protocol.poll(f.context,1,session.id)).offers.length,0);
      await assert.rejects(f.protocol.claim(f.context,r.inv.id,randomUUID(),session.id));
      assert.equal(await f.db.executorStart.count({where:{invocationId:r.inv.id}}),0);
    }
    const wrong=await startFixture(url!,"b".repeat(64),{handlerId:"not-approved",execution:false});t.after(()=>wrong.db.$disconnect());
    await assert.rejects(wrong.session());
    const f=await fixture(),c=await f.claimed(),other=await fixture();
    await assert.rejects(other.execution.authorizeStart(other.context,c.claim.id,c.input));
    await delay(Math.max(0,c.claim.leaseExpiresAt.getTime()-Date.now())+20);
    await assert.rejects(f.execution.authorizeStart(f.context,c.claim.id,c.input));
    assert.equal(await f.db.executorStart.count({where:{invocationId:c.inv.id}}),0);
  });
  await t.test("start, claim marker and event rollback together",async()=>{
    const f=await fixture(), c=await f.claimed();
    await f.db.$executeRawUnsafe(`CREATE FUNCTION reject_start_event() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.kind='START_AUTHORIZED' THEN RAISE EXCEPTION 'injected'; END IF; RETURN NEW; END; $$`);
    await f.db.$executeRawUnsafe(`CREATE TRIGGER reject_start_event BEFORE INSERT ON "InvocationEvent" FOR EACH ROW EXECUTE FUNCTION reject_start_event()`);
    try { await assert.rejects(f.execution.authorizeStart(f.context,c.claim.id,c.input));
      assert.equal(await f.db.executorStart.count({where:{invocationId:c.inv.id}}),0);
      assert.equal((await f.db.executorClaim.findUniqueOrThrow({where:{id:c.claim.id}})).startAuthorizedAt,null);
      assert.equal((await f.invocations.getInvocation(f.agentContext,c.inv.id)).status,"CLAIMED");
    }finally{await f.db.$executeRawUnsafe('DROP TRIGGER reject_start_event ON "InvocationEvent"');await f.db.$executeRawUnsafe('DROP FUNCTION reject_start_event()');}
  });
  await t.test("result ACKs are durable, idempotent, bound and conflicting evidence is audited",async()=>{
    const f=await fixture(),c=await f.claimed(),start=await f.execution.authorizeStart(f.context,c.claim.id,c.input),body=success(c.input);
    await assert.rejects(f.execution.report(f.context,start.start.id,{...body,sessionId:"wrong"}));
    await f.external.revoke(f.op,f.grant.id); // Post-start evidence is not a new execution authorization.
    const reports=await Promise.all([f.execution.report(f.context,start.start.id,body),f.execution.report(f.context,start.start.id,body)]);
    assert.equal(reports[0]!.id,reports[1]!.id);
    await assert.rejects(f.execution.report(f.context,start.start.id,{...body,outcome:"UNKNOWN",reason:"START_RESPONSE_LOST",result:undefined}));
    assert.equal(await f.db.invocationEvent.count({where:{invocationId:c.inv.id,kind:"RESULT_CONFLICT"}}),1);
    assert.equal((await f.invocations.getInvocation(f.agentContext,c.inv.id)).status,"SUCCEEDED");
    await f.admin.revokeCredential(f.credential.credentialId);
    await assert.rejects(f.execution.report(f.context,start.start.id,body));
  });
  await t.test("post-start lease expiry and session fencing preserve UNKNOWN without redispatch; late evidence reconciles",async()=>{
    const f=await fixture(),c=await f.claimed(),start=await f.execution.authorizeStart(f.context,c.claim.id,c.input);
    await delay(Math.max(0,c.claim.leaseExpiresAt.getTime()-Date.now())+30);
    const s=await f.session(); assert.equal((await f.protocol.poll(f.context,1,s.id)).offers.length,0);
    assert.equal((await f.invocations.getInvocation(f.agentContext,c.inv.id)).status,"UNKNOWN");
    await assert.rejects(f.protocol.claim(f.context,c.inv.id,randomUUID(),s.id));
    await f.execution.report(f.context,start.start.id,success(c.input));
    assert.equal((await f.invocations.getInvocation(f.agentContext,c.inv.id)).status,"SUCCEEDED");
  });
  await t.test("revocation wins a real PostgreSQL lock race before start",async()=>{
    const f=await fixture(),c=await f.claimed(),holder=new Client({connectionString:url!});
    const tagged=new URL(url!);tagged.searchParams.set("application_name","112c-start-race");
    const competing=createPrismaClient(tagged.toString()),execution=new ExecutorExecution(competing,new ExecutorProtocol(competing),true);
    await holder.connect();let pending:Promise<unknown>|undefined;
    try{await holder.query('BEGIN');await holder.query('UPDATE "CapabilityGrant" SET "revokedAt"=clock_timestamp() WHERE id=$1',[f.grant.id]);
      const result=execution.authorizeStart(f.context,c.claim.id,c.input).then(value=>({value}),error=>({error}));pending=result;
      let blocked=false;for(let n=0;n<200;n++){const rows=await f.db.$queryRaw<Array<{waiting:boolean}>>`SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE application_name='112c-start-race' AND wait_event_type='Lock') AS waiting`;if(rows[0]!.waiting){blocked=true;break;}await delay(10);}
      assert.equal(blocked,true);await holder.query('COMMIT');assert.ok("error" in await result);
      assert.equal(await f.db.executorStart.count({where:{invocationId:c.inv.id}}),0);
    }finally{await holder.query('ROLLBACK');if(pending)await Promise.allSettled([pending]);await holder.end();await competing.$disconnect();}
  });
  await t.test("SIGKILL after durable start intent/result survives actual process death without handler replay",async()=>{
    for(const point of ["after_start_intent","after_result_persisted"]){
      const f=await fixture(),r=await f.request(),dir=mkdtempSync(join(tmpdir(),"foundry-killed-")),file=join(dir,"ledger.sqlite");
      initializeLedger(file,f.identity);
      const server=createExternalApiServer({auth:f.auth,invocations:f.invocations,executors:f.protocol,execution:f.execution});
      await new Promise<void>(resolve=>server.listen(0,"127.0.0.1",resolve));
      const origin=`http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      const moduleUrl=(file:string)=>JSON.stringify(new URL(file,import.meta.url).href);
      const code=`import{readFileSync,writeSync}from'node:fs';import{StartLedger}from ${moduleUrl("../src/executor-runtime/ledger.js")};import{IsolatedExecutorRuntime}from ${moduleUrl("../src/executor-runtime/runtime.js")};import{HttpExecutorClient}from ${moduleUrl("../src/executor-runtime/api-client.js")};import{healthPing}from ${moduleUrl("../src/executor-runtime/health-ping.js")};const c=JSON.parse(readFileSync(0,'utf8')),ledger=new StartLedger(c.file,c.identity),runtime=new IsolatedExecutorRuntime(ledger,new HttpExecutorClient(c.origin,c.credential),()=>{},point=>{if(point===c.point)process.kill(process.pid,'SIGKILL');},args=>{writeSync(1,'HANDLER_CALLED');return healthPing(args)});await runtime.initialize();await runtime.tick();`;
      let ledger:StartLedger|undefined;
      try{
        const child=spawn(process.execPath,["--input-type=module","-e",code],{stdio:["pipe","pipe","pipe"]});
        let output="";child.stdout.on("data",chunk=>{output+=chunk.toString();});child.stderr.resume();
        child.stdin.end(JSON.stringify({file,identity:f.identity,origin,credential:f.credential.secret,point}));
        const signal=await new Promise<NodeJS.Signals|null>((resolve,reject)=>{child.on("error",reject);child.on("exit",(_code,signal)=>resolve(signal));});
        assert.equal(signal,"SIGKILL");assert.equal(output.includes("HANDLER_CALLED"),point==="after_result_persisted");
        ledger=new StartLedger(file,f.identity);let replayed=0;
        const restarted=new IsolatedExecutorRuntime(ledger,new HttpExecutorClient(origin,f.credential.secret),()=>{},()=>{},()=>{replayed++;return HEALTH_RESULT;});
        await restarted.initialize();assert.equal(await restarted.tick(),false);assert.equal(replayed,0);
        assert.equal((await f.invocations.getInvocation(f.agentContext,r.inv.id)).status,point==="after_start_intent"?"UNKNOWN":"SUCCEEDED");
        assert.equal(await f.db.executorStart.count({where:{invocationId:r.inv.id}}),1);assert.equal(ledger.unfinished().length,0);
      }finally{ledger?.close();await new Promise<void>(resolve=>server.close(()=>resolve()));rmSync(dir,{recursive:true});}
    }
  });
  await t.test("real HTTP, PostgreSQL and reopened SQLite reconcile lost start response and lost result ACK without replay",async()=>{
    for(const loss of ["start","ack"]){
      const f=await fixture(), r=await f.request(),dir=mkdtempSync(join(tmpdir(),"foundry112c-")),file=join(dir,"ledger.sqlite");
      initializeLedger(file,f.identity);let ledger=new StartLedger(file,f.identity),executions=0,lost=false;
      const server=createExternalApiServer({auth:f.auth,invocations:f.invocations,executors:f.protocol,execution:f.execution});
      await new Promise<void>(resolve=>server.listen(0,"127.0.0.1",resolve));
      const origin=`http://127.0.0.1:${(server.address() as AddressInfo).port}`,api=new HttpExecutorClient(origin,f.credential.secret);
      const unreliable={call:async(path:string,body?:unknown,method?:string)=>{const result=await api.call(path,body,method);if(!lost&&((loss==="start"&&path.endsWith("authorize-start"))||(loss==="ack"&&path.endsWith("results")))){lost=true;throw new Error("lost HTTP response");}return result;}};
      try{
        for(const credential of [f.token.secret,f.operatorToken.secret])for(const path of ["sessions","claims/inaccessible/authorize-start","starts/inaccessible/results"]){
          const denied=await fetch(origin+"/api/v1/executor/"+path,{method:"POST",headers:{authorization:`Bearer ${credential}`,"content-type":"application/json"},body:"{}"});assert.equal(denied.status,403);
        }
        const runtime=new IsolatedExecutorRuntime(ledger,unreliable,()=>{},()=>{},()=>{executions++;return HEALTH_RESULT;});
        await runtime.initialize();await assert.rejects(runtime.tick());ledger.close();ledger=new StartLedger(file,f.identity);
        const reopened=new IsolatedExecutorRuntime(ledger,api,()=>{},()=>{},()=>{executions++;return HEALTH_RESULT;});
        await reopened.initialize();assert.equal(await reopened.tick(),false);
        assert.equal(executions,loss==="start"?0:1);assert.equal(await f.db.executorStart.count({where:{invocationId:r.inv.id}}),1);
        assert.equal(await f.db.executorReport.count({where:{start:{invocationId:r.inv.id}}}),1);
        assert.equal((await f.invocations.getInvocation(f.agentContext,r.inv.id)).status,loss==="start"?"UNKNOWN":"SUCCEEDED");
        const history=await fetch(origin+`/api/v1/external/runs/${r.run.id}/history`,{headers:{authorization:`Bearer ${f.token.secret}`}});
        const dto=await history.json() as any;assert.ok(dto.events.some((e:any)=>e.kind==="START_AUTHORIZED"));
        if(loss==="ack")assert.deepEqual(dto.events.at(-1).execution.result,HEALTH_RESULT);
        assert.doesNotMatch(JSON.stringify(dto),/authorizationDigest|artifactDigest|ledgerId|credentialId|af_/);
        assert.equal(ledger.unfinished().length,0);
      }finally{ledger.close();await new Promise<void>(resolve=>server.close(()=>resolve()));rmSync(dir,{recursive:true});}
    }
  });
});
