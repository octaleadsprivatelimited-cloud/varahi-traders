import crypto from "node:crypto";
import type { Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { CommerceStore } from "../src/store.js";
import { signAccessToken } from "../src/security.js";
import { PrismaPersistence } from "../src/persistence.js";

const config = loadConfig({
  NODE_ENV: "test", USE_DATABASE: "false", DATABASE_URL: "mysql://unused:unused@localhost/test",
  JWT_SECRET: "delivery-contact-access-secret-at-least-32",
  JWT_REFRESH_SECRET: "delivery-contact-refresh-secret-at-least-32",
  INTEGRATION_ENCRYPTION_KEY: "delivery-contact-encryption-key-at-least-32",
});
const store = new CommerceStore();
const customer = store.createUser({ name: "Saved Customer", email: "saved-customer@example.com", mobile: "+919876543210", role: "CUSTOMER", permissions: [] });
const other = store.createUser({ name: "Other Customer", email: "other-contact@example.com", role: "CUSTOMER", permissions: [] });
const tokenFor = (id: string) => signAccessToken({ sub: id, role: "CUSTOMER", permissions: [] }, config.JWT_SECRET);
let server: Server;
let base = "";
const address = { label: "Home", line1: "10 Example Road", line2: "Apartment 2", city: "Hyderabad", state: "Telangana", postalCode: "500081", country: "IN", isDefault: true, phone: "9876543210" };
async function request(path: string, options: { customerId?: string; body?: unknown } = {}) {
  const response = await fetch(base + path, {
    method: options.body === undefined ? "GET" : "POST",
    headers: { "content-type": "application/json", ...(options.customerId ? { authorization: `Bearer ${tokenFor(options.customerId)}` } : {}), "idempotency-key": crypto.randomUUID() },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  return { status: response.status, body: await response.json() };
}
beforeAll(async () => {
  const { app } = await createApp({ config, store, persistence: null });
  server = app.listen(0, "127.0.0.1");
  await new Promise<void>(resolve => server.once("listening", resolve));
  const endpoint = server.address();
  if (!endpoint || typeof endpoint === "string") throw new Error("Missing test server");
  base = `http://127.0.0.1:${endpoint.port}`;
});
afterAll(async () => { if (server) await new Promise<void>(resolve => server.close(() => resolve())); });

it("exposes the signed-in customer's saved contact and address without sharing another customer's data", async () => {
  expect((await request("/api/v1/auth/me")).status).toBe(401);
  const profile = await request("/api/v1/auth/me", { customerId: customer.id });
  expect(profile.body.data).toMatchObject({ name: customer.name, email: customer.email, mobile: customer.mobile });
  const saved = await request("/api/v1/account/addresses", { customerId: customer.id, body: address });
  expect(saved.status).toBe(201);
  expect(saved.body.data).toMatchObject({ ...address, phone: "+919876543210" });
  const own = await request("/api/v1/account/addresses", { customerId: customer.id });
  expect(own.body.data).toHaveLength(1);
  expect(own.body.data[0].phone).toBe("+919876543210");
  expect((await request("/api/v1/account/addresses", { customerId: other.id })).body.data).toEqual([]);
  expect((await request("/api/v1/auth/me", { customerId: other.id })).body.data.mobile).toBeNull();
});

it.each([undefined, "", "1234567890", "987654321", "98765432100", "+19876543210"])("rejects checkout with missing or invalid mobile %s before reserving stock", async phone => {
  const variant = store.listProducts()[0]!.variants[0]!;
  const before = { stock: variant.stock, reserved: variant.reserved, orders: store.orders.size };
  const result = await request("/api/v1/checkout", { customerId: customer.id, body: {
    lines: [{ variantId: variant.id, quantity: 1 }], postalCode: address.postalCode,
    contact: { name: customer.name, email: customer.email, phone },
    shippingAddress: address, paymentProvider: "cod",
  } });
  expect(result.status).toBe(400);
  expect(result.body.error.code).toBe("VALIDATION_ERROR");
  expect({ stock: variant.stock, reserved: variant.reserved, orders: store.orders.size }).toEqual(before);
});

describe.skipIf(process.env.RUN_DB_TESTS !== "1")("saved delivery phone in MySQL", () => {
  it("keeps legacy addresses and round-trips the new delivery phone column", async () => {
    const p = new PrismaPersistence();
    let userId = "";
    try {
      const user = await p.db.user.create({ data: { email: `address-contact-${crypto.randomUUID()}@example.com`, name: "Address contact test" } });
      userId = user.id;
      const { phone: _phone, ...legacy } = address;
      await p.saveAddress(userId, { ...legacy, isDefault: false });
      await p.saveAddress(userId, { ...address, phone: "+919876543210" });
      const saved = await p.listAddresses(userId);
      expect(saved).toHaveLength(2);
      expect(saved[0]).toMatchObject({ phone: "+919876543210", line2: "Apartment 2", isDefault: true });
      expect(saved[1]!.phone).toBeNull();
    } finally {
      if (userId) await p.db.user.delete({ where: { id: userId } });
      await p.disconnect();
    }
  });
});
