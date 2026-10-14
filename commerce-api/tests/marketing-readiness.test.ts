import type { Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { CommerceStore } from "../src/store.js";
import { signAccessToken } from "../src/security.js";
import type { AppConfig } from "../src/config.js";

const config: AppConfig = {
  NODE_ENV: "test", PORT: 4010, DATABASE_URL: "mysql://unused",
  JWT_SECRET: "test-marketing-access-secret-at-least-32-characters",
  JWT_REFRESH_SECRET: "test-marketing-refresh-secret-at-least-32-characters",
  INTEGRATION_ENCRYPTION_KEY: "test-marketing-vault-key-at-least-32-characters",
  CORS_ORIGINS: "http://localhost:5180", TRUST_PROXY: "", USE_DATABASE: false,
  UPLOAD_DIR: "uploads", PUBLIC_UPLOAD_BASE_URL: "http://localhost:4010/uploads",
};
let server: Server;
let base: string;
let adminToken: string;
let customerToken: string;

beforeAll(async () => {
  const store = new CommerceStore();
  const { app } = await createApp({ config, store, persistence: null });
  store.products.clear();
  const admin = store.createUser({ email: "varahi.admin.fixture@gmail.com", name: "Store admin", role: "ADMIN", permissions: ["*"] });
  const customer = store.createUser({ email: "customer@example.com", name: "Customer", role: "CUSTOMER", permissions: [] });
  adminToken = signAccessToken({ sub: admin.id, role: admin.role, permissions: admin.permissions }, config.JWT_SECRET);
  customerToken = signAccessToken({ sub: customer.id, role: customer.role, permissions: [] }, config.JWT_SECRET);
  store.integrations.set("ga4-test", { id: "ga4-test", kind: "ANALYTICS", provider: "google-analytics", environment: "TEST", enabled: true, priority: 1, encryptedCredentials: "private-material-must-never-leak", publicConfig: { measurementId: "G-1234567890", _internal: "private-provider-metadata" }, updatedAt: new Date().toISOString() });
  server = app.listen(0);
  await new Promise<void>(resolve => server.once("listening", resolve));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterAll(async () => { await new Promise<void>(resolve => server.close(() => resolve())); });

describe("private marketing readiness", () => {
  it("does not reveal diagnostics to anonymous visitors or customers", async () => {
    expect((await fetch(`${base}/api/v1/admin/analytics/marketing`)).status).toBe(401);
    expect((await fetch(`${base}/api/v1/admin/analytics/marketing`, { headers: { authorization: `Bearer ${customerToken}` } })).status).toBe(403);
  });
  it("reports an empty real catalogue and only public tracking IDs to the admin", async () => {
    const response = await fetch(`${base}/api/v1/admin/analytics/marketing`, { headers: { authorization: `Bearer ${adminToken}` } });
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    const body = await response.json();
    expect(body.data.analytics).toEqual({ ga4MeasurementId: "G-1234567890" });
    expect(body.data.feed).toMatchObject({ activeProducts: 0, eligibleItems: 0, excludedItems: 0 });
    expect(body.data.businessMissing).toContain("business postal address");
    expect(JSON.stringify(body)).not.toContain("private-material");
    expect(JSON.stringify(body)).not.toContain("private-provider");
  });
});
