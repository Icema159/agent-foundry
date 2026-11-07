import assert from "node:assert/strict";
import test from "node:test";
import { AgentRegistry, type AgentRegistryStore, type RegistryAgent } from "../src/identity/agent-registry.js";
import { CredentialAuthenticator, IdentityError, TrustedCredentialIssuer, TrustedIdentityAdministration,
  requireOwner, requireScope, type IdentityStore, type Principal, type Scope, type StoredCredential } from "../src/identity/identity.js";

class MemoryStore implements IdentityStore, AgentRegistryStore {
  principals = new Map<string, Principal>();
  credentials = new Map<string, StoredCredential>();
  agents: RegistryAgent[] = [];
  counter = 0;
  async findCredential(hash: string) { return [...this.credentials.values()].find(c => c.verifier === hash) ?? null; }
  async findCredentialById(id: string) { return this.credentials.get(id) ?? null; }
  async findPrincipal(id: string) { return this.principals.get(id) ?? null; }
  async findExternalAgent(ownerId: string, id: string) { return this.agents.some(a => a.id === id && a.ownerId === ownerId && a.integration === "EXTERNAL"); }
  async createOwner() { return { id: `owner-${++this.counter}` }; }
  async createPrincipal(p: Omit<Principal, "id">) { const principal = { ...p, id: `p-${++this.counter}` }; this.principals.set(principal.id, principal); return principal; }
  async createCredential(c: { principalId: string; verifier: string; scopes: Scope[]; expiresAt: Date }) {
    const id = `c-${++this.counter}`; this.credentials.set(id, { ...c, id, principal: this.principals.get(c.principalId)!, revokedAt: null }); return { id };
  }
  async revokeCredential(id: string, at: Date) { this.credentials.get(id)!.revokedAt = at; }
  async createExternalAgent(ownerId: string, name: string, description: string | null) {
    if (this.agents.some(a => a.name === name)) throw new Error("Global name already exists");
    const agent: RegistryAgent = { id: `a-${++this.counter}`, ownerId, name, description, integration: "EXTERNAL" };
    this.agents.push(agent); return agent;
  }
  async findAgent(ownerId: string, name: string) { return this.agents.find(a => a.ownerId === ownerId && a.name === name) ?? null; }
}

async function setup() {
  const store = new MemoryStore();
  const admin = new TrustedIdentityAdministration(store);
  const issuer = new TrustedCredentialIssuer(store);
  const auth = new CredentialAuthenticator(store);
  const registry = new AgentRegistry(store);
  const owner = await admin.createOwner("one");
  const other = await admin.createOwner("two");
  const operator = await admin.createPrincipal({ ownerId: owner.id, type: "OPERATOR" });
  const token = await issuer.issue({ principalId: operator.id, scopes: ["agent:register", "agent:read"], expiresAt: new Date(Date.now() + 60000) });
  const context = await auth.authenticate(token.secret);
  return { store, admin, issuer, auth, registry, owner, other, operator, token, context };
}

test("secure credential issuance, verification, expiry and revocation", async () => {
  const f = await setup();
  const stored = f.store.credentials.get(f.token.credentialId)!;
  assert.notEqual(stored.verifier, f.token.secret);
  assert.equal(JSON.stringify(stored).includes(f.token.secret), false);
  assert.equal(f.context.ownerId, f.owner.id);
  assert.equal(f.context.principalId, f.operator.id);
  assert.deepEqual(f.context.scopes, ["agent:register", "agent:read"]);
  for (const bad of [undefined, "", "not-a-token", `af_${"a".repeat(43)}`]) await assert.rejects(f.auth.authenticate(bad), IdentityError);
  await assert.rejects(f.auth.authenticate(f.token.secret, new Date(Date.now() + 120000)), IdentityError);
  assert.throws(() => requireScope(f.context, "executor:identify"), IdentityError);
  await f.admin.revokeCredential(f.token.credentialId);
  await assert.rejects(f.auth.authenticate(f.token.secret), IdentityError);
  await assert.rejects(f.registry.findByName(f.context, "anything"), IdentityError);
});

test("role allowlists and resource bindings fail closed", async () => {
  const f = await setup();
  const agent = await f.registry.register(f.context, { name: "reader" });
  await assert.rejects(f.admin.createPrincipal({ ownerId: f.other.id, type: "AGENT", agentId: agent.id }), IdentityError);
  const agentPrincipal = await f.admin.createPrincipal({ ownerId: f.owner.id, type: "AGENT", agentId: agent.id });
  const executor = await f.admin.createPrincipal({ ownerId: f.owner.id, type: "EXECUTOR", deploymentId: "local-deployment" });
  await assert.rejects(f.admin.createPrincipal({ ownerId: f.owner.id, type: "EXECUTOR", deploymentId: " " }), IdentityError);
  await assert.rejects(f.issuer.issue({ principalId: agentPrincipal.id, scopes: ["agent:register"], expiresAt: new Date(Date.now() + 60000) }), IdentityError);
  await assert.rejects(f.issuer.issue({ principalId: executor.id, scopes: ["agent:read"], expiresAt: new Date(Date.now() + 60000) }), IdentityError);
  const token = await f.issuer.issue({ principalId: agentPrincipal.id, scopes: ["agent:read"], expiresAt: new Date(Date.now() + 60000) });
  const context = await f.auth.authenticate(token.secret);
  assert.equal(context.agentId, agent.id);
  await assert.rejects(f.registry.register(context, { name: "unauthorized" }), IdentityError);
  const exToken = await f.issuer.issue({ principalId: executor.id, scopes: ["executor:identify"], expiresAt: new Date(Date.now() + 60000) });
  assert.equal((await f.auth.authenticate(exToken.secret)).deploymentId, "local-deployment");
  f.store.credentials.get(token.credentialId)!.scopes = ["agent:register"];
  await assert.rejects(f.auth.authenticate(token.secret), IdentityError);
});

test("owner and agent binding are derived from authentication, not input", async () => {
  const f = await setup();
  const agent = await f.registry.register(f.context, { name: "external", ownerId: f.other.id } as { name: string });
  assert.equal(agent.ownerId, f.owner.id);
  assert.equal(agent.integration, "EXTERNAL");
  const otherOperator = await f.admin.createPrincipal({ ownerId: f.other.id, type: "OPERATOR" });
  const otherToken = await f.issuer.issue({ principalId: otherOperator.id, scopes: ["agent:register", "agent:read"], expiresAt: new Date(Date.now() + 60000) });
  const otherContext = await f.auth.authenticate(otherToken.secret);
  assert.equal(await f.registry.findByName(otherContext, "external"), null);
  assert.throws(() => requireOwner(otherContext, f.owner.id), IdentityError);
  await assert.rejects(f.registry.register(otherContext, { name: "external" }), /Global name/);
  await assert.rejects(f.registry.register(otherContext, { name: "repository-explorer" }), IdentityError);
  const principal = await f.admin.createPrincipal({ ownerId: f.owner.id, type: "AGENT", agentId: agent.id });
  const issued = await f.issuer.issue({ principalId: principal.id, scopes: ["agent:read"], expiresAt: new Date(Date.now() + 60000) });
  const agentContext = await f.auth.authenticate(issued.secret);
  await f.registry.register(f.context, { name: "second" });
  assert.equal((await f.registry.findByName(agentContext, "external"))?.id, agent.id);
  assert.equal(await f.registry.findByName(agentContext, "second"), null);
  await assert.rejects(f.registry.register({ ...f.context, ownerId: f.other.id }, { name: "forged" }), IdentityError);
});
