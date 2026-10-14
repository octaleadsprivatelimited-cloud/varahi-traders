import path from "node:path";
import crypto from "node:crypto";
import os from "node:os";
import { mkdtemp, readdir, rm, stat } from "node:fs/promises";
import type { Server } from "node:http";
import sharp from "sharp";
import { afterAll, beforeAll, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import type { AppConfig } from "../src/config.js";
import { brandingFileName, unusedBrandingAssets } from "../src/branding-assets.js";
import { defaultStorefrontConfig, storefrontConfigSchema } from "../src/storefront-config.js";
import { CommerceStore } from "../src/store.js";
import { signAccessToken } from "../src/security.js";
import { PrismaPersistence } from "../src/persistence.js";

let server: Server, base: string, directory: string, token: string, customerToken: string;
let store: CommerceStore;
const config: AppConfig = {
  NODE_ENV: "test", PORT: 4010, DATABASE_URL: "mysql://test:test@localhost/test", USE_DATABASE: false,
  JWT_SECRET: "test-access-secret-that-is-at-least-32-chars", JWT_REFRESH_SECRET: "test-refresh-secret-that-is-at-least-32-chars",
  INTEGRATION_ENCRYPTION_KEY: "test-encryption-key-that-is-at-least-32-chars", CORS_ORIGINS: "http://localhost:5180", TRUST_PROXY: "",
  UPLOAD_DIR: "", PUBLIC_UPLOAD_BASE_URL: "https://store.test/uploads",
};
const read = async () => (await (await fetch(`${base}/api/v1/storefront/config`)).json()).data;
const save = async (settings: unknown) => fetch(`${base}/api/v1/admin/storefront-config`, {
  method: "PUT", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(settings),
});
const image = () => sharp({ create: { width: 480, height: 120, channels: 4, background: { r: 23, g: 63, b: 43, alpha: 0.5 } } }).png().toBuffer();
async function upload(kind: string, auth = token, bytes?: Buffer) {
  const body = new FormData(); body.append("image", new Blob([new Uint8Array(bytes || await image())], { type: "image/png" }), "logo.png");
  const response = await fetch(`${base}/api/v1/admin/storefront-config/assets/${kind}`, { method: "POST", headers: { authorization: `Bearer ${auth}` }, body });
  return { status: response.status, body: await response.json() };
}
const exists = (url: string) => stat(path.join(directory, path.basename(url))).then(() => true, () => false);
beforeAll(async () => {
  directory = await mkdtemp(path.join(os.tmpdir(), "branding-test-")); config.UPLOAD_DIR = directory;
  store = new CommerceStore();
  const admin = store.createUser({ name: "Admin", email: "varahi.admin.fixture@gmail.com", role: "ADMIN", permissions: ["*"] });
  const customer = store.createUser({ name: "Customer", email: "brand-customer@example.com", role: "CUSTOMER", permissions: [] });
  token = signAccessToken({ sub: admin.id, role: admin.role, permissions: admin.permissions }, config.JWT_SECRET);
  customerToken = signAccessToken({ sub: customer.id, role: customer.role, permissions: [] }, config.JWT_SECRET);
  const { app } = await createApp({ config, store }); server = app.listen(0);
  await new Promise<void>(resolve => server.once("listening", resolve));
  const address = server.address(); if (!address || typeof address === "string") throw new Error("Missing port");
  base = `http://127.0.0.1:${address.port}`;
});
afterAll(async () => { if (server) await new Promise<void>(resolve => server.close(() => resolve())); await rm(directory, { recursive: true, force: true }); });

it("upgrades saved settings with the analytics popup hidden and configurable footer identity", async () => {
  const { analyticsPromptEnabled: _prompt, footerLogoUrl: _footer, fssaiLicense: _license, ...legacy } = defaultStorefrontConfig;
  const upgraded = storefrontConfigSchema.parse(legacy);
  expect(upgraded.analyticsPromptEnabled).toBe(false); expect(upgraded.footerLogoUrl).toBe("");
  expect(upgraded.fssaiLicense).toBe("");
  expect((await save({ ...upgraded, analyticsPromptEnabled: true })).status).toBe(200);
  expect((await read()).analyticsPromptEnabled).toBe(true);
  expect((await save(upgraded)).status).toBe(200);
  expect((await read()).analyticsPromptEnabled).toBe(false);
  expect((await save({ ...upgraded, logoUrl: "javascript:alert(1)" })).status).toBe(400);
});
it("requires administrator access before processing an upload", async () => {
  expect((await upload("logo", "invalid")).status).toBe(401);
  expect((await upload("logo", customerToken)).status).toBe(403);
  expect(await readdir(directory)).toEqual([]);
});
it("publishes replacements and deletes the old upload only after all logo references are removed", async () => {
  const first = await upload("logo"); expect(first.status).toBe(201);
  const original = first.body.data.logoUrl;
  expect(await exists(original)).toBe(true);
  const metadata = await sharp(path.join(directory, path.basename(original))).metadata();
  expect(metadata.width).toBe(480); expect(metadata.height).toBe(120); expect(metadata.hasAlpha).toBe(true);
  expect((await save({ ...await read(), footerLogoUrl: original })).status).toBe(200);
  const replacement = await upload("logo"); expect(replacement.status).toBe(201);
  expect(replacement.body.data.logoUrl).not.toBe(original);
  expect(await exists(original)).toBe(true);
  expect((await save({ ...await read(), footerLogoUrl: "" })).status).toBe(200);
  expect(await exists(original)).toBe(false);
  expect(await exists(replacement.body.data.logoUrl)).toBe(true);
  expect((await save({ ...await read(), logoUrl: original })).status).toBe(409);
  expect((await read()).logoUrl).toBe(replacement.body.data.logoUrl);
});
it("keeps the current logo on a corrupt upload and leaves no partial file", async () => {
  const before = await read(), files = await readdir(directory);
  expect((await upload("logo", token, Buffer.from("not a png"))).status).toBe(422);
  expect((await read()).logoUrl).toBe(before.logoUrl);
  expect(await readdir(directory)).toEqual(files);
});
it("keeps a product's shared image and deletes it after its last reference is removed", async () => {
  const first = await upload("footer"), original = first.body.data.footerLogoUrl;
  const product = store.listProducts()[0]!;
  const id = crypto.randomUUID();
  product.media.push({ id, type: "IMAGE", url: new URL(original).pathname, alt: "Shared logo fixture", position: product.media.length });
  const next = await upload("footer");
  expect(next.status).toBe(201); expect(next.body.data.assetCleanupPending).toBe(false);
  expect(await exists(original)).toBe(true);
  product.media = product.media.filter(media => media.id !== id);
  expect((await save(await read())).status).toBe(200);
  expect(await exists(original)).toBe(false); expect(await exists(next.body.data.footerLogoUrl)).toBe(true);
});
it("updates favicon redirects and mobile manifests and retires replaced icons", async () => {
  const first = await upload("favicon"); const next = await upload("favicon");
  expect(first.status).toBe(201); expect(next.status).toBe(201); expect(await exists(first.body.data.faviconUrl)).toBe(false);
  const icon = await sharp(path.join(directory, path.basename(next.body.data.faviconUrl))).metadata();
  expect(icon.width).toBe(256); expect(icon.height).toBe(256);
  const redirect = await fetch(`${base}/api/v1/storefront/favicon`, { redirect: "manual" });
  expect(redirect.status).toBe(302); expect(redirect.headers.get("location")).toBe(next.body.data.faviconUrl);
  expect(redirect.headers.get("cache-control")).toBe("no-store");
  const manifest = await fetch(`${base}/api/v1/storefront/manifest`);
  expect(manifest.headers.get("content-type")).toContain("application/manifest+json");
  expect((await manifest.json()).icons[0].src).toBe(next.body.data.faviconUrl);
});
it("never deletes an external, product, bundled or traversal URL, and protects shared tenant assets", () => {
  const name = "brand-17fb914a-b08c-426e-9825-90c40a5e801d.png", baseUrl = config.PUBLIC_UPLOAD_BASE_URL;
  for (const url of [`https://evil.test/uploads/${name}`, `${baseUrl}/../${name}`, `${baseUrl}/%2e%2e%2f${name}`, `${baseUrl}/favicon.svg`, `${baseUrl}/17fb914a-b08c-426e-9825-90c40a5e801d.webp`]) expect(brandingFileName(url, baseUrl)).toBeNull();
  const previous = { ...defaultStorefrontConfig, logoUrl: `${baseUrl}/${name}` };
  expect(unusedBrandingAssets([previous], [{ ...defaultStorefrontConfig, footerLogoUrl: `/uploads/${name}` }], baseUrl)).toEqual([]);
  expect(unusedBrandingAssets([previous], [defaultStorefrontConfig], baseUrl)).toEqual([previous.logoUrl]);
});
it.skipIf(process.env.RUN_DB_TESTS !== "1")("rolls back every MySQL settings alias if one publication fails", async () => {
  const persistence = new PrismaPersistence();
  const key = `branding-atomic-test:${crypto.randomUUID()}`;
  try {
    await expect(persistence.saveSettings([{ key, value: { logoUrl: "new-logo" } }, { key: "x".repeat(1024), value: {} }])).rejects.toThrow();
    expect(await persistence.getSetting(key)).toBeNull();
  } finally { await persistence.db.setting.deleteMany({ where: { key } }); await persistence.disconnect(); }
});
