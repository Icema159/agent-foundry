-- CreateEnum
CREATE TYPE "EffectProfile" AS ENUM ('READ_ONLY', 'WRITE', 'DESTRUCTIVE', 'EXTERNAL_WRITE');

-- CreateTable
CREATE TABLE "ExternalAgentVersion" (
    "id" TEXT NOT NULL,
    "ownerId" TEXT NOT NULL,
    "agentId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "config" JSONB NOT NULL,
    "digest" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ExternalAgentVersion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ToolManifest" (
    "id" TEXT NOT NULL,
    "ownerId" TEXT NOT NULL,
    "versionId" TEXT NOT NULL,
    "revision" INTEGER NOT NULL,
    "digest" TEXT NOT NULL,
    "sealed" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ToolManifest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ToolRevision" (
    "id" TEXT NOT NULL,
    "ownerId" TEXT NOT NULL,
    "versionId" TEXT NOT NULL,
    "manifestId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "revision" INTEGER NOT NULL,
    "description" TEXT NOT NULL,
    "inputSchema" JSONB NOT NULL,
    "declaredProfile" "EffectProfile" NOT NULL,
    "handlerId" TEXT NOT NULL,
    "digest" TEXT NOT NULL,

    CONSTRAINT "ToolRevision_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ExecutorDeployment" (
    "id" TEXT NOT NULL,
    "ownerId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "environment" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ExecutorDeployment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CapabilityGrant" (
    "id" TEXT NOT NULL,
    "ownerId" TEXT NOT NULL,
    "versionId" TEXT NOT NULL,
    "toolId" TEXT NOT NULL,
    "deploymentId" TEXT NOT NULL,
    "reviewedProfile" "EffectProfile" NOT NULL,
    "allowedResources" TEXT[],
    "issuedByPrincipalId" TEXT NOT NULL,
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CapabilityGrant_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ExternalAgentVersion_agentId_version_key" ON "ExternalAgentVersion"("agentId", "version");

-- CreateIndex
CREATE UNIQUE INDEX "ExternalAgentVersion_ownerId_id_key" ON "ExternalAgentVersion"("ownerId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "ToolManifest_versionId_revision_key" ON "ToolManifest"("versionId", "revision");

-- CreateIndex
CREATE UNIQUE INDEX "ToolManifest_ownerId_versionId_id_key" ON "ToolManifest"("ownerId", "versionId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "ToolRevision_manifestId_name_key" ON "ToolRevision"("manifestId", "name");

-- CreateIndex
CREATE UNIQUE INDEX "ToolRevision_ownerId_versionId_id_key" ON "ToolRevision"("ownerId", "versionId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "ExecutorDeployment_ownerId_name_environment_key" ON "ExecutorDeployment"("ownerId", "name", "environment");

-- CreateIndex
CREATE UNIQUE INDEX "ExecutorDeployment_ownerId_id_key" ON "ExecutorDeployment"("ownerId", "id");

-- CreateIndex
CREATE INDEX "CapabilityGrant_ownerId_versionId_toolId_deploymentId_revok_idx" ON "CapabilityGrant"("ownerId", "versionId", "toolId", "deploymentId", "revokedAt");

-- CreateIndex
CREATE UNIQUE INDEX "Principal_ownerId_id_key" ON "Principal"("ownerId", "id");

-- AddForeignKey
ALTER TABLE "ExternalAgentVersion" ADD CONSTRAINT "ExternalAgentVersion_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "Owner"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExternalAgentVersion" ADD CONSTRAINT "ExternalAgentVersion_ownerId_agentId_fkey" FOREIGN KEY ("ownerId", "agentId") REFERENCES "Agent"("ownerId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ToolManifest" ADD CONSTRAINT "ToolManifest_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "Owner"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ToolManifest" ADD CONSTRAINT "ToolManifest_ownerId_versionId_fkey" FOREIGN KEY ("ownerId", "versionId") REFERENCES "ExternalAgentVersion"("ownerId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ToolRevision" ADD CONSTRAINT "ToolRevision_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "Owner"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ToolRevision" ADD CONSTRAINT "ToolRevision_ownerId_versionId_manifestId_fkey" FOREIGN KEY ("ownerId", "versionId", "manifestId") REFERENCES "ToolManifest"("ownerId", "versionId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExecutorDeployment" ADD CONSTRAINT "ExecutorDeployment_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "Owner"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CapabilityGrant" ADD CONSTRAINT "CapabilityGrant_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "Owner"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CapabilityGrant" ADD CONSTRAINT "CapabilityGrant_ownerId_versionId_fkey" FOREIGN KEY ("ownerId", "versionId") REFERENCES "ExternalAgentVersion"("ownerId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CapabilityGrant" ADD CONSTRAINT "CapabilityGrant_ownerId_versionId_toolId_fkey" FOREIGN KEY ("ownerId", "versionId", "toolId") REFERENCES "ToolRevision"("ownerId", "versionId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CapabilityGrant" ADD CONSTRAINT "CapabilityGrant_ownerId_deploymentId_fkey" FOREIGN KEY ("ownerId", "deploymentId") REFERENCES "ExecutorDeployment"("ownerId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CapabilityGrant" ADD CONSTRAINT "CapabilityGrant_ownerId_issuedByPrincipalId_fkey" FOREIGN KEY ("ownerId", "issuedByPrincipalId") REFERENCES "Principal"("ownerId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Published revisions are append-only even for direct database clients.
CREATE FUNCTION reject_published_revision_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'Published revisions are immutable'; END;
$$;
CREATE TRIGGER immutable_external_version BEFORE UPDATE OR DELETE ON "ExternalAgentVersion" FOR EACH ROW EXECUTE FUNCTION reject_published_revision_change();
CREATE TRIGGER immutable_tool_revision BEFORE UPDATE OR DELETE ON "ToolRevision" FOR EACH ROW EXECUTE FUNCTION reject_published_revision_change();
-- An unpublished manifest is sealed in the same transaction as its tools.
CREATE FUNCTION guard_tool_manifest() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND NOT OLD."sealed" AND NEW."sealed" AND
     (to_jsonb(OLD) - 'sealed') = (to_jsonb(NEW) - 'sealed') THEN RETURN NEW; END IF;
  RAISE EXCEPTION 'Published manifests are immutable';
END;
$$;
CREATE TRIGGER immutable_tool_manifest BEFORE UPDATE OR DELETE ON "ToolManifest" FOR EACH ROW EXECUTE FUNCTION guard_tool_manifest();
CREATE FUNCTION guard_manifest_tool_insert() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM "ToolManifest" WHERE "id" = NEW."manifestId" AND NOT "sealed") THEN
    RAISE EXCEPTION 'Manifest is sealed or missing';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER sealed_manifest_tools BEFORE INSERT ON "ToolRevision" FOR EACH ROW EXECUTE FUNCTION guard_manifest_tool_insert();
CREATE FUNCTION ensure_manifest_sealed() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM "ToolManifest" WHERE id = NEW.id AND NOT "sealed") THEN RAISE EXCEPTION 'Manifest must be sealed before commit'; END IF;
  RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER manifest_must_be_sealed AFTER INSERT OR UPDATE ON "ToolManifest" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION ensure_manifest_sealed();
ALTER TABLE "ExternalAgentVersion" ADD CONSTRAINT "ExternalAgentVersion_positive_version" CHECK ("version" > 0);
ALTER TABLE "ToolManifest" ADD CONSTRAINT "ToolManifest_positive_revision" CHECK ("revision" > 0);
ALTER TABLE "ToolRevision" ADD CONSTRAINT "ToolRevision_positive_revision" CHECK ("revision" > 0);
ALTER TABLE "CapabilityGrant" ADD CONSTRAINT "CapabilityGrant_resources_required" CHECK (cardinality("allowedResources") > 0);
ALTER TABLE "CapabilityGrant" ALTER COLUMN "allowedResources" SET NOT NULL;
CREATE UNIQUE INDEX "CapabilityGrant_one_active_binding" ON "CapabilityGrant"("ownerId", "versionId", "toolId", "deploymentId") WHERE "revokedAt" IS NULL;

