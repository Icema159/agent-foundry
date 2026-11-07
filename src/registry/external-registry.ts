import type { PrismaClient, Prisma } from "../generated/prisma/client.js";
import { authorize, IdentityError, type AuthenticatedContext, type Scope } from "../identity/identity.js";
import { canonical, manifest, positiveInteger, text, RevisionConflict, ValidationError, type Effect, type Json } from "./validation.js";

type Binding = { versionId: string; toolId: string; deploymentId: string };
type Decision = { decision: "DENY" | "ALLOW" | "REQUIRE_APPROVAL"; executionAllowed: false };
const profiles: readonly string[] = ["READ_ONLY", "WRITE", "DESTRUCTIVE", "EXTERNAL_WRITE"];
function isConflict(error: unknown): boolean { return typeof error === "object" && error !== null && "code" in error && error.code === "P2002"; }
function inputJson(value: Json): Prisma.InputJsonValue { return value as Prisma.InputJsonValue; }
function validId(value: unknown): string { return text(value, "identifier"); }
function effect(value: unknown): Effect {
  if (typeof value !== "string" || !profiles.includes(value)) throw new ValidationError("Unknown effect profile");
  return value as Effect;
}
async function principal(context: AuthenticatedContext, scope: Scope, agentId?: string) {
  await authorize(context, scope);
  if (context.principalType !== "OPERATOR" && !(context.principalType === "AGENT" && agentId && context.agentId === agentId)) throw new IdentityError();
}
async function operator(context: AuthenticatedContext, scope: Scope) {
  await authorize(context, scope);
  if (context.principalType !== "OPERATOR") throw new IdentityError();
}

