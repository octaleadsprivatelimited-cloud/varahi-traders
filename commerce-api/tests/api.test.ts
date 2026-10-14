import crypto from "node:crypto";
import path from "node:path";
import os from "node:os";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import sharp from "sharp";
import type { Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import type { AppConfig } from "../src/config.js";
import { AppError } from "../src/errors.js";
import { signAccessToken } from "../src/security.js";
import { CommerceStore, seedStore } from "../src/store.js";
import {
  customerMetrics,
  customerSegments,
} from "../src/admin-customer-operations.js";
const config: AppConfig = {
  NODE_ENV: "test",
  PORT: 4010,
  DATABASE_URL: "mysql://test:test@localhost/test",
  JWT_SECRET: "test-access-secret-that-is-at-least-32-chars",
  JWT_REFRESH_SECRET: "test-refresh-secret-that-is-at-least-32-chars",
  INTEGRATION_ENCRYPTION_KEY: "test-encryption-key-that-is-at-least-32-chars",
  CORS_ORIGINS: "http://localhost:5180",
  TRUST_PROXY: "",
  USE_DATABASE: false,
  FIREBASE_PROJECT_ID: "test-commerce",
  FIREBASE_API_KEY: "AIza" + "x".repeat(30),
  FIREBASE_AUTH_DOMAIN: "test-commerce.firebaseapp.com",

  UPLOAD_DIR: "",
  PUBLIC_UPLOAD_BASE_URL: "http://localhost:4010/uploads",
};
let uploadDirectory = "";
let googleEmail = "google.customer@example.com";
async function googleLogin(email: string) {
  googleEmail = email;
  try { return await request("/api/v1/auth/google", { method: "POST", body: JSON.stringify({ credential: "x".repeat(120) }) }); }
  finally { googleEmail = "google.customer@example.com"; }
}
let server: Server,
  base: string,
  store: CommerceStore,
  adminToken: string,
  customerToken: string;
async function request(path: string, init: RequestInit = {}) {
  const response = await fetch(`${base}${path}`, {
    ...init,
    headers: { "content-type": "application/json", ...init.headers },
  });
  return {
    status: response.status,
    body: (await response.json()) as any,
    headers: response.headers,
  };
}
beforeAll(async () => {
  uploadDirectory = await mkdtemp(path.join(os.tmpdir(), "commerce-upload-"));
  config.UPLOAD_DIR = uploadDirectory;
  store = new CommerceStore();
  const created = await createApp({
    config,
    store,
    googleVerifier: async () => ({
      sub: `google-${googleEmail}`,
      email: googleEmail,
      email_verified: true,
      name: "Google Customer",
      aud: config.FIREBASE_PROJECT_ID || "test-commerce",
      iss: "https://accounts.google.com",
      exp: Math.floor(Date.now() / 1000) + 3600,
    }),
    providerRequest: async (input, init) => {
      const url = String(input);
      if (url === "https://api.razorpay.com/v1/orders?count=1") {
        const expected = `Basic ${Buffer.from(
          "rzp_test_public:super-secret-1234",
        ).toString("base64")}`;
        return new Response(JSON.stringify({ items: [] }), {
          status: init?.headers &&
              (init.headers as Record<string, string>).authorization === expected
            ? 200
            : 401,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(null, { status: 503 });
    },
  });
  server = created.app.listen(0);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No test port");
  base = `http://127.0.0.1:${address.port}`;
  const admin = store.createUser({ email: "varahi.admin.fixture@gmail.com", name: "Test Admin", role: "ADMIN", permissions: ["*"] });
  adminToken = signAccessToken({ sub: admin.id, role: admin.role, permissions: admin.permissions }, config.JWT_SECRET);
});
afterAll(async () => {
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  await rm(uploadDirectory, { recursive: true, force: true });
});
describe("commerce API", () => {
  it("resolves configured product handles and legacy IDs without publishing hidden products", async () => {
    const product = store.listProducts()[0]!;
    const originalSlug = product.slug;
    const originalStatus = product.status;
    try {
      product.slug = "custom-oil-url-from-admin";
      for (const key of [product.id, product.slug]) {
        const response = await request(`/api/v1/products/${key}`);
        expect(response.status).toBe(200);
        expect(response.body.data).toMatchObject({ id: product.id, slug: product.slug });
      }
      const suggestions = await request(`/api/v1/search/suggestions?q=${encodeURIComponent(product.name.slice(0, 8))}`);
      expect(suggestions.body.data).toContainEqual(expect.objectContaining({ id: product.id, slug: product.slug }));
      expect((await request("/api/v1/products/nonexistent-product-handle")).status).toBe(404);
      product.status = "ARCHIVED";
      for (const key of [product.id, product.slug]) expect((await request(`/api/v1/products/${key}`)).status).toBe(404);
    } finally {
      product.slug = originalSlug;
      product.status = originalStatus;
    }
  });
  it("does not expose product reviews or allow customer/admin review operations", async () => {
    const product = store.listProducts()[0]!;
    const removedRoutes = [
      ["GET", `/api/v1/products/${product.id}/reviews`],
      ["GET", "/api/v1/account/reviews"],
      ["POST", "/api/v1/account/reviews"],
      ["GET", "/api/v1/admin/reviews"],
      ["GET", "/api/v1/admin/reviews/legacy-review"],
      ["PATCH", "/api/v1/admin/reviews/legacy-review"],
    ];
    for (const [method, route] of removedRoutes) {
      const response = await request(route!, {
        method,
        headers: { authorization: `Bearer ${adminToken}` },
        ...(["POST", "PATCH"].includes(method!) ? {
          body: JSON.stringify({ productId: product.id, rating: 5, body: "A review that must not be stored", status: "APPROVED" }),
        } : {}),
      });
      expect(response.status, `${method} ${route}`).toBe(404);
    }
    const catalog = await request(`/api/v1/products/${product.id}`);
    expect(catalog.body.data).not.toHaveProperty("reviews");
    expect(catalog.body.data).not.toHaveProperty("rating");
    expect(catalog.body.data).not.toHaveProperty("aggregateRating");
  });
  it("reports health without leaking internals", async () => {
    const r = await request("/health");
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({
      success: true,
      data: { status: "healthy" },
    });
    const ready = await request("/ready");
    expect(ready.status).toBe(200);
    expect(ready.body.data).toMatchObject({
      status: "ready",
      persistence: "memory",
    });
  });
  it("supports verified Google sign-in", async () => {
    const google = await request("/api/v1/auth/google", {
      method: "POST",
      body: JSON.stringify({ credential: "x".repeat(120) }),
    });
    expect(google.status).toBe(200);
    expect(google.body.data.user.email).toBe("google.customer@example.com");
  });
  it("serves and securely updates white-label storefront settings", async () => {
    const initial = await request("/api/v1/storefront/config");
    expect(initial.body.data.storeName).toBe("Sri Varahi Traders");
    expect(initial.body.data.freeShippingThreshold).toBe(999);
    const unauthorized = await request("/api/v1/admin/storefront-config");
    expect(unauthorized.status).toBe(401);
    const updated = {
      ...initial.body.data,
      storeName: "Customer Store",
      primaryDomain: "shop.customer.test",
    };
    const saved = await request("/api/v1/admin/storefront-config", {
      method: "PUT",
      headers: { authorization: `Bearer ${adminToken}` },
      body: JSON.stringify(updated),
    });
    expect(saved.status).toBe(200);
    const branded = await request("/api/v1/storefront/config");
    expect(branded.body.data.storeName).toBe("Customer Store");
    const firstTenant = await request("/api/v1/admin/storefront-config", {
      method: "PUT",
      headers: { authorization: `Bearer ${adminToken}` },
      body: JSON.stringify({
        ...updated,
        storeName: "First Tenant",
        primaryDomain: "first.customer.test",
        freeShippingThreshold: 0,
      }),
    });
    expect(firstTenant.status).toBe(200);
    const secondTenant = await request("/api/v1/admin/storefront-config", {
      method: "PUT",
      headers: { authorization: `Bearer ${adminToken}` },
      body: JSON.stringify({
        ...updated,
        freeShippingThreshold: 999,
      }),
    });
    expect(secondTenant.status).toBe(200);
    const forgedTenant = await request("/api/v1/storefront/config", {
      headers: { "x-forwarded-host": "first.customer.test" },
    });
    expect(forgedTenant.body.data.storeName).toBe("Customer Store");
    expect(forgedTenant.body.data.freeShippingThreshold).toBe(999);
    expect(
      store.auditLogs.some(
        (log) => log.action === "storefront.settings.updated",
      ),
    ).toBe(true);
  });
  it("publishes targeted campaigns and recommends products from browsing intent", async () => {
    const initial = await request("/api/v1/storefront/promotions");
    expect(initial.status).toBe(200);
    expect(initial.body.data.banners[0].buttonUrl).toBe("/shop");
    const unauthorized = await request("/api/v1/admin/promotions");
    expect(unauthorized.status).toBe(401);
    const recommendation = await request("/api/v1/storefront/recommendations", {
      method: "POST",
      body: JSON.stringify({
        categories: ["Sesame Oils"],
        viewedProductIds: [],
        cartProductIds: [],
        limit: 3,
      }),
    });
    expect(recommendation.status).toBe(200);
    expect(recommendation.body.data).toHaveLength(3);
    expect(recommendation.body.data[0].reason).toContain("Sesame Oils");
  });
  it("authenticates customers through Google", async () => {
    const login = await googleLogin("ananya@example.com");
    expect(login.status).toBe(200);
    customerToken = login.body.data.accessToken;
  });
  it("enforces admin RBAC", async () => {
    const denied = await request("/api/v1/admin/products", {
      method: "POST",
      body: "{}",
    });
    expect(denied.status).toBe(401);
    const listed = await request("/api/v1/products");
    expect(listed.body.data.length).toBeGreaterThan(0);
  });
  it("returns ranked public product search suggestions", async () => {
    const suggestions = await request("/api/v1/search/suggestions?q=groundnut");
    expect(suggestions.status).toBe(200);
    expect(suggestions.body.data[0]).toMatchObject({
      name: expect.stringMatching(/groundnut/i),
      category: expect.any(String),
      price: expect.any(Number),
    });
    const shortQuery = await request("/api/v1/search/suggestions?q=t");
    expect(shortQuery.body.data).toEqual([]);
    const longQuery = await request(`/api/v1/search/suggestions?q=${"x".repeat(81)}`);
    expect(longQuery.status).toBe(400);
  });
  it("rotates refresh sessions and revokes them on logout", async () => {
    const login = await googleLogin("refresh.customer@example.com");
    const cookie = login.headers.get("set-cookie")!.split(";")[0]!;
    const refreshed = await request("/api/v1/auth/refresh", {
      method: "POST",
      headers: { cookie },
    });
    expect(refreshed.status).toBe(200);
    expect(refreshed.body.data.accessToken).toBeTypeOf("string");
    const replay = await request("/api/v1/auth/refresh", {
      method: "POST",
      headers: { cookie },
    });
    expect(replay.status).toBe(401);
    const rotatedCookie = refreshed.headers.get("set-cookie")!.split(";")[0]!;
    const logout = await request("/api/v1/auth/logout", {
      method: "POST",
      headers: { cookie: rotatedCookie },
    });
    expect(logout.status).toBe(200);
    const revoked = await request("/api/v1/auth/refresh", {
      method: "POST",
      headers: { cookie: rotatedCookie },
    });
    expect(revoked.status).toBe(401);
  });
  it("creates and archives variant products", async () => {
    const payload = {
      name: "Groundnut Oil",
      slug: "groundnut-oil",
      description: "An oil bottle fixture for catalog tests.",
      category: "Cooking Oils",
      status: "ACTIVE",
      taxRate: 12,
      hsnCode: "6204",
      variants: [
        {
          sku: "SVT-DSVT-M",
          title: "1 L",
          price: 4990,
          mrp: 5990,
          stock: 10,
          reserved: 0,
          attributes: { Volume: "1 L" },
          weightGrams: 450,
        },
      ],
    };
    const made = await request("/api/v1/admin/products", {
      method: "POST",
      headers: { authorization: `Bearer ${adminToken}` },
      body: JSON.stringify(payload),
    });
    expect(made.status).toBe(201);
    expect(made.body.data.variants[0].attributes.Volume).toBe("1 L");
    const archived = await request(
      `/api/v1/admin/products/${made.body.data.id}`,
      { method: "DELETE", headers: { authorization: `Bearer ${adminToken}` } },
    );
    expect(archived.body.data.status).toBe("ARCHIVED");
  });
  it("converts uploaded product images to optimized WebP and rejects invalid files", async () => {
    const product = store.listProducts()[0]!,
      image = await sharp({
        create: {
          width: 2400,
          height: 1800,
          channels: 3,
          background: "#b96849",
        },
      })
        .jpeg({ quality: 95 })
        .withMetadata({ orientation: 1, density: 300 })
        .toBuffer(),
      form = new FormData();
    form.append(
      "image",
      new Blob([image], { type: "image/jpeg" }),
      "product.jpg",
    );
    form.append("alt", "Product view");
    const response = await fetch(
        `${base}/api/v1/admin/products/${product.id}/media/upload`,
        {
          method: "POST",
          headers: { authorization: `Bearer ${adminToken}` },
          body: form,
        },
      ),
      body = (await response.json()) as any;
    expect(response.status).toBe(201);
    expect(body.data.media.url).toMatch(/\.webp$/);
    expect(body.data.format).toBe("webp");
    expect(body.data.width).toBe(1600);
    expect(body.data.height).toBe(1200);
    expect(body.data.thumbnail).toMatchObject({ width: 480, height: 480 });
    expect(body.data.bytes).toBeLessThan(image.length);
    const mainPath = path.join(
        uploadDirectory,
        path.basename(new URL(body.data.url).pathname),
      ),
      thumbnailPath = path.join(
        uploadDirectory,
        path.basename(new URL(body.data.thumbnailUrl).pathname),
      ),
      outputMetadata = await sharp(await readFile(mainPath)).metadata();
    expect(outputMetadata.format).toBe("webp");
    expect(outputMetadata.exif).toBeUndefined();
    expect(outputMetadata.icc).toBeUndefined();
    await expect(stat(thumbnailPath)).resolves.toBeDefined();

    const removed = await request(
      `/api/v1/admin/products/${product.id}/media/${body.data.media.id}`,
      { method: "DELETE", headers: { authorization: `Bearer ${adminToken}` } },
    );
    expect(removed.status).toBe(200);
    await expect(stat(mainPath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(stat(thumbnailPath)).rejects.toMatchObject({ code: "ENOENT" });

    const bad = new FormData();
    bad.append(
      "image",
      new Blob(["not-an-image"], { type: "text/plain" }),
      "bad.txt",
    );
    const rejected = await fetch(
      `${base}/api/v1/admin/products/${product.id}/media/upload`,
      {
        method: "POST",
        headers: { authorization: `Bearer ${adminToken}` },
        body: bad,
      },
    );
    expect(rejected.status).toBe(415);

    const spoofed = new FormData();
    spoofed.append(
      "image",
      new Blob(["not-an-image"], { type: "image/png" }),
      "spoofed.png",
    );
    const invalidContent = await fetch(
      `${base}/api/v1/admin/products/${product.id}/media/upload`,
      {
        method: "POST",
        headers: { authorization: `Bearer ${adminToken}` },
        body: spoofed,
      },
    );
    expect(invalidContent.status).toBe(415);
    await expect(invalidContent.json()).resolves.toMatchObject({
      error: { code: "IMAGE_CONTENT_INVALID" },
    });
  });
  it("manages paginated products with stable variants and non-destructive retirement", async () => {
    const smallId = crypto.randomUUID(),
      largeId = crypto.randomUUID();
    const payload = {
      name: "Admin Matrix Oil",
      slug: `admin-matrix-oil-${crypto.randomUUID().slice(0, 8)}`,
      description: "A test product used to verify the complete admin catalog workflow.",
      category: "Cooking Oils",
      brand: "Sri Varahi Traders Test",
      status: "ACTIVE",
      taxRate: 12,
      specifications: { "Oil type": "Groundnut" },
      media: [
        {
          url: "https://example.com/admin-matrix-front.webp",
          alt: "Oil bottle front",
          type: "IMAGE",
          position: 0,
        },
        {
          url: "https://example.com/admin-matrix-back.webp",
          alt: "Oil bottle back",
          type: "IMAGE",
          position: 1,
        },
      ],
      variants: [
        {
          id: smallId,
          sku: `TEST-OIL-S-${crypto.randomUUID().slice(0, 8)}`,
          title: "Small",
          active: true,
          price: 3990,
          mrp: 4490,
          stock: 8,
          reserved: 0,
          attributes: { Size: "S" },
          weightGrams: 400,
        },
        {
          id: largeId,
          sku: `TEST-OIL-L-${crypto.randomUUID().slice(0, 8)}`,
          title: "Large",
          active: true,
          price: 4190,
          mrp: 4690,
          stock: 11,
          reserved: 0,
          attributes: { Size: "L" },
          weightGrams: 430,
        },
      ],
    };
    const inactive = await request("/api/v1/admin/products", {
      method: "POST",
      headers: { authorization: `Bearer ${adminToken}` },
      body: JSON.stringify({
        ...payload,
        slug: `${payload.slug}-inactive-rejected`,
        variants: payload.variants.map((variant) => ({
          ...variant,
          active: false,
        })),
      }),
    });
    expect(inactive.status).toBe(409);
    expect(inactive.body.error.code).toBe("ACTIVE_VARIANT_REQUIRED");
    const created = await request("/api/v1/admin/products", {
      method: "POST",
      headers: { authorization: `Bearer ${adminToken}` },
      body: JSON.stringify(payload),
    });
    expect(created.status).toBe(201);
    expect(created.body.data.options).toEqual([
      { name: "Size", values: ["S", "L"] },
    ]);
    const productId = created.body.data.id as string;
    const duplicateSlug = await request("/api/v1/admin/products", {
      method: "POST",
      headers: { authorization: `Bearer ${adminToken}` },
      body: JSON.stringify({
        ...payload,
        variants: payload.variants.map((variant) => ({
          ...variant,
          id: crypto.randomUUID(),
          sku: `${variant.sku}-SLUG-CHECK`,
        })),
      }),
    });
    expect(duplicateSlug.status).toBe(409);
    expect(duplicateSlug.body.error.code).toBe("SLUG_EXISTS");
    const duplicateSku = await request("/api/v1/admin/products", {
      method: "POST",
      headers: { authorization: `Bearer ${adminToken}` },
      body: JSON.stringify({
        ...payload,
        slug: `${payload.slug}-sku-check`,
        variants: [{ ...payload.variants[0], id: crypto.randomUUID() }],
      }),
    });
    expect(duplicateSku.status).toBe(409);
    expect(duplicateSku.body.error.code).toBe("SKU_EXISTS");
    const listed = await request(
      `/api/v1/admin/products?search=Admin%20Matrix&status=ACTIVE&page=1&limit=1`,
      { headers: { authorization: `Bearer ${adminToken}` } },
    );
    expect(listed.status).toBe(200);
    expect(listed.body.data.items).toHaveLength(1);
    expect(listed.body.data.pagination.total).toBe(1);
    expect(listed.body.data.items[0]).toMatchObject({
      id: productId,
      variantCount: 2,
      activeVariantCount: 2,
      totalOnHand: 19,
    });

    const originalMedia = created.body.data.media as Array<{
      id: string;
      url: string;
      alt: string;
      type: "IMAGE";
      position: number;
    }>;
    const large = payload.variants[1]!;
    const updated = await request(`/api/v1/admin/products/${productId}`, {
      method: "PUT",
      headers: { authorization: `Bearer ${adminToken}` },
      body: JSON.stringify({
        ...payload,
        media: originalMedia.map((item, index) =>
          index === 0 ? { ...item, variantId: smallId } : item,
        ),
        variants: [{ ...large, stock: 999 }],
      }),
    });
    expect(updated.status).toBe(200);
    expect(
      updated.body.data.variants.find((variant: any) => variant.id === smallId),
    ).toMatchObject({ active: false });
    expect(
      updated.body.data.variants.find((variant: any) => variant.id === largeId),
    ).toMatchObject({ active: true, inventory: { onHand: 11 } });

    const publicProduct = await request(`/api/v1/products/${productId}`);
    expect(publicProduct.status).toBe(200);
    expect(publicProduct.body.data.variants).toHaveLength(1);
    expect(publicProduct.body.data.variants[0].id).toBe(largeId);
    expect(publicProduct.body.data.media).toHaveLength(1);
    expect(publicProduct.body.data.media[0].id).toBe(originalMedia[1]!.id);

    const reordered = await request(
      `/api/v1/admin/products/${productId}/media/order`,
      {
        method: "PUT",
        headers: { authorization: `Bearer ${adminToken}` },
        body: JSON.stringify({
          mediaIds: [originalMedia[1]!.id, originalMedia[0]!.id],
        }),
      },
    );
    expect(reordered.status).toBe(200);
    expect(reordered.body.data.map((item: any) => item.id)).toEqual([
      originalMedia[1]!.id,
      originalMedia[0]!.id,
    ]);
    const metadata = await request(
      `/api/v1/admin/products/${productId}/media/${originalMedia[1]!.id}`,
      {
        method: "PATCH",
        headers: { authorization: `Bearer ${adminToken}` },
        body: JSON.stringify({ alt: "Updated back view", variantId: largeId }),
      },
    );
    expect(metadata.status).toBe(200);
    expect(metadata.body.data).toMatchObject({
      alt: "Updated back view",
      variantId: largeId,
    });
    const removed = await request(
      `/api/v1/admin/products/${productId}/media/${originalMedia[0]!.id}`,
      {
        method: "DELETE",
        headers: { authorization: `Bearer ${adminToken}` },
      },
    );
    expect(removed.status).toBe(200);
    const detail = await request(`/api/v1/admin/products/${productId}`, {
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(detail.body.data.media).toHaveLength(1);
    expect(detail.body.data.media[0]).toMatchObject({
      id: originalMedia[1]!.id,
      position: 0,
    });
  });
  it("records idempotent inventory adjustments and paginated movement history", async () => {
    const product = store
      .listProducts()
      .find((candidate) => candidate.name === "Admin Matrix Oil")!;
    const variant = product.variants.find((candidate) => candidate.active)!;
    const before = variant.stock;
    const inventory = await request(
      `/api/v1/admin/inventory?search=${encodeURIComponent(variant.sku)}&page=1&limit=10`,
      { headers: { authorization: `Bearer ${adminToken}` } },
    );
    expect(inventory.status).toBe(200);
    expect(inventory.body.data.items[0]).toMatchObject({
      variantId: variant.id,
      onHand: before,
    });
    const missingKey = await request(
      `/api/v1/admin/inventory/${variant.id}`,
      {
        method: "PATCH",
        headers: { authorization: `Bearer ${adminToken}` },
        body: JSON.stringify({ quantity: 3, reason: "Cycle count" }),
      },
    );
    expect(missingKey.status).toBe(400);
    const key = `inventory-${crypto.randomUUID()}`;
    const adjust = () =>
      request(`/api/v1/admin/inventory/${variant.id}`, {
        method: "PATCH",
        headers: {
          authorization: `Bearer ${adminToken}`,
          "idempotency-key": key,
        },
        body: JSON.stringify({ quantity: 3, reason: "Cycle count" }),
      });
    const first = await adjust();
    expect(first.status).toBe(200);
    expect(first.body.data).toMatchObject({
      inventory: { onHand: before + 3 },
      movement: { quantity: 3, reason: "Cycle count" },
      replayed: false,
    });
    const replay = await adjust();
    expect(replay.status).toBe(200);
    expect(replay.body.data).toMatchObject({
      inventory: { onHand: before + 3 },
      replayed: true,
    });
    const conflict = await request(`/api/v1/admin/inventory/${variant.id}`, {
      method: "PATCH",
      headers: {
        authorization: `Bearer ${adminToken}`,
        "idempotency-key": key,
      },
      body: JSON.stringify({ quantity: 4, reason: "Cycle count" }),
    });
    expect(conflict.status).toBe(409);
    expect(conflict.body.error.code).toBe("IDEMPOTENCY_CONFLICT");
    const movements = await request(
      `/api/v1/admin/inventory/${variant.id}/movements?page=1&limit=10`,
      { headers: { authorization: `Bearer ${adminToken}` } },
    );
    expect(movements.status).toBe(200);
    expect(movements.body.data.pagination.total).toBe(1);
    expect(movements.body.data.items[0]).toMatchObject({
      quantity: 3,
      reason: "Cycle count",
    });
  });
  it("rolls catalog memory back when database product writes fail", async () => {
    const rollbackStore = new CommerceStore();
    const failure = new AppError(
      503,
      "PERSISTENCE_UNAVAILABLE",
      "Database write failed",
    );
    const fakePersistence = {
      findAuthUser: async ({ id }: { id: string }) => rollbackStore.users.get(id),
      connect: async () => undefined,
      hydrate: async (target: CommerceStore) => seedStore(target),
      saveProduct: async () => {
        throw failure;
      },
      archiveProduct: async () => {
        throw failure;
      },
    };
    const isolated = await createApp({
      config,
      store: rollbackStore,
      persistence: fakePersistence as any,
    });
    const isolatedServer = isolated.app.listen(0);
    await new Promise<void>((resolve) =>
      isolatedServer.once("listening", resolve),
    );
    try {
      const address = isolatedServer.address();
      if (!address || typeof address === "string")
        throw new Error("No rollback test port");
      const isolatedBase = `http://127.0.0.1:${address.port}`;
      const admin = rollbackStore.createUser({ email: "varahi.admin.fixture@gmail.com", name: "Test Admin", role: "ADMIN", permissions: ["*"] });
      const token = signAccessToken(
        { sub: admin.id, role: admin.role, permissions: admin.permissions },
        config.JWT_SECRET,
      );
      const isolatedRequest = async (path: string, init: RequestInit) => {
        const response = await fetch(`${isolatedBase}${path}`, {
          ...init,
          headers: { "content-type": "application/json", ...init.headers },
        });
        return { status: response.status, body: (await response.json()) as any };
      };
      const product = rollbackStore.listProducts()[0]!;
      const payload = {
        name: product.name,
        slug: product.slug,
        description: product.description,
        category: product.category,
        brand: product.brand,
        status: product.status,
        taxRate: product.taxRate,
        hsnCode: product.hsnCode,
        specifications: product.specifications,
        seoTitle: product.seoTitle,
        seoDescription: product.seoDescription,
        media: product.media,
        variants: product.variants.map((variant) => ({
          id: variant.id,
          sku: variant.sku,
          title: variant.title,
          active: variant.active,
          price: variant.price,
          mrp: variant.mrp,
          stock: variant.stock,
          reserved: variant.reserved,
          attributes: variant.attributes,
          weightGrams: variant.weightGrams,
        })),
      };
      const createName = "Rollback-only product";
      const create = await isolatedRequest("/api/v1/admin/products", {
        method: "POST",
        headers: { authorization: `Bearer ${token}` },
        body: JSON.stringify({
          ...payload,
          name: createName,
          slug: `rollback-${crypto.randomUUID()}`,
          media: payload.media.map(item => ({ ...item, id: crypto.randomUUID() })),
          variants: payload.variants.map((variant) => ({
            ...variant,
            id: crypto.randomUUID(),
            sku: `${variant.sku}-${crypto.randomUUID().slice(0, 8)}`,
          })),
        }),
      });
      expect(create.status).toBe(503);
      expect(
        rollbackStore.listProducts().some((candidate) => candidate.name === createName),
      ).toBe(false);

      const originalName = product.name;
      const update = await isolatedRequest(
        `/api/v1/admin/products/${product.id}`,
        {
          method: "PUT",
          headers: { authorization: `Bearer ${token}` },
          body: JSON.stringify({ ...payload, name: "Should be rolled back" }),
        },
      );
      expect(update.status).toBe(503);
      expect(rollbackStore.getProduct(product.id).name).toBe(originalName);

      const archive = await isolatedRequest(
        `/api/v1/admin/products/${product.id}`,
        {
          method: "DELETE",
          headers: { authorization: `Bearer ${token}` },
        },
      );
      expect(archive.status).toBe(503);
      expect(rollbackStore.getProduct(product.id).status).toBe("ACTIVE");
    } finally {
      await new Promise<void>((resolve, reject) =>
        isolatedServer.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });
  it("persists guest carts and authenticated wishlists", async () => {
    const product = store.listProducts()[0]!,
      variant = product.variants[0]!;
    const cart = await request("/api/v1/cart/items", {
      method: "PUT",
      body: JSON.stringify({ variantId: variant.id, quantity: 2 }),
    });
    expect(cart.status).toBe(200);
    const cartToken = cart.headers.get("x-cart-token")!;
    const listed = await request("/api/v1/cart", {
      headers: { "x-cart-token": cartToken },
    });
    expect(listed.body.data[0]).toMatchObject({
      variantId: variant.id,
      quantity: 2,
    });
    const saved = await request(`/api/v1/wishlist/${product.id}`, {
      method: "PUT",
      headers: { authorization: `Bearer ${customerToken}` },
    });
    expect(saved.status).toBe(200);
    const wishlist = await request("/api/v1/wishlist", {
      headers: { authorization: `Bearer ${customerToken}` },
    });
    expect(wishlist.body.data[0].id).toBe(product.id);
  });
  it("supports customer addresses and support tickets", async () => {
    const address = await request("/api/v1/account/addresses", {
      method: "POST",
      headers: { authorization: `Bearer ${customerToken}` },
      body: JSON.stringify({
        label: "Home",
        line1: "1 Test Road",
        city: "Hyderabad",
        state: "Telangana",
        postalCode: "500081",
        country: "IN",
        isDefault: true,
      }),
    });
    expect(address.status).toBe(201);
    const addresses = await request("/api/v1/account/addresses", {
      headers: { authorization: `Bearer ${customerToken}` },
    });
    expect(addresses.body.data).toHaveLength(1);
    const ticket = await request("/api/v1/account/support", {
      method: "POST",
      headers: { authorization: `Bearer ${customerToken}` },
      body: JSON.stringify({
        subject: "Delivery question",
        message: "Please confirm the expected delivery window.",
        priority: "NORMAL",
      }),
    });
    expect(ticket.status).toBe(201);
    const simultaneousTickets = await Promise.all(
      ["First simultaneous request", "Second simultaneous request"].map(
        (subject) =>
          request("/api/v1/account/support", {
            method: "POST",
            headers: { authorization: `Bearer ${customerToken}` },
            body: JSON.stringify({
              subject,
              message: "Created concurrently to verify unique ticket numbers.",
              priority: "NORMAL",
            }),
          }),
      ),
    );
    expect(simultaneousTickets.map((item) => item.status)).toEqual([201, 201]);
    expect(
      new Set(simultaneousTickets.map((item) => item.body.data.number)).size,
    ).toBe(2);
    const tickets = await request("/api/v1/account/support", {
      headers: { authorization: `Bearer ${customerToken}` },
    });
    expect(tickets.body.data[0].number).toMatch(/^SUP-/);
  });
  it("validates coupons and applies discounts authoritatively", async () => {
    const variant = store.listProducts()
        .filter((product) => product.status === "ACTIVE")
        .flatMap((product) => product.variants)
        .filter((item) => item.active && item.stock - item.reserved > 0)
        .sort((a, b) => b.price - a.price)
        .find((item) => Math.ceil(1000 / item.price) <= item.stock - item.reserved)!,
      quantity = Math.ceil(1000 / variant.price),
      key = `checkout-${crypto.randomUUID()}`;
    const validation = await request("/api/v1/coupons/validate", {
      method: "POST",
      body: JSON.stringify({ code: "WELCOME10", lines: [{ variantId: variant.id, quantity }] }),
    });
    expect(validation.body.data.discount).toBe(Math.round(variant.price * quantity * 0.1 * 100) / 100);

    const checkout = await request("/api/v1/checkout", {
      method: "POST",
      headers: {
        authorization: `Bearer ${customerToken}`,
        "idempotency-key": key,
      },
      body: JSON.stringify({
        lines: [{ variantId: variant.id, quantity }],
        postalCode: "500081",
        contact: {
          name: "Test Customer",
          email: "customer@example.com",
          phone: "+919876543210",
        },
        shippingAddress: {
          line1: "1 Test Road",
          city: "Hyderabad",
          state: "Telangana",
          country: "IN",
        },
        paymentProvider: "cod",
        couponCode: "WELCOME10",
      }),
    });
    expect(checkout.status).toBe(201);
    expect(checkout.body.data.order.discount).toBeGreaterThan(0);
  });
  it("quotes selectable delivery services and applies shipping rules", async () => {
    const variants = store
      .listProducts()
      .filter((product) => product.status === "ACTIVE")
      .flatMap((product) => product.variants);
    const lowValueVariant = variants.find((variant) => variant.price < 999)!;
    const quoteBody = {
      lines: [{ variantId: lowValueVariant.id, quantity: 1 }],
      postalCode: "500081",
      paymentProvider: "razorpay",
    };
    const standard = await request("/api/v1/checkout/quote", {
      method: "POST",
      body: JSON.stringify({ ...quoteBody, shippingService: "STANDARD" }),
    });
    expect(standard.status).toBe(200);
    expect(standard.body.data).toMatchObject({
      freeShipping: false,
      subtotal: lowValueVariant.price,
      selectedShipping: {
        service: "STANDARD",
        label: "Standard delivery",
      },
    });
    expect(standard.body.data.rates.map((rate: any) => rate.service)).toEqual([
      "STANDARD",
      "EXPRESS",
    ]);
    expect(standard.body.data.total).toBeCloseTo(
      standard.body.data.subtotal +
        standard.body.data.tax +
        standard.body.data.shipping,
      2,
    );

    const express = await request("/api/v1/checkout/quote", {
      method: "POST",
      body: JSON.stringify({ ...quoteBody, shippingService: "EXPRESS" }),
    });
    expect(express.status).toBe(200);
    expect(express.body.data.selectedShipping.service).toBe("EXPRESS");
    expect(express.body.data.shipping).toBeGreaterThan(
      standard.body.data.shipping,
    );

    const cod = await request("/api/v1/checkout/quote", {
      method: "POST",
      body: JSON.stringify({
        ...quoteBody,
        paymentProvider: "cod",
        shippingService: "STANDARD",
      }),
    });
    expect(cod.status).toBe(200);
    expect(cod.body.data.selectedShipping.quotedAmount).toBeGreaterThan(
      standard.body.data.selectedShipping.quotedAmount,
    );

    const highValueVariant = variants.find(
      (variant) => variant.price >= 999,
    )!;
    const threshold = await request("/api/v1/checkout/quote", {
      method: "POST",
      body: JSON.stringify({
        lines: [{ variantId: highValueVariant.id, quantity: 1 }],
        postalCode: "500081",
        paymentProvider: "razorpay",
        shippingService: "EXPRESS",
      }),
    });
    expect(threshold.status).toBe(200);
    expect(threshold.body.data.freeShipping).toBe(true);
    expect(threshold.body.data.shipping).toBe(0);
    expect(
      threshold.body.data.rates.every((rate: any) => rate.shipping === 0),
    ).toBe(true);

    const unavailable = await request("/api/v1/checkout/quote", {
      method: "POST",
      body: JSON.stringify({
        ...quoteBody,
        shippingService: "SAME_DAY_UNAVAILABLE",
      }),
    });
    expect(unavailable.status).toBe(422);
    expect(unavailable.body.error.code).toBe(
      "SHIPPING_SERVICE_UNAVAILABLE",
    );
  });
  it("calculates checkout server-side and is idempotent", async () => {
    const product = store.listProducts().find((x) => x.status === "ACTIVE")!,
      variant = product.variants[0]!,
      payload = {
        lines: [{ variantId: variant.id, quantity: 2 }],
        postalCode: "500081",
        contact: {
          name: "Test Customer",
          email: "customer@example.com",
          phone: "+919876543210",
        },
        shippingAddress: {
          line1: "1 Test Road",
          city: "Hyderabad",
          state: "Telangana",
          country: "IN",
        },
        paymentProvider: "razorpay",
        shippingService: "EXPRESS",
      },
      key = `checkout-${crypto.randomUUID()}`;
    const quote = await request("/api/v1/checkout/quote", {
      method: "POST",
      body: JSON.stringify({
        lines: payload.lines,
        postalCode: payload.postalCode,
        paymentProvider: payload.paymentProvider,
        shippingService: payload.shippingService,
      }),
    });
    expect(quote.status).toBe(200);
    const one = await request("/api/v1/checkout", {
      method: "POST",
      headers: {
        "idempotency-key": key,
        authorization: `Bearer ${customerToken}`,
      },
      body: JSON.stringify(payload),
    });
    expect(one.status).toBe(201);
    expect(one.body.data.order.subtotal).toBe(variant.price * 2);
    expect(one.body.data.order.total).toBe(quote.body.data.total);
    expect(one.body.data.order.shippingSelection).toMatchObject({
      provider: quote.body.data.provider,
      service: "EXPRESS",
      label: quote.body.data.selectedShipping.label,
      quotedAmount: quote.body.data.selectedShipping.quotedAmount,
      chargedAmount: quote.body.data.selectedShipping.chargedAmount,
    });
    expect(one.body.data.shipping).toEqual(
      quote.body.data.selectedShipping,
    );
    expect(one.body.data.price.total).toBe(quote.body.data.total);
    const two = await request("/api/v1/checkout", {
      method: "POST",
      headers: {
        "idempotency-key": key,
        authorization: `Bearer ${customerToken}`,
      },
      body: JSON.stringify(payload),
    });
    expect(two.status).toBe(200);
    expect(two.body.data.order.id).toBe(one.body.data.order.id);
    const conflict = await request("/api/v1/checkout", {
      method: "POST",
      headers: {
        "idempotency-key": key,
        authorization: `Bearer ${customerToken}`,
      },
      body: JSON.stringify({
        ...payload,
        lines: [{ variantId: variant.id, quantity: 1 }],
      }),
    });
    expect(conflict.status).toBe(409);
    expect(conflict.body.error.code).toBe("IDEMPOTENCY_CONFLICT");
    const forgedClientEvent = await request("/api/v1/payments/client-events", {
      method: "POST",
      body: JSON.stringify({
        orderNumber: one.body.data.order.number,
        providerOrderId: one.body.data.payment.externalId,
        attemptToken: `${"x".repeat(100)}`,
        type: "FAILED",
      }),
    });
    expect(forgedClientEvent.status).toBe(401);
    expect(forgedClientEvent.body.error.code).toBe("INVALID_PAYMENT_ATTEMPT");
    const cancelled = await request("/api/v1/payments/client-events", {
      method: "POST",
      body: JSON.stringify({
        orderNumber: one.body.data.order.number,
        providerOrderId: one.body.data.payment.externalId,
        attemptToken: one.body.data.paymentAttemptToken,
        type: "CANCELLED",
        gatewayPaymentId: "pay_cancelled_customer_1",
        errorCode: "CUSTOMER_CANCELLED",
        errorDescription: "Customer closed the payment window",
      }),
    });
    expect(cancelled.status).toBe(200);
    expect(cancelled.body.data.status).toBe("CANCELLED");
    const customerPayments = await request("/api/v1/account/payments", {
      headers: { authorization: `Bearer ${customerToken}` },
    });
    expect(customerPayments.status).toBe(200);
    const ownedPayment = customerPayments.body.data.find(
      (payment: any) => payment.orderNumber === one.body.data.order.number,
    );
    expect(ownedPayment).toMatchObject({
      provider: "razorpay",
      status: "CANCELLED",
      amount: one.body.data.order.total,
      providerReference: one.body.data.payment.externalId,
      transactionId: "pay_cancelled_customer_1",
    });
    expect(ownedPayment.events[0]).toMatchObject({
      errorCode: "CUSTOMER_CANCELLED",
    });
    expect(ownedPayment).not.toHaveProperty("idempotencyKey");
    expect(JSON.stringify(ownedPayment)).not.toContain("clientToken");
    const isolatedPayments = await request("/api/v1/account/payments", {
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(isolatedPayments.body.data).toEqual([]);
    expect((await request("/api/v1/account/payments")).status).toBe(401);
    const retried = await request("/api/v1/payments/retry", {
      method: "POST",
      body: JSON.stringify({
        orderNumber: one.body.data.order.number,
        provider: "razorpay",
        attemptToken: one.body.data.paymentAttemptToken,
      }),
    });
    expect(retried.status).toBe(201);
    expect(retried.body.data.payment.status).toBe("CREATED");
  });
  it("rejects overselling", async () => {
    const variant = store.listProducts().find((x) => x.status === "ACTIVE")!
      .variants[0]!,
      originalStock = variant.stock;
    variant.stock = variant.reserved;
    try {
      const r = await request("/api/v1/checkout", {
        method: "POST",
        headers: { "idempotency-key": `checkout-${crypto.randomUUID()}` },
        body: JSON.stringify({
          lines: [{ variantId: variant.id, quantity: 1 }],
          postalCode: "500081",
          contact: {
            name: "Test Customer",
            email: "customer@example.com",
            phone: "+919876543210",
          },
          shippingAddress: {
            line1: "1 Test Road",
            city: "Hyderabad",
            state: "Telangana",
            country: "IN",
          },
          paymentProvider: "cod",
        }),
      });
      expect(r.status).toBe(409);
      expect(r.body.error.code).toBe("INSUFFICIENT_STOCK");
    } finally {
      variant.stock = originalStock;
    }
  });
  it("does not reserve any stock when a multi-line cart fails", async () => {
    const products = store.listProducts().filter((x) => x.status === "ACTIVE");
    const available = products[1]!.variants[0]!;
    const unavailable = products[2]!.variants[0]!;
    const before = available.reserved,
      originalStock = unavailable.stock;
    unavailable.stock = unavailable.reserved;
    try {
      const r = await request("/api/v1/checkout", {
        method: "POST",
        headers: { "idempotency-key": `checkout-${crypto.randomUUID()}` },
        body: JSON.stringify({
          lines: [
            { variantId: available.id, quantity: 1 },
            { variantId: unavailable.id, quantity: 1 },
          ],
          postalCode: "500081",
          contact: {
            name: "Test Customer",
            email: "customer@example.com",
            phone: "+919876543210",
          },
          shippingAddress: {
            line1: "1 Test Road",
            city: "Hyderabad",
            state: "Telangana",
            country: "IN",
          },
          paymentProvider: "cod",
        }),
      });
      expect(r.status).toBe(409);
      expect(available.reserved).toBe(before);
    } finally {
      unavailable.stock = originalStock;
    }
  });
  it("enforces the order state machine and creates shipments only when packed", async () => {
    const order = [...store.orders.values()].find(
      (candidate) => candidate.status === "PAYMENT_PENDING",
    )!;
    const invalid = await request(`/api/v1/admin/orders/${order.id}/status`, {
      method: "PATCH",
      headers: { authorization: `Bearer ${adminToken}` },
      body: JSON.stringify({ status: "DELIVERED" }),
    });
    expect(invalid.status).toBe(409);
    const forgedPaid = await request(
      `/api/v1/admin/orders/${order.id}/status`,
      {
        method: "PATCH",
        headers: { authorization: `Bearer ${adminToken}` },
        body: JSON.stringify({ status: "PAID" }),
      },
    );
    expect(forgedPaid.status).toBe(409);
    expect(forgedPaid.body.error.code).toBe(
      "PAYMENT_STATE_MANAGED_EXTERNALLY",
    );
    expect(store.orders.get(order.id)!.status).toBe("PAYMENT_PENDING");
    process.env.RAZORPAY_WEBHOOK_SECRET = "test-webhook-secret";
    const webhookPayload = {
      type: "payment.captured",
      orderId: order.id,
      payload: {
        payment: {
          entity: {
            id: "pay_captured_1",
            order_id: order.payment!.externalId,
            amount: Math.round(order.total * 100),
            currency: "INR",
          },
        },
      },
    };
    const mismatchedBody = JSON.stringify({
      ...webhookPayload,
      payload: {
        payment: {
          entity: {
            ...webhookPayload.payload.payment.entity,
            amount: Math.round(order.total * 100) - 1,
          },
        },
      },
    });
    const mismatchedSignature = crypto
      .createHmac("sha256", "test-webhook-secret")
      .update(mismatchedBody)
      .digest("hex");
    const mismatched = await request("/webhooks/razorpay", {
      method: "POST",
      headers: {
        "x-event-id": "evt_payment_wrong_amount",
        "x-webhook-signature": mismatchedSignature,
      },
      body: mismatchedBody,
    });
    expect(mismatched.status).toBe(422);
    expect(mismatched.body.error.code).toBe("PAYMENT_VALUE_MISMATCH");
    const webhookBody = JSON.stringify(webhookPayload);
    const signature = crypto
      .createHmac("sha256", "test-webhook-secret")
      .update(webhookBody)
      .digest("hex");
    const paid = await request("/webhooks/razorpay", {
      method: "POST",
      headers: {
        "x-event-id": "evt_payment_captured_1",
        "x-webhook-signature": signature,
      },
      body: webhookBody,
    });
    expect(paid.status).toBe(202);
    const duplicate = await request("/webhooks/razorpay", {
      method: "POST",
      headers: {
        // Unsigned headers cannot be used to bypass replay protection.
        "x-event-id": "attacker_changed_event_id",
        "x-webhook-signature": signature,
      },
      body: webhookBody,
    });
    expect(duplicate.body.data.duplicate).toBe(true);
    for (const status of ["CONFIRMED", "PROCESSING", "PACKED"]) {
      const changed = await request(`/api/v1/admin/orders/${order.id}/status`, {
        method: "PATCH",
        headers: { authorization: `Bearer ${adminToken}` },
        body: JSON.stringify({ status }),
      });
      expect(changed.status).toBe(200);
    }
    const shipment = await request(
      `/api/v1/admin/orders/${order.id}/shipment`,
      {
        method: "POST",
        headers: { authorization: `Bearer ${adminToken}` },
        body: JSON.stringify({ service: "STANDARD" }),
      },
    );
    expect(shipment.status).toBe(201);
    expect(shipment.body.data.shipment).toMatchObject({
      provider: "development",
      status: "SHIPPED",
    });
    expect(shipment.body.data.shipment.awb).toMatch(/^TEST/);
    expect(shipment.body.data.order.shipping.shipment.awb).toBe(
      shipment.body.data.shipment.awb,
    );
    expect(store.orders.get(order.id)!.status).toBe("SHIPPED");
    expect(store.orders.get(order.id)!.shipment?.awb).toBe(
      shipment.body.data.shipment.awb,
    );
    expect(store.auditLogs.length).toBeGreaterThanOrEqual(5);
  });
  it("serves private admin order DTOs and processes cumulative idempotent refunds", async () => {
    const order = [...store.orders.values()].find(
      (candidate) =>
        candidate.status === "SHIPPED" &&
        candidate.payment?.status === "CAPTURED",
    )!;
    expect(order).toBeDefined();

    const unauthenticated = await request("/api/v1/admin/orders");
    expect(unauthenticated.status).toBe(401);
    const customerDenied = await request("/api/v1/admin/orders", {
      headers: { authorization: `Bearer ${customerToken}` },
    });
    expect(customerDenied.status).toBe(403);
    const listed = await request("/api/v1/admin/orders", {
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(listed.status).toBe(200);
    expect(listed.body.data.pagination).toMatchObject({
      page: 1,
      pageSize: 20,
    });
    expect(listed.body.data.pagination.total).toBeGreaterThan(0);
    expect(listed.body.data.summary).toMatchObject({
      totalOrders: expect.any(Number),
      activeCount: expect.any(Number),
      readyToShip: expect.any(Number),
      orderValue: expect.any(Number),
      currency: "INR",
    });
    const dto = listed.body.data.items.find((item: any) => item.id === order.id);
    expect(dto).toMatchObject({
      number: order.number,
      customer: {
        name: "Test Customer",
        email: "customer@example.com",
        phone: "+919876543210",
      },
      address: {
        line1: "1 Test Road",
        city: "Hyderabad",
        postalCode: "500081",
      },
      totals: { total: order.total, currency: "INR" },
      payment: { status: "CAPTURED", refundedAmount: 0 },
      shipping: { shipment: { status: "SHIPPED" } },
    });
    expect(dto.lineItems[0]).toMatchObject({
      variantId: order.lines[0]!.variantId,
      sku: order.lines[0]!.sku,
    });
    expect(dto.history.length).toBeGreaterThanOrEqual(5);
    expect(dto).not.toHaveProperty("idempotencyKey");
    expect(dto).not.toHaveProperty("trackingVerificationHash");
    expect(dto.payment).not.toHaveProperty("externalId");
    expect(JSON.stringify(dto)).not.toContain(order.idempotencyKey);
    expect(JSON.stringify(dto)).not.toContain("clientToken");

    const pagedSearch = await request(
      `/api/v1/admin/orders?page=1&pageSize=1&status=SHIPPED&search=${encodeURIComponent(order.number)}`,
      { headers: { authorization: `Bearer ${adminToken}` } },
    );
    expect(pagedSearch.status).toBe(200);
    expect(pagedSearch.body.data.items).toHaveLength(1);
    expect(pagedSearch.body.data.items[0].id).toBe(order.id);
    expect(pagedSearch.body.data.pagination).toMatchObject({
      page: 1,
      pageSize: 1,
      total: 1,
      totalPages: 1,
    });
    const invalidPagination = await request(
      "/api/v1/admin/orders?pageSize=101",
      { headers: { authorization: `Bearer ${adminToken}` } },
    );
    expect(invalidPagination.status).toBe(400);
    expect(invalidPagination.body.error.code).toBe("INVALID_PAGINATION");
    const invalidDeepPage = await request(
      "/api/v1/admin/orders?page=1001",
      { headers: { authorization: `Bearer ${adminToken}` } },
    );
    expect(invalidDeepPage.status).toBe(400);
    expect(invalidDeepPage.body.error.code).toBe("INVALID_PAGINATION");

    const codOrder = [...store.orders.values()].find(
      (candidate) => candidate.payment === null,
    )!;
    const codRefund = await request(
      `/api/v1/admin/orders/${codOrder.id}/refunds`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${adminToken}`,
          "idempotency-key": `refund-${crypto.randomUUID()}`,
        },
        body: JSON.stringify({
          amount: 1,
          reason: "COD has no captured gateway payment",
        }),
      },
    );
    expect(codRefund.status).toBe(409);
    expect(codRefund.body.error.code).toBe("PAYMENT_NOT_REFUNDABLE");

    const pendingVariant = store
      .listProducts()
      .find((product) => product.status === "ACTIVE")!.variants[0]!;
    const pendingCheckout = await request("/api/v1/checkout", {
      method: "POST",
      headers: { "idempotency-key": `checkout-${crypto.randomUUID()}` },
      body: JSON.stringify({
        lines: [{ variantId: pendingVariant.id, quantity: 1 }],
        postalCode: "500081",
        contact: {
          name: "Pending Customer",
          email: "pending@example.com",
          phone: "+919800000001",
        },
        shippingAddress: {
          line1: "2 Test Road",
          city: "Hyderabad",
          state: "Telangana",
          country: "IN",
        },
        paymentProvider: "razorpay",
      }),
    });
    expect(pendingCheckout.status).toBe(201);
    const uncapturedRefund = await request(
      `/api/v1/admin/orders/${pendingCheckout.body.data.order.id}/refunds`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${adminToken}`,
          "idempotency-key": `refund-${crypto.randomUUID()}`,
        },
        body: JSON.stringify({
          amount: 1,
          reason: "Gateway payment has not been captured",
        }),
      },
    );
    expect(uncapturedRefund.status).toBe(409);
    expect(uncapturedRefund.body.error.code).toBe("PAYMENT_NOT_REFUNDABLE");

    const partialAmount = 100;
    const refundKey = `refund-${crypto.randomUUID()}`;
    const partial = await request(
      `/api/v1/admin/orders/${order.id}/refunds`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${adminToken}`,
          "idempotency-key": refundKey,
        },
        body: JSON.stringify({
          amount: partialAmount,
          reason: "Customer accepted a partial refund",
        }),
      },
    );
    expect(partial.status).toBe(201);
    expect(partial.body.data).toMatchObject({
      refund: {
        amount: partialAmount,
        status: "SUCCEEDED",
        reason: "Customer accepted a partial refund",
      },
      payment: {
        status: "PARTIALLY_REFUNDED",
        refundedAmount: partialAmount,
        refundableAmount: order.total - partialAmount,
      },
    });
    expect(partial.body.data.refund.reference).toMatch(/^test_ref_/);

    const duplicate = await request(
      `/api/v1/admin/orders/${order.id}/refunds`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${adminToken}`,
          "idempotency-key": refundKey,
        },
        body: JSON.stringify({
          amount: partialAmount,
          reason: "Customer accepted a partial refund",
        }),
      },
    );
    expect(duplicate.status).toBe(200);
    expect(duplicate.body.data).toEqual(partial.body.data);

    const idempotencyConflict = await request(
      `/api/v1/admin/orders/${order.id}/refunds`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${adminToken}`,
          "idempotency-key": refundKey,
        },
        body: JSON.stringify({
          amount: partialAmount + 1,
          reason: "Customer accepted a partial refund",
        }),
      },
    );
    expect(idempotencyConflict.status).toBe(409);
    expect(idempotencyConflict.body.error.code).toBe("IDEMPOTENCY_CONFLICT");

    const overRefund = await request(
      `/api/v1/admin/orders/${order.id}/refunds`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${adminToken}`,
          "idempotency-key": `refund-${crypto.randomUUID()}`,
        },
        body: JSON.stringify({
          amount: order.total,
          reason: "This exceeds the remaining captured amount",
        }),
      },
    );
    expect(overRefund.status).toBe(422);
    expect(overRefund.body.error.code).toBe("REFUND_AMOUNT_INVALID");

    const remaining = Math.round((order.total - partialAmount) * 100) / 100;
    const finalKey = `refund-${crypto.randomUUID()}`;
    const completed = await request(
      `/api/v1/admin/orders/${order.id}/refunds`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${adminToken}`,
          "idempotency-key": finalKey,
        },
        body: JSON.stringify({
          amount: remaining,
          reason: "Final refund after returned goods inspection",
        }),
      },
    );
    expect(completed.status).toBe(201);
    expect(completed.body.data.payment).toEqual({
      status: "REFUNDED",
      refundedAmount: order.total,
      refundableAmount: 0,
    });

    const completedDuplicate = await request(
      `/api/v1/admin/orders/${order.id}/refunds`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${adminToken}`,
          "idempotency-key": finalKey,
        },
        body: JSON.stringify({
          amount: remaining,
          reason: "Final refund after returned goods inspection",
        }),
      },
    );
    expect(completedDuplicate.status).toBe(200);
    expect(completedDuplicate.body.data).toEqual(completed.body.data);

    const afterRefund = await request("/api/v1/admin/orders", {
      headers: { authorization: `Bearer ${adminToken}` },
    });
    const refundedDto = afterRefund.body.data.items.find(
      (item: any) => item.id === order.id,
    );
    expect(refundedDto.payment.status).toBe("REFUNDED");
    expect(refundedDto.payment.refunds).toHaveLength(2);
    expect(refundedDto.payment.refunds.map((item: any) => item.reason)).toEqual([
      "Customer accepted a partial refund",
      "Final refund after returned goods inspection",
    ]);
    expect(
      store.auditLogs.some(
        (entry) =>
          entry.action === "payment.refunded" &&
          (entry.after as any)?.reason ===
            "Final refund after returned goods inspection",
      ),
    ).toBe(true);
  });
  it("does not expose tracking details without matching checkout contact", async () => {
    const order = [...store.orders.values()][0]!;
    const denied = await request(
      "/api/v1/orders/track", { method: "POST", body: JSON.stringify({ orderNumber: order.number, contact: "attacker@example.com" }) },
    );
    expect(denied.status).toBe(404);
    const allowed = await request(
      "/api/v1/orders/track", { method: "POST", body: JSON.stringify({ orderNumber: order.number, contact: "customer@example.com" }) },
    );
    expect(allowed.status).toBe(200);
    expect(allowed.body.data.number).toBe(order.number);
  });
  it("returns customer-safe order records without internal checkout secrets", async () => {
    const response = await request("/api/v1/account/orders", {
      headers: { authorization: `Bearer ${customerToken}` },
    });
    expect(response.status).toBe(200);
    expect(response.body.data.length).toBeGreaterThan(0);
    expect(response.body.data[0]).toMatchObject({
      id: expect.any(String),
      number: expect.any(String),
      status: expect.any(String),
      lines: expect.any(Array),
      total: expect.any(Number),
      currency: "INR",
    });
    expect(response.body.data[0]).not.toHaveProperty("idempotencyKey");
    expect(response.body.data[0]).not.toHaveProperty("trackingVerificationHash");
    expect(response.body.data[0]).not.toHaveProperty("invoiceSnapshot");
    expect(JSON.stringify(response.body.data)).not.toContain("clientToken");
  });
  it("generates a customer invoice PDF without exposing another account", async () => {
    const order = [...store.orders.values()].find(
      (item) => item.userId === store.findUser("ananya@example.com")?.id,
    )!;
    const denied = await fetch(`${base}/api/v1/orders/${order.id}/invoice`, {
      headers: { authorization: `Bearer ${adminToken.replace(/.$/, "x")}` },
    });
    expect(denied.status).toBe(401);
    const response = await fetch(`${base}/api/v1/orders/${order.id}/invoice`, {
        headers: { authorization: `Bearer ${customerToken}` },
      }),
      bytes = Buffer.from(await response.arrayBuffer());
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("application/pdf");
    expect(response.headers.get("content-disposition")).toContain(order.number);
    expect(bytes.subarray(0, 4).toString()).toBe("%PDF");
    expect(bytes.length).toBeGreaterThan(1500);
  });
  it("manages masked integrations without losing or leaking credentials", async () => {
    const unauthorized = await request("/api/v1/admin/integrations");
    expect(unauthorized.status).toBe(401);

    const initial = await request(
      "/api/v1/admin/integrations?environment=TEST",
      { headers: { authorization: `Bearer ${adminToken}` } },
    );
    expect(initial.status).toBe(200);
    expect(initial.body.data.environment).toBe("TEST");
    const initialRazorpay = initial.body.data.items.find(
      (item: any) => item.provider === "razorpay",
    );
    expect(initialRazorpay.id).toBe("PAYMENT:razorpay:TEST");
    expect(initialRazorpay.configured).toBe(false);
    expect(JSON.stringify(initial.body)).not.toContain(
      "encryptedCredentials",
    );

    const incomplete = await request("/api/v1/admin/integrations", {
      method: "PUT",
      headers: { authorization: `Bearer ${adminToken}` },
      body: JSON.stringify({
        kind: "PAYMENT",
        provider: "Razorpay",
        enabled: true,
        priority: 1,
        environment: "TEST",
        credentials: { keySecret: "super-secret-1234" },
        publicConfig: { currency: "INR" },
      }),
    });
    expect(incomplete.status).toBe(422);
    expect(incomplete.body.error.code).toBe(
      "INTEGRATION_CONFIGURATION_INCOMPLETE",
    );

    const unknownSecret = await request("/api/v1/admin/integrations", {
      method: "PUT",
      headers: { authorization: `Bearer ${adminToken}` },
      body: JSON.stringify({
        kind: "PAYMENT",
        provider: "Razorpay",
        enabled: false,
        priority: 1,
        environment: "TEST",
        credentials: { hiddenBackdoor: "must-not-be-stored" },
      }),
    });
    expect(unknownSecret.status).toBe(400);
    expect(unknownSecret.body.error.code).toBe(
      "INTEGRATION_CREDENTIAL_FIELD_INVALID",
    );

    const saved = await request("/api/v1/admin/integrations", {
      method: "PUT",
      headers: { authorization: `Bearer ${adminToken}` },
      body: JSON.stringify({
        kind: "PAYMENT",
        provider: " RazorPay ",
        enabled: true,
        priority: 1,
        environment: "TEST",
        credentials: {
          keyId: "rzp_test_public",
          keySecret: "super-secret-1234",
          webhookSecret: "webhook-secret-5678",
        },
        publicConfig: { currency: "INR" },
      }),
    });
    expect(saved.status).toBe(200);
    expect(saved.body.data.id).toBe(initialRazorpay.id);
    expect(saved.body.data.provider).toBe("razorpay");
    expect(saved.body.data.configured).toBe(true);
    expect(saved.body.data.connected).toBe(false);
    expect(saved.body.data.maskedCredentials.keySecret).toMatch(/1234$/);
    expect(JSON.stringify(saved.body)).not.toContain("super-secret-1234");
    expect(JSON.stringify(saved.body)).not.toContain("webhook-secret-5678");

    const preserved = await request("/api/v1/admin/integrations", {
      method: "PUT",
      headers: { authorization: `Bearer ${adminToken}` },
      body: JSON.stringify({
        kind: "PAYMENT",
        provider: "razorpay",
        enabled: true,
        priority: 2,
        environment: "TEST",
        credentials: { keyId: "   ", keySecret: "" },
      }),
    });
    expect(preserved.status).toBe(200);
    expect(preserved.body.data.id).toBe(initialRazorpay.id);
    expect(preserved.body.data.configured).toBe(true);

    const listed = await request(
      "/api/v1/admin/integrations?environment=TEST",
      { headers: { authorization: `Bearer ${adminToken}` } },
    );
    const razorpayItems = listed.body.data.items.filter(
      (item: any) => item.provider === "razorpay",
    );
    expect(razorpayItems).toHaveLength(1);
    expect(razorpayItems[0].id).toBe(initialRazorpay.id);

    const tested = await request(
      `/api/v1/admin/integrations/${encodeURIComponent(initialRazorpay.id)}/test`,
      {
        method: "POST",
        headers: { authorization: `Bearer ${adminToken}` },
      },
    );
    expect(tested.status).toBe(200);
    expect(tested.body.data.test.outcome).toBe("CONNECTED");
    expect(tested.body.data.connected).toBe(true);

    const unsupported = await request("/api/v1/admin/integrations", {
      method: "PUT",
      headers: { authorization: `Bearer ${adminToken}` },
      body: JSON.stringify({
        kind: "SHIPPING",
        provider: "Delhivery",
        enabled: true,
        priority: 3,
        environment: "TEST",
        credentials: { token: "delhivery-token" },
        publicConfig: { pickupPostcode: "500001" },
      }),
    });
    expect(unsupported.status).toBe(422);
    expect(unsupported.body.error.code).toBe(
      "INTEGRATION_PROVIDER_UNAVAILABLE",
    );
    const storedUnsupported = await request("/api/v1/admin/integrations", {
      method: "PUT",
      headers: { authorization: `Bearer ${adminToken}` },
      body: JSON.stringify({
        kind: "SHIPPING",
        provider: "Delhivery",
        enabled: false,
        priority: 3,
        environment: "TEST",
        credentials: { token: "delhivery-token" },
        publicConfig: { pickupPostcode: "500001" },
      }),
    });
    expect(storedUnsupported.status).toBe(200);
    const unsupportedTest = await request(
      `/api/v1/admin/integrations/${encodeURIComponent(storedUnsupported.body.data.id)}/test`,
      {
        method: "POST",
        headers: { authorization: `Bearer ${adminToken}` },
      },
    );
    expect(unsupportedTest.status).toBe(200);
    expect(unsupportedTest.body.data.test.outcome).toBe("UNSUPPORTED");

    const resend = await request("/api/v1/admin/integrations", {
      method: "PUT",
      headers: { authorization: `Bearer ${adminToken}` },
      body: JSON.stringify({
        kind: "EMAIL",
        provider: "Resend",
        enabled: false,
        priority: 4,
        environment: "TEST",
        credentials: { apiKey: "re_secret_1234" },
        publicConfig: {
          fromEmail: "orders@example.com",
          fromName: "Example Store",
        },
      }),
    });
    expect(resend.status).toBe(200);
    const resendCleared = await request("/api/v1/admin/integrations", {
      method: "PUT",
      headers: { authorization: `Bearer ${adminToken}` },
      body: JSON.stringify({
        kind: "EMAIL",
        provider: "resend",
        enabled: true,
        priority: 4,
        environment: "TEST",
        credentials: { apiKey: "" },
        publicConfig: { fromName: "" },
      }),
    });
    expect(resendCleared.status).toBe(200);
    expect(resendCleared.body.data.configured).toBe(true);
    expect(resendCleared.body.data.publicConfig.fromEmail).toBe(
      "orders@example.com",
    );
    expect(resendCleared.body.data.publicConfig).not.toHaveProperty(
      "fromName",
    );

    const wrongDisconnect = await request(
      `/api/v1/admin/integrations/${encodeURIComponent(initialRazorpay.id)}/disconnect`,
      {
        method: "POST",
        headers: { authorization: `Bearer ${adminToken}` },
        body: JSON.stringify({ confirmation: "disconnect" }),
      },
    );
    expect(wrongDisconnect.status).toBe(400);
    const disconnected = await request(
      `/api/v1/admin/integrations/${encodeURIComponent(initialRazorpay.id)}/disconnect`,
      {
        method: "POST",
        headers: { authorization: `Bearer ${adminToken}` },
        body: JSON.stringify({ confirmation: "DISCONNECT" }),
      },
    );
    expect(disconnected.status).toBe(200);
    expect(disconnected.body.data.enabled).toBe(false);
    expect(disconnected.body.data.configured).toBe(false);
    expect(disconnected.body.data.maskedCredentials).toEqual({});
    expect(disconnected.body.data.lastTest.outcome).toBe("DISCONNECTED");
    const testedAfterDisconnect = await request(
      `/api/v1/admin/integrations/${encodeURIComponent(initialRazorpay.id)}/test`,
      {
        method: "POST",
        headers: { authorization: `Bearer ${adminToken}` },
      },
    );
    expect(testedAfterDisconnect.status).toBe(200);
    expect(testedAfterDisconnect.body.data.test.outcome).toBe(
      "UNCONFIGURED",
    );
    expect(
      store.auditLogs.some(
        (entry) => entry.action === "integration.disconnected",
      ),
    ).toBe(true);
  });
  it("rejects unsigned webhooks", async () => {
    const r = await request("/webhooks/razorpay", {
      method: "POST",
      headers: { "x-event-id": "evt_1", "x-webhook-signature": "bad" },
      body: JSON.stringify({ type: "payment.captured" }),
    });
    expect(r.status).toBe(401);
  });
  it("calculates customer value and behavioral segments from paid orders only", () => {
    const user = {
      id: "customer-metrics",
      name: "Metrics Customer",
      email: "metrics@example.com",
      role: "CUSTOMER",
      permissions: [],
      createdAt: new Date(Date.now() - 200 * 86_400_000).toISOString(),
    };
    const order = (
      id: string,
      status: string,
      total: number,
      ageDays: number,
      refunded = 0,
    ) => ({
      id,
      number: id,
      userId: user.id,
      status,
      lines: [],
      subtotal: total,
      discount: 0,
      tax: 0,
      shipping: 0,
      total,
      idempotencyKey: id,
      history: [],
      createdAt: new Date(Date.now() - ageDays * 86_400_000).toISOString(),
      payment: refunded
        ? {
            refunds: [
              {
                id: `refund-${id}`,
                amount: refunded,
                status: "SUCCEEDED" as const,
                reason: "Returned",
                idempotencyKey: `refund-${id}`,
                createdAt: new Date().toISOString(),
              },
            ],
          }
        : null,
    });
    const orders = [
      order("paid-one", "DELIVERED", 6000, 150, 2000),
      order("paid-two", "PAID", 500, 120),
      order("pending", "PAYMENT_PENDING", 10000, 1),
      order("failed", "FAILED", 8000, 2),
      order("refunded", "REFUNDED", 9000, 3),
    ];
    const metrics = customerMetrics(user.id, orders);
    expect(metrics.orderCount).toBe(5);
    expect(metrics.totalSpent).toBe(4500);
    expect(metrics.averageOrderValue).toBe(2250);
    const segments = customerSegments(user, orders);
    expect(segments).toContain("REPEAT");
    expect(segments).toContain("AT_RISK");
    expect(segments).not.toContain("HIGH_VALUE");
  });
  it("provides paginated customer operations and complete details beyond 100 records", async () => {
    const customer = store.findUser("ananya@example.com")!;
    const order =
      [...store.orders.values()].find((item) => item.userId === customer.id) ||
      [...store.orders.values()][0]!;
    expect(order).toBeTruthy();
    order.userId = customer.id;
    const createdAt = new Date().toISOString();
    for (let index = 0; index < 105; index++) {
      store.returns.set(`bulk-return-${index}`, {
        id: `bulk-return-${index}`,
        orderId: order.id,
        userId: customer.id,
        reason: `Return reason ${index}`,
        status: "REQUESTED",
        createdAt,
      });
      store.supportTickets.set(`bulk-ticket-${index}`, {
        id: `bulk-ticket-${index}`,
        number: `SUP-BULK-${index}`,
        userId: customer.id,
        subject: `Support request ${index}`,
        priority: "NORMAL",
        status: "OPEN",
        createdAt,
        messages: [
          {
            id: `bulk-message-${index}`,
            authorId: adminToken,
            body: index === 104 ? "Private internal note" : `Message ${index}`,
            internal: index === 104,
            createdAt,
          },
        ],
      });
    }
    const customers = await request(
      "/api/v1/admin/customers?search=ananya&page=1&limit=1",
      { headers: { authorization: `Bearer ${adminToken}` } },
    );
    expect(customers.status).toBe(200);
    expect(customers.body.data.items[0].metrics).toMatchObject({ currency: "INR" });
    expect(customers.body.data.pagination).toMatchObject({ page: 1, limit: 1 });
    expect(customers.body.data.summary.totalCustomers).toBeGreaterThan(0);
    const invalidQuery = await request("/api/v1/admin/customers?limit=0", {
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(invalidQuery.status).toBe(400);
    const updatedCustomer = await request(
      `/api/v1/admin/customers/${customer.id}`,
      {
        method: "PATCH",
        headers: { authorization: `Bearer ${adminToken}` },
        body: JSON.stringify({
          tags: ["VIP", "vip", "Wholesale"],
          note: "Prefers weekend delivery",
          marketingConsent: true,
        }),
      },
    );
    expect(updatedCustomer.status).toBe(200);
    expect(updatedCustomer.body.data.tags).toEqual(["VIP", "Wholesale"]);
    expect(updatedCustomer.body.data).toHaveProperty("orders");
    expect(updatedCustomer.body.data).not.toHaveProperty("reviews");
    expect(updatedCustomer.body.data.counts).not.toHaveProperty("reviews");
    expect(updatedCustomer.body.data.retention).toMatchObject({
      purchaseHistoryOwnerRetainedAfterDeletion: true,
    });
    const segments = await request("/api/v1/admin/customer-segments", {
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(segments.status).toBe(200);
    expect(segments.body.data.items.map((item: any) => item.id)).toEqual([
      "NEW",
      "REPEAT",
      "HIGH_VALUE",
      "AT_RISK",
    ]);

    const returnDetail = await request("/api/v1/admin/returns/bulk-return-104", {
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(returnDetail.status).toBe(200);
    expect(returnDetail.body.data.order.number).toBe(order.number);
    expect(returnDetail.body.data.items).toEqual([]);
    order.status = "RETURN_REQUESTED";
    const decided = await request("/api/v1/admin/returns/bulk-return-104", {
      method: "PATCH",
      headers: { authorization: `Bearer ${adminToken}` },
      body: JSON.stringify({ status: "APPROVED", notes: "Item inspected" }),
    });
    expect(decided.status).toBe(200);
    expect(decided.body.data).toMatchObject({ status: "APPROVED", itemCount: 0 });
    expect(decided.body.data).toHaveProperty("customer");

    const supportDetail = await request("/api/v1/admin/support/bulk-ticket-104", {
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(supportDetail.status).toBe(200);
    expect(supportDetail.body.data.messages[0].internal).toBe(true);
    const internal = await request(
      "/api/v1/admin/support/bulk-ticket-104/internal-notes",
      {
        method: "POST",
        headers: { authorization: `Bearer ${adminToken}` },
        body: JSON.stringify({ message: "Second private note" }),
      },
    );
    expect(internal.status).toBe(201);
    expect(internal.body.data.messages.some((item: any) => item.internal)).toBe(true);
    const customerTickets = await request("/api/v1/account/support", {
      headers: { authorization: `Bearer ${customerToken}` },
    });
    const customerTicket = customerTickets.body.data.find(
      (item: any) => item.id === "bulk-ticket-104",
    );
    expect(customerTicket.messages.every((item: any) => !item.internal)).toBe(true);
    expect(customerTicket).not.toHaveProperty("userId");
    expect(customerTicket.messages).toEqual([]);
    const invalidCustomerReply = await request(
      "/api/v1/account/support/bulk-ticket-104/replies",
      {
        method: "POST",
        headers: { authorization: `Bearer ${customerToken}` },
        body: JSON.stringify({ message: "Trying to close it", status: "CLOSED" }),
      },
    );
    expect(invalidCustomerReply.status).toBe(400);
    const customerReply = await request(
      "/api/v1/account/support/bulk-ticket-104/replies",
      {
        method: "POST",
        headers: { authorization: `Bearer ${customerToken}` },
        body: JSON.stringify({ message: "Customer follow-up" }),
      },
    );
    expect(customerReply.status).toBe(201);
    expect(customerReply.body.data.messages.every((item: any) => !item.internal)).toBe(true);
    expect(customerReply.body.data.messages[0]).not.toHaveProperty("authorId");
    expect(customerReply.body.data.messages[0]).not.toHaveProperty("internal");
    const supportUpdated = await request("/api/v1/admin/support/bulk-ticket-104", {
      method: "PATCH",
      headers: { authorization: `Bearer ${adminToken}` },
      body: JSON.stringify({ status: "RESOLVED", priority: "HIGH" }),
    });
    expect(supportUpdated.status).toBe(200);
    expect(supportUpdated.body.data).toMatchObject({
      status: "RESOLVED",
      priority: "HIGH",
    });
    expect(supportUpdated.body.data.messages.length).toBeGreaterThan(1);
  });
  it("persists selected return items and keeps partial return refunds currency-safe", async () => {
    const customer = store.findUser("ananya@example.com")!;
    const product = store.listProducts()[0]!;
    const variant = product.variants[0]!;
    const order = store.createOrder({
      userId: customer.id,
      status: "DELIVERED",
      lines: [
        {
          variantId: variant.id,
          name: product.name,
          sku: variant.sku,
          quantity: 2,
          unitPrice: 100,
          tax: 0,
        },
      ],
      subtotal: 200,
      tax: 0,
      shipping: 0,
      discount: 0,
      total: 200,
      idempotencyKey: `return-lifecycle.${crypto.randomUUID()}`,
      payment: {
        provider: "development",
        externalId: `pay_${crypto.randomUUID()}`,
        status: "CAPTURED",
        amount: 200,
        currency: "INR",
        refunds: [],
      },
    });
    const duplicateSelection = await request("/api/v1/account/returns", {
      method: "POST",
      headers: { authorization: `Bearer ${customerToken}` },
      body: JSON.stringify({
        orderId: order.id,
        reason: "Both entries duplicate the same purchased variant",
        items: [
          { variantId: variant.id, quantity: 1 },
          { variantId: variant.id, quantity: 1 },
        ],
      }),
    });
    expect(duplicateSelection.status).toBe(400);
    const excessiveSelection = await request("/api/v1/account/returns", {
      method: "POST",
      headers: { authorization: `Bearer ${customerToken}` },
      body: JSON.stringify({
        orderId: order.id,
        reason: "Quantity is greater than the purchased quantity",
        items: [{ variantId: variant.id, quantity: 3 }],
      }),
    });
    expect(excessiveSelection.status).toBe(422);
    const selected = await request("/api/v1/account/returns", {
      method: "POST",
      headers: { authorization: `Bearer ${customerToken}` },
      body: JSON.stringify({
        orderId: order.id,
        reason: "One unit arrived with a visible defect",
        items: [{ variantId: variant.id, quantity: 1 }],
      }),
    });
    expect(selected.status).toBe(201);
    expect(selected.body.data.items).toHaveLength(1);
    expect(selected.body.data.items[0]).toMatchObject({
      variantId: variant.id,
      quantity: 1,
    });
    expect(order.status).toBe("RETURN_REQUESTED");
    const rejected = await request(
      `/api/v1/admin/returns/${selected.body.data.id}`,
      {
        method: "PATCH",
        headers: { authorization: `Bearer ${adminToken}` },
        body: JSON.stringify({ status: "REJECTED", notes: "Not eligible" }),
      },
    );
    expect(rejected.status).toBe(200);
    expect(order.status).toBe("DELIVERED");

    const allItems = await request("/api/v1/account/returns", {
      method: "POST",
      headers: { authorization: `Bearer ${customerToken}` },
      body: JSON.stringify({
        orderId: order.id,
        reason: "The complete delivered line is now being returned",
      }),
    });
    expect(allItems.status).toBe(201);
    expect(allItems.body.data.items[0].quantity).toBe(2);
    const approved = await request(
      `/api/v1/admin/returns/${allItems.body.data.id}`,
      {
        method: "PATCH",
        headers: { authorization: `Bearer ${adminToken}` },
        body: JSON.stringify({ status: "APPROVED", notes: "Approved" }),
      },
    );
    expect(approved.status).toBe(200);
    expect(order.status).toBe("RETURN_APPROVED");
    const received = await request(
      `/api/v1/admin/returns/${allItems.body.data.id}`,
      {
      method: "PATCH",
      headers: { authorization: `Bearer ${adminToken}` },
      body: JSON.stringify({ status: "RECEIVED", notes: "Warehouse received" }),
      },
    );
    expect(received.status).toBe(200);
    expect(received.body.data.status).toBe("RECEIVED");
    expect(received.body.data.order.status).toBe("RETURNED");
    expect(store.returns.get(allItems.body.data.id)?.status).toBe("RECEIVED");
    const refunded = await request(`/api/v1/admin/orders/${order.id}/refunds`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${adminToken}`,
        "idempotency-key": `return-refund-${crypto.randomUUID()}`,
      },
      body: JSON.stringify({
        amount: 100,
        reason: "Refund for the returned line",
        returnRequestId: allItems.body.data.id,
      }),
    });
    expect(refunded.status).toBe(201);
    expect(refunded.body.data.payment.status).toBe("PARTIALLY_REFUNDED");
    expect(order.status).toBe("RETURNED");
    expect(store.returns.get(allItems.body.data.id)?.status).toBe("REFUNDED");
    const detail = await request(
      `/api/v1/admin/returns/${allItems.body.data.id}`,
      { headers: { authorization: `Bearer ${adminToken}` } },
    );
    expect(detail.body.data.refund).toMatchObject({
      amount: 100,
      currency: "INR",
      status: "SUCCEEDED",
    });
  });
  it("invalidates every customer session version when an account is disabled", async () => {
    const login = await googleLogin("disable.test@example.com");
    const customer = store.findUser("disable.test@example.com")!;
    customer.mobile = "+919811112222";
    const oldToken = login.body.data.accessToken;
    const oldCookie = login.headers.get("set-cookie")!.split(";")[0]!;
    const disabled = await request(`/api/v1/admin/customers/${customer.id}`, {
      method: "PATCH",
      headers: { authorization: `Bearer ${adminToken}` },
      body: JSON.stringify({ accountStatus: "DISABLED" }),
    });
    expect(disabled.status).toBe(200);
    expect(disabled.body.data.accountStatus).toBe("DISABLED");
    expect(
      (
        await request("/api/v1/account/addresses", {
          headers: { authorization: `Bearer ${oldToken}` },
        })
      ).status,
    ).toBe(401);
    expect(
      (
        await request("/api/v1/auth/refresh", {
          method: "POST",
          headers: { cookie: oldCookie },
        })
      ).status,
    ).toBe(401);
    const blockedCustomer = await googleLogin(customer.email);
    expect(blockedCustomer.status).toBe(403);
    const googleCustomer = store.findUser("google.customer@example.com")!;
    await request(`/api/v1/admin/customers/${googleCustomer.id}`, {
      method: "PATCH",
      headers: { authorization: `Bearer ${adminToken}` },
      body: JSON.stringify({ accountStatus: "DISABLED" }),
    });
    const blockedGoogle = await request("/api/v1/auth/google", {
      method: "POST",
      body: JSON.stringify({ credential: "x".repeat(120) }),
    });
    expect(blockedGoogle.status).toBe(403);
    await request(`/api/v1/admin/customers/${googleCustomer.id}`, {
      method: "PATCH",
      headers: { authorization: `Bearer ${adminToken}` },
      body: JSON.stringify({ accountStatus: "ACTIVE" }),
    });

    const enabled = await request(`/api/v1/admin/customers/${customer.id}`, {
      method: "PATCH",
      headers: { authorization: `Bearer ${adminToken}` },
      body: JSON.stringify({ accountStatus: "ACTIVE" }),
    });
    expect(enabled.body.data.accountStatus).toBe("ACTIVE");
    expect(
      (
        await request("/api/v1/account/addresses", {
          headers: { authorization: `Bearer ${oldToken}` },
        })
      ).status,
    ).toBe(401);
    const relogin = await googleLogin(customer.email);
    expect(relogin.status).toBe(200);
    expect(
      (
        await request("/api/v1/account/addresses", {
          headers: { authorization: `Bearer ${relogin.body.data.accessToken}` },
        })
      ).status,
    ).toBe(200);
  });
  it("deletes the customer identity while retaining detached owner order records", async () => {
    const customer = store.findUser("ananya@example.com")!;
    const ownedOrders = [...store.orders.values()].filter(
      (order) => order.userId === customer.id,
    );
    const retainedReturn = [...store.returns.values()].find(
      (item) => item.userId === customer.id,
    )!;
    retainedReturn.notes = "Customer-provided personal return note";
    const customerTicketIds = [...store.supportTickets.values()]
      .filter((ticket) => ticket.userId === customer.id)
      .map((ticket) => ticket.id);
    expect(retainedReturn).toBeTruthy();
    expect(customerTicketIds.length).toBeGreaterThan(0);
    const wrong = await request("/api/v1/account", {
      method: "DELETE",
      headers: { authorization: `Bearer ${customerToken}` },
      body: JSON.stringify({ confirmation: "delete" }),
    });
    expect(wrong.status).toBe(400);
    const withoutReauthentication = await request("/api/v1/account", {
      method: "DELETE",
      headers: { authorization: `Bearer ${customerToken}` },
      body: JSON.stringify({ confirmation: "DELETE" }),
    });
    expect(withoutReauthentication.status).toBe(400);
    googleEmail = customer.email;
    const deleted = await request("/api/v1/account", {
      method: "DELETE",
      headers: { authorization: `Bearer ${customerToken}` },
      body: JSON.stringify({
        confirmation: "DELETE",
        googleCredential: "x".repeat(120),
      }),
    });
    expect(deleted.status).toBe(200);
    expect(deleted.body.data.retainedOrders).toBe(ownedOrders.length);
    expect(store.findUser("ananya@example.com")).toBeUndefined();
    expect(
      ownedOrders.every(
        (order) => store.orders.get(order.id)?.userId === undefined,
      ),
    ).toBe(true);
    expect(retainedReturn).toMatchObject({
      userId: undefined,
      reason: "Personal details removed",
      notes: undefined,
    });
    expect(
      customerTicketIds.every((id) => !store.supportTickets.has(id)),
    ).toBe(true);
    const account = await request("/api/v1/auth/me", {
      headers: { authorization: `Bearer ${customerToken}` },
    });
    expect(account.status).toBe(401);
  });
});
