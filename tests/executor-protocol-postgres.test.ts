import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import type { AddressInfo } from "node:net";
import { Client } from "pg";
import { createPrismaClient } from "../src/persistence/prisma-execution-store.js";
import { PrismaIdentityStore } from "../src/identity/prisma-identity-store.js";
import { CredentialAuthenticator, TrustedCredentialIssuer, TrustedIdentityAdministration, IdentityError, type Scope } from "../src/identity/identity.js";
import { AgentRegistry } from "../src/identity/agent-registry.js";
import { ExternalRegistry } from "../src/registry/external-registry.js";
import { TrustedResourceBindings } from "../src/authorization/trusted-bindings.js";
import { RESOURCE_FREE_RESOURCE, RESOURCE_FREE_SCHEMA } from "../src/authorization/resource-binding.js";
import { InvocationService } from "../src/invocation/invocation-service.js";
import { ExecutorProtocol, ExecutorConflict } from "../src/executor/executor-protocol.js";
import { createExternalApiServer } from "../src/external-api/server.js";

const url = process.env.FOUNDRY_112B_TEST_DATABASE_URL;
test("isolated PostgreSQL: authenticated executor claims, leases and fencing", { skip: !url }, async t => {
  const parsed = new URL(url!);
  if (!["127.0.0.1", "localhost", "::1"].includes(parsed.hostname) || !/^\/foundry_112b_test_[a-z0-9]+$/.test(parsed.pathname)) throw new Error("Dedicated local foundry_112b_test_* database required");
  const db = createPrismaClient(url!);
  const store = new PrismaIdentityStore(db), admin = new TrustedIdentityAdministration(store), issuer = new TrustedCredentialIssuer(store);
  const auth = new CredentialAuthenticator(store), registry = new AgentRegistry(store), external = new ExternalRegistry(db);
  const bindings = new TrustedResourceBindings(db), invocations = new InvocationService(db), protocol = new ExecutorProtocol(db, { leaseMs: 1000 });
  const expiry = () => new Date(Date.now() + 600000);
  async function operator() {
    const owner = await admin.createOwner("112b isolated");
    const principal = await admin.createPrincipal({ ownerId: owner.id, type: "OPERATOR" });
    const token = await issuer.issue({ principalId: principal.id, scopes: ["agent:register", "version:publish", "manifest:publish", "deployment:manage", "grant:manage"], expiresAt: expiry() });
    return { owner, token, context: await auth.authenticate(token.secret) };
  }
  const op = await operator();
  async function executor(ownerId: string, deploymentId: string, scopes: Scope[] = ["executor:claim", "executor:lease"]) {
    const principal = await admin.createPrincipal({ ownerId, type: "EXECUTOR", deploymentId });
    const token = await issuer.issue({ principalId: principal.id, scopes, expiresAt: expiry() });
    return { principal, token, context: await auth.authenticate(token.secret) };
  }
  async function fixture(options: { op?: typeof op; reviewed?: "READ_ONLY" | "WRITE"; bind?: boolean; bindingLifetimeMs?: number } = {}) {
    const owner = options.op ?? op;
    const agent = await registry.register(owner.context, { name: `executor-test-${randomUUID()}` });
    const version = await external.publishVersion(owner.context, { agentId: agent.id, version: 1, config: { protocol: "112b" } });
    const manifest = await external.publishManifest(owner.context, { versionId: version.id, revision: 1, manifest: { tools: [{ name: "resource_free", revision: 1, description: "metadata only", inputSchema: RESOURCE_FREE_SCHEMA, declaredProfile: "READ_ONLY", handlerId: "never-executed" }] } });
    const tool = manifest.tools[0]!, deployment = await external.registerDeployment(owner.context, { name: `deployment-${randomUUID()}`, environment: "isolated" });
    const grant = await external.grant(owner.context, { versionId: version.id, toolId: tool.id, deploymentId: deployment.id, reviewedProfile: options.reviewed ?? "READ_ONLY", allowedResources: [RESOURCE_FREE_RESOURCE] });
    const binding = options.bind === false ? null : await bindings.approveResourceFree(owner.context, { toolId: tool.id, deploymentId: deployment.id, revision: 1, artifactDigest: "b".repeat(64), expiresAt: new Date(Date.now() + (options.bindingLifetimeMs ?? 600000)) });
    const principal = await admin.createPrincipal({ ownerId: owner.owner.id, type: "AGENT", agentId: agent.id });
    const token = await issuer.issue({ principalId: principal.id, scopes: ["run:manage", "invocation:request"], expiresAt: expiry() });
    const agentContext = await auth.authenticate(token.secret), run = await invocations.openRun(agentContext, version.id);
    const request = { runId: run.id, toolId: tool.id, deploymentId: deployment.id, grantId: grant.id, idempotencyKey: "tool-request", arguments: {} };
    const invocation = await invocations.acceptInvocation(agentContext, request);
    const claimant = await executor(owner.owner.id, deployment.id);
    return { owner, agent, version, tool, deployment, grant, binding, token, agentContext, run, request, invocation, claimant };
  }
  async function waitUntilExpired(deadline: Date) { await delay(Math.max(0, deadline.getTime() - Date.now()) + 30); }
  async function waitForLock(application: string) {
    for (let n = 0; n < 200; n++) {
      const rows = await db.$queryRaw<Array<{ waiting: boolean }>>`SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE application_name = ${application} AND wait_event_type = 'Lock') AS waiting`;
      if (rows[0]!.waiting) return;
      await delay(10);
    }
    throw new Error("Expected real PostgreSQL lock wait was not observed");
  }
  function tagged(application: string) {
    const connection = new URL(url!); connection.searchParams.set("application_name", application);
    return createPrismaClient(connection.toString());
  }
  try {
    await t.test("poll offers only eligible work and duplicate polling creates no claim", async () => {
      const f = await fixture();
      const first = await protocol.poll(f.claimant.context), second = await protocol.poll(f.claimant.context);
      assert.deepEqual(first, second); assert.equal(first.offers[0]!.invocationId, f.invocation.id);
      assert.equal(first.startAllowed, false); assert.equal(first.offers[0]!.executionAllowed, false);
      assert.equal(await db.executorClaim.count({ where: { invocationId: f.invocation.id } }), 0);
      assert.equal(await db.invocationEvent.count({ where: { invocationId: f.invocation.id } }), 1);
    });
    await t.test("claim identity, snapshot and generation survive inspection and duplicate requests", async () => {
      const f = await fixture();
      const results = await Promise.all(Array.from({ length: 3 }, () => protocol.claim(f.claimant.context, f.invocation.id, "same-key")));
      assert.equal(new Set(results.map(c => c.id)).size, 1);
      const claim = results[0]!;
      assert.equal(claim.generation, 1); assert.equal(claim.executorPrincipalId, f.claimant.principal.id);
      assert.equal(claim.credentialId, f.claimant.token.credentialId); assert.equal(claim.startAuthorizedAt, null);
      assert.equal(claim.authorizationDigest, (await db.invocationAuthorization.findUniqueOrThrow({ where: { invocationId: f.invocation.id } })).digest);
      const inspected = await protocol.inspect(f.claimant.context, claim.id);
      assert.equal(inspected.current, true); assert.equal(inspected.startAllowed, false);
      assert.equal((await db.invocation.findUniqueOrThrow({ where: { id: f.invocation.id } })).status, "CLAIMED");
      assert.equal(await db.executorClaim.count({ where: { invocationId: f.invocation.id } }), 1);
      assert.equal(await db.invocationEvent.count({ where: { invocationId: f.invocation.id, kind: "CLAIMED" } }), 1);
    });
    await t.test("two concurrent executors produce exactly one claim winner", async () => {
      const f = await fixture(), second = await executor(op.owner.id, f.deployment.id);
      const outcomes = await Promise.allSettled([protocol.claim(f.claimant.context, f.invocation.id, "one"), protocol.claim(second.context, f.invocation.id, "two")]);
      assert.equal(outcomes.filter(r => r.status === "fulfilled").length, 1);
      assert.ok(outcomes.some(r => r.status === "rejected" && r.reason instanceof ExecutorConflict));
      assert.equal(await db.executorClaim.count({ where: { invocationId: f.invocation.id, status: "ACTIVE" } }), 1);
    });
    await t.test("agent/operator and cross-owner/deployment access are rejected", async () => {
      const f = await fixture(), other = await fixture(), foreign = await fixture({ op: await operator() });
      await assert.rejects(protocol.poll(f.agentContext), IdentityError);
      await assert.rejects(protocol.poll(op.context), IdentityError);
      await assert.rejects(protocol.claim(other.claimant.context, f.invocation.id, "wrong-dep"), IdentityError);
      await assert.rejects(protocol.claim(foreign.claimant.context, f.invocation.id, "wrong-owner"), IdentityError);
      const claim = await protocol.claim(f.claimant.context, f.invocation.id, "owned");
      await assert.rejects(protocol.inspect(other.claimant.context, claim.id), IdentityError);
      await assert.rejects(protocol.release(foreign.claimant.context, claim.id, 1), IdentityError);
      const fakeDeployment = await executor(op.owner.id, "nonexistent-deployment");
      await assert.rejects(protocol.poll(fakeDeployment.context), IdentityError);
    });
    await t.test("unverified and approval-pending work cannot be offered or claimed", async () => {
      for (const options of [{ bind: false }, { reviewed: "WRITE" as const }]) {
        const f = await fixture(options);
        assert.deepEqual((await protocol.poll(f.claimant.context)).offers, []);
        await assert.rejects(protocol.claim(f.claimant.context, f.invocation.id, "blocked"), ExecutorConflict);
      }
    });
    await t.test("revoked/expired executor credentials and removed scopes are rejected", async () => {
      for (const change of ["revoke", "expire", "scope"]) {
        const f = await fixture();
        if (change === "revoke") await admin.revokeCredential(f.claimant.token.credentialId);
        else await db.credential.update({ where: { id: f.claimant.token.credentialId }, data: change === "expire" ? { expiresAt: new Date(0) } : { scopes: ["executor:identify"] } });
        await assert.rejects(protocol.claim(f.claimant.context, f.invocation.id, change), IdentityError);
      }
    });
    await t.test("renewal and release are fenced by exact claimant, credential and generation", async () => {
      const f = await fixture(), second = await executor(op.owner.id, f.deployment.id);
      const claim = await protocol.claim(f.claimant.context, f.invocation.id, "first");
      await assert.rejects(protocol.renew(second.context, claim.id, claim.generation), IdentityError);
      await assert.rejects(protocol.renew(f.claimant.context, claim.id, claim.generation + 1), ExecutorConflict);
      await delay(20);
      const renewed = await protocol.renew(f.claimant.context, claim.id, claim.generation);
      assert.ok(renewed.leaseExpiresAt > claim.leaseExpiresAt);
      const released = await protocol.release(f.claimant.context, claim.id, claim.generation);
      assert.equal(released.status, "RELEASED");
      assert.equal((await protocol.release(f.claimant.context, claim.id, claim.generation)).id, claim.id);
      const next = await protocol.claim(second.context, f.invocation.id, "second");
      assert.equal(next.generation, 2);
      await assert.rejects(protocol.renew(f.claimant.context, claim.id, 1), ExecutorConflict);
      await assert.rejects(protocol.release(f.claimant.context, claim.id, 1), ExecutorConflict);
      await assert.rejects(protocol.claim(f.claimant.context, f.invocation.id, "first"), ExecutorConflict);
      const events = await invocations.history(f.agentContext, f.run.id);
      assert.deepEqual(events.map(e => e.kind), ["AUTHORIZATION_DECISION", "CLAIMED", "CLAIM_RENEWED", "CLAIM_RELEASED", "CLAIMED"]);
      assert.deepEqual(events.slice(1).map(e => e.claimGeneration), [1, 1, 1, 2]);
    });
    await t.test("claim-key conflict cannot redirect an accepted assignment", async () => {
      const f = await fixture(), claim = await protocol.claim(f.claimant.context, f.invocation.id, "key");
      await protocol.release(f.claimant.context, claim.id, claim.generation);
      await assert.rejects(protocol.claim(f.claimant.context, f.invocation.id, "key"), ExecutorConflict);
      const newRun = await invocations.openRun(f.agentContext, f.version.id);
      const next = await invocations.acceptInvocation(f.agentContext, { ...f.request, runId: newRun.id });
      await assert.rejects(protocol.claim(f.claimant.context, next.id, "key"), ExecutorConflict);
      assert.equal(await db.executorClaim.count({ where: { invocationId: next.id } }), 0);
    });
    await t.test("expired pre-start claims reconcile durably and advance generation", async () => {
      const f = await fixture(), claim = await protocol.claim(f.claimant.context, f.invocation.id, "before-disconnect");
      await waitUntilExpired(claim.leaseExpiresAt);
      await assert.rejects(protocol.renew(f.claimant.context, claim.id, claim.generation), ExecutorConflict);
      assert.equal((await db.executorClaim.findUniqueOrThrow({ where: { id: claim.id } })).status, "EXPIRED");
      assert.equal((await protocol.poll(f.claimant.context)).offers[0]!.invocationId, f.invocation.id);
      const next = await protocol.claim(f.claimant.context, f.invocation.id, "after-disconnect");
      assert.equal(next.generation, 2);
      assert.equal(await db.invocationEvent.count({ where: { invocationId: f.invocation.id, kind: "CLAIM_EXPIRED" } }), 1);
    });
    await t.test("current assignments reconcile after a new service and database client", async () => {
      const f = await fixture(), claim = await protocol.claim(f.claimant.context, f.invocation.id, "restart");
      const fresh = createPrismaClient(url!);
      try {
        const newContext = await new CredentialAuthenticator(new PrismaIdentityStore(fresh)).authenticate(f.claimant.token.secret);
        const result = await new ExecutorProtocol(fresh).inspect(newContext, claim.id);
        assert.equal(result.claim.id, claim.id); assert.equal(result.claim.generation, 1); assert.equal(result.current, true);
      } finally { await fresh.$disconnect(); }
      await db.credential.update({ where: { id: f.claimant.token.credentialId }, data: { scopes: ["executor:lease"] } });
      assert.equal((await protocol.inspect(f.claimant.context, claim.id)).current, false);
    });
    await t.test("grant, binding, requester revocation and changed deployment prevent new claims", async () => {
      for (const change of ["grant", "binding", "requester", "deployment"]) {
        const f = await fixture();
        if (change === "grant") await external.revoke(op.context, f.grant.id);
        if (change === "binding") await bindings.revoke(op.context, f.binding!.id);
        if (change === "requester") await admin.revokeCredential(f.token.credentialId);
        if (change === "deployment") await db.executorDeployment.update({ where: { id: f.deployment.id }, data: { environment: "changed" } });
        assert.equal((await protocol.poll(f.claimant.context)).offers.length, 0);
        await assert.rejects(protocol.claim(f.claimant.context, f.invocation.id, change), ExecutorConflict);
        assert.equal(await db.executorClaim.count({ where: { invocationId: f.invocation.id } }), 0);
      }
    });
    await t.test("binding expiry remains fail-closed before claim", async () => {
      const f = await fixture({ bindingLifetimeMs: 1500 });
      await waitUntilExpired(f.binding!.expiresAt);
      await assert.rejects(protocol.claim(f.claimant.context, f.invocation.id, "expired"), ExecutorConflict);
      assert.equal((await protocol.poll(f.claimant.context)).offers.length, 0);
    });
    await t.test("revoked claimant is fenced and another current executor can reclaim pre-start work", async () => {
      const f = await fixture(), other = await executor(op.owner.id, f.deployment.id);
      const claim = await protocol.claim(f.claimant.context, f.invocation.id, "old-credential");
      await admin.revokeCredential(f.claimant.token.credentialId);
      await assert.rejects(protocol.renew(f.claimant.context, claim.id, 1), IdentityError);
      assert.equal((await protocol.poll(other.context)).offers[0]!.invocationId, f.invocation.id);
      assert.equal((await db.executorClaim.findUniqueOrThrow({ where: { id: claim.id } })).status, "REVOKED");
      assert.equal((await protocol.claim(other.context, f.invocation.id, "replacement")).generation, 2);
    });
    await t.test("revoked policy ends a pre-start claim without inventing an execution failure", async () => {
      const f = await fixture(), claim = await protocol.claim(f.claimant.context, f.invocation.id, "claim");
      await external.revoke(op.context, f.grant.id);
      await assert.rejects(protocol.renew(f.claimant.context, claim.id, 1), ExecutorConflict);
      assert.equal((await db.executorClaim.findUniqueOrThrow({ where: { id: claim.id } })).status, "REVOKED");
      assert.equal((await invocations.getInvocation(f.agentContext, f.invocation.id)).status, "REVOKED");
      assert.equal(await db.invocationEvent.count({ where: { invocationId: f.invocation.id, status: { in: ["START_AUTHORIZED", "RUNNING", "SUCCEEDED", "FAILED"] } } }), 0);
    });
    await t.test("UNKNOWN and start history never permit release or automatic reassignment", async () => {
      for (const history of [false, true]) {
        const f = await fixture(), claim = await protocol.claim(f.claimant.context, f.invocation.id, "fixture");
        // Isolated test fixtures only: no production protocol can report a start.
        if (history) await db.invocationEvent.create({ data: { runId: f.run.id, invocationId: f.invocation.id, actorPrincipalId: op.context.principalId, kind: "START_AUTHORIZED", status: "START_AUTHORIZED", reason: "TEST_FIXTURE" } });
        else await db.invocation.update({ where: { id: f.invocation.id }, data: { status: "UNKNOWN", reason: "TEST_FIXTURE" } });
        await waitUntilExpired(claim.leaseExpiresAt);
        assert.equal((await protocol.poll(f.claimant.context)).offers.length, 0);
        await assert.rejects(protocol.release(f.claimant.context, claim.id, 1), ExecutorConflict);
        await assert.rejects(protocol.claim(f.claimant.context, f.invocation.id, "unsafe-retry"), ExecutorConflict);
        assert.equal((await db.executorClaim.findUniqueOrThrow({ where: { id: claim.id } })).status, "ACTIVE");
        await assert.rejects(invocations.closeRun(f.agentContext, f.run.id));
      }
    });
    await t.test("database guards freeze claim identity, generation and disabled start marker", async () => {
      const f = await fixture(), claim = await protocol.claim(f.claimant.context, f.invocation.id, "immutable");
      await assert.rejects(db.executorClaim.update({ where: { id: claim.id }, data: { generation: 2 } }));
      await assert.rejects(db.executorClaim.update({ where: { id: claim.id }, data: { startAuthorizedAt: new Date() } }));
      await assert.rejects(db.executorClaim.delete({ where: { id: claim.id } }));
      await protocol.release(f.claimant.context, claim.id, 1);
      await assert.rejects(db.executorClaim.create({ data: { ...claim, id: `invalid-${randomUUID()}`, requestKey: "invalid-generation", closedAt: null, status: "ACTIVE" } }));
    });
    await t.test("claim and audit event commit atomically", async () => {
      const f = await fixture();
      await db.$executeRawUnsafe(`CREATE FUNCTION reject_claim_event() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.kind = 'CLAIMED' THEN RAISE EXCEPTION 'injected event failure'; END IF; RETURN NEW; END; $$`);
      await db.$executeRawUnsafe(`CREATE TRIGGER reject_claim_event BEFORE INSERT ON "InvocationEvent" FOR EACH ROW EXECUTE FUNCTION reject_claim_event()`);
      try {
        await assert.rejects(protocol.claim(f.claimant.context, f.invocation.id, "rollback"));
        assert.equal(await db.executorClaim.count({ where: { invocationId: f.invocation.id } }), 0);
        assert.equal((await invocations.getInvocation(f.agentContext, f.invocation.id)).status, "READY");
        assert.equal(await db.invocationEvent.count({ where: { invocationId: f.invocation.id } }), 1);
      } finally {
        await db.$executeRawUnsafe('DROP TRIGGER reject_claim_event ON "InvocationEvent"');
        await db.$executeRawUnsafe('DROP FUNCTION reject_claim_event()');
      }
    });
    await t.test("HTTP executor boundary enforces roles, scopes, DTOs, methods and history", async () => {
      const f = await fixture(), limited = await executor(op.owner.id, f.deployment.id, ["executor:identify"]);
      const server = createExternalApiServer({ auth, invocations, executors: protocol });
      await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
      const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      async function call(path: string, secret: string | undefined = f.claimant.token.secret, body?: unknown, method = "POST", raw?: string, contentType = "application/json") {
        const response = await fetch(origin + path, { method, headers: { ...(secret ? { authorization: `Bearer ${secret}` } : {}), "content-type": contentType }, ...(method === "POST" ? { body: raw ?? JSON.stringify(body ?? {}) } : {}) });
        return { status: response.status, body: await response.json() as any };
      }
      const prefix = "/api/v1/executor";
      try {
        assert.equal((await call(prefix + "/poll", "bad")).status, 401);
        assert.equal((await call(prefix + "/poll", "")).status, 401);
        assert.equal((await call(prefix + "/poll", f.token.secret)).status, 403);
        assert.equal((await call(prefix + "/poll", op.token.secret)).status, 403);
        assert.equal((await call(prefix + "/poll", limited.token.secret)).status, 403);
        assert.equal((await call(prefix + "/poll", undefined, {}, "GET")).status, 405);
        assert.equal((await call(prefix + "/poll", undefined, { limit: 11 })).status, 400);
        assert.equal((await call(prefix + "/poll", undefined, { deploymentId: f.deployment.id })).status, 400);
        assert.equal((await call(prefix + "/poll", undefined, undefined, "POST", "{bad")).status, 400);
        assert.equal((await call(prefix + "/poll", undefined, {}, "POST", undefined, "text/plain")).status, 415);
        assert.equal((await call(prefix + "/poll", undefined, undefined, "POST", "x".repeat(66000))).status, 413);
        assert.equal((await call("/api/v1/external/runs", undefined, { versionId: f.version.id })).status, 403);
        const polled = await call(prefix + "/poll"); assert.equal(polled.status, 200);
        const created = await call(prefix + "/claims", undefined, { invocationId: f.invocation.id, requestKey: "http" });
        assert.equal(created.status, 200); const claim = created.body.claim;
        assert.equal(claim.startAllowed, false); assert.equal(claim.executionAllowed, false);
        assert.doesNotMatch(JSON.stringify(created), /credentialId|executorPrincipalId|authorizationDigest|arguments|snapshot|artifactDigest|af_/);
        assert.equal((await call(`${prefix}/claims/${claim.id}`, undefined, undefined, "GET")).body.current, true);
        assert.equal((await call(`${prefix}/claims/${claim.id}/renew`, undefined, { generation: claim.generation })).status, 200);
        assert.equal((await call(`${prefix}/claims/${claim.id}/renew`, undefined, { generation: 999 })).status, 409);
        for (const action of ["start", "authorize-start", "result", "approve"]) assert.equal((await call(`${prefix}/claims/${claim.id}/${action}`)).status, 404);
        assert.equal((await call(`${prefix}/claims/${claim.id}/release`, undefined, { generation: claim.generation })).status, 200);
        const history = await call(`/api/v1/external/runs/${f.run.id}/history?limit=2`, f.token.secret, undefined, "GET");
        assert.equal(history.status, 200); assert.equal(history.body.events[1].claim.id, claim.id);
        const after = await call(`/api/v1/external/runs/${f.run.id}/history?after=${history.body.nextCursor}`, f.token.secret, undefined, "GET");
        assert.deepEqual(after.body.events.map((e: any) => e.kind), ["CLAIM_RENEWED", "CLAIM_RELEASED"]);
        assert.doesNotMatch(JSON.stringify(after), /credentialId|requestFingerprint|artifactDigest|af_/);
        await admin.revokeCredential(f.claimant.token.credentialId);
        assert.equal((await call(prefix + "/poll")).status, 401);
      } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
    });
    await t.test("grant revocation committed before claim blocks assignment under real lock contention", async () => {
      const f = await fixture(), holder = new Client({ connectionString: url! }), competing = tagged("112b-revocation-first");
      await holder.connect(); let pending: Promise<unknown> | undefined;
      try {
        await holder.query('BEGIN'); await holder.query('UPDATE "CapabilityGrant" SET "revokedAt"=clock_timestamp() WHERE id=$1', [f.grant.id]);
        const outcome = new ExecutorProtocol(competing).claim(f.claimant.context, f.invocation.id, "race").then(value => ({ value }), error => ({ error })); pending = outcome;
        await waitForLock("112b-revocation-first"); await holder.query('COMMIT');
        assert.ok("error" in await outcome);
        assert.equal(await db.executorClaim.count({ where: { invocationId: f.invocation.id } }), 0);
      } finally { await holder.query('ROLLBACK'); await Promise.allSettled(pending ? [pending] : []); await holder.end(); await competing.$disconnect(); }
    });
    await t.test("claim first then revocation cannot renew or authorize start", async () => {
      const f = await fixture(), holder = new Client({ connectionString: url! });
      const claimDb = tagged("112b-claim-first"), revokeDb = tagged("112b-revoke-second");
      await holder.connect(); const pending: Promise<unknown>[] = [];
      try {
        await holder.query('BEGIN'); await holder.query('SELECT id FROM "TrustedResourceBinding" WHERE id=$1 FOR UPDATE', [f.binding!.id]);
        const claimed = new ExecutorProtocol(claimDb).claim(f.claimant.context, f.invocation.id, "race"); pending.push(claimed);
        await waitForLock("112b-claim-first");
        const revoked = new ExternalRegistry(revokeDb).revoke(op.context, f.grant.id); pending.push(revoked);
        await waitForLock("112b-revoke-second"); await holder.query('COMMIT');
        const claim = await claimed; await revoked;
        await assert.rejects(protocol.renew(f.claimant.context, claim.id, claim.generation), ExecutorConflict);
        assert.equal((await db.executorClaim.findUniqueOrThrow({ where: { id: claim.id } })).status, "REVOKED");
      } finally { await holder.query('ROLLBACK'); await Promise.allSettled(pending); await holder.end(); await claimDb.$disconnect(); await revokeDb.$disconnect(); }
    });
    await t.test("concurrent renewal and polling cannot revive or double-expire a lease", async () => {
      const f = await fixture(), claim = await protocol.claim(f.claimant.context, f.invocation.id, "expiring");
      const other = await executor(op.owner.id, f.deployment.id);
      const holder = new Client({ connectionString: url! }), renewing = tagged("112b-renew-expired"), polling = tagged("112b-expiration-poll");
      await holder.connect(); const pending: Promise<unknown>[] = [];
      try {
        await holder.query('BEGIN'); await holder.query('SELECT id FROM "Credential" WHERE id=$1 FOR UPDATE', [f.claimant.token.credentialId]);
        const outcome = new ExecutorProtocol(renewing).renew(f.claimant.context, claim.id, 1).then(value => ({ value }), error => ({ error })); pending.push(outcome);
        await waitForLock("112b-renew-expired");
        const poll = new ExecutorProtocol(polling).poll(other.context); pending.push(poll);
        await waitForLock("112b-expiration-poll");
        await waitUntilExpired(claim.leaseExpiresAt); await holder.query('COMMIT');
        const result = await outcome;
        assert.ok("error" in result && result.error instanceof ExecutorConflict);
        assert.equal((await db.executorClaim.findUniqueOrThrow({ where: { id: claim.id } })).status, "EXPIRED");
        assert.equal(await db.invocationEvent.count({ where: { invocationId: f.invocation.id, kind: "CLAIM_EXPIRED" } }), 1);
        assert.equal((await poll).offers[0]!.invocationId, f.invocation.id);
      } finally { await holder.query('ROLLBACK'); await Promise.allSettled(pending); await holder.end(); await renewing.$disconnect(); await polling.$disconnect(); }
    });
    await t.test("renewal committed before expiration keeps a concurrent poll from expiring the claim", async () => {
      const f = await fixture(), longLease = new ExecutorProtocol(db, { leaseMs: 3000 });
      const claim = await longLease.claim(f.claimant.context, f.invocation.id, "renew-first");
      const other = await executor(op.owner.id, f.deployment.id);
      const holder = new Client({ connectionString: url! }), renewing = tagged("112b-renew-first"), polling = tagged("112b-poll-second");
      await holder.connect(); const pending: Promise<unknown>[] = [];
      try {
        await holder.query('BEGIN'); await holder.query('SELECT id FROM "TrustedResourceBinding" WHERE id=$1 FOR UPDATE', [f.binding!.id]);
        const renewal = new ExecutorProtocol(renewing, { leaseMs: 3000 }).renew(f.claimant.context, claim.id, 1); pending.push(renewal);
        await waitForLock("112b-renew-first");
        const poll = new ExecutorProtocol(polling).poll(other.context); pending.push(poll);
        await waitForLock("112b-poll-second"); await holder.query('COMMIT');
        assert.ok((await renewal).leaseExpiresAt > claim.leaseExpiresAt);
        assert.deepEqual((await poll).offers, []);
        assert.equal((await db.executorClaim.findUniqueOrThrow({ where: { id: claim.id } })).status, "ACTIVE");
        assert.equal(await db.invocationEvent.count({ where: { invocationId: f.invocation.id, kind: "CLAIM_EXPIRED" } }), 0);
      } finally { await holder.query('ROLLBACK'); await Promise.allSettled(pending); await holder.end(); await renewing.$disconnect(); await polling.$disconnect(); }
    });
  } finally { await db.$disconnect(); }
});
