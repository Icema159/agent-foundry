ALTER TYPE "ExecutionStatus" ADD VALUE 'WAITING_FOR_APPROVAL';

CREATE TYPE "ApprovalStatus" AS ENUM ('PENDING', 'APPROVED', 'DENIED');

ALTER TYPE "StepKind" ADD VALUE 'APPROVAL_REQUIRED';
ALTER TYPE "StepKind" ADD VALUE 'APPROVAL_APPROVED';
ALTER TYPE "StepKind" ADD VALUE 'APPROVAL_DENIED';

ALTER TABLE "AgentVersion" RENAME COLUMN "allowedToolNames" TO "toolPolicies";

UPDATE "AgentVersion"
SET "toolPolicies" = COALESCE(
  (
    SELECT jsonb_object_agg(name, to_jsonb('ALLOW'::text))
    FROM jsonb_array_elements_text("toolPolicies") AS tools(name)
  ),
  '{}'::jsonb
);

CREATE TABLE "Approval" (
  "id" TEXT NOT NULL,
  "taskRunId" TEXT NOT NULL,
  "toolName" TEXT NOT NULL,
  "validatedArguments" JSONB NOT NULL,
  "resumeMessages" JSONB NOT NULL,
  "runtimeStep" INTEGER NOT NULL,
  "status" "ApprovalStatus" NOT NULL DEFAULT 'PENDING',
  "requestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "decidedAt" TIMESTAMP(3),
  "consumedAt" TIMESTAMP(3),
  CONSTRAINT "Approval_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "Approval_status_requestedAt_idx" ON "Approval"("status", "requestedAt");
CREATE INDEX "Approval_taskRunId_requestedAt_idx" ON "Approval"("taskRunId", "requestedAt");

ALTER TABLE "Approval" ADD CONSTRAINT "Approval_taskRunId_fkey"
FOREIGN KEY ("taskRunId") REFERENCES "TaskRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;
