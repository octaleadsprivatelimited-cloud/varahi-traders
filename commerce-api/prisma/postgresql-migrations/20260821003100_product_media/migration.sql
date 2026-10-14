ALTER TABLE "Product"
ADD COLUMN "specifications" JSONB NOT NULL DEFAULT '{}',
ADD COLUMN "seoTitle" TEXT,
ADD COLUMN "seoDescription" TEXT;

CREATE TABLE "ProductMedia" (
  "id" UUID NOT NULL,
  "productId" UUID NOT NULL,
  "variantId" UUID,
  "url" TEXT NOT NULL,
  "alt" TEXT NOT NULL,
  "type" TEXT NOT NULL DEFAULT 'IMAGE',
  "position" INTEGER NOT NULL DEFAULT 0,
  CONSTRAINT "ProductMedia_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ProductMedia_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "ProductMedia_variantId_fkey" FOREIGN KEY ("variantId") REFERENCES "ProductVariant"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX "ProductMedia_productId_position_idx" ON "ProductMedia"("productId", "position");
CREATE INDEX "ProductMedia_variantId_idx" ON "ProductMedia"("variantId");
