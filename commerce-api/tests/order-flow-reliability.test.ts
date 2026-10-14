import crypto from "node:crypto";
import type { Server } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app.js";
import type { AppConfig } from "../src/config.js";
import { AppError } from "../src/errors.js";
import { PrismaPersistence } from "../src/persistence.js";
import { SecretVault } from "../src/security.js";
import { CommerceStore, seedStore, type StoredOrder } from "../src/store.js";

const config: AppConfig = {
  NODE_ENV: "test", PORT: 4010, DATABASE_URL: "mysql://unused",
  JWT_SECRET: "test-access-secret-that-is-at-least-32-chars",
  JWT_REFRESH_SECRET: "test-refresh-secret-that-is-at-least-32-chars",
  INTEGRATION_ENCRYPTION_KEY: "test-encryption-key-that-is-at-least-32-chars",
  CORS_ORIGINS: "http://localhost:5180", TRUST_PROXY: "", USE_DATABASE: false,
  UPLOAD_DIR: "uploads", PUBLIC_UPLOAD_BASE_URL: "http://localhost:4010/uploads",
};
const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => server.close(() => resolve()))));
});

async function start(persistence: PrismaPersistence | null = null, providerRequest?: typeof fetch) {
  const store = new CommerceStore();
  const { app } = await createApp({ config, store, persistence, providerRequest });
  const server = app.listen(0);
  servers.push(server);
  await new Promise<void>(resolve => server.once("listening", resolve));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  return {
    store,
    post: async (path: string, body: unknown, headers: Record<string, string> = {}) => {
      const response = await fetch(base + path, {
        method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body),
      });
      return { status: response.status, body: await response.json() as any };
    },
  };
}

function checkout(variantId: string, paymentProvider = "cod") {
  return {
    lines: [{ variantId, quantity: 2 }], postalCode: "500081", paymentProvider,
    contact: { name: "Test Buyer", email: "buyer@example.com", phone: "9876543210" },
    shippingAddress: { line1: "10 Test Street", city: "Hyderabad", state: "Telangana", country: "IN" },
  };
}

