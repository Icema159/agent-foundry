-- AlterTable
ALTER TABLE "InvocationEvent" ADD COLUMN     "findingId" TEXT;

-- CreateTable
CREATE TABLE "ExecutorLedgerAnchor" (
    "bindingId" TEXT NOT NULL,
    "proofDigest" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ExecutorLedgerAnchor_pkey" PRIMARY KEY ("bindingId")
);

-- CreateTable
CREATE TABLE "OperatorFinding" (
    "id" TEXT NOT NULL,
    "invocationId" TEXT NOT NULL,
    "ownerId" TEXT NOT NULL,
    "actorPrincipalId" TEXT NOT NULL,
    "credentialId" TEXT NOT NULL,
    "requestKey" TEXT NOT NULL,
    "requestDigest" TEXT NOT NULL,
    "basisSequence" BIGINT NOT NULL,
    "decision" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "evidence" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OperatorFinding_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "OperatorFinding_ownerId_invocationId_requestKey_key" ON "OperatorFinding"("ownerId", "invocationId", "requestKey");

-- CreateIndex
CREATE UNIQUE INDEX "OperatorFinding_invocationId_basisSequence_key" ON "OperatorFinding"("invocationId", "basisSequence");

-- AddForeignKey
ALTER TABLE "ExecutorLedgerAnchor" ADD CONSTRAINT "ExecutorLedgerAnchor_bindingId_fkey" FOREIGN KEY ("bindingId") REFERENCES "TrustedResourceBinding"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OperatorFinding" ADD CONSTRAINT "OperatorFinding_invocationId_fkey" FOREIGN KEY ("invocationId") REFERENCES "Invocation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OperatorFinding" ADD CONSTRAINT "OperatorFinding_ownerId_actorPrincipalId_fkey" FOREIGN KEY ("ownerId", "actorPrincipalId") REFERENCES "Principal"("ownerId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OperatorFinding" ADD CONSTRAINT "OperatorFinding_actorPrincipalId_credentialId_fkey" FOREIGN KEY ("actorPrincipalId", "credentialId") REFERENCES "Credential"("principalId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;


ALTER TABLE "ExecutorLedgerAnchor" ADD CONSTRAINT "ExecutorLedgerAnchor_digest" CHECK ("proofDigest" ~ '^[a-f0-9]{64}$');
CREATE FUNCTION guard_ledger_anchor() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM 1 FROM "TrustedResourceBinding" WHERE id=NEW."bindingId" FOR UPDATE;
  IF EXISTS (SELECT 1 FROM "ExecutorSession" WHERE "bindingId"=NEW."bindingId") THEN
    RAISE EXCEPTION 'Historical installations require explicit recovery, not a new continuity baseline';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER ledger_anchor_insert BEFORE INSERT ON "ExecutorLedgerAnchor" FOR EACH ROW EXECUTE FUNCTION guard_ledger_anchor();
CREATE TRIGGER immutable_ledger_anchor BEFORE UPDATE OR DELETE ON "ExecutorLedgerAnchor" FOR EACH ROW EXECUTE FUNCTION reject_published_revision_change();

ALTER TABLE "OperatorFinding" ADD CONSTRAINT "OperatorFinding_decision" CHECK (decision IN ('RETAIN_UNKNOWN','CONFLICTING_EVIDENCE','RECOVERY_BLOCKED') AND length(reason) BETWEEN 1 AND 1000);
CREATE FUNCTION guard_operator_finding() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM 1 FROM "Invocation" WHERE id=NEW."invocationId" FOR UPDATE;
  IF NOT EXISTS (SELECT 1 FROM "Invocation" WHERE id=NEW."invocationId" AND "ownerId"=NEW."ownerId" AND status='UNKNOWN') OR
     NOT EXISTS (SELECT 1 FROM "Principal" p JOIN "Credential" c ON c."principalId"=p.id
       WHERE p.id=NEW."actorPrincipalId" AND p.type='OPERATOR' AND p."ownerId"=NEW."ownerId" AND c.id=NEW."credentialId"
       AND c."revokedAt" IS NULL AND c."expiresAt">(clock_timestamp() AT TIME ZONE 'UTC') AND 'operator:reconcile'=ANY(c.scopes)) OR
     NEW."basisSequence" IS DISTINCT FROM (SELECT MAX(sequence) FROM "InvocationEvent" WHERE "invocationId"=NEW."invocationId") THEN
    RAISE EXCEPTION 'Operator finding requires current owner-scoped unresolved evidence';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER operator_finding_guard BEFORE INSERT ON "OperatorFinding" FOR EACH ROW EXECUTE FUNCTION guard_operator_finding();
CREATE TRIGGER immutable_operator_finding BEFORE UPDATE OR DELETE ON "OperatorFinding" FOR EACH ROW EXECUTE FUNCTION reject_published_revision_change();
CREATE FUNCTION check_atomic_operator_finding() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM "InvocationEvent" WHERE "findingId"=NEW.id AND "invocationId"=NEW."invocationId" AND kind='OPERATOR_FINDING'
    AND status='UNKNOWN' AND "actorPrincipalId"=NEW."actorPrincipalId") THEN RAISE EXCEPTION 'Operator finding and event must commit together'; END IF;
  RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER atomic_operator_finding AFTER INSERT ON "OperatorFinding" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_atomic_operator_finding();

CREATE INDEX "InvocationEvent_invocationId_sequence_idx" ON "InvocationEvent"("invocationId", "sequence");
