-- CreateEnum
CREATE TYPE "ExecutorClaimStatus" AS ENUM ('ACTIVE', 'RELEASED', 'EXPIRED', 'REVOKED');

-- AlterTable
ALTER TABLE "InvocationEvent" ADD COLUMN     "claimGeneration" INTEGER,
ADD COLUMN     "claimId" TEXT,
ADD COLUMN     "leaseExpiresAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "ExecutorClaim" (
    "id" TEXT NOT NULL,
    "ownerId" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "invocationId" TEXT NOT NULL,
    "deploymentId" TEXT NOT NULL,
    "executorPrincipalId" TEXT NOT NULL,
    "credentialId" TEXT NOT NULL,
    "requestKey" TEXT NOT NULL,
    "authorizationDigest" TEXT NOT NULL,
    "generation" INTEGER NOT NULL,
    "status" "ExecutorClaimStatus" NOT NULL DEFAULT 'ACTIVE',
    "leaseExpiresAt" TIMESTAMP(3) NOT NULL,
    "startAuthorizedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "closedAt" TIMESTAMP(3),

    CONSTRAINT "ExecutorClaim_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ExecutorClaim_ownerId_deploymentId_status_leaseExpiresAt_idx" ON "ExecutorClaim"("ownerId", "deploymentId", "status", "leaseExpiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "ExecutorClaim_invocationId_generation_key" ON "ExecutorClaim"("invocationId", "generation");

-- CreateIndex
CREATE UNIQUE INDEX "ExecutorClaim_ownerId_executorPrincipalId_requestKey_key" ON "ExecutorClaim"("ownerId", "executorPrincipalId", "requestKey");

-- CreateIndex
CREATE UNIQUE INDEX "Credential_principalId_id_key" ON "Credential"("principalId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "InvocationAuthorization_invocationId_digest_key" ON "InvocationAuthorization"("invocationId", "digest");

-- CreateIndex
CREATE UNIQUE INDEX "Invocation_ownerId_deploymentId_runId_id_key" ON "Invocation"("ownerId", "deploymentId", "runId", "id");

-- AddForeignKey
ALTER TABLE "ExecutorClaim" ADD CONSTRAINT "ExecutorClaim_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "Owner"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExecutorClaim" ADD CONSTRAINT "ExecutorClaim_ownerId_deploymentId_runId_invocationId_fkey" FOREIGN KEY ("ownerId", "deploymentId", "runId", "invocationId") REFERENCES "Invocation"("ownerId", "deploymentId", "runId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExecutorClaim" ADD CONSTRAINT "ExecutorClaim_ownerId_deploymentId_fkey" FOREIGN KEY ("ownerId", "deploymentId") REFERENCES "ExecutorDeployment"("ownerId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExecutorClaim" ADD CONSTRAINT "ExecutorClaim_ownerId_executorPrincipalId_fkey" FOREIGN KEY ("ownerId", "executorPrincipalId") REFERENCES "Principal"("ownerId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExecutorClaim" ADD CONSTRAINT "ExecutorClaim_executorPrincipalId_credentialId_fkey" FOREIGN KEY ("executorPrincipalId", "credentialId") REFERENCES "Credential"("principalId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExecutorClaim" ADD CONSTRAINT "ExecutorClaim_invocationId_authorizationDigest_fkey" FOREIGN KEY ("invocationId", "authorizationDigest") REFERENCES "InvocationAuthorization"("invocationId", "digest") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE UNIQUE INDEX "ExecutorClaim_one_active_per_invocation" ON "ExecutorClaim"("invocationId") WHERE status = 'ACTIVE';
ALTER TABLE "ExecutorClaim" ADD CONSTRAINT "ExecutorClaim_generation_positive" CHECK (generation > 0);
ALTER TABLE "ExecutorClaim" ADD CONSTRAINT "ExecutorClaim_deadline" CHECK ("leaseExpiresAt" > "createdAt");
ALTER TABLE "ExecutorClaim" ADD CONSTRAINT "ExecutorClaim_closed_state" CHECK ((status = 'ACTIVE') = ("closedAt" IS NULL));
-- Reserved for a future reviewed start migration; 11.2b cannot record a start.
ALTER TABLE "ExecutorClaim" ADD CONSTRAINT "ExecutorClaim_start_disabled" CHECK ("startAuthorizedAt" IS NULL);

CREATE FUNCTION guard_executor_claim() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE current_status "InvocationStatus"; expected_generation INTEGER;
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'Claim history cannot be deleted'; END IF;
  SELECT status INTO current_status FROM "Invocation" WHERE id = NEW."invocationId" FOR UPDATE;
  IF current_status NOT IN ('READY', 'CLAIMED') OR EXISTS (
    SELECT 1 FROM "InvocationEvent" WHERE "invocationId" = NEW."invocationId" AND
    (status IN ('START_AUTHORIZED','RUNNING','SUCCEEDED','FAILED','UNKNOWN') OR kind = 'START_AUTHORIZED')
  ) THEN RAISE EXCEPTION 'Potentially started Invocations cannot be reclaimed'; END IF;
  IF TG_OP = 'INSERT' THEN
    SELECT COALESCE(MAX(generation), 0) + 1 INTO expected_generation FROM "ExecutorClaim" WHERE "invocationId" = NEW."invocationId";
    IF current_status <> 'READY' OR NEW.status <> 'ACTIVE' OR NEW.generation <> expected_generation OR
      NOT EXISTS (SELECT 1 FROM "ExternalRun" WHERE id = NEW."runId" AND status = 'RUNNING') THEN
      RAISE EXCEPTION 'Invalid pre-start claim or fencing generation';
    END IF;
  ELSE
    IF current_status <> 'CLAIMED' OR OLD.status <> 'ACTIVE' OR
       (to_jsonb(OLD) - ARRAY['status','leaseExpiresAt','updatedAt','closedAt']) <>
       (to_jsonb(NEW) - ARRAY['status','leaseExpiresAt','updatedAt','closedAt']) THEN
      RAISE EXCEPTION 'Claim identity and closed claims are immutable';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER executor_claim_guard BEFORE INSERT OR UPDATE OR DELETE ON "ExecutorClaim"
FOR EACH ROW EXECUTE FUNCTION guard_executor_claim();

ALTER TABLE "InvocationEvent" ADD CONSTRAINT "InvocationEvent_claim_metadata" CHECK (
  ("claimId" IS NULL AND "claimGeneration" IS NULL AND "leaseExpiresAt" IS NULL) OR
  ("claimId" IS NOT NULL AND "claimGeneration" IS NOT NULL AND "claimGeneration" > 0 AND "leaseExpiresAt" IS NOT NULL)
);
