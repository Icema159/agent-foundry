-- CreateEnum
CREATE TYPE "ExternalRunStatus" AS ENUM ('RUNNING', 'COMPLETED');

-- CreateEnum
CREATE TYPE "InvocationStatus" AS ENUM ('REQUESTED', 'READY', 'PENDING_APPROVAL', 'CLAIMED', 'START_AUTHORIZED', 'RUNNING', 'SUCCEEDED', 'FAILED', 'DENIED', 'REVOKED', 'EXPIRED', 'UNKNOWN');

-- CreateTable
CREATE TABLE "ExternalRun" (
    "id" TEXT NOT NULL,
    "ownerId" TEXT NOT NULL,
    "agentId" TEXT NOT NULL,
    "versionId" TEXT NOT NULL,
    "status" "ExternalRunStatus" NOT NULL DEFAULT 'RUNNING',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "ExternalRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Invocation" (
    "id" TEXT NOT NULL,
    "ownerId" TEXT NOT NULL,
    "agentId" TEXT NOT NULL,
    "versionId" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "toolId" TEXT NOT NULL,
    "deploymentId" TEXT NOT NULL,
    "grantId" TEXT,
    "idempotencyKey" TEXT NOT NULL,
    "arguments" JSONB NOT NULL,
    "fingerprint" TEXT NOT NULL,
    "status" "InvocationStatus" NOT NULL,
    "reason" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Invocation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InvocationEvent" (
    "sequence" BIGSERIAL NOT NULL,
    "runId" TEXT NOT NULL,
    "invocationId" TEXT NOT NULL,
    "actorPrincipalId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "status" "InvocationStatus" NOT NULL,
    "reason" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "InvocationEvent_pkey" PRIMARY KEY ("sequence")
);

-- CreateIndex
CREATE UNIQUE INDEX "ExternalRun_ownerId_agentId_versionId_id_key" ON "ExternalRun"("ownerId", "agentId", "versionId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "Invocation_ownerId_runId_idempotencyKey_key" ON "Invocation"("ownerId", "runId", "idempotencyKey");

-- CreateIndex
CREATE UNIQUE INDEX "Invocation_runId_id_key" ON "Invocation"("runId", "id");

-- CreateIndex
CREATE INDEX "InvocationEvent_runId_sequence_idx" ON "InvocationEvent"("runId", "sequence");

-- CreateIndex
CREATE UNIQUE INDEX "CapabilityGrant_ownerId_versionId_toolId_deploymentId_id_key" ON "CapabilityGrant"("ownerId", "versionId", "toolId", "deploymentId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "ExternalAgentVersion_ownerId_agentId_id_key" ON "ExternalAgentVersion"("ownerId", "agentId", "id");

-- AddForeignKey
ALTER TABLE "ExternalRun" ADD CONSTRAINT "ExternalRun_ownerId_agentId_versionId_fkey" FOREIGN KEY ("ownerId", "agentId", "versionId") REFERENCES "ExternalAgentVersion"("ownerId", "agentId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Invocation" ADD CONSTRAINT "Invocation_ownerId_agentId_versionId_runId_fkey" FOREIGN KEY ("ownerId", "agentId", "versionId", "runId") REFERENCES "ExternalRun"("ownerId", "agentId", "versionId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Invocation" ADD CONSTRAINT "Invocation_ownerId_versionId_toolId_fkey" FOREIGN KEY ("ownerId", "versionId", "toolId") REFERENCES "ToolRevision"("ownerId", "versionId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Invocation" ADD CONSTRAINT "Invocation_ownerId_deploymentId_fkey" FOREIGN KEY ("ownerId", "deploymentId") REFERENCES "ExecutorDeployment"("ownerId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Invocation" ADD CONSTRAINT "Invocation_ownerId_versionId_toolId_deploymentId_grantId_fkey" FOREIGN KEY ("ownerId", "versionId", "toolId", "deploymentId", "grantId") REFERENCES "CapabilityGrant"("ownerId", "versionId", "toolId", "deploymentId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InvocationEvent" ADD CONSTRAINT "InvocationEvent_runId_invocationId_fkey" FOREIGN KEY ("runId", "invocationId") REFERENCES "Invocation"("runId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- One unfinished or uncertain invocation per run; UNKNOWN never frees the slot.
CREATE UNIQUE INDEX "Invocation_one_active_per_run" ON "Invocation"("runId")
WHERE "status" IN ('REQUESTED', 'READY', 'PENDING_APPROVAL', 'CLAIMED', 'START_AUTHORIZED', 'RUNNING', 'UNKNOWN');
ALTER TABLE "ExternalRun" ADD CONSTRAINT "ExternalRun_id_prefix" CHECK (left("id", 4) = 'ext_');
CREATE FUNCTION protect_invocation_identity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (to_jsonb(OLD) - ARRAY['status','reason','updatedAt']) <> (to_jsonb(NEW) - ARRAY['status','reason','updatedAt']) THEN
    RAISE EXCEPTION 'Invocation request identity is immutable';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER immutable_invocation_request BEFORE UPDATE ON "Invocation" FOR EACH ROW EXECUTE FUNCTION protect_invocation_identity();
CREATE TRIGGER immutable_invocation_events BEFORE UPDATE OR DELETE ON "InvocationEvent" FOR EACH ROW EXECUTE FUNCTION reject_published_revision_change();

