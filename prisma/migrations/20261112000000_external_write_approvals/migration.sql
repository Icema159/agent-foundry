-- AlterTable
ALTER TABLE "TrustedResourceBinding" ADD COLUMN     "outputResource" TEXT;

-- AlterTable
ALTER TABLE "InvocationEvent" ADD COLUMN     "externalApprovalId" TEXT;

-- CreateTable
CREATE TABLE "ExternalApprovalRequest" (
    "id" TEXT NOT NULL,
    "invocationId" TEXT NOT NULL,
    "ownerId" TEXT NOT NULL,
    "authorizationDigest" TEXT NOT NULL,
    "identity" JSONB NOT NULL,
    "digest" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ExternalApprovalRequest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ExternalApprovalDecision" (
    "approvalId" TEXT NOT NULL,
    "ownerId" TEXT NOT NULL,
    "actorPrincipalId" TEXT NOT NULL,
    "credentialId" TEXT NOT NULL,
    "requestKey" TEXT NOT NULL,
    "requestDigest" TEXT NOT NULL,
    "decision" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ExternalApprovalDecision_pkey" PRIMARY KEY ("approvalId")
);

-- CreateTable
CREATE TABLE "ExternalApprovalConsumption" (
    "approvalId" TEXT NOT NULL,
    "startId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ExternalApprovalConsumption_pkey" PRIMARY KEY ("approvalId")
);

-- CreateIndex
CREATE UNIQUE INDEX "ExternalApprovalRequest_invocationId_key" ON "ExternalApprovalRequest"("invocationId");

-- CreateIndex
CREATE UNIQUE INDEX "ExternalApprovalConsumption_startId_key" ON "ExternalApprovalConsumption"("startId");

-- AddForeignKey
ALTER TABLE "ExternalApprovalRequest" ADD CONSTRAINT "ExternalApprovalRequest_invocationId_fkey" FOREIGN KEY ("invocationId") REFERENCES "Invocation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExternalApprovalDecision" ADD CONSTRAINT "ExternalApprovalDecision_approvalId_fkey" FOREIGN KEY ("approvalId") REFERENCES "ExternalApprovalRequest"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExternalApprovalDecision" ADD CONSTRAINT "ExternalApprovalDecision_ownerId_actorPrincipalId_fkey" FOREIGN KEY ("ownerId", "actorPrincipalId") REFERENCES "Principal"("ownerId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExternalApprovalDecision" ADD CONSTRAINT "ExternalApprovalDecision_actorPrincipalId_credentialId_fkey" FOREIGN KEY ("actorPrincipalId", "credentialId") REFERENCES "Credential"("principalId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExternalApprovalConsumption" ADD CONSTRAINT "ExternalApprovalConsumption_approvalId_fkey" FOREIGN KEY ("approvalId") REFERENCES "ExternalApprovalRequest"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExternalApprovalConsumption" ADD CONSTRAINT "ExternalApprovalConsumption_startId_fkey" FOREIGN KEY ("startId") REFERENCES "ExecutorStart"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


ALTER TABLE "TrustedResourceBinding" DROP CONSTRAINT "TrustedResourceBinding_mode";
ALTER TABLE "TrustedResourceBinding" DROP CONSTRAINT "TrustedResourceBinding_execution_profile";
ALTER TABLE "TrustedResourceBinding" ADD CONSTRAINT "TrustedResourceBinding_mode" CHECK (mode IN ('RESOURCE_FREE_READ_ONLY_V1','DEMO_RECEIPT_WRITE_V1'));
ALTER TABLE "TrustedResourceBinding" ADD CONSTRAINT "TrustedResourceBinding_execution_profile" CHECK (COALESCE(
 (mode='RESOURCE_FREE_READ_ONLY_V1' AND "outputResource" IS NULL AND (("executionProfile" IS NULL AND "ledgerId" IS NULL) OR
   ("executionProfile"='docker-health-ping-v1' AND "ledgerId" ~ '^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$'))) OR
 (mode='DEMO_RECEIPT_WRITE_V1' AND "executionProfile"='docker-demo-receipt-v1' AND
   "ledgerId" ~ '^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$' AND
   "outputResource" ~ '^foundry:demo-output:[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$'),FALSE));

