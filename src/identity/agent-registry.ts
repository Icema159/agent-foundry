import { IdentityError, requireOwner, authorize, type AuthenticatedContext } from "./identity.js";

export type RegistryAgent = { id: string; ownerId: string; name: string; integration: "REFERENCE" | "EXTERNAL"; description: string | null };
export interface AgentRegistryStore {
  createExternalAgent(ownerId: string, name: string, description: string | null): Promise<RegistryAgent>;
  findAgent(ownerId: string, name: string): Promise<RegistryAgent | null>;
}

export class AgentRegistry {
  constructor(private readonly store: AgentRegistryStore) {}
  async register(context: AuthenticatedContext, input: { name: string; description?: string }): Promise<RegistryAgent> {
    await authorize(context, "agent:register");
    if (context.principalType !== "OPERATOR" || typeof input.name !== "string" || !input.name.trim() || input.name.trim() === "repository-explorer" || input.name.length > 200 ||
        (input.description !== undefined && (typeof input.description !== "string" || input.description.length > 2000))) throw new IdentityError();
    // Identity, owner and integration are derived here, never from input properties.
    return this.store.createExternalAgent(context.ownerId, input.name.trim(), input.description ?? null);
  }
  async findByName(context: AuthenticatedContext, name: string): Promise<RegistryAgent | null> {
    await authorize(context, "agent:read");
    if (typeof name !== "string" || !name.trim()) throw new IdentityError();
    const agent = await this.store.findAgent(context.ownerId, name.trim());
    if (!agent) return null;
    requireOwner(context, agent.ownerId);
    if (context.principalType === "AGENT" && context.agentId !== agent.id) return null;
    if (context.principalType !== "AGENT" && context.principalType !== "OPERATOR") throw new IdentityError();
    return agent;
  }
}
