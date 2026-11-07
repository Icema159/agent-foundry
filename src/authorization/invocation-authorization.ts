import type { CapabilityGrant, Credential, ExecutorDeployment, Invocation, Prisma, ToolRevision, TrustedResourceBinding } from "../generated/prisma/client.js";
import { canonical } from "../registry/validation.js";
import { deploymentDigest, grantDigest, isResourceFreeReadOnly, RESOURCE_FREE_MODE, RESOURCE_FREE_RESOURCE } from "./resource-binding.js";
import { databaseNow } from "./credential-lock.js";

type Tool = ToolRevision & { manifest: { digest: string; version: { digest: string } } };
export type Decision = { status: "REQUESTED" | "DENIED" | "READY" | "PENDING_APPROVAL"; reason: string;
  binding: TrustedResourceBinding | null; executionPolicy: "ALLOW" | "REQUIRE_APPROVAL"; };

/** Run and requester credential must already be locked by the caller. */
export async function evaluateAuthorization(tx: Prisma.TransactionClient, tool: ToolRevision, deployment: ExecutorDeployment,
  grant: CapabilityGrant | null, args: unknown): Promise<Decision> {
  const executionPolicy = tool.declaredProfile === "READ_ONLY" && grant?.reviewedProfile === "READ_ONLY" ? "ALLOW" : "REQUIRE_APPROVAL";
  const base = { binding: null, executionPolicy } as const;
  if (!grant || grant.revokedAt || !grant.allowedResources.length ||
      (tool.declaredProfile !== "READ_ONLY" && grant.reviewedProfile === "READ_ONLY"))
    return { ...base, status: "DENIED", reason: "CAPABILITY_NOT_GRANTED" };
  if (!isResourceFreeReadOnly(tool, args)) return { ...base, status: "REQUESTED", reason: "RESOURCE_BINDING_UNVERIFIED" };
  const rows = await tx.$queryRaw<Array<{ id: string }>>`SELECT id FROM "TrustedResourceBinding"
    WHERE "ownerId" = ${tool.ownerId} AND "versionId" = ${tool.versionId} AND "toolId" = ${tool.id}
      AND "deploymentId" = ${deployment.id} AND "revokedAt" IS NULL FOR UPDATE`;
  const binding = rows[0] ? await tx.trustedResourceBinding.findUnique({ where: { id: rows[0].id } }) : null;
  const now = await databaseNow(tx);
  if (!binding || binding.mode !== RESOURCE_FREE_MODE || binding.expiresAt <= now! || binding.toolDigest !== tool.digest ||
      binding.deploymentDigest !== deploymentDigest(deployment)) return { ...base, status: "REQUESTED", reason: "RESOURCE_BINDING_UNVERIFIED" };
  if (!grant.allowedResources.includes(RESOURCE_FREE_RESOURCE)) return { ...base, binding, status: "DENIED", reason: "RESOURCE_NOT_GRANTED" };
  return { binding, executionPolicy, status: executionPolicy === "ALLOW" ? "READY" : "PENDING_APPROVAL",
    reason: executionPolicy === "ALLOW" ? "RESOURCE_AUTHORIZED" : "APPROVAL_REQUIRED" };
}

export function authorizationSnapshot(invocation: Invocation, tool: Tool, deployment: ExecutorDeployment,
  grant: CapabilityGrant, binding: TrustedResourceBinding, credential: Credential, executionPolicy: string) {
  return canonical({ format: 1, invocationId: invocation.id, ownerId: invocation.ownerId, agentId: invocation.agentId,
    versionId: invocation.versionId, versionDigest: tool.manifest.version.digest, runId: invocation.runId,
    requestFingerprint: invocation.fingerprint, argumentsDigest: canonical(invocation.arguments).digest,
    tool: { id: tool.id, revision: tool.revision, digest: tool.digest, manifestId: tool.manifestId, manifestDigest: tool.manifest.digest, handlerId: tool.handlerId },
    deployment: { id: deployment.id, digest: deploymentDigest(deployment), environment: deployment.environment },
    grant: { id: grant.id, policyRevision: grant.id, digest: grantDigest(grant) },
    binding: { id: binding.id, revision: binding.revision, mode: binding.mode, artifactDigest: binding.artifactDigest,
      toolDigest: binding.toolDigest, deploymentDigest: binding.deploymentDigest, approvedByPrincipalId: binding.approvedByPrincipalId,
      expiresAt: binding.expiresAt.toISOString() },
    requester: { credentialId: credential.id, principalId: credential.principalId },
    resource: RESOURCE_FREE_RESOURCE, executionPolicy,
    expiresAt: new Date(Math.min(binding.expiresAt.getTime(), credential.expiresAt.getTime())).toISOString() });
}

