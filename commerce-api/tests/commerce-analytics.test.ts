import { describe, expect, it } from "vitest";
// These browser-only helpers are transformed by Vitest, not compiled into the API.
const catalogSource = "../../src/data/commerce.ts";
const analyticsSource = "../../src/lib/commerce-analytics.ts";
const { products: previewProducts } = await import(catalogSource);
const { analyticsItemsForCart, analyticsItemsForProducts, analyticsPurchase, commerceAmount, discountedCommerceItems, productAnalyticsItem, purchaseIsConfirmed } = await import(analyticsSource);

const product = {
  id: "spice-turmeric", name: "Turmeric Powder", category: "Sesame Oils",
  price: 129, mrp: 149, rating: 0, reviews: 0, glyph: "", tone: "",
  variants: [
    { id: "turmeric-100g", sku: "T100", title: "100 g", options: { Weight: "100 g" }, price: 129, mrp: 149, stock: 3 },
    { id: "turmeric-250g", sku: "T250", title: "250 g", options: { Weight: "250 g" }, price: 279, mrp: 319, stock: 2 },
  ],
};

describe("merchandise analytics values", () => {
  it("uses the selected Merchant variant ID and rupees, preserving actual accepted quantity", () => {
    expect(productAnalyticsItem(product, product.variants![1], 2)).toEqual({
      item_id: "turmeric-250g", item_name: "Turmeric Powder", item_category: "Sesame Oils", item_variant: "250 g", price: 279, quantity: 2,
    });
  });

  it("does not count SSR preview products or unavailable cart options as live events", () => {
    expect(analyticsItemsForProducts(previewProducts)).toEqual([]);
    expect(analyticsItemsForCart([
      { product, variant: product.variants![0], entry: { quantity: 3 }, unresolved: true },
      { product, entry: { quantity: 2 }, unresolved: false },
      { product, variant: product.variants![1], entry: { quantity: 2 }, unresolved: false },
    ])).toEqual([productAnalyticsItem(product, product.variants![1], 2)]);
  });

  it("allocates an order coupon to merchandise and keeps GST/shipping separate", () => {
    const result = analyticsPurchase({
      number: "RS-123", status: "CONFIRMED", subtotal: 537, discount: 53.7, tax: 26.85, shipping: 49, total: 559.15,
      lines: [
        { variantId: "turmeric-100g", name: "Turmeric Powder", unitPrice: 129, quantity: 2 },
        { variantId: "turmeric-250g", name: "Turmeric Powder", unitPrice: 279, quantity: 1 },
      ],
    });
    expect(result.value).toBe(483.3);
    expect(result.tax).toBe(26.85);
    expect(result.shipping).toBe(49);
    expect(result.currency).toBe("INR");
    expect(commerceAmount(result.items.reduce((sum: number, item: { price: number; quantity: number }) => sum + item.price * item.quantity, 0))).toBe(result.value);
  });

  it("never sends private invoice, customer or payment fields even when the server response includes them", () => {
    const response = {
      number: "RS-456", status: "CONFIRMED", subtotal: 129, discount: 0, tax: 6.45, shipping: 49, total: 184.45,
      lines: [{ variantId: "turmeric-100g", name: "Turmeric Powder", unitPrice: 129, quantity: 1 }],
      userId: "private-customer", invoiceSnapshot: { contact: { email: "buyer@example.com", phone: "+919876543210" }, shipping: { line1: "Private address" } },
      paymentAttemptToken: "private-token", trackingVerificationHash: "private-hash",
    };
    const serialized = JSON.stringify(analyticsPurchase(response));
    for (const forbidden of ["private", "buyer@example.com", "9876543210", "invoice", "contact", "shippingAddress", "paymentAttemptToken"])
      expect(serialized).not.toContain(forbidden);
    expect(analyticsPurchase(response).transaction_id).toBe("RS-456");
  });

  it("handles full discounts and fractional allocation without negative revenue", () => {
    const items = [productAnalyticsItem(product, product.variants![0], 3)!];
    expect(discountedCommerceItems(items, 999)[0].price).toBe(0);
    const discounted = discountedCommerceItems(items, 1);
    expect(commerceAmount(discounted[0].price * 3)).toBe(386);
    expect(items[0].price).toBe(129);
  });
});

describe("purchase confirmation gates", () => {
  it("counts COD only after server confirmation, including a fulfilled idempotent response", () => {
    expect(purchaseIsConfirmed("cod", "CONFIRMED")).toBe(true);
    expect(purchaseIsConfirmed("cod", "SHIPPED")).toBe(true);
    for (const status of ["PAYMENT_PENDING", "FAILED", "CANCELLED", "REFUNDED"])
      expect(purchaseIsConfirmed("cod", status)).toBe(false);
  });

  it("never treats a checkout response or a submitted/failed online attempt as a purchase", () => {
    expect(purchaseIsConfirmed("cashfree", "PAID")).toBe(false);
    for (const status of ["PENDING", "FAILED", "REFUNDED", "SUBMITTED"])
      expect(purchaseIsConfirmed("cashfree", "PAYMENT_PENDING", status)).toBe(false);
    expect(purchaseIsConfirmed("cashfree", "PAID", "CAPTURED")).toBe(true);
  });
});
