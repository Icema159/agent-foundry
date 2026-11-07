-- AlterTable
ALTER TABLE "InvocationEvent" ADD COLUMN     "authorization" JSONB;

-- CreateTable
CREATE TABLE "TrustedResourceBinding" (
    "id" TEXT NOT NULL,
    "ownerId" TEXT NOT NULL,
    "versionId" TEXT NOT NULL,
    "toolId" TEXT NOT NULL,
    "deploymentId" TEXT NOT NULL,
    "revision" INTEGER NOT NULL,
    "mode" TEXT NOT NULL,
    "artifactDigest" TEXT NOT NULL,
    "toolDigest" TEXT NOT NULL,
    "deploymentDigest" TEXT NOT NULL,
    "approvedByPrincipalId" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TrustedResourceBinding_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InvocationAuthorization" (
    "invocationId" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "bindingId" TEXT NOT NULL,
    "credentialId" TEXT NOT NULL,
    "snapshot" JSONB NOT NULL,
    "digest" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "InvocationAuthorization_pkey" PRIMARY KEY ("invocationId")
);

-- CreateIndex
CREATE INDEX "TrustedResourceBinding_ownerId_versionId_toolId_deploymentI_idx" ON "TrustedResourceBinding"("ownerId", "versionId", "toolId", "deploymentId", "revokedAt");

-- CreateIndex
CREATE UNIQUE INDEX "TrustedResourceBinding_toolId_deploymentId_revision_key" ON "TrustedResourceBinding"("toolId", "deploymentId", "revision");

-- CreateIndex
CREATE UNIQUE INDEX "InvocationAuthorization_runId_invocationId_key" ON "InvocationAuthorization"("runId", "invocationId");

-- AddForeignKey
ALTER TABLE "TrustedResourceBinding" ADD CONSTRAINT "TrustedResourceBinding_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "Owner"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TrustedResourceBinding" ADD CONSTRAINT "TrustedResourceBinding_ownerId_versionId_toolId_fkey" FOREIGN KEY ("ownerId", "versionId", "toolId") REFERENCES "ToolRevision"("ownerId", "versionId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TrustedResourceBinding" ADD CONSTRAINT "TrustedResourceBinding_ownerId_deploymentId_fkey" FOREIGN KEY ("ownerId", "deploymentId") REFERENCES "ExecutorDeployment"("ownerId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TrustedResourceBinding" ADD CONSTRAINT "TrustedResourceBinding_ownerId_approvedByPrincipalId_fkey" FOREIGN KEY ("ownerId", "approvedByPrincipalId") REFERENCES "Principal"("ownerId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InvocationAuthorization" ADD CONSTRAINT "InvocationAuthorization_runId_invocationId_fkey" FOREIGN KEY ("runId", "invocationId") REFERENCES "Invocation"("runId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InvocationAuthorization" ADD CONSTRAINT "InvocationAuthorization_bindingId_fkey" FOREIGN KEY ("bindingId") REFERENCES "TrustedResourceBinding"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InvocationAuthorization" ADD CONSTRAINT "InvocationAuthorization_credentialId_fkey" FOREIGN KEY ("credentialId") REFERENCES "Credential"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- A policy revision is a grant identity; changing policy requires a new grant.
-- Both revocations and eligibility checks lock these rows. Revocation is monotonic.
CREATE FUNCTION guard_revocable_authorization() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND
     (to_jsonb(OLD) - 'revokedAt') = (to_jsonb(NEW) - 'revokedAt') AND
     (OLD."revokedAt" IS NULL OR OLD."revokedAt" = NEW."revokedAt") THEN RETURN NEW; END IF;
  RAISE EXCEPTION 'Authorization revisions are immutable; revocation cannot be undone';
END;
$$;
CREATE TRIGGER immutable_grant_policy BEFORE UPDATE OR DELETE ON "CapabilityGrant"
FOR EACH ROW EXECUTE FUNCTION guard_revocable_authorization();
CREATE TRIGGER immutable_resource_binding BEFORE UPDATE OR DELETE ON "TrustedResourceBinding"
FOR EACH ROW EXECUTE FUNCTION guard_revocable_authorization();
CREATE TRIGGER immutable_invocation_authorization BEFORE UPDATE OR DELETE ON "InvocationAuthorization"
FOR EACH ROW EXECUTE FUNCTION reject_published_revision_change();

ALTER TABLE "TrustedResourceBinding" ADD CONSTRAINT "TrustedResourceBinding_revision_positive" CHECK (revision > 0);
ALTER TABLE "TrustedResourceBinding" ADD CONSTRAINT "TrustedResourceBinding_mode" CHECK (mode = 'RESOURCE_FREE_READ_ONLY_V1');
ALTER TABLE "TrustedResourceBinding" ADD CONSTRAINT "TrustedResourceBinding_artifact_digest" CHECK ("artifactDigest" ~ '^[a-f0-9]{64}$');
ALTER TABLE "TrustedResourceBinding" ADD CONSTRAINT "TrustedResourceBinding_expiry" CHECK ("expiresAt" > "createdAt");
CREATE UNIQUE INDEX "TrustedResourceBinding_one_active" ON "TrustedResourceBinding"("toolId", "deploymentId") WHERE "revokedAt" IS NULL;
