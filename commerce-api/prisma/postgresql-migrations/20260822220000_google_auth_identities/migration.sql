-- Persist third-party identities by their provider-issued stable subject.
-- Existing email-only Google sign-ins cannot be safely backfilled because the
-- Google subject was not previously stored; those accounts must link again.
ALTER TYPE "ProviderKind" ADD VALUE IF NOT EXISTS 'AUTH';

-- Passwordless provider accounts keep an opaque internal hash, so track
-- whether password authentication is actually available to the customer.
ALTER TABLE "User"
    ADD COLUMN "passwordEnabled" BOOLEAN NOT NULL DEFAULT true;

CREATE TABLE "AuthIdentity" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "provider" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "audience" TEXT NOT NULL,
    "email" TEXT,
    "lastAuthenticatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AuthIdentity_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "AuthIdentity_provider_subject_key"
    ON "AuthIdentity"("provider", "subject");
CREATE UNIQUE INDEX "AuthIdentity_userId_provider_key"
    ON "AuthIdentity"("userId", "provider");
CREATE INDEX "AuthIdentity_userId_idx" ON "AuthIdentity"("userId");

ALTER TABLE "AuthIdentity"
    ADD CONSTRAINT "AuthIdentity_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
