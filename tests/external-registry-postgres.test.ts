import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { createPrismaClient, PrismaExecutionStore } from "../src/persistence/prisma-execution-store.js";
import { PrismaIdentityStore } from "../src/identity/prisma-identity-store.js";
import { CredentialAuthenticator, IdentityError, TrustedCredentialIssuer, TrustedIdentityAdministration } from "../src/identity/identity.js";
import { AgentRegistry } from "../src/identity/agent-registry.js";
import { ExternalRegistry } from "../src/registry/external-registry.js";
import { RevisionConflict, ValidationError } from "../src/registry/validation.js";

const url = process.env.FOUNDRY_11B_TEST_DATABASE_URL;
test("isolated PostgreSQL: immutable publications, ownership and capability policy", { skip: !url }, async () => {
  const parsed = new URL(url!);
  if (!["127.0.0.1", "localhost", "::1"].includes(parsed.hostname) || !/^\/foundry_11b_test_[a-z0-9]+$/.test(parsed.pathname)) throw new Error("Dedicated local foundry_11b_test_* database required");
  const db = createPrismaClient(url!);
  try {
    const legacy = await new PrismaExecutionStore(db).resolveAgentVersion({ name: "repository-explorer", description: "reference", version: 1,
      systemInstructions: "reference", modelProvider: "ollama", modelName: "qwen", maxSteps: 8, toolPolicies: {} });
    const legacyAgain = await new PrismaExecutionStore(db).resolveAgentVersion({ name: "repository-explorer", description: "reference", version: 1,
      systemInstructions: "reference", modelProvider: "ollama", modelName: "qwen", maxSteps: 8, toolPolicies: {} });
    assert.deepEqual(legacyAgain, legacy);
    const store = new PrismaIdentityStore(db), admin = new TrustedIdentityAdministration(store), issuer = new TrustedCredentialIssuer(store), auth = new CredentialAuthenticator(store);
    const registry = new AgentRegistry(store), external = new ExternalRegistry(db), owner = await admin.createOwner("11b test"), other = await admin.createOwner("11b other");
    const op = await admin.createPrincipal({ ownerId: owner.id, type: "OPERATOR" });
    const scopes = ["agent:register", "version:publish", "manifest:publish", "deployment:manage", "grant:manage"] as const;
    const credential = await issuer.issue({ principalId: op.id, scopes: [...scopes], expiresAt: new Date(Date.now() + 60000) });
    const ctx = await auth.authenticate(credential.secret);
    const a = await registry.register(ctx, { name: `test-${randomUUID()}` });
    const version = await external.publishVersion(ctx, { agentId: a.id, version: 1, config: { b: 2, a: 1 } });
    const same = await external.publishVersion(ctx, { agentId: a.id, version: 1, config: { a: 1, b: 2 } });
    assert.equal(same.id, version.id);
    await assert.rejects(external.publishVersion(ctx, { agentId: a.id, version: 1, config: { a: 2 } }), RevisionConflict);
    const v2 = await external.publishVersion(ctx, { agentId: a.id, version: 2, config: { a: 2 } });
    assert.notEqual(v2.id, version.id);
    const results = await Promise.all(Array.from({ length: 3 }, () => external.publishVersion(ctx, { agentId: a.id, version: 3, config: { a: 3 } })));
    assert.equal(new Set(results.map(item => item.id)).size, 1);
    const schema = { type: "object", properties: { path: { type: "string" } }, required: ["path"], additionalProperties: false };
    const m = { tools: [{ name: "write", revision: 1, description: "write", inputSchema: schema, declaredProfile: "WRITE", handlerId: "files.write" },
      { name: "read", revision: 1, description: "read", inputSchema: schema, declaredProfile: "READ_ONLY", handlerId: "files.read" },
      { name: "delete", revision: 1, description: "delete", inputSchema: schema, declaredProfile: "DESTRUCTIVE", handlerId: "files.delete" },
      { name: "send", revision: 1, description: "send", inputSchema: schema, declaredProfile: "EXTERNAL_WRITE", handlerId: "api.send" }] };
    const published = await external.publishManifest(ctx, { versionId: version.id, revision: 1, manifest: m });
    assert.equal(published.sealed, true); assert.equal(published.tools.length, 4);
    assert.equal((await external.publishManifest(ctx, { versionId: version.id, revision: 1, manifest: m })).id, published.id);
    await assert.rejects(external.publishManifest(ctx, { versionId: version.id, revision: 1, manifest: { tools: [m.tools[0]] } }), RevisionConflict);
    await assert.rejects(external.publishManifest(ctx, { versionId: version.id, revision: 2, manifest: { tools: [{ ...m.tools[0], declaredProfile: "UNKNOWN" }] } }), ValidationError);
    assert.equal(await db.toolManifest.count({ where: { versionId: version.id } }), 1);
    assert.equal(await db.capabilityGrant.count({ where: { ownerId: owner.id } }), 0);
    const concurrent = await Promise.all(Array.from({ length: 3 }, () => external.publishManifest(ctx, { versionId: version.id, revision: 3, manifest: m })));
    assert.equal(new Set(concurrent.map(item => item.id)).size, 1);
    await assert.rejects(db.$transaction(async tx => {
      await tx.toolManifest.create({ data: { ownerId: owner.id, versionId: version.id, revision: 55, digest: "temporary" } });
    }));
    assert.equal(await db.toolManifest.count({ where: { versionId: version.id, revision: 55 } }), 0);
    await assert.rejects(db.$transaction(async tx => {
      await tx.toolManifest.create({ data: { ownerId: owner.id, versionId: version.id, revision: 56, digest: "temporary" } });
      throw new Error("injected publication failure");
    }));
    assert.equal(await db.toolManifest.count({ where: { versionId: version.id, revision: 56 } }), 0);
    await assert.rejects(db.externalAgentVersion.update({ where: { id: version.id }, data: { digest: "tampered" } }));
    await assert.rejects(db.toolManifest.update({ where: { id: published.id }, data: { digest: "tampered" } }));
    await assert.rejects(db.toolRevision.update({ where: { id: published.tools[0]!.id }, data: { handlerId: "tampered" } }));
    await assert.rejects(db.toolRevision.create({ data: { ownerId: owner.id, versionId: version.id, manifestId: published.id, name: "late", revision: 1,
      description: "late", inputSchema: schema, declaredProfile: "READ_ONLY", handlerId: "late", digest: "fake" } }));
    const dep = await external.registerDeployment(ctx, { name: "local", environment: "test" });
    const agent = await admin.createPrincipal({ ownerId: owner.id, type: "AGENT", agentId: a.id });
    const ac = await issuer.issue({ principalId: agent.id, scopes: ["capability:check", "manifest:publish"], expiresAt: new Date(Date.now() + 60000) });
    const agentCtx = await auth.authenticate(ac.secret);
    const agentVersion = await external.publishManifest(agentCtx, { versionId: version.id, revision: 4, manifest: m });
    assert.ok(agentVersion.id);
    const write = published.tools.find(t => t.name === "write")!, read = published.tools.find(t => t.name === "read")!;
    const binding = { versionId: version.id, toolId: write.id, deploymentId: dep.id };
    const request = { ...binding, resource: "workspace:a", environment: "test" };
    assert.deepEqual(await external.decide(agentCtx, request), { decision: "DENY", executionAllowed: false });
    await assert.rejects(external.grant(agentCtx, { ...binding, reviewedProfile: "WRITE", allowedResources: ["workspace:a"] }), IdentityError);
    await assert.rejects(external.grant(ctx, { ...binding, reviewedProfile: "READ_ONLY", allowedResources: ["workspace:a"] }), ValidationError);
    const grant = await external.grant(ctx, { ...binding, reviewedProfile: "WRITE", allowedResources: ["workspace:a"] });
    await assert.rejects(external.grant(ctx, { ...binding, reviewedProfile: "WRITE", allowedResources: ["workspace:b"] }));
    assert.equal((await external.decide(agentCtx, request)).decision, "REQUIRE_APPROVAL");
    assert.equal((await external.decide(agentCtx, { ...request, resource: "workspace:b" })).decision, "DENY");
    assert.equal((await external.decide(agentCtx, { ...request, environment: "prod" })).decision, "DENY");
    await external.revoke(ctx, grant.id);
    assert.equal((await external.decide(agentCtx, request)).decision, "DENY");
    assert.equal((await db.externalAgentVersion.findUniqueOrThrow({ where: { id: version.id } })).digest, version.digest);
    const rgrant = await external.grant(ctx, { ...binding, toolId: read.id, reviewedProfile: "READ_ONLY", allowedResources: ["workspace:a"] });
    assert.deepEqual(await external.decide(agentCtx, { ...request, toolId: read.id }), { decision: "ALLOW", executionAllowed: false });
    for (const profile of ["DESTRUCTIVE", "EXTERNAL_WRITE"] as const) {
      const t = published.tools.find(item => item.declaredProfile === profile)!;
      await external.grant(ctx, { ...binding, toolId: t.id, reviewedProfile: profile, allowedResources: ["workspace:a"] });
      assert.deepEqual(await external.decide(agentCtx, { ...request, toolId: t.id }), { decision: "REQUIRE_APPROVAL", executionAllowed: false });
    }
    for (const field of ["versionId", "toolId", "deploymentId"] as const) {
      assert.equal((await external.decide(agentCtx, { ...request, toolId: read.id, [field]: undefined } as unknown as typeof request)).decision, "DENY");
    }
    assert.ok(rgrant.id);
    const otherOp = await admin.createPrincipal({ ownerId: other.id, type: "OPERATOR" });
    const otherCred = await issuer.issue({ principalId: otherOp.id, scopes: ["grant:manage", "version:publish", "manifest:publish"], expiresAt: new Date(Date.now() + 60000) });
    const otherCtx = await auth.authenticate(otherCred.secret);
    await assert.rejects(external.grant(otherCtx, { ...binding, reviewedProfile: "WRITE", allowedResources: ["workspace:a"] }), IdentityError);
    await assert.rejects(external.publishVersion(otherCtx, { agentId: a.id, version: 4, config: {} }), IdentityError);
    await assert.rejects(external.publishManifest(otherCtx, { versionId: version.id, revision: 4, manifest: m }), IdentityError);
    await assert.rejects(external.revoke(otherCtx, rgrant.id), IdentityError);
    const otherAgent = await db.agent.create({ data: { ownerId: other.id, name: `other-${randomUUID()}`, integration: "EXTERNAL" } });
    const otherVersion = await external.publishVersion(otherCtx, { agentId: otherAgent.id, version: 1, config: {} });
    await assert.rejects(external.publishManifest(agentCtx, { versionId: otherVersion.id, revision: 1, manifest: m }), IdentityError);
    await assert.rejects(db.$executeRaw`UPDATE "CapabilityGrant" SET "allowedResources" = NULL WHERE id = ${rgrant.id}`);
    const executor = await admin.createPrincipal({ ownerId: owner.id, type: "EXECUTOR", deploymentId: dep.id });
    const ec = await issuer.issue({ principalId: executor.id, scopes: ["executor:identify"], expiresAt: new Date(Date.now() + 60000) });
    await assert.rejects(external.grant(await auth.authenticate(ec.secret), { ...binding, reviewedProfile: "WRITE", allowedResources: ["workspace:a"] }), IdentityError);
  } finally { await db.$disconnect(); }
});
