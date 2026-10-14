import crypto from "node:crypto";
import type { Server } from "node:http";
import { afterEach, beforeEach, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { signAccessToken } from "../src/security.js";
import { defaultStorefrontConfig } from "../src/storefront-config.js";
import type { CommerceStore } from "../src/store.js";

let server: Server, base: string, store: CommerceStore, adminToken: string;
let selectedId: string, selectedVariant: string, secondPack: string, otherVariant: string;
const config = loadConfig({ NODE_ENV: "test", DATABASE_URL: "mysql://unused:unused@localhost/test", USE_DATABASE: "false", JWT_SECRET: "coupon-access-secret-at-least-32-characters", JWT_REFRESH_SECRET: "coupon-refresh-secret-at-least-32-characters", INTEGRATION_ENCRYPTION_KEY: "coupon-encryption-secret-at-least-32-characters" });
async function call(path: string, method = "GET", body?: unknown, admin = false) {
  const response = await fetch(base + path, { method, headers: { "content-type": "application/json", ...(admin ? { authorization: `Bearer ${adminToken}` } : {}), ...(path === "/api/v1/checkout" ? { "idempotency-key": crypto.randomUUID() } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { status: response.status, body: await response.json() };
}
const offer = (patch = {}) => ({ code: "SELECT20", type: "PERCENTAGE", value: 20, minimumSpend: 0, startsAt: new Date(Date.now() - 60000).toISOString(), endsAt: new Date(Date.now() + 86400000).toISOString(), enabled: true, perUserLimit: 1, appliesTo: "SELECTED_PRODUCTS", productIds: [selectedId], ...patch });
const save = (patch = {}) => call("/api/v1/admin/coupons", "PUT", offer(patch), true);
const mixed = () => [{ variantId: selectedVariant, quantity: 1 }, { variantId: otherVariant, quantity: 1 }];
const validate = (lines = mixed(), code = "SELECT20") => call("/api/v1/coupons/validate", "POST", { code, lines });
const quoteInput = (lines = mixed()) => ({ lines, postalCode: "500081", paymentProvider: "cod", couponCode: "SELECT20" });
beforeEach(async () => {
  const result = await createApp({ config, persistence: null }); store = result.store;
  const admin = store.createUser({ name: "Coupon admin fixture", email: "varahi.admin.fixture@gmail.com", role: "ADMIN", permissions: ["*"] });
  adminToken = signAccessToken({ sub: admin.id, role: "ADMIN", permissions: ["*"], authVersion: admin.authVersion || 0 }, config.JWT_SECRET);
  const [selected, other] = store.listProducts(); selectedId = selected!.id;
  const variant = selected!.variants[0]!; selectedVariant = variant.id;
  variant.price = 100; variant.stock = 100; variant.reserved = 0; variant.active = true; selected!.taxRate = 5; selected!.status = "ACTIVE";
  const pack = { ...variant, id: crypto.randomUUID(), sku: `COUPON-${crypto.randomUUID()}`, price: 150 }; selected!.variants.push(pack); secondPack = pack.id;
  const otherPack = other!.variants[0]!; otherVariant = otherPack.id;
  otherPack.price = 500; otherPack.stock = 100; otherPack.reserved = 0; otherPack.active = true; other!.taxRate = 5; other!.status = "ACTIVE";
  server = result.app.listen(0, "127.0.0.1"); await new Promise<void>(resolve => server.once("listening", resolve));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  await call("/api/v1/admin/storefront-config", "PUT", { ...defaultStorefrontConfig, manualDeliveryEnabled: true, deliveryCharge: 59, freeShippingThreshold: 100000, codEnabled: true }, true);
});
afterEach(async () => { await new Promise<void>(resolve => server.close(() => resolve())); });

it("round trips selected products and requires authorized, valid non-empty product choices", async () => {
  expect((await call("/api/v1/admin/coupons", "PUT", offer())).status).toBe(401);
  expect((await save({ productIds: [] })).status).toBe(400);
  expect((await save({ productIds: [crypto.randomUUID()] })).body.error.code).toBe("COUPON_PRODUCT_NOT_FOUND");
  expect((await save({ productIds: [selectedId, selectedId] })).body.data.productIds).toEqual([selectedId]);
  expect((await call("/api/v1/admin/coupons", "GET", undefined, true)).body.data).toEqual(expect.arrayContaining([expect.objectContaining({ code: "SELECT20", appliesTo: "SELECTED_PRODUCTS", productIds: [selectedId] })]));
});
it("defaults legacy coupons to all products and clears selected ids when changed to all", async () => {
  const { appliesTo: _scope, productIds: _ids, ...legacy } = offer();
  expect((await call("/api/v1/admin/coupons", "PUT", legacy, true)).body.data).toMatchObject({ appliesTo: "ALL_PRODUCTS", productIds: [] });
  expect((await validate()).body.data).toMatchObject({ discount: 120, eligibleSubtotal: 600 });
  await save(); await save({ appliesTo: "ALL_PRODUCTS" });
  expect(store.coupons.get("SELECT20")?.productIds).toEqual([]);
  expect((await validate()).body.data.discount).toBe(120);
});
it("discounts every variant of a selected product while excluding other merchandise", async () => {
  await save();
  const result = await validate([{ variantId: selectedVariant, quantity: 2 }, { variantId: secondPack, quantity: 1 }, { variantId: otherVariant, quantity: 1 }], " select20 ");
  expect(result.status).toBe(200);
  expect(result.body.data).toMatchObject({ code: "SELECT20", discount: 70, eligibleSubtotal: 350, appliesTo: "SELECTED_PRODUCTS", freeShipping: false });
  expect((await validate([{ variantId: otherVariant, quantity: 1 }])).body.error.code).toBe("COUPON_NOT_APPLICABLE");
  expect((await validate([{ variantId: secondPack, quantity: 1 }])).body.data.discount).toBe(30);
});
it("bases minimum spend on eligible items, caps percentages and fixed discounts", async () => {
  await save({ minimumSpend: 200 });
  expect((await validate()).body.error.code).toBe("COUPON_MINIMUM_SPEND");
  expect((await validate([{ variantId: selectedVariant, quantity: 2 }])).body.data.discount).toBe(40);
  await save({ maximumDiscount: 15 }); expect((await validate()).body.data.discount).toBe(15);
  await save({ type: "FIXED_AMOUNT", value: 1000 }); expect((await validate()).body.data.discount).toBe(100);
});
it("rejects expired, future, paused and exhausted coupons and cannot trust client totals", async () => {
  for (const patch of [
    { startsAt: new Date(Date.now() - 120000).toISOString(), endsAt: new Date(Date.now() - 60000).toISOString() },
    { startsAt: new Date(Date.now() + 60000).toISOString() }, { enabled: false },
  ]) { await save(patch); expect((await validate()).body.error.code).toBe("COUPON_NOT_APPLICABLE"); }
  await save({ usageLimit: 1 }); store.coupons.get("SELECT20")!.used = 1;
  expect((await validate()).body.error.code).toBe("COUPON_NOT_APPLICABLE");
  await save({ usageLimit: 10 });
  expect((await call("/api/v1/coupons/validate", "POST", { code: "SELECT20", subtotal: 99999 })).status).toBe(400);
  expect((await call("/api/v1/coupons/validate", "POST", { code: "SELECT20", lines: mixed(), subtotal: 99999 })).status).toBe(400);
  expect((await call("/api/v1/coupons/validate", "POST", { code: "SELECT20", lines: [{ variantId: selectedVariant, quantity: 1, unitPrice: 99999 }] })).body.data.discount).toBe(20);
  expect((await validate([{ variantId: selectedVariant, quantity: 15 }, { variantId: selectedVariant, quantity: 10 }])).status).toBe(422);
});
it.each([
  ["SELECTED_PRODUCTS", 20, 669],
  ["ALL_PRODUCTS", 120, 569],
] as const)("keeps the %s discount consistent in bag validation, checkout and the confirmed order", async (appliesTo, discount, total) => {
  await save({ appliesTo });
  expect((await validate()).body.data.discount).toBe(discount);
  const quote = await call("/api/v1/checkout/quote", "POST", quoteInput());
  expect(quote.status).toBe(200); expect(quote.body.data).toMatchObject({ subtotal: 600, tax: 30, shipping: 59, couponDiscount: discount, total });
  const placed = await call("/api/v1/checkout", "POST", { ...quoteInput(), expectedTotal: total, contact: { name: "Coupon fixture", email: "coupon@example.com", phone: "9876543210" }, shippingAddress: { line1: "Fixture Street", city: "Hyderabad", state: "Telangana", country: "IN" } });
  expect(placed.status).toBe(201); expect(placed.body.data.order).toMatchObject({ total, couponDiscount: discount });
  expect(store.orders.get(placed.body.data.order.id)?.invoiceSnapshot?.discounts?.coupon).toBe(discount);
});
it.each([
  ["SELECTED_PRODUCTS", "FIXED_AMOUNT", 250, undefined, 100, 589],
  ["ALL_PRODUCTS", "FIXED_AMOUNT", 250, undefined, 250, 439],
  ["SELECTED_PRODUCTS", "PERCENTAGE", 20, 15, 15, 674],
  ["ALL_PRODUCTS", "PERCENTAGE", 20, 15, 15, 674],
] as const)("keeps %s %s discounts and caps consistent at checkout", async (appliesTo, type, value, maximumDiscount, discount, total) => {
  await save({ appliesTo, type, value, maximumDiscount });
  expect((await validate()).body.data.discount).toBe(discount);
  const quote = await call("/api/v1/checkout/quote", "POST", quoteInput());
  expect(quote.status).toBe(200);
  expect(quote.body.data).toMatchObject({ couponDiscount: discount, total });
});
it("revalidates changed quantities and equal-price product replacements from variant identities", async () => {
  await save();
  expect((await validate()).body.data.discount).toBe(20);
  const more = [{ variantId: selectedVariant, quantity: 2 }, { variantId: otherVariant, quantity: 1 }];
  expect((await validate(more)).body.data.discount).toBe(40);
  expect((await call("/api/v1/checkout/quote", "POST", quoteInput(more))).body.data).toMatchObject({ couponDiscount: 40, total: 754 });
  store.getVariant(otherVariant).variant.price = 100;
  expect((await validate([{ variantId: otherVariant, quantity: 1 }])).body.error.code).toBe("COUPON_NOT_APPLICABLE");
  expect((await call("/api/v1/checkout/quote", "POST", quoteInput([{ variantId: otherVariant, quantity: 1 }]))).body.error.code).toBe("COUPON_NOT_APPLICABLE");
});
it("rejects changed coupon scope before order creation or stock reservation", async () => {
  await save();
  const oldQuote = (await call("/api/v1/checkout/quote", "POST", quoteInput())).body.data;
  await save({ appliesTo: "ALL_PRODUCTS" });
  const result = await call("/api/v1/checkout", "POST", { ...quoteInput(), expectedTotal: oldQuote.total, contact: { name: "Coupon fixture", email: "coupon@example.com", phone: "9876543210" }, shippingAddress: { line1: "Fixture Street", city: "Hyderabad", state: "Telangana", country: "IN" } });
  expect(result.status).toBe(409); expect(result.body.error.code).toBe("CHECKOUT_PRICE_CHANGED");
  expect(store.orders.size).toBe(0); expect(store.getVariant(selectedVariant).variant.reserved).toBe(0);
});
it("waives order shipping only when selected items qualify for the shipping coupon", async () => {
  await save({ type: "FREE_SHIPPING", value: 0, minimumSpend: 100 });
  expect((await validate()).body.data).toMatchObject({ discount: 0, freeShipping: true });
  expect((await call("/api/v1/checkout/quote", "POST", quoteInput())).body.data).toMatchObject({ shipping: 0, couponDiscount: 0, total: 630 });
  expect((await call("/api/v1/checkout/quote", "POST", quoteInput([{ variantId: otherVariant, quantity: 1 }]))).body.error.code).toBe("COUPON_NOT_APPLICABLE");
});
