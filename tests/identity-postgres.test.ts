import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import test from "node:test";
import { Client } from "pg";
import { createPrismaClient, PrismaExecutionStore } from "../src/persistence/prisma-execution-store.js";
import { PrismaIdentityStore } from "../src/identity/prisma-identity-store.js";
import { AgentRegistry } from "../src/identity/agent-registry.js";
import { CredentialAuthenticator, IdentityError, TrustedCredentialIssuer, TrustedIdentityAdministration } from "../src/identity/identity.js";

const databaseUrl = process.env.FOUNDRY_TEST_DATABASE_URL;
test("isolated PostgreSQL migration preserves legacy history and enforces identity ownership", { skip: !databaseUrl }, async () => {
  const url = new URL(databaseUrl!);
  if (!["127.0.0.1", "localhost", "::1"].includes(url.hostname) || !/^\/foundry_11a_test_[a-z0-9]+$/.test(url.pathname)) {
    throw new Error("FOUNDRY_TEST_DATABASE_URL must point to a dedicated local foundry_11a_test_* database");
  }
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    const existing = await client.query("SELECT count(*)::int AS n FROM pg_tables WHERE schemaname = 'public'");
    assert.equal(existing.rows[0].n, 0, "Test database must be empty; it is never reset by this test");
    const migrations = (await readdir("prisma/migrations", { withFileTypes: true })).filter(entry => entry.isDirectory()).map(entry => entry.name).sort();
    for (const name of migrations.filter(name => name < "20261105000000_identity_foundation")) {
      await client.query(await readFile(`prisma/migrations/${name}/migration.sql`, "utf8"));
    }
    await client.query(`INSERT INTO "Agent" ("id","name","updatedAt") VALUES ('legacy-agent','repository-explorer',now());
      INSERT INTO "AgentVersion" ("id","agentId","version","systemInstructions","modelProvider","modelName","maxSteps","toolPolicies") VALUES ('legacy-version','legacy-agent',1,'system','ollama','qwen',8,'{}');
      INSERT INTO "Task" ("id","agentId","prompt","workspaceRoot","updatedAt") VALUES ('legacy-task','legacy-agent','hi','/tmp',now());
      INSERT INTO "TaskRun" ("id","taskId","agentVersionId") VALUES ('legacy-run','legacy-task','legacy-version');
      INSERT INTO "Step" ("id","taskRunId","sequence","kind","payload") VALUES ('legacy-step','legacy-run',1,'FINAL_ANSWER','{}');`);
    await client.query(await readFile("prisma/migrations/20261105000000_identity_foundation/migration.sql", "utf8"));
    const legacy = await client.query(`SELECT a.id,a."ownerId",a.integration,v.id AS version,r.id AS run,s.id AS step
      FROM "Agent" a JOIN "AgentVersion" v ON v."agentId"=a.id JOIN "TaskRun" r ON r."agentVersionId"=v.id JOIN "Step" s ON s."taskRunId"=r.id WHERE a.id='legacy-agent'`);
    assert.deepEqual(legacy.rows[0], { id: "legacy-agent", ownerId: "foundry-local-owner", integration: "REFERENCE", version: "legacy-version", run: "legacy-run", step: "legacy-step" });
    const prisma = createPrismaClient(databaseUrl!);
    try {
      const existingReference = await new PrismaExecutionStore(prisma).resolveAgentVersion({ name: "repository-explorer", description: "legacy", version: 1,
        systemInstructions: "system", modelProvider: "ollama", modelName: "qwen", maxSteps: 8, toolPolicies: {} });
      assert.deepEqual(existingReference, { agentId: "legacy-agent", agentVersionId: "legacy-version" });
      const store = new PrismaIdentityStore(prisma);
      const admin = new TrustedIdentityAdministration(store);
      const owner = await admin.createOwner("test-owner");
      const other = await admin.createOwner("other-owner");
      const operator = await admin.createPrincipal({ ownerId: owner.id, type: "OPERATOR" });
      const issued = await new TrustedCredentialIssuer(store).issue({ principalId: operator.id, scopes: ["agent:register", "agent:read"], expiresAt: new Date(Date.now() + 60000) });
      const context = await new CredentialAuthenticator(store).authenticate(issued.secret);
      const registry = new AgentRegistry(store);
      const agent = await registry.register(context, { name: "unique-external" });
      assert.equal(agent.ownerId, owner.id);
      assert.equal(agent.integration, "EXTERNAL");
      assert.equal(await prisma.agentVersion.count({ where: { agentId: agent.id } }), 0);
      await assert.rejects(admin.createPrincipal({ ownerId: other.id, type: "AGENT", agentId: agent.id }), IdentityError);
      await assert.rejects(client.query(`INSERT INTO "Principal" (id,"ownerId",type,"agentId") VALUES ('bad',$1,'AGENT',$2)`, [other.id, agent.id]));
      await assert.rejects(client.query(`INSERT INTO "Principal" (id,"ownerId",type,"agentId") VALUES ('bad2',$1,'OPERATOR',$2)`, [owner.id, agent.id]));
      await assert.rejects(prisma.agent.create({ data: { name: agent.name, ownerId: other.id, integration: "EXTERNAL" } }));
      const row = await prisma.credential.findUniqueOrThrow({ where: { id: issued.credentialId } });
      assert.equal(JSON.stringify(row).includes(issued.secret), false);
      await admin.revokeCredential(issued.credentialId);
      await assert.rejects(registry.findByName(context, agent.name), IdentityError);
    } finally { await prisma.$disconnect(); }
  } finally { await client.end(); }
});
