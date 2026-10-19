CREATE TABLE "EvalRun" (
  "id" TEXT NOT NULL,
  "caseId" TEXT NOT NULL,
  "caseRevision" TEXT NOT NULL,
  "caseDefinition" JSONB NOT NULL,
  "taskRunId" TEXT NOT NULL,
  "result" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "completedAt" TIMESTAMP(3),
  CONSTRAINT "EvalRun_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "EvalRun_taskRunId_key" ON "EvalRun"("taskRunId");
CREATE INDEX "EvalRun_caseId_createdAt_idx" ON "EvalRun"("caseId", "createdAt");
ALTER TABLE "EvalRun" ADD CONSTRAINT "EvalRun_taskRunId_fkey" FOREIGN KEY ("taskRunId") REFERENCES "TaskRun"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
