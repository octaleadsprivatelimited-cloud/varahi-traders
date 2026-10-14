import crypto from "node:crypto";
import type { Server } from "node:http";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { SecretVault, signAccessToken } from "../src/security.js";
import { defaultStorefrontConfig, storefrontConfigSchema } from "../src/storefront-config.js";
import { onlinePaymentDiscount } from "../src/payment-policy.js";
import { renderEmailNotification } from "../src/notification-content.js";
import type { CommerceStore } from "../src/store.js";

let server: Server, base: string, store: CommerceStore, adminToken: string, variantId: string;
const config = loadConfig({ NODE_ENV: "production", DATABASE_URL: "mysql://unused:unused@localhost/test", USE_DATABASE: "true", JWT_SECRET: "offer-access-secret-at-least-32-characters", JWT_REFRESH_SECRET: "offer-refresh-secret-at-least-32-characters", INTEGRATION_ENCRYPTION_KEY: "offer-encryption-secret-at-least-32-characters", CORS_ORIGINS: "https://shop.example.com", PUBLIC_UPLOAD_BASE_URL: "https://shop.example.com/uploads" });
const gatewayRequest = vi.fn<typeof fetch>();
async function call(path: string, method = "GET", body?: unknown, authenticated = false, key?: string) {
  const response = await fetch(base + path, { method, headers: { "content-type": "application/json", ...(authenticated ? { authorization: `Bearer ${adminToken}` } : {}), ...(key ? { "idempotency-key": key } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { status: response.status, body: await response.json() };
}
const setPolicy = (patch = {}) => call("/api/v1/admin/storefront-config", "PUT", { ...defaultStorefrontConfig, manualDeliveryEnabled: true, ...patch }, true);
const quoteInput = (paymentProvider = "cashfree", extra = {}) => ({ lines: [{ variantId, quantity: 1 }], postalCode: "500081", paymentProvider, ...extra });
const checkoutInput = (expectedTotal?: number) => ({ ...quoteInput(), expectedTotal, contact: { name: "Offer fixture", email: "offer@example.com", phone: "9876543210" }, shippingAddress: { line1: "Fixture Street", city: "Hyderabad", state: "Telangana", country: "IN" } });
function configureCashfree(environment = "LIVE") {
  store.integrations.set("offer-cashfree", { id: "offer-cashfree", kind: "PAYMENT", provider: "cashfree", enabled: true, priority: 1, environment, encryptedCredentials: new SecretVault(config.INTEGRATION_ENCRYPTION_KEY).encrypt({ clientId: "fixture-app", clientSecret: "fixture-secret" }), publicConfig: {}, updatedAt: new Date().toISOString() });
}
beforeEach(async () => {
  for (const name of ["CASHFREE_ENVIRONMENT", "CASHFREE_CLIENT_ID", "CASHFREE_CLIENT_SECRET"]) vi.stubEnv(name, "");
  gatewayRequest.mockReset().mockImplementation(async (_url, init) => {
    const body = JSON.parse(String(init?.body));
    return new Response(JSON.stringify({ order_id: body.order_id, payment_session_id: "fixture-session" }));
  });
  const result = await createApp({ config, persistence: null, providerRequest: gatewayRequest }); store = result.store;
  const admin = store.createUser({ name: "Admin fixture", email: "varahi.admin.fixture@gmail.com", role: "ADMIN", permissions: ["*"] });
  adminToken = signAccessToken({ sub: admin.id, role: "ADMIN", permissions: ["*"], authVersion: admin.authVersion || 0 }, config.JWT_SECRET);
  const product = store.listProducts()[0]!, variant = product.variants[0]!; product.taxRate = 5; variantId = variant.id; variant.price = 500; variant.stock = 50; variant.reserved = 0;
  configureCashfree();
  server = result.app.listen(0, "127.0.0.1"); await new Promise<void>(resolve => server.once("listening", resolve));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterEach(async () => { await new Promise<void>(resolve => server.close(() => resolve())); vi.unstubAllEnvs(); });

it("defaults to COD enabled and no mandatory online discount, including legacy settings", async () => {
  const { codEnabled: _cod, onlinePaymentDiscountEnabled: _enabled, onlinePaymentDiscountType: _type, onlinePaymentDiscountValue: _value, ...legacy } = defaultStorefrontConfig;
  expect(storefrontConfigSchema.parse(legacy)).toMatchObject({ codEnabled: true, onlinePaymentDiscountEnabled: false, onlinePaymentDiscountValue: 0 });
  await setPolicy();
  expect((await call("/api/v1/checkout/quote", "POST", quoteInput())).body.data).toMatchObject({ subtotal: 500, tax: 25, shipping: 59, discount: 0, onlinePaymentDiscount: 0, total: 584 });
});
it("applies percentage online discounts after coupons and never discounts COD, tax or delivery", async () => {
  await setPolicy({ onlinePaymentDiscountEnabled: true, onlinePaymentDiscountValue: 10 });
  store.coupons.set("OFFER50", { code: "OFFER50", type: "FIXED_AMOUNT", value: 50, minimumSpend: 0, startsAt: 0, endsAt: Date.now() + 60000, used: 0, perUserLimit: 1, enabled: true });
  const online = await call("/api/v1/checkout/quote", "POST", quoteInput("cashfree", { couponCode: "OFFER50" }));
  expect(online.status).toBe(200); expect(online.body.data).toMatchObject({ couponDiscount: 50, onlinePaymentDiscount: 45, discount: 95, subtotal: 500, tax: 25, shipping: 59, total: 489 });
  expect((await call("/api/v1/checkout/quote", "POST", quoteInput("cod", { couponCode: "OFFER50" }))).body.data).toMatchObject({ couponDiscount: 50, onlinePaymentDiscount: 0, discount: 50, total: 534 });
  expect(gatewayRequest).not.toHaveBeenCalled();
});
it("replaces fixed offers, caps them and removes the active offer when disabled or zero", async () => {
  await setPolicy({ onlinePaymentDiscountEnabled: true, onlinePaymentDiscountType: "FIXED_AMOUNT", onlinePaymentDiscountValue: 80 });
  expect((await call("/api/v1/checkout/quote", "POST", quoteInput())).body.data).toMatchObject({ onlinePaymentDiscount: 80, total: 504 });
  await setPolicy({ onlinePaymentDiscountEnabled: true, onlinePaymentDiscountType: "FIXED_AMOUNT", onlinePaymentDiscountValue: 800 });
  expect((await call("/api/v1/checkout/quote", "POST", quoteInput())).body.data).toMatchObject({ onlinePaymentDiscount: 500, total: 84 });
  for (const patch of [{ onlinePaymentDiscountEnabled: false, onlinePaymentDiscountValue: 10 }, { onlinePaymentDiscountEnabled: true, onlinePaymentDiscountValue: 0 }]) {
    await setPolicy(patch); expect((await call("/api/v1/checkout/quote", "POST", quoteInput())).body.data).toMatchObject({ onlinePaymentDiscount: 0, total: 584 });
  }
});
it("caps a 100% online offer so a free-delivery order remains payable through Cashfree", async () => {
  store.getVariant(variantId).product.taxRate = 0;
  await setPolicy({ deliveryCharge: 0, onlinePaymentDiscountEnabled: true, onlinePaymentDiscountValue: 100 });
  expect((await call("/api/v1/checkout/quote", "POST", quoteInput())).body.data).toMatchObject({ shipping: 0, tax: 0, onlinePaymentDiscount: 499, total: 1 });
});
it("rejects stale offers before inventory reservation and sends only the confirmed discounted total to Cashfree", async () => {
  await setPolicy({ onlinePaymentDiscountEnabled: true, onlinePaymentDiscountValue: 10 });
  const oldQuote = (await call("/api/v1/checkout/quote", "POST", quoteInput())).body.data;
  await setPolicy({ onlinePaymentDiscountEnabled: true, onlinePaymentDiscountType: "FIXED_AMOUNT", onlinePaymentDiscountValue: 80 });
  const stale = await call("/api/v1/checkout", "POST", checkoutInput(oldQuote.total), false, crypto.randomUUID());
  expect(stale.status).toBe(409); expect(stale.body.error.code).toBe("CHECKOUT_PRICE_CHANGED"); expect(store.orders.size).toBe(0); expect(store.getVariant(variantId).variant.reserved).toBe(0); expect(gatewayRequest).not.toHaveBeenCalled();
  const key = crypto.randomUUID(), input = checkoutInput(504), placed = await call("/api/v1/checkout", "POST", input, false, key);
  expect(placed.status).toBe(201); expect(placed.body.data.order).toMatchObject({ status: "PAYMENT_PENDING", onlinePaymentDiscount: 80, couponDiscount: 0, total: 504 });
  expect(JSON.parse(String(gatewayRequest.mock.calls[0]![1]?.body)).order_amount).toBe(504);
  const order = store.orders.get(placed.body.data.order.id)!; expect(order.invoiceSnapshot?.discounts).toMatchObject({ coupon: 0, onlinePayment: 80, onlineOffer: { type: "FIXED_AMOUNT", value: 80 } });
  await setPolicy({ onlinePaymentDiscountEnabled: false });
  const repeated = await call("/api/v1/checkout", "POST", input, false, key); expect(repeated.body.data.order.total).toBe(504); expect(gatewayRequest).toHaveBeenCalledOnce();
  expect((await call("/api/v1/payments/retry", "POST", { orderNumber: order.number, provider: "cod", attemptToken: placed.body.data.paymentAttemptToken })).body.error.code).toBe("INVALID_PAYMENT_METHOD");
  expect(order.status).toBe("PAYMENT_PENDING");
});
it("enforces COD being disabled for quotes and placement even when the client sends an old method", async () => {
  await setPolicy({ codEnabled: false });
  expect((await call("/api/v1/payments/providers")).body.data).toMatchObject({ cod: { enabled: false }, cashfree: { enabled: true }, checkout: { enabled: true } });
  const quote = await call("/api/v1/checkout/quote", "POST", quoteInput("cod")); expect(quote.status).toBe(409); expect(quote.body.error.code).toBe("COD_DISABLED");
  const result = await call("/api/v1/checkout", "POST", { ...checkoutInput(), paymentProvider: "cod" }, false, crypto.randomUUID()); expect(result.status).toBe(409); expect(store.orders.size).toBe(0); expect(store.getVariant(variantId).variant.reserved).toBe(0);
  await setPolicy({ codEnabled: true }); expect((await call("/api/v1/checkout/quote", "POST", quoteInput("cod"))).status).toBe(200);
});
it("closes checkout when COD is disabled and there is no enabled LIVE online gateway", async () => {
  await setPolicy({ codEnabled: false, onlinePaymentDiscountEnabled: true, onlinePaymentDiscountValue: 10 });
  configureCashfree("TEST");
  const readiness = await call("/api/v1/payments/providers"); expect(readiness.body.data).toMatchObject({ checkout: { enabled: false }, cashfree: { enabled: false }, cod: { enabled: false } });
  const result = await call("/api/v1/checkout/quote", "POST", quoteInput()); expect(result.status).toBe(503); expect(result.body.error.code).toBe("PAYMENT_NOT_CONFIGURED");
  expect(JSON.stringify(readiness.body)).not.toMatch(/fixture-secret|fixture-app|encryptedCredentials/);
});
it("rejects invalid discount settings and unauthenticated admin changes", async () => {
  for (const patch of [{ onlinePaymentDiscountValue: -1 }, { onlinePaymentDiscountValue: 101 }, { onlinePaymentDiscountValue: 10.001 }, { onlinePaymentDiscountType: "INVALID" }]) expect((await setPolicy(patch)).status).toBe(400);
  expect((await call("/api/v1/admin/storefront-config", "PUT", defaultStorefrontConfig)).status).toBe(401);
  expect(onlinePaymentDiscount({ ...defaultStorefrontConfig, onlinePaymentDiscountEnabled: true, onlinePaymentDiscountValue: 10 }, false, 500, 0)).toBe(0);
});
it("includes the confirmed online discount in customer email charges", () => {
  const email = renderEmailNotification("order.confirmed", { storeName: "Sri Varahi Traders", orderNumber: "RU-OFFER", paymentLabel: "Paid online", charges: { subtotal: 500, couponDiscount: 50, onlinePaymentDiscount: 45, discount: 95, tax: 25, shipping: 59, total: 489 } });
  expect(email.text).toContain("Online-payment discount: -INR 45.00"); expect(email.text).toContain("Coupon discount: -INR 50.00"); expect(email.text).toContain("Grand total: INR 489.00");
});
