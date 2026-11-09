-- AlterTable
ALTER TABLE "TrustedResourceBinding" ADD COLUMN     "executionProfile" TEXT,
ADD COLUMN     "ledgerId" TEXT;

-- AlterTable
ALTER TABLE "ExecutorClaim" ADD COLUMN     "sessionId" TEXT;

-- AlterTable
ALTER TABLE "InvocationEvent" ADD COLUMN     "executionResult" JSONB,
ADD COLUMN     "reportId" TEXT,
ADD COLUMN     "startId" TEXT;

-- CreateTable
CREATE TABLE "ExecutorSession" (
    "id" TEXT NOT NULL,
    "ownerId" TEXT NOT NULL,
    "deploymentId" TEXT NOT NULL,
    "executorPrincipalId" TEXT NOT NULL,
    "credentialId" TEXT NOT NULL,
    "bindingId" TEXT NOT NULL,
    "sessionKey" TEXT NOT NULL,
    "requestDigest" TEXT NOT NULL,
    "artifactDigest" TEXT NOT NULL,
    "ledgerId" TEXT NOT NULL,
    "executionProfile" TEXT NOT NULL,
    "generation" INTEGER NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ExecutorSession_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ExecutorStart" (
    "id" TEXT NOT NULL,
    "invocationId" TEXT NOT NULL,
    "claimId" TEXT NOT NULL,
    "generation" INTEGER NOT NULL,
    "sessionId" TEXT NOT NULL,
    "requestKey" TEXT NOT NULL,
    "requestDigest" TEXT NOT NULL,
    "authorizationDigest" TEXT NOT NULL,
    "artifactDigest" TEXT NOT NULL,
    "startDeadline" TIMESTAMP(3) NOT NULL,
    "resultDeadline" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ExecutorStart_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ExecutorReport" (
    "id" TEXT NOT NULL,
    "startId" TEXT NOT NULL,
    "outcome" "InvocationStatus" NOT NULL,
    "reason" TEXT NOT NULL,
    "result" JSONB,
    "digest" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ExecutorReport_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ExecutorSession_ownerId_deploymentId_sessionKey_key" ON "ExecutorSession"("ownerId", "deploymentId", "sessionKey");

-- CreateIndex
CREATE UNIQUE INDEX "ExecutorSession_ownerId_deploymentId_generation_key" ON "ExecutorSession"("ownerId", "deploymentId", "generation");

-- CreateIndex
CREATE UNIQUE INDEX "ExecutorSession_ownerId_deploymentId_executorPrincipalId_cr_key" ON "ExecutorSession"("ownerId", "deploymentId", "executorPrincipalId", "credentialId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "ExecutorStart_invocationId_key" ON "ExecutorStart"("invocationId");

-- CreateIndex
CREATE UNIQUE INDEX "ExecutorStart_claimId_key" ON "ExecutorStart"("claimId");

-- CreateIndex
CREATE UNIQUE INDEX "ExecutorReport_startId_digest_key" ON "ExecutorReport"("startId", "digest");

-- CreateIndex
CREATE UNIQUE INDEX "TrustedResourceBinding_ownerId_deploymentId_id_key" ON "TrustedResourceBinding"("ownerId", "deploymentId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "ExecutorClaim_invocationId_id_generation_sessionId_key" ON "ExecutorClaim"("invocationId", "id", "generation", "sessionId");

-- AddForeignKey
ALTER TABLE "ExecutorClaim" ADD CONSTRAINT "ExecutorClaim_ownerId_deploymentId_executorPrincipalId_cre_fkey" FOREIGN KEY ("ownerId", "deploymentId", "executorPrincipalId", "credentialId", "sessionId") REFERENCES "ExecutorSession"("ownerId", "deploymentId", "executorPrincipalId", "credentialId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExecutorSession" ADD CONSTRAINT "ExecutorSession_ownerId_deploymentId_fkey" FOREIGN KEY ("ownerId", "deploymentId") REFERENCES "ExecutorDeployment"("ownerId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExecutorSession" ADD CONSTRAINT "ExecutorSession_ownerId_executorPrincipalId_fkey" FOREIGN KEY ("ownerId", "executorPrincipalId") REFERENCES "Principal"("ownerId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExecutorSession" ADD CONSTRAINT "ExecutorSession_executorPrincipalId_credentialId_fkey" FOREIGN KEY ("executorPrincipalId", "credentialId") REFERENCES "Credential"("principalId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExecutorSession" ADD CONSTRAINT "ExecutorSession_ownerId_deploymentId_bindingId_fkey" FOREIGN KEY ("ownerId", "deploymentId", "bindingId") REFERENCES "TrustedResourceBinding"("ownerId", "deploymentId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExecutorStart" ADD CONSTRAINT "ExecutorStart_invocationId_fkey" FOREIGN KEY ("invocationId") REFERENCES "Invocation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExecutorStart" ADD CONSTRAINT "ExecutorStart_invocationId_claimId_generation_sessionId_fkey" FOREIGN KEY ("invocationId", "claimId", "generation", "sessionId") REFERENCES "ExecutorClaim"("invocationId", "id", "generation", "sessionId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExecutorReport" ADD CONSTRAINT "ExecutorReport_startId_fkey" FOREIGN KEY ("startId") REFERENCES "ExecutorStart"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
-- Reviewed start protocol: a claim alone still never authorizes execution.
ALTER TABLE "ExecutorClaim" DROP CONSTRAINT "ExecutorClaim_start_disabled";
ALTER TABLE "TrustedResourceBinding" ADD CONSTRAINT "TrustedResourceBinding_execution_profile" CHECK (
  ("executionProfile" IS NULL AND "ledgerId" IS NULL) OR
  ("executionProfile" IS NOT NULL AND "executionProfile" = 'docker-health-ping-v1' AND "ledgerId" IS NOT NULL AND "ledgerId" ~ '^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$')
);
CREATE UNIQUE INDEX "ExecutorSession_one_active" ON "ExecutorSession"("ownerId", "deploymentId") WHERE active;
ALTER TABLE "ExecutorSession" ADD CONSTRAINT "ExecutorSession_positive_generation" CHECK (generation > 0);

CREATE FUNCTION guard_executor_session() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE expected INTEGER;
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'Session history is immutable'; END IF;
  IF TG_OP = 'INSERT' THEN
    PERFORM 1 FROM "ExecutorDeployment" WHERE id = NEW."deploymentId" FOR UPDATE;
    SELECT COALESCE(MAX(generation),0)+1 INTO expected FROM "ExecutorSession" WHERE "deploymentId"=NEW."deploymentId";
    IF NEW.generation <> expected OR NOT NEW.active THEN RAISE EXCEPTION 'Invalid session generation'; END IF;
  ELSIF NOT OLD.active OR NEW.active OR (to_jsonb(OLD)-'active') <> (to_jsonb(NEW)-'active') THEN
    RAISE EXCEPTION 'Session identity cannot be changed or reactivated';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER executor_session_guard BEFORE INSERT OR UPDATE OR DELETE ON "ExecutorSession" FOR EACH ROW EXECUTE FUNCTION guard_executor_session();

CREATE OR REPLACE FUNCTION guard_executor_claim() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE current_status "InvocationStatus"; expected_generation INTEGER;
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'Claim history cannot be deleted'; END IF;
  SELECT status INTO current_status FROM "Invocation" WHERE id = NEW."invocationId" FOR UPDATE;
  IF TG_OP='UPDATE' AND OLD."startAuthorizedAt" IS NULL AND NEW."startAuthorizedAt" IS NOT NULL THEN
    IF current_status <> 'CLAIMED' OR OLD.status <> 'ACTIVE' OR
       (to_jsonb(OLD)-ARRAY['startAuthorizedAt','updatedAt']) <> (to_jsonb(NEW)-ARRAY['startAuthorizedAt','updatedAt']) OR
       NOT EXISTS (SELECT 1 FROM "ExecutorStart" WHERE "claimId"=NEW.id AND "createdAt"=NEW."startAuthorizedAt") THEN
      RAISE EXCEPTION 'Start marker requires exact atomic start authorization';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW."startAuthorizedAt" IS NOT NULL OR current_status NOT IN ('READY','CLAIMED') OR EXISTS (
    SELECT 1 FROM "InvocationEvent" WHERE "invocationId"=NEW."invocationId" AND
    (status IN ('START_AUTHORIZED','RUNNING','SUCCEEDED','FAILED','UNKNOWN') OR kind='START_AUTHORIZED')
  ) THEN RAISE EXCEPTION 'Potentially started Invocations cannot be reclaimed'; END IF;
  IF TG_OP='INSERT' THEN
    SELECT COALESCE(MAX(generation),0)+1 INTO expected_generation FROM "ExecutorClaim" WHERE "invocationId"=NEW."invocationId";
    IF current_status <> 'READY' OR NEW.status <> 'ACTIVE' OR NEW.generation <> expected_generation OR
       NOT EXISTS (SELECT 1 FROM "ExternalRun" WHERE id=NEW."runId" AND status='RUNNING') THEN
      RAISE EXCEPTION 'Invalid pre-start claim or generation';
    END IF;
  ELSIF current_status <> 'CLAIMED' OR OLD.status <> 'ACTIVE' OR
       (to_jsonb(OLD)-ARRAY['status','leaseExpiresAt','updatedAt','closedAt']) <> (to_jsonb(NEW)-ARRAY['status','leaseExpiresAt','updatedAt','closedAt']) THEN
    RAISE EXCEPTION 'Claim identity and closed claims are immutable';
  END IF;
  RETURN NEW;
END;
$$;
CREATE FUNCTION check_atomic_executor_start() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM "ExecutorClaim" c JOIN "Invocation" i ON i.id=c."invocationId"
    WHERE c.id=NEW."claimId" AND c."startAuthorizedAt"=NEW."createdAt" AND i.status='START_AUTHORIZED') OR
     NOT EXISTS (SELECT 1 FROM "InvocationEvent" WHERE "startId"=NEW.id AND kind='START_AUTHORIZED') THEN
    RAISE EXCEPTION 'Start authorization, marker, state and event must commit together';
  END IF;
  RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER atomic_executor_start AFTER INSERT ON "ExecutorStart" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_atomic_executor_start();
CREATE TRIGGER immutable_executor_start BEFORE UPDATE OR DELETE ON "ExecutorStart" FOR EACH ROW EXECUTE FUNCTION reject_published_revision_change();
CREATE TRIGGER immutable_executor_report BEFORE UPDATE OR DELETE ON "ExecutorReport" FOR EACH ROW EXECUTE FUNCTION reject_published_revision_change();
ALTER TABLE "ExecutorReport" ADD CONSTRAINT "ExecutorReport_supported_outcome" CHECK (
  (outcome='UNKNOWN' AND result IS NULL) OR (outcome='SUCCEEDED' AND result='{"ok":true,"tool":"health_ping","version":1}'::jsonb)
);
