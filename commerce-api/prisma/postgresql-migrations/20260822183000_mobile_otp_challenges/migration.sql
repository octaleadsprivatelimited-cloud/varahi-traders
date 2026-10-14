CREATE TABLE "MobileOtpChallenge" (
    "mobile" VARCHAR(16) NOT NULL,
    "codeHash" CHAR(64) NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "resendAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MobileOtpChallenge_pkey" PRIMARY KEY ("mobile")
);

CREATE INDEX "MobileOtpChallenge_expiresAt_idx"
ON "MobileOtpChallenge"("expiresAt");
