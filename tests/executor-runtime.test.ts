import { createServer } from "node:http";
import { ExecutorApi, HttpExecutorClient } from "../src/executor-runtime/api-client.js";
import { executorProtocolOptions } from "../src/executor/protocol-validation.js";
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
        if (route === "/sessions") return { session: { id: `session-${++session}`, generation: 1, executionProfile: "docker-health-ping-v1", active: true, ...identity } };
        if (route === "/recovery") return { claims: ledger.all().map(a=>({id:a.claimId,invocationId:a.invocationId,generation:a.generation,sessionId:a.sessionId,artifactDigest:a.artifactDigest,status:"ACTIVE",reportCredentialCurrent:true,start:start?{id:start.id,requestKey:start.requestKey,reports:[...reports.entries()].map(([digest,b])=>({id:"report-"+digest,digest,outcome:b.outcome}))}:null})),executionAllowed:false,hasMore:false,nextCursor:null };
        if (route === "/poll") return { startAllowed: false, offers: [{ executionAllowed: false, runId: "run", invocationId: "inv" }] };
        if (route === "/claims") return { claim: { deploymentId: identity.deploymentId, runId:"run", status:"ACTIVE", startAllowed:false, executionAllowed:false, id: "claim", invocationId: "inv", generation: 1 } };
        if (route.endsWith("/release")) return { claim: { deploymentId:identity.deploymentId,runId:"run",status:"RELEASED",startAllowed:false,executionAllowed:false,id:"claim",invocationId:"inv",generation:1 } };
        if (route.endsWith("/authorize-start")) { start = { ...body, authorizationDigest: "a".repeat(64), id: "start", invocationId: "inv", claimId: "claim", startDeadline: new Date(Date.now() + 5000).toISOString() }; return { start, executionAllowed: true, startAllowed: true, ledgerId: identity.ledgerId }; }
        if (route.endsWith("/start")) return { start, startAllowed:false,executionAllowed:false,startCommitted: !!start, claimFenced: true };
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


test("invalid claim, permit or ACK stops the executor at its durable boundary", async t => {
  type Stage = "claim" | "permit" | "start" | "ack";
  const cases: Array<[Stage, Record<string, unknown>]> = [
    ["claim", { deploymentId: "other" }], ["claim", { invocationId: "other" }], ["claim", { generation: -1 }],
    ["permit", { startAllowed: "false" }], ["permit", { executionAllowed: false }], ["permit", { executionAllowed: undefined }],
    ["permit", { ledgerId: "other" }], ["permit", { start: null }],
    ["start", { sessionId: "other" }], ["start", { claimId: "other" }], ["start", { generation: 2 }],
    ["start", { startDeadline: undefined }], ["start", { artifactDigest: "b".repeat(64) }],
    ["ack", { acknowledged: "true" }], ["ack", { startId: "other" }], ["ack", { reportId: undefined }],
    ["ack", { outcome: "UNKNOWN" }], ["ack", { verification: undefined }], ["ack", { digest: "bad" }],
  ];
  for (const [stage, patch] of cases) await t.test(stage + " " + Object.keys(patch)[0] + "=" + Object.values(patch)[0], async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "foundry-boundary-"));
    const file = path.join(dir, "ledger.sqlite");
    const identity = { deploymentId: "dep", bindingId: "bind", ledgerId: randomUUID(), artifactDigest: "a".repeat(64) };
    initializeLedger(file, identity);
    const ledger = new StartLedger(file, identity);
    let calls = 0;
    const api = { async call(route: string, body?: any) {
      if (route === "/sessions") return { session: { ...identity, generation: 1, executionProfile: "docker-health-ping-v1", id: "session", active: true } };
      if (route === "/recovery") return { executionAllowed: false, claims: [], hasMore: false, nextCursor: null };
      if (route === "/poll") return { startAllowed: false, offers: [{ executionAllowed: false, runId: "run", invocationId: "inv" }] };
      if (route === "/claims") return { claim: { deploymentId: "dep", runId: "run", status: "ACTIVE", startAllowed: false,
        executionAllowed: false, id: "claim", invocationId: "inv", generation: 1, ...(stage === "claim" && patch) } };
      if (route.endsWith("/authorize-start")) return { startAllowed: true, executionAllowed: true, ledgerId: identity.ledgerId,
        start: { ...body, authorizationDigest: identity.artifactDigest, id: "start", invocationId: "inv", claimId: "claim",
          startDeadline: new Date(Date.now() + 5000).toISOString(), ...(stage === "start" && patch) }, ...(stage === "permit" && patch) };
      if (route.endsWith("/results")) return { acknowledged: true, reportId: "report", startId: "start", digest: reportIdentity(body).digest,
        outcome: body.outcome, verification: "EXECUTOR_REPORTED", ...patch };
      throw Error("Unexpected request");
    } };
    try {
      const runtime = new IsolatedExecutorRuntime(ledger, api, () => {}, () => {}, () => { calls++; return HEALTH_RESULT; });
      await runtime.initialize();
      await assert.rejects(runtime.tick());
      assert.equal(calls, stage === "ack" ? 1 : 0);
      if (stage === "claim") assert.deepEqual(ledger.all(), []);
      else {
        const a = ledger.get("claim");
        assert.equal(a.state, stage === "ack" ? "RESULT_PENDING" : "START_REQUESTED");
        assert.equal(a.ack, null);
        if (stage === "ack") assert.equal(JSON.parse(a.report!).outcome, "SUCCEEDED");
      }
    } finally { ledger.close(); await rm(dir, { recursive: true, force: true }); }
  });
});

test("shared API lease configuration accepts only in-range integer milliseconds", () => {
  assert.deepEqual(executorProtocolOptions({}), { leaseMs: 30000 });
  for (const value of ["1000", "7100", "120000"])
    assert.deepEqual(executorProtocolOptions({ FOUNDRY_EXECUTOR_LEASE_MS: value }), { leaseMs: Number(value) });
  for (const value of ["", " ", "999", "120001", "-1000", "1.5", "2e3", "5000ms"])
    assert.throws(() => executorProtocolOptions({ FOUNDRY_EXECUTOR_LEASE_MS: value }), /FOUNDRY_EXECUTOR_LEASE_MS/);
});

test("executor rejects invalid JSON and malformed success envelopes over HTTP", async () => {
  let reply = "{";
  const server = createServer((_req, res) => res.writeHead(200, { "content-type": "application/json" }).end(reply));
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    assert.ok(address && typeof address === "object");
    const api = new ExecutorApi(new HttpExecutorClient(`http://127.0.0.1:${address.port}`, "test-only"));
    await assert.rejects(api.poll("session"), SyntaxError);
    for (const value of [null, [], { startAllowed: false, offers: "invalid" }]) {
      reply = JSON.stringify(value);
      await assert.rejects(api.poll("session"), /Invalid executor API response/);
    }
    reply = JSON.stringify({ startAllowed: false, executionAllowed: false, startCommitted: false, start: {}, claimFenced: true });
    await assert.rejects(api.inspect("claim"), /Invalid executor API response/);
  } finally {
    await new Promise<void>((resolve, reject) => server.close(err => err ? reject(err) : resolve()));
  }
});