CREATE FUNCTION guard_external_approval_request() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NOT EXISTS (SELECT 1 FROM "Invocation" i JOIN "InvocationAuthorization" a ON a."invocationId"=i.id
  JOIN "TrustedResourceBinding" b ON b.id=a."bindingId" JOIN "Credential" c ON c.id=a."credentialId"
  WHERE i.id=NEW."invocationId" AND i."ownerId"=NEW."ownerId" AND i.status='PENDING_APPROVAL' AND i.arguments='{}'::jsonb
   AND a.digest=NEW."authorizationDigest" AND b.mode='DEMO_RECEIPT_WRITE_V1'
   AND NEW."expiresAt">(clock_timestamp() AT TIME ZONE 'UTC') AND NEW."expiresAt"<=b."expiresAt" AND NEW."expiresAt"<=c."expiresAt"
   AND NEW.identity->>'invocationId'=i.id AND NEW.identity->>'authorizationDigest'=a.digest
   AND NEW.identity->'action'->>'resource'=b."outputResource" AND NEW.identity->'action'->>'target'='receipt-'||i.id||'.txt') THEN
  RAISE EXCEPTION 'External approval must bind exact pending WRITE request';
 END IF; RETURN NEW;
END; $$;
CREATE TRIGGER external_approval_request_guard BEFORE INSERT ON "ExternalApprovalRequest" FOR EACH ROW EXECUTE FUNCTION guard_external_approval_request();
CREATE TRIGGER immutable_external_approval_request BEFORE UPDATE OR DELETE ON "ExternalApprovalRequest" FOR EACH ROW EXECUTE FUNCTION reject_published_revision_change();
CREATE TRIGGER immutable_external_approval_decision BEFORE UPDATE OR DELETE ON "ExternalApprovalDecision" FOR EACH ROW EXECUTE FUNCTION reject_published_revision_change();
CREATE TRIGGER immutable_external_approval_consumption BEFORE UPDATE OR DELETE ON "ExternalApprovalConsumption" FOR EACH ROW EXECUTE FUNCTION reject_published_revision_change();
ALTER TABLE "ExternalApprovalDecision" ADD CONSTRAINT "ExternalApprovalDecision_fields" CHECK (decision IN ('APPROVE','REJECT') AND length(reason) BETWEEN 1 AND 1000 AND length("requestKey") BETWEEN 1 AND 128);
CREATE FUNCTION guard_external_approval_decision() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NOT EXISTS (SELECT 1 FROM "ExternalApprovalRequest" a JOIN "Invocation" i ON i.id=a."invocationId" JOIN "ExternalRun" r ON r.id=i."runId"
  JOIN "Principal" p ON p.id=NEW."actorPrincipalId" JOIN "Credential" c ON c.id=NEW."credentialId" AND c."principalId"=p.id
  WHERE a.id=NEW."approvalId" AND i.status='PENDING_APPROVAL' AND r.status='RUNNING' AND i."ownerId"=NEW."ownerId" AND a."ownerId"=NEW."ownerId"
   AND p.type='OPERATOR' AND p."ownerId"=NEW."ownerId" AND c."revokedAt" IS NULL AND c."expiresAt">(clock_timestamp() AT TIME ZONE 'UTC')
   AND 'operator:approve'=ANY(c.scopes) AND (NEW.decision='REJECT' OR a."expiresAt">(clock_timestamp() AT TIME ZONE 'UTC'))) THEN
  RAISE EXCEPTION 'External decision requires current explicit operator authority';
 END IF; RETURN NEW;
END; $$;
CREATE TRIGGER external_approval_decision_guard BEFORE INSERT ON "ExternalApprovalDecision" FOR EACH ROW EXECUTE FUNCTION guard_external_approval_decision();
CREATE FUNCTION check_atomic_external_decision() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NOT EXISTS (SELECT 1 FROM "ExternalApprovalRequest" a JOIN "Invocation" i ON i.id=a."invocationId" JOIN "InvocationEvent" e ON e."invocationId"=i.id
  WHERE a.id=NEW."approvalId" AND e."externalApprovalId"=a.id AND e."actorPrincipalId"=NEW."actorPrincipalId"
   AND ((NEW.decision='APPROVE' AND i.status='READY' AND e.status='READY' AND e.kind='EXTERNAL_APPROVAL_APPROVED') OR
        (NEW.decision='REJECT' AND i.status='REVOKED' AND e.status='REVOKED' AND e.kind='EXTERNAL_APPROVAL_REJECTED'))) THEN
  RAISE EXCEPTION 'External decision, state and event must commit atomically';
 END IF; RETURN NULL;
