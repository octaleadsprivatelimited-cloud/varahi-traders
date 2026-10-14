import crypto from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PrismaPersistence } from "../src/persistence.js";
import { CommerceStore } from "../src/store.js";

const enabled = process.env.RUN_DB_TESTS === "1";
describe.skipIf(!enabled)("MySQL persistence", () => {
  const persistence = new PrismaPersistence();
  const store = new CommerceStore();
  let variantId = "",
    originalOnHand = 0,
    originalReserved = 0;

  beforeAll(async () => {
    await persistence.connect();
    await persistence.hydrate(store);
    const variant = store.listProducts()[0]!.variants[0]!;
    variantId = variant.id;
    const inventory = await persistence.db.inventory.findUniqueOrThrow({
      where: { variantId },
    });
    originalOnHand = inventory.onHand;
    originalReserved = inventory.reserved;
    await persistence.db.inventory.update({
      where: { variantId },
      data: { onHand: 1, reserved: 0 },
    });
  });

  afterAll(async () => {
    await persistence.db.order.deleteMany({
      where: { idempotencyKey: { startsWith: "db-concurrency-" } },
    });
    await persistence.db.inventory.update({
      where: { variantId },
      data: { onHand: originalOnHand, reserved: originalReserved },
    });
    await persistence.disconnect();
  });

  it("allows only one reservation for the final unit", async () => {
    const { product, variant } = store.getVariant(variantId);
    const makeOrder = (suffix: string) =>
      store.createOrder({
        status: "PAYMENT_PENDING",
        lines: [
          {
            variantId,
            name: product.name,
            sku: variant.sku,
            quantity: 1,
            unitPrice: variant.price,
            tax: (variant.price * product.taxRate) / 100,
          },
        ],
        subtotal: variant.price,
        discount: 0,
        tax: (variant.price * product.taxRate) / 100,
        shipping: 0,
        total: variant.price * (1 + product.taxRate / 100),
        idempotencyKey: `db-concurrency-${suffix}-${crypto.randomUUID()}`,
      });
    const results = await Promise.allSettled([
      persistence.saveOrderAndReservations(makeOrder("a"), "500081", "cod"),
      persistence.saveOrderAndReservations(makeOrder("b"), "500081", "cod"),
    ]);
    expect(
      results.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(1);
    expect(
      results.filter((result) => result.status === "rejected"),
    ).toHaveLength(1);
    const inventory = await persistence.db.inventory.findUniqueOrThrow({
      where: { variantId },
    });
    expect(inventory.reserved).toBe(1);
  });
});
