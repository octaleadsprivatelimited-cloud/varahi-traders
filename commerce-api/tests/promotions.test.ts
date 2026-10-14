import type { Server } from "node:http";
import { afterAll, beforeAll, expect, it } from "vitest";
import { defaultPromotionConfig, promotionConfigSchema, publicPromotionConfig } from "../src/promotions.js";
import { createApp } from "../src/app.js";
import { CommerceStore } from "../src/store.js";
import { signAccessToken } from "../src/security.js";
import type { AppConfig } from "../src/config.js";

const visibilityPath = "../../src/lib/promotion-visibility.ts";
const { canShowOfferOnPath, popupFrequencyAllows } = await import(visibilityPath);
const campaigns = promotionConfigSchema.parse({
  ...defaultPromotionConfig,
  banners: [defaultPromotionConfig.banners[0], { ...defaultPromotionConfig.banners[0], id: "567a71d1-2143-4eb5-90c1-7dab1c8a7970", placement: "HOME_INLINE" }],
  popups: [{ id: "7f6f988e-cd4a-47fb-a115-2379ff9bfdd0", name: "Welcome", enabled: true, startsAt: "", endsAt: "", audience: "ALL", headline: "Welcome offer", body: "A welcome offer.", couponCode: "WELCOME", buttonLabel: "Shop", buttonUrl: "/shop", delaySeconds: 4, frequency: "ONCE" }],
});

it("preserves existing campaigns on upgrade and removes both popup types when switched off", () => {
  const { welcomePopupEnabled: _oldField, ...legacy } = campaigns;
  expect(promotionConfigSchema.parse(legacy).welcomePopupEnabled).toBe(true);
  const result = publicPromotionConfig({ ...campaigns, welcomePopupEnabled: false });
  expect(result.welcomePopupEnabled).toBe(false);
  expect(result.popups).toEqual([]);
  expect(result.banners.map(item => item.placement)).toEqual(["HOME_INLINE"]);
  expect(campaigns.banners).toHaveLength(2);
  expect(campaigns.popups).toHaveLength(1);
});

it("keeps popup offers away from authentication, checkout and account pages", () => {
  for (const path of ["/login", "/signup", "/cart", "/checkout", "/customer", "/customer/orders", "/account", "/admin", "/admin/marketing", "/order-confirmation/123"]) expect(canShowOfferOnPath(path)).toBe(false);
  for (const path of ["/", "/shop", "/product/sesame-oil"]) expect(canShowOfferOnPath(path)).toBe(true);
  expect(popupFrequencyAllows("ONCE", "1000", 86402000)).toBe(false);
  expect(popupFrequencyAllows("DAILY", "1000", 1001)).toBe(false);
  expect(popupFrequencyAllows("DAILY", "1000", 86401000)).toBe(true);
  expect(popupFrequencyAllows("EVERY_VISIT", "1000", 1001)).toBe(true);
});

let server: Server;
let base = "";
let token = "";
const config: AppConfig = {
  NODE_ENV: "test", PORT: 4010, DATABASE_URL: "mysql://test:test@localhost/test", USE_DATABASE: false,
  JWT_SECRET: "test-access-secret-that-is-at-least-32-chars", JWT_REFRESH_SECRET: "test-refresh-secret-that-is-at-least-32-chars", INTEGRATION_ENCRYPTION_KEY: "test-encryption-key-that-is-at-least-32-chars", CORS_ORIGINS: "http://localhost:5180", TRUST_PROXY: "", UPLOAD_DIR: "uploads", PUBLIC_UPLOAD_BASE_URL: "http://localhost:4010/uploads",
};
beforeAll(async () => {
  const store = new CommerceStore();
  const admin = store.createUser({ name: "Admin", email: "varahi.admin.fixture@gmail.com", role: "ADMIN", permissions: ["*"] });
  token = signAccessToken({ sub: admin.id, role: admin.role, permissions: admin.permissions }, config.JWT_SECRET);
  const { app } = await createApp({ config, store });
  server = app.listen(0);
  await new Promise<void>(resolve => server.once("listening", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing test port");
  base = `http://127.0.0.1:${address.port}`;
});
afterAll(async () => { if (server) await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); });
it("publishes the admin switch, retains editable content and restores it when enabled", async () => {
  const save = (enabled: boolean, authToken = token) => fetch(`${base}/api/v1/admin/promotions`, { method: "PUT", headers: { "content-type": "application/json", authorization: `Bearer ${authToken}` }, body: JSON.stringify({ ...campaigns, welcomePopupEnabled: enabled }) });
  expect((await save(false, "invalid")).status).toBe(401);
  expect((await save(false)).status).toBe(200);
  const publicResponse = await fetch(`${base}/api/v1/storefront/promotions`);
  expect(publicResponse.headers.get("cache-control")).toBe("no-store");
  const hidden = (await publicResponse.json()).data;
  expect(hidden.welcomePopupEnabled).toBe(false);
  expect(hidden.banners.map((item: { placement: string }) => item.placement)).toEqual(["HOME_INLINE"]);
  expect(hidden.popups).toEqual([]);
  const adminResponse = await fetch(`${base}/api/v1/admin/promotions`, { headers: { authorization: `Bearer ${token}` } });
  const saved = (await adminResponse.json()).data;
  expect(saved.welcomePopupEnabled).toBe(false);
  expect(saved.banners).toHaveLength(2);
  expect(saved.popups).toHaveLength(1);
  expect((await save(true)).status).toBe(200);
  const restored = (await (await fetch(`${base}/api/v1/storefront/promotions`)).json()).data;
  expect(restored.welcomePopupEnabled).toBe(true);
  expect(restored.banners).toHaveLength(2);
  expect(restored.popups).toHaveLength(1);
});