/**
 * Reusable guard inside a caller-owned transaction holding run, Invocation and
 * original requester credential/principal locks. It never authorizes a start.
 * A future executor must add authenticated assignment/lease/approval checks and
 * commit START_AUTHORIZED in this SAME transaction; a returned boolean is no permit.
 */
export async function recheckPinnedAuthorization(tx: Prisma.TransactionClient, invocation: Invocation,
  credential: Credential, expectedDigest: string) {
  const reject = (reason: string) => ({ eligible: false, startAllowed: false, reason } as const);
  if (invocation.status !== "READY") return reject(invocation.status === "PENDING_APPROVAL" ? "APPROVAL_REQUIRED" : "INVALID_STATE");
  const saved = await tx.invocationAuthorization.findUnique({ where: { invocationId: invocation.id } });
  if (!saved || saved.digest !== expectedDigest || canonical(saved.snapshot).digest !== saved.digest) return reject("AUTHORIZATION_MISMATCH");
  if (saved.credentialId !== credential.id) return reject("REQUEST_CREDENTIAL_MISMATCH");
  // Never accept the caller's previously loaded credential as current evidence.
  await tx.$queryRaw`SELECT id FROM "Credential" WHERE id = ${saved.credentialId} FOR UPDATE`;
  const current = await tx.credential.findUnique({ where: { id: saved.credentialId } });
  if (!current) return reject("REQUEST_CREDENTIAL_INVALID");
  credential = current;
  await tx.$queryRaw`SELECT id FROM "Principal" WHERE id = ${credential.principalId} FOR UPDATE`;
  const now = await databaseNow(tx);
  const principal = await tx.principal.findUnique({ where: { id: credential.principalId } });
  if (credential.revokedAt || credential.expiresAt <= now! || !credential.scopes.includes("invocation:request") ||
      principal?.type !== "AGENT" || principal.ownerId !== invocation.ownerId || principal.agentId !== invocation.agentId)
    return reject("REQUEST_CREDENTIAL_INVALID");
  if (!await tx.agent.findFirst({ where: { id: invocation.agentId, ownerId: invocation.ownerId, integration: "EXTERNAL" } }))
    return reject("REQUEST_CREDENTIAL_INVALID");
  if (!invocation.grantId) return reject("CAPABILITY_NOT_GRANTED");
  await tx.$queryRaw`SELECT id FROM "CapabilityGrant" WHERE id = ${invocation.grantId} FOR UPDATE`;
  const grant = await tx.capabilityGrant.findFirst({ where: { id: invocation.grantId, ownerId: invocation.ownerId,
    versionId: invocation.versionId, toolId: invocation.toolId, deploymentId: invocation.deploymentId } });
  await tx.$queryRaw`SELECT id FROM "ExecutorDeployment" WHERE id = ${invocation.deploymentId} AND "ownerId" = ${invocation.ownerId} FOR UPDATE`;
  const deployment = await tx.executorDeployment.findFirst({ where: { id: invocation.deploymentId, ownerId: invocation.ownerId } });
  const tool = await tx.toolRevision.findFirst({ where: { id: invocation.toolId, ownerId: invocation.ownerId,
    versionId: invocation.versionId, manifest: { sealed: true } }, include: { manifest: { include: { version: true } } } });
  if (!grant || !deployment || !tool) return reject("AUTHORIZATION_MISMATCH");
  const decision = await evaluateAuthorization(tx, tool, deployment, grant, invocation.arguments);
  if (decision.status !== "READY" || !decision.binding) return reject(decision.reason);
  const snapshot = authorizationSnapshot(invocation, tool, deployment, grant, decision.binding, credential, decision.executionPolicy);
  if (snapshot.digest !== saved.digest || saved.bindingId !== decision.binding.id) return reject("AUTHORIZATION_MISMATCH");
  const checkedAt = await databaseNow(tx);
  if (credential.expiresAt <= checkedAt! || decision.binding.expiresAt <= checkedAt!) return reject("AUTHORIZATION_EXPIRED");
  return { eligible: true, startAllowed: false, reason: "ELIGIBLE_NOT_START_AUTHORIZED", authorizationDigest: snapshot.digest } as const;
}
