-- CreateEnum
CREATE TYPE "DeliverySource" AS ENUM ('SUBMISSION', 'APPROVAL', 'RECOVERY');

-- CreateEnum
CREATE TYPE "DeliveryOutcome" AS ENUM ('UNCONFIRMED', 'CONFIRMED', 'NOT_SENT', 'ACK_UNKNOWN');

-- AlterTable
ALTER TABLE "TaskRun" ADD COLUMN     "deliveryId" TEXT;

-- CreateTable
CREATE TABLE "TaskRunDelivery" (
    "id" TEXT NOT NULL,
    "taskRunId" TEXT NOT NULL,
    "source" "DeliverySource" NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "claimedAt" TIMESTAMP(3),

    CONSTRAINT "TaskRunDelivery_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TaskRunDeliveryAttempt" (
    "id" TEXT NOT NULL,
    "deliveryId" TEXT NOT NULL,
    "actor" TEXT NOT NULL,
    "manual" BOOLEAN NOT NULL,
    "outcome" "DeliveryOutcome" NOT NULL DEFAULT 'UNCONFIRMED',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),

    CONSTRAINT "TaskRunDeliveryAttempt_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "TaskRunDelivery_taskRunId_createdAt_idx" ON "TaskRunDelivery"("taskRunId", "createdAt");

-- CreateIndex
CREATE INDEX "TaskRunDeliveryAttempt_deliveryId_createdAt_idx" ON "TaskRunDeliveryAttempt"("deliveryId", "createdAt");

-- AddForeignKey
ALTER TABLE "TaskRunDelivery" ADD CONSTRAINT "TaskRunDelivery_taskRunId_fkey" FOREIGN KEY ("taskRunId") REFERENCES "TaskRun"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TaskRunDeliveryAttempt" ADD CONSTRAINT "TaskRunDeliveryAttempt_deliveryId_fkey" FOREIGN KEY ("deliveryId") REFERENCES "TaskRunDelivery"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

