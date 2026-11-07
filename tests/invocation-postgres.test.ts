import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { createPrismaClient, PrismaExecutionStore } from "../src/persistence/prisma-execution-store.js";
import { PrismaIdentityStore } from "../src/identity/prisma-identity-store.js";
import { AgentRegistry } from "../src/identity/agent-registry.js";
import { CredentialAuthenticator, IdentityError, TrustedCredentialIssuer, TrustedIdentityAdministration } from "../src/identity/identity.js";
import { ExternalRegistry } from "../src/registry/external-registry.js";
import { InvocationService, InvocationConflict } from "../src/invocation/invocation-service.js";
import { ValidationError } from "../src/registry/validation.js";
import { recoverStaleRuns } from "../src/recovery/recover-stale-runs.js";

const url = process.env.FOUNDRY_11C_TEST_DATABASE_URL;
test("isolated PostgreSQL: invocation admission, isolation, history and races", { skip: !url }, async () => {
  const parsed = new URL(url!);
  if (!["127.0.0.1", "localhost", "::1"].includes(parsed.hostname) || !/^\/foundry_11c_test_[a-z0-9]+$/.test(parsed.pathname)) throw new Error("Dedicated local foundry_11c_test_* database required");
  const db = createPrismaClient(url!);
  try {
    const store = new PrismaIdentityStore(db), admin = new TrustedIdentityAdministration(store), issuer = new TrustedCredentialIssuer(store);
    const auth = new CredentialAuthenticator(store), registry = new AgentRegistry(store), external = new ExternalRegistry(db), service = new InvocationService(db);
    const owner = await admin.createOwner("11c owner"), other = await admin.createOwner("11c other"), expiry = new Date(Date.now() + 600000);
    const op = await admin.createPrincipal({ ownerId: owner.id, type: "OPERATOR" });
    const oc = await issuer.issue({ principalId: op.id, scopes: ["agent:register", "version:publish", "manifest:publish", "deployment:manage", "grant:manage"], expiresAt: expiry });
    const operator = await auth.authenticate(oc.secret), a = await registry.register(operator, { name: `test-${randomUUID()}` });
    const version = await external.publishVersion(operator, { agentId: a.id, version: 1, config: { label: "test" } });
    const schema = { type: "object", properties: { path: { type: "string" }, count: { type: "integer" } }, required: ["path"], additionalProperties: false };
    const manifest = await external.publishManifest(operator, { versionId: version.id, revision: 1, manifest: { tools: [
      { name: "read", revision: 1, description: "read", inputSchema: schema, declaredProfile: "READ_ONLY", handlerId: "read" } ] } });
    const tool = manifest.tools[0]!, dep = await external.registerDeployment(operator, { name: "test", environment: "dev" });
    const grant = await external.grant(operator, { versionId: version.id, toolId: tool.id, deploymentId: dep.id, reviewedProfile: "READ_ONLY", allowedResources: ["resource"] });
    const p = await admin.createPrincipal({ ownerId: owner.id, type: "AGENT", agentId: a.id });
    const token = await issuer.issue({ principalId: p.id, scopes: ["run:manage", "invocation:request"], expiresAt: expiry });
    const ctx = await auth.authenticate(token.secret), run = await service.openRun(ctx, version.id);
    assert.match(run.id, /^ext_/); assert.equal(run.agentId, a.id); assert.equal(run.versionId, version.id);
    const otherOp = await admin.createPrincipal({ ownerId: other.id, type: "OPERATOR" });
    const otherOpToken = await issuer.issue({ principalId: otherOp.id, scopes: ["agent:register"], expiresAt: expiry });
    const otherAgent = await registry.register(await auth.authenticate(otherOpToken.secret), { name: `other-${randomUUID()}` });
    const otherPrincipal = await admin.createPrincipal({ ownerId: other.id, type: "AGENT", agentId: otherAgent.id });
    const otherToken = await issuer.issue({ principalId: otherPrincipal.id, scopes: ["run:manage", "invocation:request"], expiresAt: expiry });
    const otherCtx = await auth.authenticate(otherToken.secret);
    await assert.rejects(service.openRun(otherCtx, version.id), IdentityError);
    await assert.rejects(service.history(otherCtx, run.id), IdentityError);
    const base = { runId: run.id, toolId: tool.id, deploymentId: dep.id, grantId: grant.id, arguments: { path: "readme", count: 1 } };
    await assert.rejects(service.acceptInvocation(otherCtx, { ...base, idempotencyKey: "other" }), IdentityError);
    const sibling = await registry.register(operator, { name: `sibling-${randomUUID()}` });
    const siblingPrincipal = await admin.createPrincipal({ ownerId: owner.id, type: "AGENT", agentId: sibling.id });
    const siblingToken = await issuer.issue({ principalId: siblingPrincipal.id, scopes: ["run:manage", "invocation:request"], expiresAt: expiry });
    const siblingCtx = await auth.authenticate(siblingToken.secret);
    await assert.rejects(service.openRun(siblingCtx, version.id), IdentityError);
    await assert.rejects(service.history(siblingCtx, run.id), IdentityError);
    for (const args of [{}, { path: 1 }, { path: "x", count: 1.5 }, { path: "x", extra: true }, { path: "x", token: "secret" }])
      await assert.rejects(service.acceptInvocation(ctx, { ...base, idempotencyKey: "bad", arguments: args }), ValidationError);
    assert.equal(await db.invocation.count({ where: { runId: run.id } }), 0);
    const receipt = await Promise.all(Array.from({ length: 4 }, () => service.acceptInvocation(ctx, { ...base, idempotencyKey: "same" })));
    assert.equal(new Set(receipt.map(x => x.id)).size, 1);
    const invocation = receipt[0]!; assert.equal(invocation.status, "REQUESTED"); assert.equal(invocation.reason, "RESOURCE_BINDING_UNVERIFIED");
    assert.equal(await db.invocationEvent.count({ where: { runId: run.id } }), 1);
    const rollbackRun = await service.openRun(ctx, version.id);
    await db.$executeRawUnsafe(`CREATE FUNCTION test_reject_event() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected event failure'; END; $$`);
    try {
      await db.$executeRawUnsafe(`CREATE TRIGGER test_reject_event BEFORE INSERT ON "InvocationEvent" FOR EACH ROW EXECUTE FUNCTION test_reject_event()`);
      await assert.rejects(service.acceptInvocation(ctx, { ...base, runId: rollbackRun.id, idempotencyKey: "rollback" }));
      assert.equal(await db.invocation.count({ where: { runId: rollbackRun.id } }), 0);
      assert.equal(await db.invocationEvent.count({ where: { runId: rollbackRun.id } }), 0);
    } finally {
      await db.$executeRawUnsafe('DROP TRIGGER IF EXISTS test_reject_event ON "InvocationEvent"');
      await db.$executeRawUnsafe('DROP FUNCTION IF EXISTS test_reject_event()');
    }
    await assert.rejects(service.acceptInvocation(ctx, { ...base, idempotencyKey: "same", arguments: { path: "different" } }), InvocationConflict);
    const competing = await Promise.allSettled(["different1", "different2"].map(idempotencyKey => service.acceptInvocation(ctx, { ...base, idempotencyKey })));
    assert.ok(competing.every(x => x.status === "rejected"));
    for (const invalid of [undefined, null, ""] as unknown as string[]) {
      await assert.rejects(service.history(ctx, invalid)); await assert.rejects(service.closeRun(ctx, invalid));
      await assert.rejects(service.cancelBlocked(ctx, run.id, invalid));
    }
    assert.equal((await db.invocation.findUniqueOrThrow({ where: { id: invocation.id } })).status, "REQUESTED");
    await assert.rejects(service.closeRun(ctx, run.id), InvocationConflict);
    await assert.rejects(db.invocation.update({ where: { id: invocation.id }, data: { fingerprint: "tampered" } }));
    const cancelled = await service.cancelBlocked(ctx, run.id, invocation.id); assert.equal(cancelled.status, "REVOKED");
    await assert.rejects(service.cancelBlocked(ctx, run.id, invocation.id), InvocationConflict);
    const events = await service.history(ctx, run.id); assert.deepEqual(events.map(e => e.status), ["REQUESTED", "REVOKED"]);
    assert.ok(events[1]!.sequence > events[0]!.sequence);
    assert.equal((await service.history(ctx, run.id, events[0]!.sequence)).length, 1);
    assert.equal(JSON.stringify(events, (_k, v) => typeof v === "bigint" ? String(v) : v).includes("readme"), false);
    await assert.rejects(db.invocationEvent.delete({ where: { sequence: events[0]!.sequence } }));
    await external.revoke(operator, grant.id);
    assert.equal((await service.acceptInvocation(ctx, { ...base, idempotencyKey: "same" })).id, invocation.id);
    const denied = await service.acceptInvocation(ctx, { ...base, idempotencyKey: "revoked" }); assert.equal(denied.status, "DENIED"); assert.equal(denied.grantId, grant.id);
    await service.closeRun(ctx, run.id);
    assert.equal((await service.acceptInvocation(ctx, { ...base, idempotencyKey: "same" })).id, invocation.id);
    await assert.rejects(service.acceptInvocation(ctx, { ...base, idempotencyKey: "new-after-close" }), InvocationConflict);

    // Competing close and admission serialize under the same PostgreSQL row lock.
    const newGrant = await external.grant(operator, { versionId: version.id, toolId: tool.id, deploymentId: dep.id, reviewedProfile: "READ_ONLY", allowedResources: ["resource"] });
    const snapshotRun = await service.openRun(ctx, version.id);
    let reads = 0;
    const changingRequest = { ...base, runId: snapshotRun.id, grantId: newGrant.id, idempotencyKey: "snapshot" };
    Object.defineProperty(changingRequest, "arguments", { enumerable: true, get() { reads++; return { path: reads === 1 ? "original" : "changed" }; } });
    const snapshot = await service.acceptInvocation(ctx, changingRequest);
    assert.equal(reads, 1); assert.deepEqual(snapshot.arguments, { path: "original" });
    const competeRun = await service.openRun(ctx, version.id);
    const compete = await Promise.allSettled(["first", "second"].map(idempotencyKey => service.acceptInvocation(ctx, { ...base, runId: competeRun.id, grantId: newGrant.id, idempotencyKey })));
    assert.equal(compete.filter(result => result.status === "fulfilled").length, 1);
    assert.equal(await db.invocation.count({ where: { runId: competeRun.id } }), 1);
    const raceRun = await service.openRun(ctx, version.id);
    const raceRequest = { ...base, runId: raceRun.id, grantId: newGrant.id, idempotencyKey: "race" };
    const race = await Promise.allSettled([service.closeRun(ctx, raceRun.id), service.acceptInvocation(ctx, raceRequest)]);
    assert.equal(race.filter(r => r.status === "fulfilled").length, 1);
    const raceRow = await db.externalRun.findUniqueOrThrow({ where: { id: raceRun.id } });
    const raceCount = await db.invocation.count({ where: { runId: raceRun.id } });
    assert.ok((raceRow.status === "COMPLETED" && raceCount === 0) || (raceRow.status === "RUNNING" && raceCount === 1));

    // UNKNOWN is fixture-seeded only; no 11.1c transition fabricates it.
    const unknownRun = await service.openRun(ctx, version.id);
    const unknown = await service.acceptInvocation(ctx, { ...base, runId: unknownRun.id, grantId: newGrant.id, idempotencyKey: "unknown" });
    await db.invocation.update({ where: { id: unknown.id }, data: { status: "UNKNOWN", reason: "TEST_FIXTURE" } });
    await db.invocationEvent.create({ data: { runId: unknownRun.id, invocationId: unknown.id, actorPrincipalId: p.id, kind: "TEST_FIXTURE", status: "UNKNOWN", reason: "TEST_FIXTURE" } });
    await assert.rejects(service.closeRun(ctx, unknownRun.id), InvocationConflict);
    await assert.rejects(service.cancelBlocked(ctx, unknownRun.id, unknown.id), InvocationConflict);
    await assert.rejects(service.acceptInvocation(ctx, { ...base, runId: unknownRun.id, grantId: newGrant.id, idempotencyKey: "retry" }), InvocationConflict);
    assert.equal((await service.acceptInvocation(ctx, { ...base, runId: unknownRun.id, grantId: newGrant.id, idempotencyKey: "unknown" })).status, "UNKNOWN");
    assert.deepEqual((await service.history(ctx, unknownRun.id)).map(event => event.status), ["REQUESTED", "UNKNOWN"]);
    await assert.rejects(db.invocation.create({ data: { ...unknown, arguments: { path: "fixture" }, id: `fixture-${randomUUID()}`, idempotencyKey: "bypass", status: "REQUESTED" } }));

    const referenceStore = new PrismaExecutionStore(db);
    await assert.rejects(referenceStore.loadExecution(unknownRun.id), /External runs/);
    await assert.rejects(referenceStore.claimExecution("task", unknownRun.id, "worker", new Date()), /External runs/);
    await assert.rejects(referenceStore.heartbeat(unknownRun.id, "worker", new Date()), /External runs/);
    const legacy = await referenceStore.resolveAgentVersion({ name: "repository-explorer", description: "test", version: 1,
      systemInstructions: "test", modelProvider: "ollama", modelName: "test", maxSteps: 8, toolPolicies: { read_file: "ALLOW" } });
    const pending = await referenceStore.createPendingExecution(legacy.agentId, legacy.agentVersionId, "test", "/tmp");
    await referenceStore.claimExecution(pending.taskId, pending.taskRunId, "test-worker", new Date(0));
    const stale = await referenceStore.findStaleExecutions(new Date(Date.now() + 60000));
    assert.equal(stale.some(item => item.taskRunId === unknownRun.id), false);
    assert.ok(stale.some(item => item.taskRunId === pending.taskRunId));
    const recovered = await recoverStaleRuns({ store: referenceStore, queue: { async enqueue() { return { jobId: "test" }; }, async close() {} }, now: new Date(), leaseTimeoutMs: 1000, maxRecoveries: 1 });
    assert.equal(recovered.requeued, 1);
    assert.equal((await db.externalRun.findUniqueOrThrow({ where: { id: unknownRun.id } })).status, "RUNNING");
  } finally { await db.$disconnect(); }
});
