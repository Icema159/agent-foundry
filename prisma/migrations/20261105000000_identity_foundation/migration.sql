-- The fixed owner reserves the existing local reference installation. No agent,
-- version, task or run identifiers are replaced, and no credentials are seeded.
CREATE TYPE "AgentIntegration" AS ENUM ('REFERENCE', 'EXTERNAL');
CREATE TYPE "PrincipalType" AS ENUM ('OPERATOR', 'AGENT', 'EXECUTOR');

CREATE TABLE "Owner" (
  "id" TEXT PRIMARY KEY,
  "name" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
INSERT INTO "Owner" ("id", "name") VALUES ('foundry-local-owner', 'Legacy local installation');

ALTER TABLE "Agent" ADD COLUMN "ownerId" TEXT NOT NULL DEFAULT 'foundry-local-owner';
ALTER TABLE "Agent" ADD COLUMN "integration" "AgentIntegration" NOT NULL DEFAULT 'REFERENCE';
ALTER TABLE "Agent" ADD CONSTRAINT "Agent_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "Owner"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE UNIQUE INDEX "Agent_ownerId_id_key" ON "Agent"("ownerId", "id");
-- Agent.name remains globally unique in this compatibility stage.

CREATE TABLE "Principal" (
  "id" TEXT PRIMARY KEY,
  "ownerId" TEXT NOT NULL,
  "type" "PrincipalType" NOT NULL,
  "agentId" TEXT,
  "deploymentId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "Principal_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "Owner"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "Principal_ownerId_agentId_fkey" FOREIGN KEY ("ownerId", "agentId") REFERENCES "Agent"("ownerId", "id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "Principal_type_binding_check" CHECK (
    ("type" = 'OPERATOR' AND "agentId" IS NULL AND "deploymentId" IS NULL) OR
    ("type" = 'AGENT' AND "agentId" IS NOT NULL AND "deploymentId" IS NULL) OR
    ("type" = 'EXECUTOR' AND "agentId" IS NULL AND "deploymentId" IS NOT NULL AND length(trim("deploymentId")) > 0)
  )
);
CREATE INDEX "Principal_ownerId_idx" ON "Principal"("ownerId");

CREATE TABLE "Credential" (
  "id" TEXT PRIMARY KEY,
  "principalId" TEXT NOT NULL,
  "verifier" TEXT NOT NULL,
  "scopes" TEXT[] NOT NULL,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "revokedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "Credential_principalId_fkey" FOREIGN KEY ("principalId") REFERENCES "Principal"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "Credential_verifier_key" ON "Credential"("verifier");
CREATE INDEX "Credential_principalId_idx" ON "Credential"("principalId");
