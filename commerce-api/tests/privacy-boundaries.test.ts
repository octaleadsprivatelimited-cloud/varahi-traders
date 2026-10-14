import crypto from "node:crypto";
import { readFile } from "node:fs/promises";
import type { Server } from "node:http";
import ts from "typescript";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app.js";
import type { AppConfig } from "../src/config.js";
import { signAccessToken } from "../src/security.js";
import { CommerceStore, type StoredOrder, type StoredUser } from "../src/store.js";

const source = ts.createSourceFile("app.ts", await readFile(new URL("../src/app.ts", import.meta.url), "utf8"), ts.ScriptTarget.Latest, true);
const adminRoutes: Array<{ method: string; path: string }> = [];
function routeInventory(node: ts.Node) {
  if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && node.expression.expression.getText(source) === "app") {
    const [path] = node.arguments;
    if (path && ts.isStringLiteral(path) && path.text.startsWith("/api/v1/admin/"))
      adminRoutes.push({ method: node.expression.name.text.toUpperCase(), path: path.text.replace(/:[A-Za-z][\w]*/g, "0176d4bf-c82d-41c0-a082-cb9e69faefc2") });
  }
  ts.forEachChild(node, routeInventory);
}
routeInventory(source);
const config: AppConfig = {
  NODE_ENV: "test", PORT: 0, DATABASE_URL: "mysql://unused", USE_DATABASE: false,
  JWT_SECRET: "test-access-secret-that-is-at-least-32-chars", JWT_REFRESH_SECRET: "test-refresh-secret-that-is-at-least-32-chars",
  INTEGRATION_ENCRYPTION_KEY: "test-encryption-key-that-is-at-least-32-chars", CORS_ORIGINS: "http://localhost:5180", TRUST_PROXY: "",
  UPLOAD_DIR: "uploads", PUBLIC_UPLOAD_BASE_URL: "http://localhost:4010/uploads",
};
let server: Server, base: string, store: CommerceStore, owner: StoredUser, other: StoredUser, ownerToken: string, otherToken: string, order: StoredOrder;
const sign = (user: StoredUser) => signAccessToken({ sub: user.id, role: user.role, permissions: user.permissions, authVersion: user.authVersion || 0 }, config.JWT_SECRET);
async function call(path: string, token?: string, method = "GET", body?: unknown, headers: Record<string, string> = {}) {
  const response = await fetch(base + path, { method, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), "content-type": "application/json", ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const text = await response.text();
  return { status: response.status, headers: response.headers, text, body: response.headers.get("content-type")?.includes("application/json") ? JSON.parse(text) : null };
}
beforeAll(async () => {
  store = new CommerceStore();
  owner = store.createUser({ name: "Private Buyer", email: "private-owner@example.com", mobile: "+919876543210", role: "CUSTOMER", permissions: [] });
  other = store.createUser({ name: "Other Buyer", email: "other-buyer@example.com", role: "CUSTOMER", permissions: [] });
  const { app } = await createApp({ config, store, persistence: null });
  ownerToken = sign(owner); otherToken = sign(other);
  const product = store.listProducts()[0]!, variant = product.variants[0]!;
  order = store.createOrder({ userId: owner.id, status: "DELIVERED", lines: [{ variantId: variant.id, name: product.name, sku: variant.sku, quantity: 1, unitPrice: variant.price, tax: 0 }], subtotal: variant.price, tax: 0, shipping: 0, discount: 0, total: variant.price,
    idempotencyKey: "private-idempotency-fixture", trackingVerificationHash: crypto.createHash("sha256").update(owner.email).digest("hex"),
    invoiceSnapshot: { contact: { name: owner.name, email: owner.email, phone: owner.mobile }, shipping: { line1: "Private Address Fixture", city: "Hyderabad", state: "Telangana", postalCode: "500081", country: "IN" } },
  });
  order.history.push({ to: "DELIVERED", at: new Date().toISOString(), actor: "internal-staff@example.com", source: "staff-only-note" });
  server = app.listen(0); await new Promise<void>(resolve => server.once("listening", resolve));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterAll(async () => { if (server) await new Promise<void>(resolve => server.close(() => resolve())); });

describe("every admin API permission boundary", () => {
  it.each(adminRoutes)("$method $path denies anonymous and customer callers", async ({ method, path }) => {
    const body = ["GET", "HEAD"].includes(method) ? undefined : {};
    const anonymous = await call(path, undefined, method, body);
    expect(anonymous.status).toBe(401);
    const denied = await call(path, otherToken, method, body, { "x-role": "ADMIN", "x-permissions": "*" });
    expect(denied.status).toBe(403);
    for (const response of [anonymous, denied]) {
      expect(response.headers.get("cache-control")).toContain("no-store");
      expect(response.text).not.toMatch(/private-owner@example|9876543210|encryptedCredentials|clientSecret|passwordHash/);
    }
  });
});
it.each(["/api/v1/account/orders", "/api/v1/account/payments", "/api/v1/account/addresses", "/api/v1/account/support", "/api/v1/account/returns", "/api/v1/account/auth-methods", "/api/v1/auth/me", "/api/v1/wishlist"])("protects private account reads at %s", async path => {
  expect((await call(path)).status).toBe(401);
  expect((await call(path, "forged-token")).status).toBe(401);
});
it("does not let one customer read another customer's orders, payments, address, support or invoice", async () => {
  const address = await call("/api/v1/account/addresses", ownerToken, "POST", { label: "Home", line1: "Private Address Fixture", city: "Hyderabad", state: "Telangana", postalCode: "500081", country: "IN", phone: "9876543210" });
  const ticket = await call("/api/v1/account/support", ownerToken, "POST", { subject: "Private issue", message: "Private Buyer support content" });
  expect(address.status).toBe(201); expect(ticket.status).toBe(201);
  for (const path of ["orders", "payments", "addresses", "support", "returns"]) {
    const response = await call(`/api/v1/account/${path}`, otherToken);
    expect(response.status).toBe(200); expect(response.body.data).toEqual([]);
    expect(response.text).not.toMatch(/Private Buyer|private-owner@example|9876543210|Private Address Fixture/);
  }
  expect((await call(`/api/v1/account/addresses/${address.body.data.id}`, otherToken, "DELETE")).status).toBe(404);
  expect((await call(`/api/v1/account/support/${ticket.body.data.id}/replies`, otherToken, "POST", { message: "Unauthorized reply" })).status).toBe(404);
  expect((await call("/api/v1/account/returns", otherToken, "POST", { orderId: order.id, reason: "Damaged package" })).status).toBe(404);
  expect((await call(`/api/v1/orders/${order.id}/invoice`, otherToken)).status).toBe(404);
  expect((await call(`/api/v1/orders/${order.id}/invoice`)).status).toBe(401);
  const invoice = await call(`/api/v1/orders/${order.id}/invoice`, ownerToken);
  expect(invoice.status).toBe(200); expect(invoice.headers.get("content-type")).toContain("application/pdf");
});
it("keeps contact details out of tracking URLs and exposes only minimal verified tracking data", async () => {
  expect((await call(`/api/v1/orders/${order.number}/track?contact=private-owner@example.com`)).status).toBe(410);
  const denied = await call("/api/v1/orders/track", undefined, "POST", { orderNumber: order.number, contact: "wrong@example.com" });
  const missing = await call("/api/v1/orders/track", undefined, "POST", { orderNumber: "SVT-missing", contact: owner.email });
  expect(denied.status).toBe(404); expect(missing.text).toBe(denied.text);
  for (const contact of [owner.email.toUpperCase(), "9876543210", "+91 9876543210"]) {
    const response = await call("/api/v1/orders/track", undefined, "POST", { orderNumber: order.number, contact });
    expect(response.status).toBe(200); expect(response.body.data.number).toBe(order.number);
    expect(response.text).not.toMatch(/private-owner@example|9876543210|Private Address|internal-staff|staff-only|trackingVerificationHash|invoiceSnapshot|userId|idempotencyKey/);
    expect(Object.keys(response.body.data.history[0]).sort()).toEqual(["at", "to"]);
  }
});
it("revalidates revoked and disabled sessions on optional-login cart, coupons and checkout APIs", async () => {
  const user = store.createUser({ name: "Revoked", email: "revoked@example.com", role: "CUSTOMER", permissions: [] }), token = sign(user);
  const requests = [{ path: "/api/v1/cart", method: "GET" }, { path: "/api/v1/cart/items", method: "PUT" }, { path: "/api/v1/coupons/validate", method: "POST" }, { path: "/api/v1/checkout", method: "POST" }];
  user.authVersion = 1;
  for (const request of requests) expect((await call(request.path, token, request.method, request.method === "GET" ? undefined : {})).status).toBe(401);
  const current = sign(user); user.disabledAt = new Date().toISOString();
  for (const request of requests) expect((await call(request.path, current, request.method, request.method === "GET" ? undefined : {})).status).toBe(403);
});
it("returns safe checkout snapshots on initial and duplicate requests and rejects raw card data", async () => {
  const variant = store.listProducts()[0]!.variants[0]!;
  const input = { lines: [{ variantId: variant.id, quantity: 1 }], postalCode: "500081", paymentProvider: "cod", contact: { name: owner.name, email: owner.email, phone: "9876543210" }, shippingAddress: { line1: "Private Address Fixture", city: "Hyderabad", state: "Telangana", country: "IN" } };
  const headers = { "idempotency-key": crypto.randomUUID() };
  const first = await call("/api/v1/checkout", ownerToken, "POST", input, headers), duplicate = await call("/api/v1/checkout", ownerToken, "POST", input, headers);
  expect(first.status).toBe(201); expect(duplicate.status).toBe(200); expect(duplicate.body.data.order.id).toBe(first.body.data.order.id);
  for (const response of [first, duplicate]) expect(response.text).not.toMatch(/private-owner@example|9876543210|Private Address Fixture|invoiceSnapshot|trackingVerificationHash|idempotencyKey|userId/);
  for (const body of [{ ...input, cardNumber: "4111111111111111", cvv: "123" }, { ...input, contact: { ...input.contact, cardNumber: "4111111111111111" } }]) {
    const response = await call("/api/v1/checkout", ownerToken, "POST", body, { "idempotency-key": crypto.randomUUID() });
    expect(response.status).toBe(400); expect(response.text).not.toContain("4111111111111111");
  }
});
it("does not break saved carts or expose draft products after catalog changes", async () => {
  const [active, hidden] = store.listProducts();
  const deleted = crypto.randomUUID();
  store.carts.set(`user:${other.id}`, new Map([[active!.variants[0]!.id, 1], [hidden!.variants[0]!.id, 1], [deleted, 1]]));
  store.wishlists.set(other.id, new Set([active!.id, hidden!.id, deleted]));
  const previous = hidden!.status; hidden!.status = "DRAFT";
  try {
    const cart = await call("/api/v1/cart", otherToken), wishlist = await call("/api/v1/wishlist", otherToken);
    expect(cart.status).toBe(200); expect(cart.body.data.map((item: any) => item.product.id)).toEqual([active!.id]);
    expect(wishlist.status).toBe(200); expect(wishlist.body.data.map((item: any) => item.id)).toEqual([active!.id]);
    expect((await call(`/api/v1/wishlist/${hidden!.id}`, otherToken, "PUT", {})).status).toBe(404);
    expect((await call("/api/v1/cart/items", otherToken, "PUT", { variantId: deleted, quantity: 0 })).status).toBe(200);
  } finally { hidden!.status = previous; }
});
it("rejects unsigned payment webhooks, cross-origin private reads and malformed JSON without leaking request contents", async () => {
  const denied = await call("/webhooks/cashfree", undefined, "POST", { customer_email: owner.email });
  expect(denied.status).toBe(401); expect(denied.text).not.toContain(owner.email);
  const crossOrigin = await call("/api/v1/account/orders", ownerToken, "GET", undefined, { origin: "https://untrusted.test" });
  expect(crossOrigin.status).toBe(403); expect(crossOrigin.headers.get("access-control-allow-origin")).toBeNull();
  const malformed = await fetch(base + "/api/v1/orders/track", { method: "POST", headers: { "content-type": "application/json" }, body: '{"contact":"private-owner@example.com"' });
  expect(malformed.status).toBe(400); expect(await malformed.text()).not.toContain(owner.email);
});
it("never writes request headers, query contacts, bodies or cookie values into request logs", async () => {
  const chunks: string[] = [];
  const { app } = await createApp({ config: { ...config, NODE_ENV: "development" }, persistence: null, logDestination: { write: chunk => { chunks.push(String(chunk)); } } });
  const logServer = app.listen(0); await new Promise<void>(resolve => logServer.once("listening", resolve));
  try {
    await fetch(`http://127.0.0.1:${(logServer.address() as { port: number }).port}/api/v1/orders/someone@example.com/track?contact=private-owner@example.com`, { headers: { cookie: "varahi_refresh_token=private-cookie", authorization: "Bearer private-access-token", "x-cart-token": "private-cart-token", referer: "https://shop.test/track?contact=+919876543210" } });
    await vi.waitFor(() => expect(chunks.length).toBeGreaterThan(0));
    const output = chunks.join("");
    for (const secret of ["private-owner@example.com", "someone@example.com", "9876543210", "private-cookie", "private-access-token", "private-cart-token"]) expect(output).not.toContain(secret);
    expect(output).toContain("/api/v1/orders/:number/track");
  } finally { await new Promise<void>(resolve => logServer.close(() => resolve())); }
});
