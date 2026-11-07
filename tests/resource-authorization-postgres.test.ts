import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import type { AddressInfo } from "node:net";
import { Client } from "pg";
import test from "node:test";
import { createPrismaClient } from "../src/persistence/prisma-execution-store.js";
import { PrismaIdentityStore } from "../src/identity/prisma-identity-store.js";
import { AgentRegistry } from "../src/identity/agent-registry.js";
import { CredentialAuthenticator, IdentityError, TrustedCredentialIssuer, TrustedIdentityAdministration } from "../src/identity/identity.js";
import { ExternalRegistry } from "../src/registry/external-registry.js";
import { InvocationService, InvocationConflict } from "../src/invocation/invocation-service.js";
import { TrustedResourceBindings } from "../src/authorization/trusted-bindings.js";
import { databaseNow } from "../src/authorization/credential-lock.js";
import { RESOURCE_FREE_RESOURCE, RESOURCE_FREE_SCHEMA } from "../src/authorization/resource-binding.js";
import { ValidationError, canonical, type Effect } from "../src/registry/validation.js";
import { createExternalApiServer } from "../src/external-api/server.js";

const url = process.env.FOUNDRY_112A_TEST_DATABASE_URL;
test("isolated PostgreSQL: resource authorization, immutable evidence and revocation ordering", { skip: !url }, async t => {
  const parsed = new URL(url!);
  if (!["127.0.0.1", "localhost", "::1"].includes(parsed.hostname) || !/^\/foundry_112a_test_[a-z0-9]+$/.test(parsed.pathname)) throw new Error("Dedicated local foundry_112a_test_* database required");
  const db = createPrismaClient(url!);
  const store = new PrismaIdentityStore(db), admin = new TrustedIdentityAdministration(store), issuer = new TrustedCredentialIssuer(store);
  const auth = new CredentialAuthenticator(store), registry = new AgentRegistry(store), external = new ExternalRegistry(db);
  const service = new InvocationService(db), bindings = new TrustedResourceBindings(db);
  const expiry = () => new Date(Date.now() + 600000);
  async function operator() {
    const owner = await admin.createOwner("112a test");
    const principal = await admin.createPrincipal({ ownerId: owner.id, type: "OPERATOR" });
    const token = await issuer.issue({ principalId: principal.id, scopes: ["agent:register", "version:publish", "manifest:publish", "deployment:manage", "grant:manage"], expiresAt: expiry() });
    return { owner, context: await auth.authenticate(token.secret) };
  }
  const op = await operator();
  async function fixture(options: { bind?: boolean; schema?: unknown; profile?: Effect; reviewed?: Effect; resources?: string[]; operator?: typeof op } = {}) {
    const operator = options.operator ?? op;
    const agent = await registry.register(operator.context, { name: `auth-${randomUUID()}` });
    const version = await external.publishVersion(operator.context, { agentId: agent.id, version: 1, config: { test: "resource authorization" } });
    const manifest = await external.publishManifest(operator.context, { versionId: version.id, revision: 1, manifest: { tools: [{ name: "tool", revision: 1, description: "test", inputSchema: options.schema ?? RESOURCE_FREE_SCHEMA, declaredProfile: options.profile ?? "READ_ONLY", handlerId: "trusted-no-resource-handler" }] } });
    const tool = manifest.tools[0]!, dep = await external.registerDeployment(operator.context, { name: `test-${randomUUID()}`, environment: "isolated" });
    const grant = await external.grant(operator.context, { versionId: version.id, toolId: tool.id, deploymentId: dep.id, reviewedProfile: options.reviewed ?? options.profile ?? "READ_ONLY", allowedResources: options.resources ?? [RESOURCE_FREE_RESOURCE] });
    const bindingInput = { toolId: tool.id, deploymentId: dep.id, revision: 1, artifactDigest: "a".repeat(64), expiresAt: expiry() };
    const binding = options.bind === false ? null : await bindings.approveResourceFree(operator.context, bindingInput);
    const principal = await admin.createPrincipal({ ownerId: operator.owner.id, type: "AGENT", agentId: agent.id });
    const token = await issuer.issue({ principalId: principal.id, scopes: ["run:manage", "invocation:request"], expiresAt: expiry() });
    const context = await auth.authenticate(token.secret), run = await service.openRun(context, version.id);
    const request = { runId: run.id, toolId: tool.id, deploymentId: dep.id, grantId: grant.id, idempotencyKey: "request", arguments: {} };
    return { operator, agent, version, tool, dep, grant, binding, bindingInput, principal, token, context, run, request };
  }
  async function saved(id: string) { return db.invocationAuthorization.findUniqueOrThrow({ where: { invocationId: id } }); }
  async function waitForLock(application: string) {
    for (let n = 0; n < 250; n++) {
      const rows = await db.$queryRaw<Array<{ waiting: boolean }>>`SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE application_name = ${application} AND wait_event_type = 'Lock') AS waiting`;
      if (rows[0]!.waiting) return;
      await delay(20);
    }
    throw new Error("Expected database lock wait was not observed");
  }
  function tagged(application: string) {
    const connection = new URL(url!); connection.searchParams.set("application_name", application);
    return createPrismaClient(connection.toString());
  }
  try {
    await t.test("authorization time is UTC regardless of the database session timezone", async () => {
      await db.$transaction(async tx => {
        await tx.$executeRawUnsafe("SET LOCAL TIME ZONE 'Pacific/Auckland'");
        assert.ok(Math.abs((await databaseNow(tx)).getTime() - Date.now()) < 2000);
      });
    });
    await t.test("trusted READ_ONLY becomes READY with exact durable evidence, never start authorization", async () => {
      const f = await fixture(), inv = await service.acceptInvocation(f.context, f.request), evidence = await saved(inv.id);
      assert.equal(inv.status, "READY"); assert.equal(inv.reason, "RESOURCE_AUTHORIZED");
      assert.equal(evidence.bindingId, f.binding!.id); assert.equal(evidence.credentialId, f.token.credentialId);
      assert.equal(canonical(evidence.snapshot).digest, evidence.digest);
      const event = (await service.history(f.context, f.run.id))[0]!;
      assert.equal((event.authorization as any).authorizationDigest, evidence.digest);
      assert.equal((event.authorization as any).requestFingerprint, inv.fingerprint);
      assert.equal((event.authorization as any).policyRevision, f.grant.id);
      const check = await service.inspectStartEligibility(f.context, inv.id, evidence.digest);
      assert.equal(check.eligible, true); assert.equal(check.startAllowed, false);
      assert.equal((await service.getInvocation(f.context, inv.id)).status, "READY");
      assert.equal(await db.invocationEvent.count({ where: { invocationId: inv.id } }), 1);
    });
    await t.test("missing bindings and filesystem targets remain blocked; grants alone never authorize", async () => {
      const f = await fixture({ bind: false });
      const blocked = await service.acceptInvocation(f.context, f.request);
      assert.equal(blocked.reason, "RESOURCE_BINDING_UNVERIFIED");
      await bindings.approveResourceFree(op.context, f.bindingInput);
      assert.equal((await service.acceptInvocation(f.context, f.request)).status, "REQUESTED");
      assert.equal(await db.invocationAuthorization.count({ where: { invocationId: blocked.id } }), 0);
      await service.cancelBlocked(f.context, f.run.id, blocked.id);
      const noGrant = { ...f.request, idempotencyKey: "no-grant", grantId: undefined };
      assert.equal((await service.acceptInvocation(f.context, noGrant)).status, "DENIED");
      const path = await fixture({ bind: false, schema: { type: "object", properties: { path: { type: "string" } }, required: ["path"], additionalProperties: false } });
      await assert.rejects(bindings.approveResourceFree(op.context, path.bindingInput), ValidationError);
      const inv = await service.acceptInvocation(path.context, { ...path.request, arguments: { path: "README.md" } });
      assert.equal(inv.status, "REQUESTED"); assert.equal(inv.reason, "RESOURCE_BINDING_UNVERIFIED");
    });
    await t.test("resource spoofing and encoded/schema arguments cannot reach eligibility", async () => {
      const f = await fixture();
      for (const arguments_ of [{ resourceId: RESOURCE_FREE_RESOURCE }, { allowedResources: [RESOURCE_FREE_RESOURCE] }, { path: "%2e%2e%2f" }, { risk: "READ_ONLY" }, "{}", []])
        await assert.rejects(service.acceptInvocation(f.context, { ...f.request, arguments: arguments_ }), ValidationError);
      assert.equal(await db.invocation.count({ where: { runId: f.run.id } }), 0);
    });
    await t.test("operator attestation is exact, scoped, immutable and cannot be self-approved", async () => {
      const f = await fixture({ bind: false });
      await assert.rejects(bindings.approveResourceFree(f.context, f.bindingInput), IdentityError);
      await assert.rejects(bindings.approveResourceFree(op.context, { ...f.bindingInput, artifactDigest: "not-a-digest" }), ValidationError);
      await assert.rejects(bindings.approveResourceFree(op.context, { ...f.bindingInput, expiresAt: new Date(0) }), ValidationError);
      const binding = await bindings.approveResourceFree(op.context, f.bindingInput);
      await assert.rejects(db.trustedResourceBinding.update({ where: { id: binding.id }, data: { artifactDigest: "b".repeat(64) } }));
      await assert.rejects(db.capabilityGrant.update({ where: { id: f.grant.id }, data: { allowedResources: ["*"] } }));
      await bindings.revoke(op.context, binding.id);
      await assert.rejects(db.trustedResourceBinding.update({ where: { id: binding.id }, data: { revokedAt: null } }));
    });
    await t.test("grant resource mismatch is DENIED even with a trusted binding", async () => {
      const f = await fixture({ resources: ["another-resource"] });
      const inv = await service.acceptInvocation(f.context, f.request);
      assert.equal(inv.status, "DENIED"); assert.equal(inv.reason, "RESOURCE_NOT_GRANTED");
      assert.equal(await db.invocationAuthorization.count({ where: { invocationId: inv.id } }), 0);
    });
    await t.test("binding cannot transfer to another deployment or tool revision", async () => {
      const f = await fixture();
      const dep = await external.registerDeployment(op.context, { name: `other-${randomUUID()}`, environment: "isolated" });
      const grant = await external.grant(op.context, { versionId: f.version.id, toolId: f.tool.id, deploymentId: dep.id, reviewedProfile: "READ_ONLY", allowedResources: [RESOURCE_FREE_RESOURCE] });
      const wrongDep = await service.acceptInvocation(f.context, { ...f.request, deploymentId: dep.id, grantId: grant.id });
      assert.equal(wrongDep.reason, "RESOURCE_BINDING_UNVERIFIED");
      await service.cancelBlocked(f.context, f.run.id, wrongDep.id);
      const manifest = await external.publishManifest(op.context, { versionId: f.version.id, revision: 2, manifest: { tools: [{ name: "tool", revision: 2, description: "new revision", inputSchema: RESOURCE_FREE_SCHEMA, declaredProfile: "READ_ONLY", handlerId: "trusted-no-resource-handler" }] } });
      const tool = manifest.tools[0]!;
      const nextGrant = await external.grant(op.context, { versionId: f.version.id, toolId: tool.id, deploymentId: f.dep.id, reviewedProfile: "READ_ONLY", allowedResources: [RESOURCE_FREE_RESOURCE] });
      assert.equal((await service.acceptInvocation(f.context, { ...f.request, idempotencyKey: "new-revision", toolId: tool.id, grantId: nextGrant.id })).reason, "RESOURCE_BINDING_UNVERIFIED");
    });
    await t.test("cross-owner and wrong-agent operations are rejected", async () => {
      const f = await fixture(), sibling = await fixture(), other = await fixture({ operator: await operator() });
      await assert.rejects(service.acceptInvocation(sibling.context, f.request), IdentityError);
      await assert.rejects(service.acceptInvocation(other.context, f.request), IdentityError);
      await assert.rejects(bindings.approveResourceFree(other.operator.context, { ...f.bindingInput, revision: 2 }), IdentityError);
      const inv = await service.acceptInvocation(f.context, f.request), evidence = await saved(inv.id);
      await assert.rejects(service.inspectStartEligibility(sibling.context, inv.id, evidence.digest), IdentityError);
      await assert.rejects(service.inspectStartEligibility(other.context, inv.id, evidence.digest), IdentityError);
    });
    await t.test("revocation blocks new eligibility and never upgrades an idempotent receipt", async () => {
      const f = await fixture(), inv = await service.acceptInvocation(f.context, f.request), evidence = await saved(inv.id);
      await external.revoke(op.context, f.grant.id);
      assert.equal((await service.inspectStartEligibility(f.context, inv.id, evidence.digest)).eligible, false);
      assert.equal((await service.acceptInvocation(f.context, f.request)).id, inv.id);
      const run = await service.openRun(f.context, f.version.id);
      assert.equal((await service.acceptInvocation(f.context, { ...f.request, runId: run.id })).status, "DENIED");
      await assert.rejects(db.capabilityGrant.update({ where: { id: f.grant.id }, data: { revokedAt: null } }));
    });
    await t.test("replacement binding revisions cannot silently refresh pinned authorization", async () => {
      const f = await fixture(), inv = await service.acceptInvocation(f.context, f.request), evidence = await saved(inv.id);
      await bindings.revoke(op.context, f.binding!.id);
      assert.equal((await service.inspectStartEligibility(f.context, inv.id, evidence.digest)).eligible, false);
      await bindings.approveResourceFree(op.context, { ...f.bindingInput, revision: 2 });
      assert.equal((await service.inspectStartEligibility(f.context, inv.id, evidence.digest)).reason, "AUTHORIZATION_MISMATCH");
      assert.equal((await service.acceptInvocation(f.context, f.request)).id, inv.id);
    });
    await t.test("revoked or expired request credentials cannot authorize", async () => {
      for (const revoke of [true, false]) {
        const f = await fixture(), inv = await service.acceptInvocation(f.context, f.request), evidence = await saved(inv.id);
        if (revoke) await admin.revokeCredential(f.token.credentialId);
        else await db.credential.update({ where: { id: f.token.credentialId }, data: { expiresAt: new Date(0) } });
        await assert.rejects(service.inspectStartEligibility(f.context, inv.id, evidence.digest), IdentityError);
        await assert.rejects(service.acceptInvocation(f.context, f.request), IdentityError);
      }
    });
    await t.test("binding expiry blocks inspection and new admissions", async () => {
      const f = await fixture({ bind: false });
      const expiresAt = new Date(Date.now() + 1500);
      await bindings.approveResourceFree(op.context, { ...f.bindingInput, expiresAt });
      const inv = await service.acceptInvocation(f.context, f.request), evidence = await saved(inv.id);
      await delay(Math.max(0, expiresAt.getTime() - Date.now()) + 30);
      assert.equal((await service.inspectStartEligibility(f.context, inv.id, evidence.digest)).eligible, false);
      const run = await service.openRun(f.context, f.version.id);
      assert.equal((await service.acceptInvocation(f.context, { ...f.request, runId: run.id })).reason, "RESOURCE_BINDING_UNVERIFIED");
    });
    await t.test("all sensitive profiles stay approval-gated and cannot be self-promoted", async () => {
      for (const reviewed of ["WRITE", "DESTRUCTIVE", "EXTERNAL_WRITE"] as const) {
        const f = await fixture({ reviewed }), inv = await service.acceptInvocation(f.context, f.request), evidence = await saved(inv.id);
        assert.equal(inv.status, "PENDING_APPROVAL"); assert.equal(inv.reason, "APPROVAL_REQUIRED");
        assert.equal((await service.inspectStartEligibility(f.context, inv.id, evidence.digest)).eligible, false);
        const sensitive = await fixture({ bind: false, profile: reviewed });
        await assert.rejects(bindings.approveResourceFree(op.context, sensitive.bindingInput), ValidationError);
        const blocked = await service.acceptInvocation(sensitive.context, sensitive.request);
        assert.equal(blocked.status, "REQUESTED");
        assert.equal(((await service.history(sensitive.context, sensitive.run.id))[0]!.authorization as any).executionPolicy, "REQUIRE_APPROVAL");
      }
    });
    await t.test("idempotency, UNKNOWN, single-active and invalid-transition fences remain", async () => {
      const f = await fixture();
      const same = await Promise.all(Array.from({ length: 4 }, () => service.acceptInvocation(f.context, f.request)));
      assert.equal(new Set(same.map(inv => inv.id)).size, 1);
      const inv = same[0]!, evidence = await saved(inv.id);
      assert.equal(await db.invocationAuthorization.count({ where: { invocationId: inv.id } }), 1);
      await assert.rejects(service.acceptInvocation(f.context, { ...f.request, idempotencyKey: "another" }), InvocationConflict);
      await assert.rejects(service.acceptInvocation(f.context, { ...f.request, grantId: undefined }), InvocationConflict);
      await assert.rejects(service.cancelBlocked(f.context, f.run.id, inv.id), InvocationConflict);
      await assert.rejects(service.closeRun(f.context, f.run.id), InvocationConflict);
      assert.equal((await service.inspectStartEligibility(f.context, inv.id, "different-digest")).eligible, false);
      await assert.rejects(db.invocationAuthorization.update({ where: { invocationId: inv.id }, data: { digest: "changed" } }));
      await db.invocation.update({ where: { id: inv.id }, data: { status: "UNKNOWN", reason: "TEST_FIXTURE" } });
      assert.equal((await service.inspectStartEligibility(f.context, inv.id, evidence.digest)).eligible, false);
      await assert.rejects(service.acceptInvocation(f.context, { ...f.request, idempotencyKey: "retry" }), InvocationConflict);
    });
    await t.test("Invocation, authorization evidence and event roll back together", async () => {
      const f = await fixture();
      await db.$executeRawUnsafe(`CREATE FUNCTION reject_auth_event() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected event failure'; END; $$`);
      await db.$executeRawUnsafe(`CREATE TRIGGER reject_auth_event BEFORE INSERT ON "InvocationEvent" FOR EACH ROW EXECUTE FUNCTION reject_auth_event()`);
      try {
        await assert.rejects(service.acceptInvocation(f.context, f.request));
        assert.equal(await db.invocation.count({ where: { runId: f.run.id } }), 0);
        assert.equal(await db.invocationAuthorization.count({ where: { runId: f.run.id } }), 0);
        assert.equal(await db.invocationEvent.count({ where: { runId: f.run.id } }), 0);
      } finally {
        await db.$executeRawUnsafe('DROP TRIGGER reject_auth_event ON "InvocationEvent"');
        await db.$executeRawUnsafe('DROP FUNCTION reject_auth_event()');
      }
    });
    await t.test("HTTP DTOs preserve safety; no public state setter or start exists", async () => {
      const f = await fixture(), server = createExternalApiServer({ auth, invocations: service });
      await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
      const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1/external`;
      const headers = { authorization: `Bearer ${f.token.secret}`, "content-type": "application/json" };
      const body = { idempotencyKey: "http", toolId: f.tool.id, deploymentId: f.dep.id, grantId: f.grant.id, arguments: {} };
      try {
        const response = await fetch(`${base}/runs/${f.run.id}/invocations`, { method: "POST", headers, body: JSON.stringify(body) });
        assert.equal(response.status, 200); const result = await response.json() as any;
        assert.equal(result.invocation.status, "READY"); assert.equal(result.invocation.executionAllowed, false);
        assert.doesNotMatch(JSON.stringify(result), /snapshot|credentialId|fingerprint|arguments|artifactDigest|ownerId/);
        for (const extra of [{ status: "READY" }, { resourceId: RESOURCE_FREE_RESOURCE }, { bindingId: f.binding!.id }]) {
          const spoof = await fetch(`${base}/runs/${f.run.id}/invocations`, { method: "POST", headers, body: JSON.stringify({ ...body, ...extra }) });
          assert.equal(spoof.status, 400);
        }
        const start = await fetch(`${base}/invocations/${result.invocation.id}/start`, { method: "POST", headers, body: "{}" });
        assert.equal(start.status, 404);
        const history = await fetch(`${base}/runs/${f.run.id}/history`, { headers });
        assert.doesNotMatch(JSON.stringify(await history.json()), /requestFingerprint|credentialId|artifactDigest|snapshot/);
      } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
    });
    await t.test("grant revocation committed first blocks concurrent admission", async () => {
      const f = await fixture(), holder = new Client({ connectionString: url! });
      const competing = tagged("112a-admission-after-revoke"), otherService = new InvocationService(competing);
      await holder.connect(); let pending: Promise<unknown> | undefined;
      try {
        await holder.query('BEGIN');
        await holder.query('UPDATE "CapabilityGrant" SET "revokedAt"=clock_timestamp() WHERE id=$1', [f.grant.id]);
        const result = otherService.acceptInvocation(f.context, f.request); pending = result;
        await waitForLock("112a-admission-after-revoke");
        await holder.query('COMMIT');
        assert.equal((await result).status, "DENIED");
      } finally { await holder.query('ROLLBACK'); await Promise.allSettled(pending ? [pending] : []); await holder.end(); await competing.$disconnect(); }
    });
    await t.test("admission committed first can be READY but revocation invalidates the guard", async () => {
      const f = await fixture(), holder = new Client({ connectionString: url! });
      const admissionDb = tagged("112a-admission-first"), revokeDb = tagged("112a-revoke-second");
      await holder.connect(); const pending: Promise<unknown>[] = [];
      try {
        await holder.query('BEGIN');
        await holder.query('SELECT id FROM "TrustedResourceBinding" WHERE id=$1 FOR UPDATE', [f.binding!.id]);
        const admission = new InvocationService(admissionDb).acceptInvocation(f.context, f.request); pending.push(admission);
        await waitForLock("112a-admission-first");
        const revocation = new ExternalRegistry(revokeDb).revoke(op.context, f.grant.id); pending.push(revocation);
        await waitForLock("112a-revoke-second");
        await holder.query('COMMIT');
        const inv = await admission; await revocation;
        assert.equal(inv.status, "READY");
        assert.equal((await service.inspectStartEligibility(f.context, inv.id, (await saved(inv.id)).digest)).eligible, false);
      } finally { await holder.query('ROLLBACK'); await Promise.allSettled(pending); await holder.end(); await admissionDb.$disconnect(); await revokeDb.$disconnect(); }
    });
    await t.test("binding revocation committed first blocks concurrent admission", async () => {
      const f = await fixture(), holder = new Client({ connectionString: url! });
      const competing = tagged("112a-binding-revocation"), otherService = new InvocationService(competing);
      await holder.connect(); let pending: Promise<unknown> | undefined;
      try {
        await holder.query('BEGIN');
        await holder.query('UPDATE "TrustedResourceBinding" SET "revokedAt"=clock_timestamp() WHERE id=$1', [f.binding!.id]);
        const result = otherService.acceptInvocation(f.context, f.request); pending = result;
        await waitForLock("112a-binding-revocation");
        await holder.query('COMMIT');
        assert.equal((await result).reason, "RESOURCE_BINDING_UNVERIFIED");
      } finally { await holder.query('ROLLBACK'); await Promise.allSettled(pending ? [pending] : []); await holder.end(); await competing.$disconnect(); }
    });
  } finally { await db.$disconnect(); }
});
