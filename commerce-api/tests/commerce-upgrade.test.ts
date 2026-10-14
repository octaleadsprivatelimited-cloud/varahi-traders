import crypto from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Server } from "node:http";
import { createApp } from "../src/app.js";
import { CommerceStore } from "../src/store.js";
import { SecretVault, signAccessToken } from "../src/security.js";
import type { AppConfig } from "../src/config.js";
const config: AppConfig = {
  NODE_ENV: "test",
  PORT: 4010,
  DATABASE_URL: "mysql://unused",
  JWT_SECRET: "test-access-secret-that-is-at-least-32-chars",
  JWT_REFRESH_SECRET: "test-refresh-secret-that-is-at-least-32-chars",
  INTEGRATION_ENCRYPTION_KEY: "test-encryption-key-that-is-at-least-32-chars",
  CORS_ORIGINS: "http://localhost:5180",
  TRUST_PROXY: "",
  USE_DATABASE: false,
  FIREBASE_PROJECT_ID: "test-commerce",
  FIREBASE_API_KEY: "AIza" + "x".repeat(30),
  FIREBASE_AUTH_DOMAIN: "test-commerce.firebaseapp.com",

  UPLOAD_DIR: "uploads",
  PUBLIC_UPLOAD_BASE_URL: "http://localhost:4010/uploads",
};
let server: Server, base: string, store: CommerceStore, adminToken: string;
let googleEmail = "varahi.admin.fixture@gmail.com";
const orders = new Map<string, number>();
async function request(
  path: string,
  body?: unknown,
  headers: Record<string, string> = {},
) {
  const r = await fetch(base + path, {
    method: body === undefined ? "GET" : "POST",
    headers: { "content-type": "application/json", ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: r.status, body: (await r.json()) as any };
}
function signed(payload: unknown) {
  const raw = JSON.stringify(payload),
    timestamp = String(Date.now());
  return {
    "x-webhook-timestamp": timestamp,
    "x-webhook-signature": crypto
      .createHmac("sha256", "cf-secret")
      .update(timestamp)
      .update(raw)
      .digest("base64"),
  };
}
beforeAll(async () => {
  store = new CommerceStore();
  const result = await createApp({
    config,
    store,
    persistence: null,
    googleVerifier: async () => ({
      sub: `google-${googleEmail}`,
      email: googleEmail,
      email_verified: true,
      aud: config.FIREBASE_PROJECT_ID || "test-commerce",
      iss: "https://accounts.google.com",
      exp: Math.floor(Date.now() / 1000) + 300,
    }),
    providerRequest: async (url, init) => {
      const body = init?.body ? JSON.parse(String(init.body)) : null;
      if (String(url).endsWith("/orders") && body) {
        orders.set(body.order_id, body.order_amount);
        return new Response(
          JSON.stringify({
            order_id: body.order_id,
            payment_session_id: "session_test",
          }),
        );
      }
      if (String(url).endsWith("/refunds") && body)
        return new Response(
          JSON.stringify({
            refund_id: body.refund_id,
            refund_status: "PENDING",
          }),
        );
      return new Response("{}", { status: 500 });
    },
  });
  store.integrations.set("cashfree-test", {
    id: "cashfree-test",
    kind: "PAYMENT",
    provider: "cashfree",
    enabled: true,
    priority: 1,
    environment: "TEST",
    encryptedCredentials: new SecretVault(
      config.INTEGRATION_ENCRYPTION_KEY,
    ).encrypt({ clientId: "cf-id", clientSecret: "cf-secret" }),
    publicConfig: {},
    updatedAt: new Date().toISOString(),
  });
  server = result.app.listen(0);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const admin = store.createUser({ email: googleEmail, name: "Admin", role: "ADMIN", permissions: ["*"] });
  adminToken = signAccessToken({ sub: admin.id, role: admin.role, permissions: admin.permissions }, config.JWT_SECRET);
});
afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});
describe("complete commerce integration", () => {
  it("allows the designated Google administrator and gives other accounts customer access", async () => {
    const credential = "google-token".padEnd(120, "x");
    const linked = await request("/api/v1/auth/google", { credential });
    expect(linked.status).toBe(200);
    expect(linked.body.data.user.role).toBe("ADMIN");
    adminToken = linked.body.data.accessToken;
    expect(
      (await request("/api/v1/auth/google", { credential })).body.data.user
        .role,
    ).toBe("ADMIN");
    googleEmail = "new-google@example.com";
    expect(
      (await request("/api/v1/auth/google", { credential })).body.data.user
        .role,
    ).toBe("CUSTOMER");
  });
  it("verifies Cashfree captures, rejects tampering, and completes refunds only on a signed success", async () => {
    const variant = store.listProducts()[0]!.variants[0]!;
    const checkout = await request(
      "/api/v1/checkout",
      {
        lines: [{ variantId: variant.id, quantity: 1 }],
        postalCode: "500081",
        paymentProvider: "cashfree",
        contact: {
          name: "Buyer",
          email: "buyer@example.com",
          phone: "9876543210",
        },
        shippingAddress: {
          line1: "10 Test Street",
          city: "Hyderabad",
          state: "Telangana",
          country: "IN",
        },
      },
      { "idempotency-key": crypto.randomUUID() },
    );
    expect(checkout.status).toBe(201);
    const order = checkout.body.data.order,
      payment = checkout.body.data.payment;
    expect(payment.environment).toBe("TEST");
    const payload = {
      type: "PAYMENT_SUCCESS_WEBHOOK",
      data: {
        order: { order_id: payment.externalId },
        payment: {
          cf_payment_id: 12345,
          payment_status: "SUCCESS",
          payment_amount: order.total,
          payment_currency: "INR",
        },
      },
    };
    expect((await request("/webhooks/cashfree", payload)).status).toBe(401);
    const wrong = {
      ...payload,
      data: {
        ...payload.data,
        payment: { ...payload.data.payment, payment_amount: 1 },
      },
    };
    expect(
      (await request("/webhooks/cashfree", wrong, signed(wrong))).status,
    ).toBe(422);
    expect(
      (await request("/webhooks/cashfree", payload, signed(payload))).status,
    ).toBe(202);
    expect(
      (await request("/webhooks/cashfree", payload, signed(payload))).body.data
        .duplicate,
    ).toBe(true);
    const refund = await request(
      `/api/v1/admin/orders/${order.id}/refunds`,
      { amount: 100, reason: "Customer cancellation" },
      {
        authorization: `Bearer ${adminToken}`,
        "idempotency-key": crypto.randomUUID(),
      },
    );
    expect(refund.status).toBe(202);
    expect(refund.body.data.refund.status).toBe("PENDING");
    const event = {
      type: "REFUND_STATUS_WEBHOOK",
      data: {
        refund: {
          order_id: payment.externalId,
          refund_id: refund.body.data.refund.reference,
          refund_status: "SUCCESS",
          refund_amount: 100,
        },
      },
    };
    expect(
      (await request("/webhooks/cashfree", event, signed(event))).status,
    ).toBe(200);
    expect(store.orders.get(order.id)?.payment?.refundedAmount).toBe(100);
    expect(
      (await request("/webhooks/cashfree", event, signed(event))).status,
    ).toBe(200);
    expect(store.orders.get(order.id)?.payment?.refundedAmount).toBe(100);
  });
});
