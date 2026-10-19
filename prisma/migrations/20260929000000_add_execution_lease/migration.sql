ALTER TABLE "TaskRun"
ADD COLUMN "workerId" TEXT,
ADD COLUMN "heartbeatAt" TIMESTAMP(3),
ADD COLUMN "recoveryCount" INTEGER NOT NULL DEFAULT 0;

CREATE INDEX "TaskRun_status_heartbeatAt_idx" ON "TaskRun"("status", "heartbeatAt");
