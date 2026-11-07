import { createHash, randomBytes } from "node:crypto";

export type PrincipalType = "OPERATOR" | "AGENT" | "EXECUTOR";
export type Scope = "agent:register" | "agent:read" | "executor:identify" | "version:publish" | "manifest:publish" | "deployment:manage" | "grant:manage" | "capability:check" | "run:manage" | "invocation:request";
const allowed: Record<PrincipalType, readonly Scope[]> = {
  OPERATOR: ["agent:register", "agent:read", "version:publish", "manifest:publish", "deployment:manage", "grant:manage", "capability:check"],
  AGENT: ["agent:read", "version:publish", "manifest:publish", "capability:check", "run:manage", "invocation:request"],
  EXECUTOR: ["executor:identify"],
};

export type Principal = {
  id: string; ownerId: string; type: PrincipalType;
  agentId: string | null; deploymentId: string | null;
};
export type StoredCredential = {
  id: string; principal: Principal; verifier: string; scopes: string[];
  expiresAt: Date; revokedAt: Date | null;
};
export interface IdentityStore {
  findCredential(verifier: string): Promise<StoredCredential | null>;
  findCredentialById(id: string): Promise<StoredCredential | null>;
  createCredential(input: { principalId: string; verifier: string; scopes: Scope[]; expiresAt: Date }): Promise<{ id: string }>;
  findPrincipal(id: string): Promise<Principal | null>;
  findExternalAgent(ownerId: string, agentId: string): Promise<boolean>;
  createOwner(name: string): Promise<{ id: string }>;
  createPrincipal(input: { ownerId: string; type: PrincipalType; agentId: string | null; deploymentId: string | null }): Promise<Principal>;
  revokeCredential(credentialId: string, at: Date): Promise<void>;
}

const verifiedContexts = new WeakSet<object>();
const contextStores = new WeakMap<object, IdentityStore>();
export type AuthenticatedContext = Readonly<{
  ownerId: string; principalId: string; principalType: PrincipalType;
  credentialId: string; scopes: readonly Scope[]; agentId: string | null; deploymentId: string | null;
}>;

export class IdentityError extends Error {
  constructor() { super("Authentication or authorization failed"); this.name = "IdentityError"; }
}
function assertScopes(type: PrincipalType, scopes: readonly string[]): asserts scopes is readonly Scope[] {
  if (!Object.hasOwn(allowed, type) || !Array.isArray(scopes) || scopes.length === 0 ||
      new Set(scopes).size !== scopes.length || scopes.some(scope => !allowed[type].includes(scope as Scope))) throw new IdentityError();
}
async function validatePrincipal(store: IdentityStore, principal: Principal): Promise<void> {
  if (!principal.id || !principal.ownerId) throw new IdentityError();
  if (principal.type === "OPERATOR" && principal.agentId === null && principal.deploymentId === null) return;
  if (principal.type === "AGENT" && principal.agentId && principal.deploymentId === null &&
      await store.findExternalAgent(principal.ownerId, principal.agentId)) return;
  if (principal.type === "EXECUTOR" && principal.agentId === null && principal.deploymentId?.trim()) return;
  throw new IdentityError();
}
function verifier(secret: string): string { return createHash("sha256").update(secret, "utf8").digest("hex"); }

/** Trusted administrative process only: never expose this method as an unauthenticated endpoint. */
export class TrustedCredentialIssuer {
  constructor(private readonly store: IdentityStore) {}
  async issue(input: { principalId: string; scopes: Scope[]; expiresAt: Date }, now = new Date()): Promise<{ credentialId: string; secret: string }> {
    const principal = await this.store.findPrincipal(input.principalId);
    if (!principal) throw new IdentityError();
    await validatePrincipal(this.store, principal);
    assertScopes(principal.type, input.scopes);
    if (!(input.expiresAt instanceof Date) || !Number.isFinite(input.expiresAt.getTime()) || input.expiresAt <= now) throw new IdentityError();
    const secret = `af_${randomBytes(32).toString("base64url")}`;
    const record = await this.store.createCredential({ principalId: principal.id, verifier: verifier(secret), scopes: [...input.scopes], expiresAt: input.expiresAt });
    return { credentialId: record.id, secret };
  }
}

/** Local trusted bootstrap/administration, not an authenticated remote API. */
export class TrustedIdentityAdministration {
  constructor(private readonly store: IdentityStore) {}
  async createOwner(name: string): Promise<{ id: string }> {
    if (typeof name !== "string" || !name.trim()) throw new IdentityError();
    return this.store.createOwner(name.trim());
  }
  async createPrincipal(input: { ownerId: string; type: PrincipalType; agentId?: string; deploymentId?: string }): Promise<Principal> {
    const candidate: Principal = { id: "new", ownerId: input.ownerId, type: input.type,
      agentId: input.agentId ?? null, deploymentId: input.deploymentId ?? null };
    await validatePrincipal(this.store, candidate);
    return this.store.createPrincipal({ ownerId: candidate.ownerId, type: candidate.type,
      agentId: candidate.agentId, deploymentId: candidate.deploymentId });
  }
  async revokeCredential(credentialId: string, at = new Date()): Promise<void> {
    if (!credentialId || !Number.isFinite(at.getTime())) throw new IdentityError();
    await this.store.revokeCredential(credentialId, at);
  }
}

export class CredentialAuthenticator {
  constructor(private readonly store: IdentityStore) {}
  async authenticate(secret: unknown, now = new Date()): Promise<AuthenticatedContext> {
    if (typeof secret !== "string" || !/^af_[A-Za-z0-9_-]{43}$/.test(secret)) throw new IdentityError();
    const record = await this.store.findCredential(verifier(secret));
    if (!record || record.revokedAt || !Number.isFinite(record.expiresAt.getTime()) || record.expiresAt <= now) throw new IdentityError();
    await validatePrincipal(this.store, record.principal);
    assertScopes(record.principal.type, record.scopes);
    const context: AuthenticatedContext = Object.freeze({
      ownerId: record.principal.ownerId, principalId: record.principal.id, principalType: record.principal.type,
      credentialId: record.id, scopes: Object.freeze([...record.scopes]),
      agentId: record.principal.agentId, deploymentId: record.principal.deploymentId,
    });
    verifiedContexts.add(context);
    contextStores.set(context, this.store);
    return context;
  }
}

export function requireScope(context: AuthenticatedContext, scope: Scope): void {
  if (!context || !verifiedContexts.has(context) || !context.scopes.includes(scope)) throw new IdentityError();
}
export function requireOwner(context: AuthenticatedContext, ownerId: string): void {
  if (!context || !verifiedContexts.has(context) || context.ownerId !== ownerId) throw new IdentityError();
}

/** Recheck durable revocation, expiry, bindings and scopes before every operation. */
export async function authorize(context: AuthenticatedContext, scope: Scope, now = new Date()): Promise<void> {
  requireScope(context, scope);
  const store = contextStores.get(context);
  if (!store) throw new IdentityError();
  const record = await store.findCredentialById(context.credentialId);
  if (!record || record.revokedAt || !Number.isFinite(record.expiresAt.getTime()) || record.expiresAt <= now) throw new IdentityError();
  const p = record.principal;
  await validatePrincipal(store, p);
  assertScopes(p.type, record.scopes);
  if (p.id !== context.principalId || p.ownerId !== context.ownerId || p.type !== context.principalType ||
      p.agentId !== context.agentId || p.deploymentId !== context.deploymentId || !record.scopes.includes(scope)) throw new IdentityError();
}