/** Identity and grants foundation only. This service never executes or schedules tools. */
export class ExternalRegistry {
  constructor(private readonly db: PrismaClient) {}
  async publishVersion(context: AuthenticatedContext, input: { agentId: string; version: number; config: unknown }) {
    const agentId = validId(input.agentId); const version = positiveInteger(input.version);
    await principal(context, "version:publish", agentId);
    const agent = await this.db.agent.findFirst({ where: { id: agentId, ownerId: context.ownerId, integration: "EXTERNAL" }, select: { id: true } });
    if (!agent) throw new IdentityError();
    if (!input.config || typeof input.config !== "object" || Array.isArray(input.config)) throw new ValidationError("Config must be a JSON object");
    const config = canonical(input.config);
    try {
      return await this.db.externalAgentVersion.create({ data: { ownerId: context.ownerId, agentId, version, config: inputJson(config.value), digest: config.digest } });
    } catch (error) {
      if (!isConflict(error)) throw error;
      const existing = await this.db.externalAgentVersion.findUnique({ where: { agentId_version: { agentId, version } } });
      if (!existing || existing.ownerId !== context.ownerId || existing.digest !== config.digest) throw new RevisionConflict();
      return existing;
    }
  }
  async publishManifest(context: AuthenticatedContext, input: { versionId: string; revision: number; manifest: unknown }) {
    await authorize(context, "manifest:publish");
    const versionId = validId(input.versionId); const revision = positiveInteger(input.revision);
    const version = await this.db.externalAgentVersion.findFirst({ where: { id: versionId, ownerId: context.ownerId } });
    // Authenticate even for missing IDs; no owner information is returned.
    await principal(context, "manifest:publish", version?.agentId);
    if (!version) throw new IdentityError();
    const m = manifest(input.manifest);
    try {
      return await this.db.$transaction(async tx => {
        const created = await tx.toolManifest.create({ data: { ownerId: context.ownerId, versionId, revision, digest: m.digest } });
        await tx.toolRevision.createMany({ data: m.tools.map(tool => ({ ownerId: context.ownerId, versionId, manifestId: created.id,
          name: tool.name, revision: tool.revision, description: tool.description, inputSchema: inputJson(tool.inputSchema),
          declaredProfile: tool.declaredProfile, handlerId: tool.handlerId, digest: canonical(tool).digest })) });
        return tx.toolManifest.update({ where: { id: created.id }, data: { sealed: true }, include: { tools: { orderBy: { name: "asc" } } } });
      });
    } catch (error) {
      if (!isConflict(error)) throw error;
      const existing = await this.db.toolManifest.findUnique({ where: { versionId_revision: { versionId, revision } }, include: { tools: { orderBy: { name: "asc" } } } });
      if (!existing || existing.ownerId !== context.ownerId || existing.digest !== m.digest) throw new RevisionConflict();
      return existing;
    }
  }
  async registerDeployment(context: AuthenticatedContext, input: { name: string; environment: string }) {
    await operator(context, "deployment:manage");
    return this.db.executorDeployment.create({ data: { ownerId: context.ownerId, name: text(input.name, "deployment name"), environment: text(input.environment, "environment") } });
  }
  async grant(context: AuthenticatedContext, input: Binding & { reviewedProfile: Effect; allowedResources: string[] }) {
    await operator(context, "grant:manage");
    const versionId = validId(input.versionId), toolId = validId(input.toolId), deploymentId = validId(input.deploymentId);
    const reviewedProfile = effect(input.reviewedProfile);
    if (!Array.isArray(input.allowedResources) || !input.allowedResources.length || input.allowedResources.length > 64) throw new ValidationError("Explicit allowed resources required");
    const allowedResources = input.allowedResources.map(value => text(value, "resource"));
    if (new Set(allowedResources).size !== allowedResources.length || allowedResources.includes("*")) throw new ValidationError("Invalid allowed resources");
    const [version, tool, deployment] = await Promise.all([
      this.db.externalAgentVersion.findFirst({ where: { id: versionId, ownerId: context.ownerId } }),
      this.db.toolRevision.findFirst({ where: { id: toolId, versionId, ownerId: context.ownerId } }),
      this.db.executorDeployment.findFirst({ where: { id: deploymentId, ownerId: context.ownerId } }),
    ]);
    if (!version || !tool || !deployment) throw new IdentityError();
    if (tool.declaredProfile !== "READ_ONLY" && reviewedProfile === "READ_ONLY") throw new ValidationError("Reviewed profile cannot downgrade declared effects");
    return this.db.capabilityGrant.create({ data: { ownerId: context.ownerId, versionId, toolId, deploymentId,
      reviewedProfile, allowedResources, issuedByPrincipalId: context.principalId } });
  }
  async revoke(context: AuthenticatedContext, grantId: string): Promise<void> {
    await operator(context, "grant:manage");
    const updated = await this.db.capabilityGrant.updateMany({ where: { id: validId(grantId), ownerId: context.ownerId, revokedAt: null }, data: { revokedAt: new Date() } });
    if (updated.count !== 1) throw new IdentityError();
  }
  async decide(context: AuthenticatedContext, input: Binding & { resource: string; environment: string }): Promise<Decision> {
    await authorize(context, "capability:check");
    const deny: Decision = { decision: "DENY", executionAllowed: false };
    if (context.principalType !== "AGENT" || !context.agentId) return deny;
    if (!input || typeof input.versionId !== "string" || !input.versionId.trim() || typeof input.toolId !== "string" || !input.toolId.trim() ||
        typeof input.deploymentId !== "string" || !input.deploymentId.trim() || typeof input.resource !== "string" || !input.resource.trim() ||
        typeof input.environment !== "string" || !input.environment.trim()) return deny;
    const grant = await this.db.capabilityGrant.findFirst({ where: { ownerId: context.ownerId, versionId: input.versionId, toolId: input.toolId,
      deploymentId: input.deploymentId, revokedAt: null, allowedResources: { has: input.resource },
      version: { agentId: context.agentId }, deployment: { environment: input.environment } }, include: { tool: true } });
    if (!grant || !profiles.includes(grant.reviewedProfile) || !profiles.includes(grant.tool.declaredProfile) ||
        (grant.tool.declaredProfile !== "READ_ONLY" && grant.reviewedProfile === "READ_ONLY")) return deny;
    return { decision: grant.reviewedProfile === "READ_ONLY" ? "ALLOW" : "REQUIRE_APPROVAL", executionAllowed: false };
  }
}