describe("checkout failure recovery", () => {
  it.each(["cod", "development"])("restores stock and reservations when %s persistence rejects the order", async provider => {
    const persistence = {
      connect: vi.fn(async () => {}),
      hydrate: vi.fn(async (store: CommerceStore) => seedStore(store)),
      getSetting: vi.fn(async () => null),
      saveOrderAndReservations: vi.fn(async () => { throw new AppError(409, "INVENTORY_CONFLICT", "Stock changed during checkout"); }),
    };
    const { store, post } = await start(persistence as unknown as PrismaPersistence);
    const variant = store.listProducts()[0]!.variants[0]!;
    const before = { stock: variant.stock, reserved: variant.reserved };
    const orderCount = store.orders.size;
    const result = await post("/api/v1/checkout", checkout(variant.id, provider), { "idempotency-key": crypto.randomUUID() });
    expect(result.status).toBe(409);
    expect(persistence.saveOrderAndReservations).toHaveBeenCalledOnce();
    expect(variant).toMatchObject(before);
    expect(store.orders.size).toBe(orderCount);
  });

  it("keeps committed COD stock when response encoding fails after durable acceptance", async () => {
    const persistence = {
      connect: vi.fn(async () => {}), hydrate: vi.fn(async (store: CommerceStore) => seedStore(store)),
      getSetting: vi.fn(async () => null),
      saveOrderAndReservations: vi.fn(async (order: StoredOrder) => {
        Object.defineProperty(order, "number", { get: () => { throw new Error("Response encoding failed"); } });
      }),
    };
    const { store, post } = await start(persistence as unknown as PrismaPersistence);
    const variant = store.listProducts()[0]!.variants[0]!;
    const before = { stock: variant.stock, reserved: variant.reserved, orders: store.orders.size };
    const result = await post("/api/v1/checkout", checkout(variant.id), { "idempotency-key": crypto.randomUUID() });
    expect(result.status).toBe(500);
    expect(persistence.saveOrderAndReservations).toHaveBeenCalledOnce();
    expect(variant.stock).toBe(before.stock - 2);
    expect(variant.reserved).toBe(before.reserved);
    expect(store.orders.size).toBe(before.orders + 1);
  });

  it("retains captured status when a late checkout popup cancellation arrives", async () => {
    const { store, post } = await start();
    const variant = store.listProducts()[0]!.variants[0]!;
    const result = await post("/api/v1/checkout", checkout(variant.id, "development"), { "idempotency-key": crypto.randomUUID() });
    expect(result.status).toBe(201);
    const { order, payment, paymentAttemptToken } = result.body.data;
    const stored = store.orders.get(order.id)!;
    stored.payment!.status = "CAPTURED";
    stored.payment!.gatewayTransactionId = "verified-capture";
    stored.payment!.refunds = [{ id: "private-refund", amount: 1, status: "PENDING", reason: "Private staff note", idempotencyKey: "private-refund-key", createdAt: new Date().toISOString() }];
    store.transitionOrder(order.id, "PAID", undefined, "GATEWAY_VERIFICATION");
    const before = { stock: variant.stock, reserved: variant.reserved };
    const event = await post("/api/v1/payments/client-events", {
      orderNumber: order.number, providerOrderId: payment.externalId, attemptToken: paymentAttemptToken,
      type: "CANCELLED", gatewayPaymentId: "late-popup-event",
    });
    expect(event.status).toBe(200);
    expect(event.body.data).toMatchObject({ status: "CAPTURED", gatewayTransactionId: "verified-capture" });
    expect(JSON.stringify(event.body)).not.toMatch(/Private staff note|private-refund|idempotencyKey|refunds/);
    expect(stored.status).toBe("PAID");
    expect(variant).toMatchObject(before);
  });

  it.each([false, true])("recovers a timed-out Cashfree create using its original idempotency key (reloaded=%s)", async reloaded => {
    const requests: Array<{ url: string; headers: Record<string, string>; body: any }> = [];
    const providerRequest = vi.fn<typeof fetch>(async (url, init) => {
      const body = JSON.parse(String(init?.body));
      requests.push({ url: String(url), headers: init?.headers as Record<string, string>, body });
      if (requests.length === 1) throw new Error("Gateway accepted request but response was lost");
      return new Response(JSON.stringify({ order_id: body.order_id, payment_session_id: "recovered-session" }));
    });
    const { store, post } = await start(null, providerRequest);
    store.integrations.set("cashfree-test", {
      id: "cashfree-test", kind: "PAYMENT", provider: "cashfree", enabled: true, priority: 1, environment: "TEST",
      encryptedCredentials: new SecretVault(config.INTEGRATION_ENCRYPTION_KEY).encrypt({ clientId: "test-id", clientSecret: "test-secret" }),
      publicConfig: {}, updatedAt: new Date().toISOString(),
    });
    const variant = store.listProducts()[0]!.variants[0]!;
    const created = await post("/api/v1/checkout", checkout(variant.id, "cashfree"), { "idempotency-key": crypto.randomUUID() });
    expect(created.status).toBe(202);
    const { order, paymentAttemptToken } = created.body.data;
    const before = { stock: variant.stock, reserved: variant.reserved };
    // The persisted failed create has no gateway ID when rehydrated on restart.
    if (reloaded) store.orders.get(order.id)!.payment!.externalId = undefined;
    const retried = await post("/api/v1/payments/retry", {
      orderNumber: order.number, provider: "cashfree", attemptToken: paymentAttemptToken,
    });
    expect(retried.status).toBe(201);
    expect(retried.body.data.payment.clientToken).toBe("recovered-session");
    expect(requests).toHaveLength(2);
    expect(requests[1]?.url).toBe("https://sandbox.cashfree.com/pg/orders");
    expect(requests[1]?.headers["x-idempotency-key"]).toBe(requests[0]?.headers["x-idempotency-key"]);
    expect(requests[1]?.body.order_id).toBe(requests[0]?.body.order_id);
    expect(variant).toMatchObject(before);
  });
});

