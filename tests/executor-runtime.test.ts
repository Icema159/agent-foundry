import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { StartLedger, initializeLedger, type LedgerIdentity } from "../src/executor-runtime/ledger.js";
import { IsolatedExecutorRuntime, type FaultPoint } from "../src/executor-runtime/runtime.js";
import { validateDockerProfile } from "../src/executor-runtime/docker-profile.js";
import { healthPing } from "../src/executor-runtime/health-ping.js";
import { validateLinuxIsolation, validatePrivateOrigin } from "../src/executor-runtime/isolation.js";
import { HEALTH_RESULT, reportIdentity } from "../src/executor/execution-contract.js";

test("health_ping is fixed, resource-free and accepts exact empty arguments", () => {
  assert.deepEqual(healthPing({}), HEALTH_RESULT);
  for (const args of [null, [], { path: "/tmp" }, { command: "anything" }]) assert.throws(() => healthPing(args));
});
test("executor isolation has no in-process or public HTTP fallback", () => {
  const valid = { platform: "linux", uid: 10001, gid: 10001, container: true, status: "CapEff:\t0000000000000000\nNoNewPrivs:\t1", mounts: "1 0 1:1 / / ro,relatime - overlay overlay ro" };
  assert.doesNotThrow(() => validateLinuxIsolation(valid));
  for (const patch of [{ platform: "darwin" }, { uid: 0 }, { container: false }, { status: "CapEff:\tffffffff\nNoNewPrivs:\t0" }, { mounts: valid.mounts.replace("ro,relatime", "rw,relatime") }])
    assert.throws(() => validateLinuxIsolation({ ...valid, ...patch }));
  assert.equal(validatePrivateOrigin("http://foundry-api:3002"), "http://foundry-api:3002");
  assert.throws(() => validatePrivateOrigin("http://host.docker.internal:3002"));
  assert.throws(() => validatePrivateOrigin("http://example.com"));
});
test("SQLite ledger survives reopen, fences duplicate starts and never replaces missing/corrupt storage", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "foundry-ledger-")), file = path.join(dir, "ledger.sqlite");
  const identity: LedgerIdentity = { deploymentId: "deployment", bindingId: "binding", ledgerId: randomUUID(), artifactDigest: "a".repeat(64) };
  try {
    assert.throws(() => new StartLedger(file, identity)); initializeLedger(file, identity);
    assert.throws(() => initializeLedger(file, identity));
    const ledger = new StartLedger(file, identity), claim = { id: "claim", invocationId: "inv", generation: 1 };
    ledger.prepare(claim, "session"); ledger.move(claim.id, ["PREPARED"], "START_REQUESTED"); ledger.close();
    const reopened = new StartLedger(file, identity);
    assert.equal(reopened.get(claim.id).state, "START_REQUESTED");
    assert.throws(() => reopened.prepare({ ...claim, id: "another", generation: 2 }, "session"));
    reopened.move(claim.id, ["START_REQUESTED"], "START_INTENT", "start");
    assert.throws(() => reopened.move(claim.id, ["START_REQUESTED"], "START_INTENT", "start")); reopened.close();
    assert.throws(() => new StartLedger(file, { ...identity, ledgerId: randomUUID() }));
    const corrupt = path.join(dir, "corrupt.sqlite"); await writeFile(corrupt, "not SQLite");
    assert.throws(() => new StartLedger(corrupt, identity));
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("fault-injected reopen never reruns a possibly started handler and resends persisted results", async t => {
  for (const point of ["after_prepare", "after_start_requested", "after_start_response", "after_start_intent", "after_handler", "after_result_persisted", "after_result_ack"] as FaultPoint[]) {
    await t.test(point, async () => {
      const dir = await mkdtemp(path.join(tmpdir(), "foundry-fault-")), file = path.join(dir, "ledger.sqlite");
      const identity: LedgerIdentity = { deploymentId: "dep", bindingId: "bind", ledgerId: randomUUID(), artifactDigest: "a".repeat(64) };
      let calls = 0, session = 0, start: any = null; const reports = new Map<string, any>();
      const api = { async call(route: string, body?: any) {
        if (route === "/sessions") return { session: { id: `session-${++session}`, active: true, ...identity } };
        if (route === "/recovery") return { claims: ledger.all().map(a=>({id:a.claimId,invocationId:a.invocationId,generation:a.generation,sessionId:a.sessionId,artifactDigest:a.artifactDigest,status:"ACTIVE",reportCredentialCurrent:true,start:start?{id:start.id,requestKey:start.requestKey,reports:[...reports.entries()].map(([digest,b])=>({id:"report-"+digest,digest,outcome:b.outcome}))}:null})),hasMore:false,nextCursor:null };
        if (route === "/poll") return { offers: [{ invocationId: "inv" }] };
        if (route === "/claims") return { claim: { id: "claim", invocationId: "inv", generation: 1 } };
        if (route.endsWith("/release")) return {};
        if (route.endsWith("/authorize-start")) { start = { ...body, id: "start", invocationId: "inv", claimId: "claim", startDeadline: new Date(Date.now() + 5000).toISOString() }; return { start, startAllowed: true, ledgerId: identity.ledgerId }; }
        if (route.endsWith("/start")) return { start, startCommitted: !!start, claimFenced: true };
        if (route.endsWith("/results")) { const digest = reportIdentity(body).digest; if (!reports.has(digest)) reports.set(digest, body); return { acknowledged: true, reportId: "report-"+digest, outcome: body.outcome, startId: "start", digest, verification: "EXECUTOR_REPORTED" }; }
        throw new Error("Unexpected route");
      } };
      initializeLedger(file, identity); let ledger = new StartLedger(file, identity);
      try {
        const runtime = new IsolatedExecutorRuntime(ledger, api, () => {}, p => { if (p === point) throw new Error("simulated crash"); }, args => { assert.equal(ledger.get("claim").state,"START_INTENT"); calls++; return healthPing(args); });
        await runtime.initialize(); await assert.rejects(runtime.tick()); ledger.close();
        ledger = new StartLedger(file, identity);
        const restarted = new IsolatedExecutorRuntime(ledger, api, () => {}, () => {}, args => { assert.equal(ledger.get("claim").state,"START_INTENT"); calls++; return healthPing(args); });
        await restarted.initialize();
        assert.equal(calls, ["after_handler","after_result_persisted","after_result_ack"].includes(point) ? 1 : 0);
        assert.equal(reports.size, ["after_prepare","after_start_requested"].includes(point) ? 0 : 1);
        if (reports.size) assert.equal([...reports.values()][0].outcome, ["after_result_persisted","after_result_ack"].includes(point) ? "SUCCEEDED" : "UNKNOWN");
      } finally { ledger.close(); await rm(dir, { recursive: true, force: true }); }
    });
  }
});


test("trusted Docker launch rejects shared/privileged/exposed executor profiles", () => {
  const config={name:"executor",image:"fixed-image",network:"control",apiContainer:"api",secretsVolume:"secret",ledgerVolume:"ledger"};
  const container={Config:{User:"10001:10001",Entrypoint:["node","/app/main.mjs"],Cmd:null},HostConfig:{Mounts:[{VolumeOptions:{NoCopy:true}},{VolumeOptions:{NoCopy:true}}],ReadonlyRootfs:true,Privileged:false,NetworkMode:"control",CapDrop:["ALL"],CapAdd:[],SecurityOpt:["no-new-privileges"],Memory:134217728,NanoCpus:500000000,PidsLimit:64,PortBindings:{}},Mounts:[{Type:"volume",Name:"ledger",Destination:"/ledger",RW:true},{Type:"volume",Name:"secret",Destination:"/secrets",RW:false}],NetworkSettings:{Networks:{control:{}}}};
  const network={Internal:true,Driver:"bridge",Options:{"com.docker.network.bridge.gateway_mode_ipv4":"isolated"},Containers:{a:{Name:"executor"},b:{Name:"api"}}};
  const api={HostConfig:{PortBindings:{},NetworkMode:"control",Privileged:false},NetworkSettings:{Networks:{control:{},database:{}}}};
  assert.doesNotThrow(()=>validateDockerProfile(container,network,api,config));
  for(const patch of [{Privileged:true},{ReadonlyRootfs:false},{CapAdd:["SYS_ADMIN"]},{Memory:0},{NanoCpus:0},{PidsLimit:0},{SecurityOpt:[]},{PortBindings:{"3002/tcp":[{}]}}])assert.throws(()=>validateDockerProfile({...container,HostConfig:{...container.HostConfig,...patch}},network,api,config));
  assert.throws(()=>validateDockerProfile({...container,Mounts:[...container.Mounts,{Type:"bind",Destination:"/var/run/docker.sock"}]},network,api,config));
  assert.throws(()=>validateDockerProfile(container,{...network,Internal:false},api,config));
  assert.throws(()=>validateDockerProfile(container,{...network,Containers:{agent:{Name:"untrusted-agent"}}},api,config));
  assert.throws(()=>validateDockerProfile(container,network,{...api,HostConfig:{...api.HostConfig,PortBindings:{"3002/tcp":[{}]}}},config));
});


test("malformed result ACK never clears a durable pending result",async()=>{
 for(const patch of [{reportId:undefined},{outcome:"UNKNOWN"},{verification:undefined},{digest:"bad"}]){
  const dir=await mkdtemp(path.join(tmpdir(),"foundry-ack-")),file=path.join(dir,"ledger.sqlite"),identity={deploymentId:"dep",bindingId:"bind",ledgerId:randomUUID(),artifactDigest:"a".repeat(64)};
  initializeLedger(file,identity);const ledger=new StartLedger(file,identity);let calls=0;
  const api={async call(route:string,body?:any){
   if(route==="/sessions")return{session:{...identity,id:"session",active:true}};
   if(route==="/recovery")return{claims:[],hasMore:false};
   if(route==="/poll")return{offers:[{invocationId:"inv"}]};
   if(route==="/claims")return{claim:{id:"claim",invocationId:"inv",generation:1}};
   if(route.endsWith("authorize-start"))return{startAllowed:true,ledgerId:identity.ledgerId,start:{...body,id:"start",invocationId:"inv",claimId:"claim",startDeadline:new Date(Date.now()+5000).toISOString()}};
   if(route.endsWith("results"))return{acknowledged:true,reportId:"report",startId:"start",digest:reportIdentity(body).digest,outcome:body.outcome,verification:"EXECUTOR_REPORTED",...patch};
   throw Error("Unexpected request");
  }};
  try{const runtime=new IsolatedExecutorRuntime(ledger,api,()=>{},()=>{},()=>{calls++;return HEALTH_RESULT;});await runtime.initialize();await assert.rejects(runtime.tick());assert.equal(calls,1);assert.equal(ledger.get("claim").state,"RESULT_PENDING");assert.equal(ledger.get("claim").ack,null);}
  finally{ledger.close();await rm(dir,{recursive:true,force:true});}
 }
});
