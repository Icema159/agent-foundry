import { randomUUID } from "node:crypto";
import { createPrismaClient } from "../src/persistence/prisma-execution-store.js";
import { PrismaIdentityStore } from "../src/identity/prisma-identity-store.js";
import { CredentialAuthenticator, TrustedCredentialIssuer, TrustedIdentityAdministration } from "../src/identity/identity.js";
import { AgentRegistry } from "../src/identity/agent-registry.js";
import { ExternalRegistry } from "../src/registry/external-registry.js";
import { TrustedResourceBindings } from "../src/authorization/trusted-bindings.js";
import { RESOURCE_FREE_RESOURCE, RESOURCE_FREE_SCHEMA } from "../src/authorization/resource-binding.js";
import { InvocationService } from "../src/invocation/invocation-service.js";
import { ExecutorProtocol } from "../src/executor/executor-protocol.js";
import { ExecutorExecution } from "../src/executor/execution-service.js";
import { WRITE_HANDLER, WRITE_PROFILE } from "../src/executor/demo-receipt-contract.js";
import { ExternalApprovals } from "../src/external-approvals/external-approvals.js";
import { EXECUTION_PROFILE } from "../src/executor/execution-contract.js";

/** Trusted test bootstrap; used only with dedicated test databases. */
export async function startFixture(url: string, artifactDigest = "b".repeat(64), options: { reviewed?: "READ_ONLY" | "WRITE" | "DESTRUCTIVE" | "EXTERNAL_WRITE"; handlerId?: string; execution?: boolean; write?:boolean; approvalTtlMs?:number } = {}) {
  const db = createPrismaClient(url), store = new PrismaIdentityStore(db);
  const admin = new TrustedIdentityAdministration(store), issuer = new TrustedCredentialIssuer(store), auth = new CredentialAuthenticator(store);
  const registry = new AgentRegistry(store), external = new ExternalRegistry(db), bindings = new TrustedResourceBindings(db);
  const invocations = new InvocationService(db,options.approvalTtlMs??900000), protocol = new ExecutorProtocol(db, { leaseMs: 5000 }), execution = new ExecutorExecution(db, protocol, true);
  const expiresAt = new Date(Date.now() + 600000);
  const owner = await admin.createOwner("112c isolated");
  const operator = await admin.createPrincipal({ ownerId: owner.id, type: "OPERATOR" });
  const operatorToken = await issuer.issue({ principalId: operator.id, scopes: ["agent:register","version:publish","manifest:publish","deployment:manage","grant:manage","operator:reconcile",...(options.write?["operator:approve"as const]:[])], expiresAt });
  const op = await auth.authenticate(operatorToken.secret);
  const agent = await registry.register(op, { name: `health-${randomUUID()}` });
  const version = await external.publishVersion(op, { agentId: agent.id, version: 1, config: { test: "112c" } });
  const manifest = await external.publishManifest(op, { versionId: version.id, revision: 1, manifest: { tools: [{ name: options.write?"write_demo_receipt":"health_ping", revision: 1, description: "fixed ping", inputSchema: RESOURCE_FREE_SCHEMA, declaredProfile: options.write?"WRITE":"READ_ONLY", handlerId: options.handlerId ?? (options.write?WRITE_HANDLER:"health_ping.v1") }] } });
  const tool = manifest.tools[0]!, deployment = await external.registerDeployment(op, { name: `ping-${randomUUID()}`, environment: "isolated" });
  const outputResource=options.write?`foundry:demo-output:${randomUUID()}`:undefined;
  const grant = await external.grant(op, { versionId: version.id, toolId: tool.id, deploymentId: deployment.id, reviewedProfile: options.reviewed ?? (options.write?"WRITE":"READ_ONLY"), allowedResources: [outputResource??RESOURCE_FREE_RESOURCE] });
  const ledgerId = randomUUID();
  const binding = options.write?await bindings.approveDemoOutput(op,{toolId:tool.id,deploymentId:deployment.id,revision:1,artifactDigest,expiresAt,ledgerId,outputResource:outputResource!}):await bindings.approveResourceFree(op, { toolId: tool.id, deploymentId: deployment.id, revision: 1, artifactDigest, expiresAt, ...(options.execution === false ? {} : { execution: { profile: EXECUTION_PROFILE, ledgerId } }) });
  const principal = await admin.createPrincipal({ ownerId: owner.id, type: "AGENT", agentId: agent.id });
  const token = await issuer.issue({ principalId: principal.id, scopes: ["run:manage","invocation:request"], expiresAt });
  const agentContext = await auth.authenticate(token.secret);
  const executor = await admin.createPrincipal({ ownerId: owner.id, type: "EXECUTOR", deploymentId: deployment.id });
  const credential = await issuer.issue({ principalId: executor.id, scopes: ["executor:claim","executor:lease","executor:session","executor:start","executor:report"], expiresAt });
  const context = await auth.authenticate(credential.secret);
  const identity = { deploymentId: deployment.id, bindingId: binding.id, ledgerId, artifactDigest,...(options.write?{executionProfile:WRITE_PROFILE,outputResource}:{}) };
  async function request() {
    const run = await invocations.openRun(agentContext, version.id);
    const inv = await invocations.acceptInvocation(agentContext, { runId: run.id, toolId: tool.id, deploymentId: deployment.id, grantId: grant.id, idempotencyKey: randomUUID(), arguments: {} });
    return { run, inv };
  }
  const proofDigest = "c".repeat(64);
  async function session() { return execution.registerSession(context, { ...identity, sessionKey: randomUUID(), executionProfile: options.write?WRITE_PROFILE:EXECUTION_PROFILE, ledgerProofDigest: proofDigest }); }
  async function claimed() {
    const r = await request(), s = await session(), claim = await protocol.claim(context, r.inv.id, randomUUID(), s.id);
    const input = { sessionId: s.id, generation: claim.generation, requestKey: randomUUID(), artifactDigest, ledgerId };
    return { ...r, s, claim, input };
  }
  return { approvals:new ExternalApprovals(db), db, admin, issuer, auth, external, bindings, invocations, protocol, execution, owner, op, operatorToken, agentContext, token, credential, context, identity, version, tool, deployment, grant, binding, request, session, claimed };
}