describe("persisted Cashfree verification", () => {
  it("commits catalog stock once when refreshing a captured payment from MySQL", async () => {
    let persistedOrder: StoredOrder;
    const persistence = {
      connect: vi.fn(async () => {}),
      hydrate: vi.fn(async (store: CommerceStore) => seedStore(store)),
      getSetting: vi.fn(async () => null),
      saveOrderAndReservations: vi.fn(async (order: StoredOrder) => {
        persistedOrder = structuredClone(order);
      }),
      resolvePaymentWebhook: vi.fn(async () => ({ paymentId: "persisted-payment" })),
      reconcilePayment: vi.fn(async () => {
        persistedOrder.status = "PAID";
        persistedOrder.inventoryState = "COMMITTED";
        persistedOrder.payment!.status = "CAPTURED";
      }),
      refreshOrder: vi.fn(async (store: CommerceStore) => {
        store.orders.set(persistedOrder.id, structuredClone(persistedOrder));
      }),
    };
    const providerRequest = vi.fn<typeof fetch>(async (_url, init) => {
      if (init?.method === "POST") {
        const body = JSON.parse(String(init.body));
        return new Response(JSON.stringify({ order_id: body.order_id, payment_session_id: "test-session" }));
      }
      return new Response(JSON.stringify([{
        payment_status: "SUCCESS", cf_payment_id: "test-capture",
        payment_amount: persistedOrder.total, payment_currency: "INR",
      }]));
    });
    const { store, post } = await start(persistence as unknown as PrismaPersistence, providerRequest);
    store.integrations.set("cashfree-test", {
      id: "cashfree-test", kind: "PAYMENT", provider: "cashfree", enabled: true, priority: 1, environment: "TEST",
      encryptedCredentials: new SecretVault(config.INTEGRATION_ENCRYPTION_KEY).encrypt({ clientId: "test-id", clientSecret: "test-secret" }),
      publicConfig: {}, updatedAt: new Date().toISOString(),
    });
    const variant = store.listProducts()[0]!.variants[0]!;
    const before = { stock: variant.stock, reserved: variant.reserved };
    const created = await post("/api/v1/checkout", checkout(variant.id, "cashfree"), { "idempotency-key": crypto.randomUUID() });
    expect(created.status).toBe(201);
    expect(variant.reserved).toBe(before.reserved + 2);
    const input = {
      orderNumber: created.body.data.order.number, provider: "cashfree",
      attemptToken: created.body.data.paymentAttemptToken,
    };
    const verified = await post("/api/v1/payments/verify", input);
    expect(verified.body.data).toMatchObject({ status: "CAPTURED", orderStatus: "PAID" });
    expect(variant).toMatchObject({ stock: before.stock - 2, reserved: before.reserved });
    await post("/api/v1/payments/verify", input);
    expect(persistence.reconcilePayment).toHaveBeenCalledOnce();
    expect(variant).toMatchObject({ stock: before.stock - 2, reserved: before.reserved });
  });
});

describe("persisted payment client events", () => {
  it.each(["CAPTURED", "REFUNDED", "PARTIALLY_REFUNDED"])("preserves %s even if it arrives after the initial payment read", async terminalStatus => {
    const current = { id: "payment-1", status: terminalStatus, gatewayTransactionId: "verified-capture" };
    const updateMany = vi.fn(async (input: { where: { status: { notIn: string[] } }; data: { status: string; gatewayTransactionId: string } }) => {
      if (input.where.status.notIn.includes(current.status)) return { count: 0 };
      Object.assign(current, input.data);
      return { count: 1 };
    });
    const tx = {
      payment: {
        findFirst: vi.fn(async () => ({ ...current, status: "CREATED" })),
        updateMany,
        findUniqueOrThrow: vi.fn(async () => current),
      },
      paymentTransaction: { upsert: vi.fn(async () => ({})) },
    };
    const persistence = new PrismaPersistence({ $transaction: async (fn: (db: typeof tx) => unknown) => fn(tx) } as never);
    const input = { orderNumber: "RU-TEST", providerOrderId: "cashfree-order", type: "FAILED" as const, gatewayPaymentId: "late-event" };
    const result = await persistence.recordPaymentClientEvent(input);
    expect(result).toMatchObject({ status: terminalStatus, gatewayTransactionId: "verified-capture" });
    await persistence.recordPaymentClientEvent(input);
    expect(tx.paymentTransaction.upsert.mock.calls[0]).toEqual(tx.paymentTransaction.upsert.mock.calls[1]);
    expect(updateMany).toHaveBeenCalledTimes(2);
  });
});
