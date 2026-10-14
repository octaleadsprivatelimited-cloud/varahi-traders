ALTER TABLE "InventoryMovement"
ADD COLUMN "idempotencyKey" TEXT;

CREATE UNIQUE INDEX "InventoryMovement_idempotencyKey_key"
ON "InventoryMovement"("idempotencyKey");
