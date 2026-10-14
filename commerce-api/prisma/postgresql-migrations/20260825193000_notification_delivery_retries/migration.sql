ALTER TABLE "Notification"
  ADD COLUMN "attempts" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  ADD COLUMN "lockedAt" TIMESTAMP(3);

DROP INDEX "Notification_status_createdAt_idx";
CREATE INDEX "Notification_status_nextAttemptAt_createdAt_idx"
  ON "Notification"("status", "nextAttemptAt", "createdAt");
