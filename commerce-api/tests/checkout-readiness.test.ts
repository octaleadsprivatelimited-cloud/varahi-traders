import type { Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { SecretVault } from "../src/security.js";

const encryptionKey = "checkout-readiness-encryption-key-32-characters";
let server: Server | undefined;

async function setup() {
  const config = loadConfig({
    NODE_ENV: "production",
    DATABASE_URL: "mysql://unused:unused@localhost/test",
    JWT_SECRET: "checkout-readiness-access-secret-32-characters",
    JWT_REFRESH_SECRET: "checkout-readiness-refresh-secret-32-characters",
    INTEGRATION_ENCRYPTION_KEY: encryptionKey,
    CORS_ORIGINS: "https://shop.example.com",
    USE_DATABASE: "true",
    PUBLIC_UPLOAD_BASE_URL: "https://shop.example.com/uploads",
  });
  const result = await createApp({ config, persistence: null });
  server = result.app.listen(0, "127.0.0.1");
  await new Promise<void>(resolve => server!.once("listening", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing server address");
  return { ...result, base: `http://127.0.0.1:${address.port}` };
}

afterEach(async () => {
  if (server) await new Promise<void>((resolve, reject) => server!.close(error => error ? reject(error) : resolve()));
  server = undefined;
});

describe("production checkout availability", () => {
  it("keeps checkout and COD unavailable until a live shipping provider is configured", async () => {
    const { base, store } = await setup();
    const availability = await (await fetch(`${base}/api/v1/payments/providers`)).json();
    expect(availability.data).toMatchObject({ checkout: { enabled: false }, cod: { enabled: false }, cashfree: { enabled: false } });
    const variant = store.listProducts()[0]!.variants[0]!;
    const quote = await fetch(`${base}/api/v1/checkout/quote`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ lines: [{ variantId: variant.id, quantity: 1 }], postalCode: "500081", paymentProvider: "cod" }),
    });
    expect(quote.status).toBe(503);
    expect((await quote.json()).error.code).toBe("SHIPPING_NOT_CONFIGURED");
    expect(store.orders.size).toBe(0);
  });

  it("only enables checkout for an enabled, configured LIVE provider and never exposes credentials", async () => {
    const { base, store } = await setup();
    const entry = {
      id: "shipping-readiness-test", kind: "SHIPPING" as const, provider: "shiprocket", enabled: true,
      priority: 1, environment: "TEST" as "TEST" | "LIVE",
      encryptedCredentials: new SecretVault(encryptionKey).encrypt({ token: "private-provider-token" }),
      publicConfig: { pickupPostcode: "500081", pickupLocation: "Warehouse" },
      updatedAt: new Date().toISOString(),
    };
    store.integrations.set(entry.id, entry);
    const readiness = async () => (await (await fetch(`${base}/api/v1/payments/providers`)).json());
    expect((await readiness()).data.checkout.enabled).toBe(false);
    entry.environment = "LIVE";
    const enabled = await readiness();
    expect(enabled.data).toMatchObject({ checkout: { enabled: true }, cod: { enabled: true } });
    expect(JSON.stringify(enabled)).not.toContain("private-provider-token");
    entry.enabled = false;
    expect((await readiness()).data.checkout.enabled).toBe(false);
    entry.enabled = true;
    entry.encryptedCredentials = new SecretVault(encryptionKey).encrypt({});
    expect((await readiness()).data.checkout.enabled).toBe(false);
  });
});
