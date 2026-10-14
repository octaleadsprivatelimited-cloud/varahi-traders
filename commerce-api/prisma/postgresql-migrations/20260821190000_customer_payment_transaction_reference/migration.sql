-- Preserve the gateway's captured/payment transaction identifier separately
-- from the provider order reference stored in externalId.
ALTER TABLE "Payment" ADD COLUMN "gatewayTransactionId" TEXT;
