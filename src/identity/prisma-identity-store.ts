import type { PrismaClient } from "../generated/prisma/client.js";
import type { IdentityStore, Principal, Scope } from "./identity.js";
import type { AgentRegistryStore, RegistryAgent } from "./agent-registry.js";

/** Persistence adapter. Only trusted composition code should hold this directly. */
export class PrismaIdentityStore implements IdentityStore, AgentRegistryStore {
  constructor(private readonly prisma: PrismaClient) {}
  async findCredential(verifier: string) {
    return this.prisma.credential.findUnique({ where: { verifier }, include: { principal: true } });
  }
  async findCredentialById(id: string) {
    return this.prisma.credential.findUnique({ where: { id }, include: { principal: true } });
  }
  async createCredential(input: { principalId: string; verifier: string; scopes: Scope[]; expiresAt: Date }) {
    return this.prisma.credential.create({ data: input, select: { id: true } });
  }
  async findPrincipal(id: string) { return this.prisma.principal.findUnique({ where: { id } }); }
  async findExternalAgent(ownerId: string, agentId: string): Promise<boolean> {
    return (await this.prisma.agent.count({ where: { id: agentId, ownerId, integration: "EXTERNAL" } })) === 1;
  }
  async createOwner(name: string) { return this.prisma.owner.create({ data: { name }, select: { id: true } }); }
  async createPrincipal(input: { ownerId: string; type: Principal["type"]; agentId: string | null; deploymentId: string | null }) {
    return this.prisma.principal.create({ data: input });
  }
  async revokeCredential(credentialId: string, at: Date): Promise<void> {
    await this.prisma.credential.update({ where: { id: credentialId }, data: { revokedAt: at } });
  }
  async createExternalAgent(ownerId: string, name: string, description: string | null): Promise<RegistryAgent> {
    return this.prisma.agent.create({ data: { ownerId, name, description, integration: "EXTERNAL" } });
  }
  async findAgent(ownerId: string, name: string): Promise<RegistryAgent | null> {
    return this.prisma.agent.findFirst({ where: { ownerId, name } });
  }
}