END; $$;
CREATE CONSTRAINT TRIGGER atomic_external_decision AFTER INSERT ON "ExternalApprovalDecision" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_atomic_external_decision();
CREATE FUNCTION guard_external_approval_consumption() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NOT EXISTS (SELECT 1 FROM "ExternalApprovalRequest" a JOIN "ExternalApprovalDecision" d ON d."approvalId"=a.id
  JOIN "ExecutorStart" s ON s.id=NEW."startId" AND s."invocationId"=a."invocationId" JOIN "Invocation" i ON i.id=s."invocationId"
  JOIN "Credential" c ON c.id=d."credentialId" JOIN "Principal" p ON p.id=c."principalId"
  WHERE a.id=NEW."approvalId" AND a."authorizationDigest"=s."authorizationDigest" AND i.status='CLAIMED' AND d.decision='APPROVE'
   AND a."expiresAt">(clock_timestamp() AT TIME ZONE 'UTC') AND c."revokedAt" IS NULL AND c."expiresAt">(clock_timestamp() AT TIME ZONE 'UTC')
   AND p.type='OPERATOR' AND p."ownerId"=i."ownerId" AND 'operator:approve'=ANY(c.scopes)) THEN
  RAISE EXCEPTION 'Only exact live approved start may consume external approval';
 END IF; RETURN NEW;
END; $$;
CREATE TRIGGER external_approval_consumption_guard BEFORE INSERT ON "ExternalApprovalConsumption" FOR EACH ROW EXECUTE FUNCTION guard_external_approval_consumption();
CREATE FUNCTION check_atomic_external_write_start() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF EXISTS (SELECT 1 FROM "InvocationAuthorization" a JOIN "TrustedResourceBinding" b ON b.id=a."bindingId" WHERE a."invocationId"=NEW."invocationId" AND b.mode='DEMO_RECEIPT_WRITE_V1') AND
   NOT EXISTS (SELECT 1 FROM "ExternalApprovalConsumption" c JOIN "ExternalApprovalRequest" a ON a.id=c."approvalId"
    JOIN "InvocationEvent" e ON e."startId"=NEW.id AND e."externalApprovalId"=a.id AND e.kind='EXTERNAL_APPROVAL_CONSUMED'
    WHERE c."startId"=NEW.id AND a."invocationId"=NEW."invocationId") THEN
  RAISE EXCEPTION 'WRITE start and exact approval consumption must commit together';
 END IF; RETURN NULL;
END; $$;
CREATE CONSTRAINT TRIGGER atomic_external_write_start AFTER INSERT ON "ExecutorStart" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_atomic_external_write_start();

ALTER TABLE "ExecutorReport" DROP CONSTRAINT "ExecutorReport_supported_outcome";
ALTER TABLE "ExecutorReport" ADD CONSTRAINT "ExecutorReport_supported_outcome" CHECK ((outcome='UNKNOWN' AND result IS NULL) OR (outcome='SUCCEEDED' AND jsonb_typeof(result)='object'));
CREATE FUNCTION guard_fixed_executor_result() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE expected JSONB; inv_id TEXT; resource TEXT; handler TEXT;
BEGIN
 IF NEW.outcome='UNKNOWN' THEN
  IF NEW.reason NOT IN ('START_RESPONSE_LOST','EXECUTOR_RESTART_UNCERTAIN','HANDLER_OUTCOME_UNKNOWN','START_DEADLINE_EXPIRED') THEN RAISE EXCEPTION 'Unknown uncertainty reason'; END IF;
  RETURN NEW;
 END IF;
 SELECT i.id,b."outputResource",t."handlerId" INTO inv_id,resource,handler FROM "ExecutorStart" s JOIN "Invocation" i ON i.id=s."invocationId"
  JOIN "InvocationAuthorization" a ON a."invocationId"=i.id JOIN "TrustedResourceBinding" b ON b.id=a."bindingId" JOIN "ToolRevision" t ON t.id=i."toolId" WHERE s.id=NEW."startId";
 IF handler='health_ping.v1' AND NEW.reason='HEALTH_PING_RETURNED' THEN expected='{"ok":true,"tool":"health_ping","version":1}'::jsonb;
 ELSIF handler='write_demo_receipt.v1' AND resource IS NOT NULL AND NEW.reason='DEMO_RECEIPT_CREATED' THEN
  expected=jsonb_build_object('tool','write_demo_receipt','version',1,'invocationId',inv_id,'resource',resource,'path','receipt-'||inv_id||'.txt',
   'contentDigest',encode(sha256(convert_to(E'Agent Foundry controlled receipt\nInvocation: '||inv_id||E'\nResource: '||resource||E'\n','UTF8')),'hex'));
 ELSE RAISE EXCEPTION 'Unsupported fixed handler report'; END IF;
 IF NEW.result IS DISTINCT FROM expected THEN RAISE EXCEPTION 'Result does not bind exact controlled handler'; END IF;
 RETURN NEW;
END; $$;
CREATE TRIGGER fixed_executor_result_guard BEFORE INSERT ON "ExecutorReport" FOR EACH ROW EXECUTE FUNCTION guard_fixed_executor_result();
