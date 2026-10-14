import crypto from "node:crypto";
import { describe, expect, it } from "vitest";
import { PrismaPersistence } from "../src/persistence.js";
import { CommerceStore } from "../src/store.js";
import { couponBenefit } from "../src/coupon-policy.js";

describe.skipIf(process.env.RUN_DB_TESTS !== "1")("persisted product coupons", () => {
  it("retains selected products across reloads and rejects a changed rule before reserving inventory", async () => {
    const p = new PrismaPersistence(), code = `SCOPE-${crypto.randomUUID().slice(0, 20)}`;
    try {
      const store = new CommerceStore(); await p.hydrate(store);
      const product = store.listProducts().find(item => item.variants.some(variant => variant.price > 0))!;
      const variant = product.variants.find(item => item.price > 0)!;
      const coupon = { code, type: "PERCENTAGE" as const, value: 10, minimumSpend: 0, startsAt: Date.now() - 60000, endsAt: Date.now() + 86400000, enabled: true, used: 0, perUserLimit: 1, appliesTo: "SELECTED_PRODUCTS" as const, productIds: [product.id] };
      await p.saveCoupon({ ...coupon, maximumDiscount: 5, usageLimit: 10 });
      await p.saveCoupon(coupon);
      expect(await p.db.coupon.findUnique({ where: { code } })).toMatchObject({ maximumDiscount: null, usageLimit: null });
      const reloaded = new CommerceStore(); await p.hydrate(reloaded);
      expect(reloaded.coupons.get(code)).toMatchObject({ appliesTo: "SELECTED_PRODUCTS", productIds: [product.id] });
      const discount = couponBenefit(reloaded.coupons.get(code), [{ productId: product.id, unitPrice: variant.price, quantity: 1 }]).discount;
      const order = store.createOrder({ status: "PAYMENT_PENDING", lines: [{ variantId: variant.id, name: product.name, sku: variant.sku, quantity: 1, unitPrice: variant.price, tax: 0 }], subtotal: variant.price, discount, tax: 0, shipping: 0, total: variant.price - discount, idempotencyKey: `coupon-scope:${crypto.randomUUID()}` });
      await p.saveCoupon({ ...coupon, value: 20 });
      await expect(p.saveOrderAndReservations(order, "500081", "cod", code)).rejects.toMatchObject({ code: "CHECKOUT_PRICE_CHANGED" });
      await p.saveCoupon({ ...coupon, type: "FIXED_AMOUNT", value: 0 });
      const shippingOrder = { ...order, discount: 0, invoiceSnapshot: { discounts: { coupon: 0, couponFreeShipping: true, onlinePayment: 0 } } };
      await expect(p.saveOrderAndReservations(shippingOrder, "500081", "cod", code)).rejects.toMatchObject({ code: "CHECKOUT_PRICE_CHANGED" });
      expect(await p.db.order.findUnique({ where: { id: order.id } })).toBeNull();
      await p.saveCoupon({ ...coupon, appliesTo: "ALL_PRODUCTS" });
      const all = new CommerceStore(); await p.hydrate(all);
      expect(all.coupons.get(code)).toMatchObject({ appliesTo: "ALL_PRODUCTS", productIds: [] });
    } finally {
      await p.db.coupon.deleteMany({ where: { code } }); await p.disconnect();
    }
  });
});
