import crypto from "node:crypto";
import type { Server } from "node:http";
import { afterEach, beforeEach, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { signAccessToken } from "../src/security.js";
import { defaultStorefrontConfig } from "../src/storefront-config.js";
import type { CommerceStore } from "../src/store.js";

let server: Server, base: string, store: CommerceStore, adminToken: string, variantId: string;
const config = loadConfig({ NODE_ENV: "production", DATABASE_URL: "mysql://unused:unused@localhost/test", USE_DATABASE: "true", JWT_SECRET: "manual-delivery-access-secret-32-characters", JWT_REFRESH_SECRET: "manual-delivery-refresh-secret-32-characters", INTEGRATION_ENCRYPTION_KEY: "manual-delivery-encryption-secret-32-characters", CORS_ORIGINS: "https://shop.example.com", PUBLIC_UPLOAD_BASE_URL: "https://shop.example.com/uploads" });
async function call(path: string, method = "GET", body?: unknown, authenticated = false, key?: string) {
  const response = await fetch(base + path, { method, headers: { "content-type": "application/json", ...(authenticated ? { authorization: `Bearer ${adminToken}` } : {}), ...(key ? { "idempotency-key": key } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { status: response.status, body: await response.json() };
}
async function setPolicy(charge = 59, threshold = 999, enabled = true) {
  return call("/api/v1/admin/storefront-config", "PUT", { ...defaultStorefrontConfig, manualDeliveryEnabled: enabled, deliveryCharge: charge, freeShippingThreshold: threshold, announcement: "Free delivery on orders above ₹999" }, true);
}
const quoteInput = (quantity = 1) => ({ lines: [{ variantId, quantity }], postalCode: "500081", paymentProvider: "cod" });
const checkoutInput = (expectedTotal?: number) => ({ ...quoteInput(), shippingService: "MANUAL", expectedTotal, contact: { name: "Delivery fixture", email: "fixture@example.com", phone: "9876543210" }, shippingAddress: { line1: "Fixture Street", city: "Hyderabad", state: "Telangana", country: "IN" } });
beforeEach(async () => {
  const result = await createApp({ config, persistence: null }); store = result.store;
  const admin = [...store.users.values()].find(user => user.email === "varahi.admin.fixture@gmail.com") || store.createUser({ name: "Admin fixture", email: "varahi.admin.fixture@gmail.com", role: "ADMIN", permissions: ["*"] });
  adminToken = signAccessToken({ sub: admin.id, role: "ADMIN", permissions: ["*"], authVersion: admin.authVersion || 0 }, config.JWT_SECRET);
  const variant = store.listProducts()[0]!.variants[0]!; variantId = variant.id; variant.price = 500; variant.stock = 50; variant.reserved = 0;
  server = result.app.listen(0, "127.0.0.1"); await new Promise<void>(resolve => server.once("listening", resolve));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterEach(async () => { await new Promise<void>(resolve => server.close(() => resolve())); });

it("opens production COD checkout only after the admin enables a valid delivery policy", async () => {
  expect((await call("/api/v1/payments/providers")).body.data.checkout.enabled).toBe(false);
  expect((await call("/api/v1/admin/storefront-config", "PUT", { ...defaultStorefrontConfig, manualDeliveryEnabled: true })).status).toBe(401);
  expect((await setPolicy()).status).toBe(200);
  expect((await call("/api/v1/payments/providers")).body.data).toMatchObject({ checkout: { enabled: true }, cod: { enabled: true }, cashfree: { enabled: false } });
  const quote = await call("/api/v1/checkout/quote", "POST", quoteInput());
  expect(quote.status).toBe(200); expect(quote.body.data).toMatchObject({ provider: "manual", shipping: 59, selectedShipping: { service: "MANUAL", etaMinDays: 3, etaDays: 6 } });
  expect((await call("/api/v1/storefront/config")).body.data.announcement).toBe("");
});
it("replaces current charges, applies the free threshold, and rejects stale totals before reserving stock", async () => {
  await setPolicy(); const before = await call("/api/v1/checkout/quote", "POST", quoteInput());
  await setPolicy(89);
  const current = await call("/api/v1/checkout/quote", "POST", quoteInput()); expect(current.body.data.shipping).toBe(89);
  const stale = await call("/api/v1/checkout", "POST", checkoutInput(before.body.data.total), false, crypto.randomUUID());
  expect(stale.status).toBe(409); expect(stale.body.error.code).toBe("CHECKOUT_PRICE_CHANGED"); expect(store.orders.size).toBe(0); expect(store.getVariant(variantId).variant.reserved).toBe(0);
  expect((await call("/api/v1/checkout/quote", "POST", quoteInput(2))).body.data.shipping).toBe(0);
  await setPolicy(89, 0); expect((await call("/api/v1/checkout/quote", "POST", quoteInput())).body.data.shipping).toBe(0);
});
it("creates an idempotent COD order with confirmed charges and keeps old orders unchanged after a price update", async () => {
  await setPolicy(); const quote = (await call("/api/v1/checkout/quote", "POST", quoteInput())).body.data, input = checkoutInput(quote.total), key = crypto.randomUUID();
  const placed = await call("/api/v1/checkout", "POST", input, false, key);
  expect(placed.status).toBe(201); expect(placed.body.data.order).toMatchObject({ status: "CONFIRMED", shipping: 59, total: quote.total });
  await setPolicy(89);
  const repeat = await call("/api/v1/checkout", "POST", input, false, key); expect(repeat.status).toBe(200); expect(repeat.body.data.order.shipping).toBe(59);
  expect(store.orders.size).toBe(1); expect((await call("/api/v1/checkout/quote", "POST", quoteInput())).body.data.shipping).toBe(89);
});
it("records actual manual dispatch details even if current delivery settings changed", async () => {
  await setPolicy(); const placed = await call("/api/v1/checkout", "POST", checkoutInput(), false, crypto.randomUUID()), id = placed.body.data.order.id;
  for (const status of ["PROCESSING", "PACKED"]) expect((await call(`/api/v1/admin/orders/${id}/status`, "PATCH", { status }, true)).status).toBe(200);
  await setPolicy(89, 999, false);
  expect((await call(`/api/v1/admin/orders/${id}/shipment`, "POST", { service: "MANUAL" }, true)).status).toBe(422);
  const dispatch = await call(`/api/v1/admin/orders/${id}/shipment`, "POST", { courier: "Fixture delivery partner", service: "MANUAL" }, true);
  expect(dispatch.status).toBe(201); expect(store.orders.get(id)?.status).toBe("SHIPPED"); expect(store.orders.get(id)?.shipment?.courier).toBe("Fixture delivery partner"); expect(store.orders.get(id)?.shipment?.awb).toBeUndefined();
  const track = await call("/api/v1/orders/track", "POST", { orderNumber: placed.body.data.order.number, contact: "fixture@example.com" });
  expect(track.body.data).toMatchObject({ status: "SHIPPED", shipment: { courier: "Fixture delivery partner" } });
  expect(JSON.stringify(track.body)).not.toMatch(/fixture@example|9876543210|Fixture Street/);
  for (const status of ["OUT_FOR_DELIVERY", "DELIVERED"]) expect((await call(`/api/v1/admin/orders/${id}/status`, "PATCH", { status }, true)).status).toBe(200);
  const delivered = await call("/api/v1/orders/track", "POST", { orderNumber: placed.body.data.order.number, contact: "fixture@example.com" });
  expect(delivered.body.data).toMatchObject({ status: "DELIVERED", shipment: { status: "DELIVERED" } });
});
it("rejects overseas delivery and invalid price configurations without creating orders", async () => {
  await setPolicy(); const input = checkoutInput(); input.shippingAddress.country = "US";
  expect((await call("/api/v1/checkout", "POST", input, false, crypto.randomUUID())).status).toBe(422); expect(store.orders.size).toBe(0);
  expect((await setPolicy(-1)).status).toBe(400);
});
