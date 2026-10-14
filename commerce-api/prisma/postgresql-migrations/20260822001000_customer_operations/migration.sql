ALTER TABLE "User"
ADD COLUMN "tags" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
ADD COLUMN "note" TEXT,
ADD COLUMN "marketingConsent" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN "marketingConsentUpdatedAt" TIMESTAMP(3),
ADD COLUMN "authVersion" INTEGER NOT NULL DEFAULT 0;

UPDATE "User"
SET "authVersion" = 1
WHERE "role" = 'CUSTOMER' AND "disabledAt" IS NOT NULL;

UPDATE "Session"
SET "revokedAt" = NOW()
WHERE "revokedAt" IS NULL
  AND "userId" IN (
    SELECT "id" FROM "User"
    WHERE "role" = 'CUSTOMER' AND "disabledAt" IS NOT NULL
  );

CREATE INDEX "User_role_disabledAt_createdAt_idx"
ON "User"("role", "disabledAt", "createdAt");

CREATE INDEX "User_role_marketingConsent_createdAt_idx"
ON "User"("role", "marketingConsent", "createdAt");

CREATE INDEX "ReturnRequest_status_createdAt_idx"
ON "ReturnRequest"("status", "createdAt");

CREATE INDEX "Review_status_createdAt_idx"
ON "Review"("status", "createdAt");

CREATE INDEX "Review_userId_createdAt_idx"
ON "Review"("userId", "createdAt");
