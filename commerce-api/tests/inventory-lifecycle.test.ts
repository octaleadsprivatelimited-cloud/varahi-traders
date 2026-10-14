import crypto from "node:crypto";
import { describe, expect, it } from "vitest";
import { CommerceStore, seedStore } from "../src/store.js";

function reservedOrder(store: CommerceStore) {
  const variant = [...store.products.values()][0]!.variants[0]!;
  const lines = [{ variantId: variant.id, quantity: 2 }];
  store.reserveMany(lines);
  const order = store.createOrder({
    status: "PAYMENT_PENDING",
    inventoryState: "RESERVED",
    lines: [{
      variantId: variant.id,
      name: "Inventory lifecycle product",
      sku: variant.sku,
      quantity: 2,
      unitPrice: variant.price,
      tax: 0,
    }],
    subtotal: variant.price * 2,
    tax: 0,
    shipping: 0,
    discount: 0,
    total: variant.price * 2,
    idempotencyKey: crypto.randomUUID(),
  });
  return { order, variant };
}

describe("order inventory lifecycle", () => {
  it("commits reserved units exactly once when payment succeeds", () => {
    const store = new CommerceStore();
    seedStore(store);
    const { order, variant } = reservedOrder(store);
    const before = variant.stock;

    store.transitionOrder(order.id, "PAID", undefined, "PAYMENT");
    expect(order.inventoryState).toBe("COMMITTED");
    expect(variant.reserved).toBe(0);
    expect(variant.stock).toBe(before - 2);

    store.transitionOrder(order.id, "PAID", undefined, "PAYMENT");
    expect(variant.stock).toBe(before - 2);
  });

  it("releases failures, re-reserves retries and releases cancellation", () => {
    const store = new CommerceStore();
    seedStore(store);
    const { order, variant } = reservedOrder(store);
    const before = variant.stock;

    store.transitionOrder(order.id, "FAILED", undefined, "PAYMENT");
    expect(order.inventoryState).toBe("RELEASED");
    expect(variant.reserved).toBe(0);
    expect(variant.stock).toBe(before);

    store.transitionOrder(order.id, "PAYMENT_PENDING", undefined, "PAYMENT_RETRY");
    expect(order.inventoryState).toBe("RESERVED");
    expect(variant.reserved).toBe(2);

    store.transitionOrder(order.id, "CANCELLED", undefined, "CUSTOMER");
    expect(order.inventoryState).toBe("RELEASED");
    expect(variant.reserved).toBe(0);
    expect(variant.stock).toBe(before);
  });

  it("restocks committed units when fulfilment is cancelled", () => {
    const store = new CommerceStore();
    seedStore(store);
    const { order, variant } = reservedOrder(store);
    const before = variant.stock;
    store.transitionOrder(order.id, "PAID", undefined, "PAYMENT");
    store.transitionOrder(order.id, "CONFIRMED", undefined, "ADMIN");
    expect(variant.stock).toBe(before - 2);

    store.transitionOrder(order.id, "CANCELLED", undefined, "ADMIN");
    expect(order.inventoryState).toBe("RELEASED");
    expect(variant.stock).toBe(before);
    expect(variant.reserved).toBe(0);
  });
});
