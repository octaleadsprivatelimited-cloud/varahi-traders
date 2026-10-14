import type { Server } from "node:http";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import type { AppConfig } from "../src/config.js";
import type { GoogleClaims } from "../src/firebase-auth.js";
import { signAccessToken } from "../src/security.js";
import { SINGLE_ADMIN_EMAIL } from "../src/auth-policy.js";
import { CommerceStore } from "../src/store.js";

const testConfig: AppConfig = {
  NODE_ENV: "test",
  PORT: 0,
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

  UPLOAD_DIR: process.cwd(),
  PUBLIC_UPLOAD_BASE_URL: "http://localhost:4010/uploads",
};

async function listen(
  config: AppConfig,
  options: {
    store?: CommerceStore;
    googleVerifier?: (
      idToken: string,
      clientId: string,
    ) => Promise<GoogleClaims>;
  } = {},
) {
  const store = options.store || new CommerceStore();
  const created = await createApp({
      config,
      store,
      persistence: null,
      googleVerifier: options.googleVerifier,
    }),
    server = created.app.listen(0);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No test port");
  return { server, base: `http://127.0.0.1:${address.port}`, store };
}

async function close(server: Server) {
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
}

async function request(base: string, path: string, body?: unknown) {
  const response = await fetch(`${base}${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers:
      body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return {
    status: response.status,
    body: (await response.json()) as any,
    headers: response.headers,
  };
}

function googleClaims(sub: string, email: string): GoogleClaims {
  return {
    sub,
    email,
    email_verified: true,
    name: "Google Customer",
    aud: "unused-by-test-verifier.apps.googleusercontent.com",
    iss: "https://accounts.google.com",
    exp: Math.floor(Date.now() / 1_000) + 300,
  };
}

describe("Google-only authentication surface", () => {
  it("removes registration, local login and manual Google linking", async () => {
    const isolated = await listen(testConfig);
    try {
      for (const path of ["/api/v1/auth/register", "/api/v1/auth/login", "/api/v1/account/auth/google/link"]) {
        const result = await request(isolated.base, path, {});
        expect(result.status).toBe(404);
      }
      const providers = await request(isolated.base, "/api/v1/auth/providers");
      expect(providers.body.data).not.toHaveProperty("password");
      expect(providers.body.data.mobileOtp.enabled).toBe(false);
    } finally { await close(isolated.server); }
  });

  it("throttles Google login attempts and returns retry metadata", async () => {
    const isolated = await listen(testConfig);
    try {
      let limited: Awaited<ReturnType<typeof request>> | undefined;
      for (let index = 0; index < 11; index++)
        limited = await request(isolated.base, "/api/v1/auth/google", { credential: "invalid".padEnd(120, "x") });
      expect(limited!.status).toBe(429);
      expect(limited!.body.error).toMatchObject({ code: "RATE_LIMITED", details: { retryAfterSeconds: expect.any(Number) } });
      expect(Number(limited!.headers.get("retry-after"))).toBeGreaterThan(0);
    } finally { await close(isolated.server); }
  });
});

describe("Google customer authentication", () => {
  it("loads only the Google customer's orders before and after cookie renewal without caching private responses", async () => {
    const isolated = await listen(testConfig, { googleVerifier: async () => googleClaims("order-customer", "buyer@example.com") });
    try {
      const login = await request(isolated.base, "/api/v1/auth/google", { credential: "x".repeat(120) });
      expect(login.status).toBe(200);
      expect(login.body.data.user.role).toBe("CUSTOMER");
      const customerId = login.body.data.user.id;
      const createdAt = new Date().toISOString();
      for (const [id, userId] of [["own-order", customerId], ["other-order", "another-customer"]]) {
        isolated.store.orders.set(id, {
          id, userId, number: id, status: "CONFIRMED", lines: [], subtotal: 100,
          tax: 0, shipping: 0, discount: 0, total: 100, idempotencyKey: id,
          history: [{ to: "CONFIRMED", at: createdAt }], createdAt,
        });
      }
      const loadAccount = async (token: string) => {
        const headers = { authorization: `Bearer ${token}` };
        const me = await fetch(`${isolated.base}/api/v1/auth/me`, { headers });
        expect(me.status).toBe(200);
        expect((await me.json()).data.id).toBe(customerId);
        const orders = await fetch(`${isolated.base}/api/v1/account/orders`, { headers });
        expect(orders.status).toBe(200);
        expect(orders.headers.get("cache-control")).toBe("private, no-store");
        expect(orders.headers.get("vary")).toContain("Authorization");
        expect((await orders.json()).data.map((order: { id: string }) => order.id)).toEqual(["own-order"]);
      };
      await loadAccount(login.body.data.accessToken);
      const renewed = await fetch(`${isolated.base}/api/v1/auth/refresh`, {
        method: "POST", headers: { cookie: login.headers.get("set-cookie")!.split(";")[0]! },
      });
      expect(renewed.status).toBe(200);
      await loadAccount((await renewed.json()).data.accessToken);
      const anonymous = await fetch(`${isolated.base}/api/v1/account/orders`);
      expect(anonymous.status).toBe(401);
      expect(anonymous.headers.get("cache-control")).toBe("private, no-store");
    } finally { await close(isolated.server); }
  });

  it("publishes Firebase web config and verifies tokens for the configured project", async () => {
    let verifiedProject = "";
    const isolated = await listen(testConfig, { googleVerifier: async (_token, project) => { verifiedProject = project; return googleClaims("subject", "new@gmail.com"); } });
    try {
      const providers = await request(isolated.base, "/api/v1/auth/providers");
      expect(providers.body.data.google).toEqual({ enabled: true });
      expect(providers.body.data.firebase).toMatchObject({ enabled: true, projectId: "test-commerce", authDomain: "test-commerce.firebaseapp.com" });
      expect((await request(isolated.base, "/api/v1/auth/google", { credential: "x".repeat(120) })).status).toBe(200);
      expect(verifiedProject).toBe("test-commerce");
    } finally { await close(isolated.server); }
  });
  it("fails closed when Firebase configuration is absent or malformed", async () => {
    for (const FIREBASE_PROJECT_ID of ["", "invalid.apps.googleusercontent.com"]) {
      const isolated = await listen({ ...testConfig, FIREBASE_PROJECT_ID });
      try {
        expect((await request(isolated.base, "/api/v1/auth/providers")).body.data.google.enabled).toBe(false);
        expect((await request(isolated.base, "/api/v1/auth/google", { credential: "x".repeat(120) })).status).toBe(503);
      } finally { await close(isolated.server); }
    }
  });

  it("keys returning users by Google subject and rejects email-only collisions", async () => {
    const initialCredential = "initial-google".padEnd(120, "x"),
      changedCredential = "changed-google".padEnd(120, "x"),
      collisionCredential = "collision-google".padEnd(120, "x"),
      blankSubjectCredential = "blank-google".padEnd(120, "x");
    const verifier = async (credential: string) => {
      if (credential === changedCredential)
        return googleClaims("stable-subject", "renamed@example.com");
      if (credential === collisionCredential)
        return googleClaims("different-subject", "existing@example.com");
      if (credential === blankSubjectCredential)
        return googleClaims("   ", "blank-subject@example.com");
      return googleClaims("stable-subject", "original@example.com");
    };
    const isolated = await listen(
      {
        ...testConfig,

      },
      { googleVerifier: verifier },
    );
    try {
      const initial = await request(isolated.base, "/api/v1/auth/google", {
        credential: initialCredential,
      });
      expect(initial.status).toBe(200);
      const returning = await request(isolated.base, "/api/v1/auth/google", {
        credential: changedCredential,
      });
      expect(returning.status).toBe(200);
      expect(returning.body.data.user.id).toBe(initial.body.data.user.id);
      expect(returning.body.data.user.email).toBe("original@example.com");

      isolated.store.createUser({ name: "Existing Customer", email: "existing@example.com", role: "CUSTOMER", permissions: [] });
      const collision = await request(isolated.base, "/api/v1/auth/google", {
        credential: collisionCredential,
      });
      expect(collision.status).toBe(409);
      expect(collision.body.error).toMatchObject({
        code: "GOOGLE_ACCOUNT_LINK_REQUIRED",
        message: expect.stringContaining("store administrator"),
      });

      const blankSubject = await request(
        isolated.base,
        "/api/v1/auth/google",
        { credential: blankSubjectCredential },
      );
      expect(blankSubject.status).toBe(401);
      expect(blankSubject.body.error.code).toBe("INVALID_GOOGLE_TOKEN");
    } finally {
      await close(isolated.server);
    }
  });

  it("migrates authoritative existing Google emails without allowing subject replacement", async () => {
    const store = new CommerceStore();
    const owner = store.createUser({ name: "Owner", email: "owner@gmail.com", role: "ADMIN", permissions: ["catalog:write"] });
    const workspace = store.createUser({ name: "Staff", email: "staff@store.example", role: "STAFF", permissions: [] });
    const isolated = await listen({ ...testConfig }, {
      store,
      googleVerifier: async (credential) => credential.startsWith("workspace")
        ? googleClaims("workspace-sub", workspace.email)
        : googleClaims(credential.startsWith("replacement") ? "replacement-sub" : "owner-sub", owner.email),
    });
    try {
      const login = await request(isolated.base, "/api/v1/auth/google", { credential: "owner".padEnd(120, "x") });
      expect(login.status).toBe(200);
      expect(login.body.data.user).toMatchObject({ id: owner.id, role: "CUSTOMER" });
      expect(store.users.get(owner.id)?.permissions).toEqual([]);
      const replacement = await request(isolated.base, "/api/v1/auth/google", { credential: "replacement".padEnd(120, "x") });
      expect(replacement.status).toBe(409);
      expect(replacement.body.error.code).toBe("GOOGLE_ACCOUNT_LINK_REQUIRED");
      const staffLogin = await request(isolated.base, "/api/v1/auth/google", { credential: "workspace".padEnd(120, "x") });
      expect(staffLogin.status).toBe(409);
      expect(staffLogin.body.error.code).toBe("GOOGLE_ACCOUNT_LINK_REQUIRED");
    } finally { await close(isolated.server); }
  });

  it("grants the sole administrator role only after fresh Google verification", async () => {
    const store = new CommerceStore();
    const owner = store.createUser({ name: "Store owner", email: SINGLE_ADMIN_EMAIL, role: "CUSTOMER", permissions: [] });
    const oldCustomerToken = signAccessToken({ sub: owner.id, role: "CUSTOMER", permissions: [], authVersion: 0 }, testConfig.JWT_SECRET);
    const isolated = await listen(testConfig, { store, googleVerifier: async () => googleClaims("designated-owner", SINGLE_ADMIN_EMAIL) });
    const me = (token: string) => fetch(`${isolated.base}/api/v1/auth/me`, { headers: { authorization: `Bearer ${token}` } });
    try {
      const before = await me(oldCustomerToken);
      expect(before.status).toBe(200);
      expect((await before.json()).data.role).toBe("CUSTOMER");
      const login = await request(isolated.base, "/api/v1/auth/google", { credential: "owner".padEnd(120, "x") });
      expect(login.status).toBe(200);
      expect(login.body.data.user).toMatchObject({ id: owner.id, role: "ADMIN" });
      const current = await me(login.body.data.accessToken);
      expect((await current.json()).data.permissions).toEqual(["*"]);
      expect((await me(oldCustomerToken)).status).toBe(401);
      const dashboard = await fetch(`${isolated.base}/api/v1/admin/storefront-config`, { headers: { authorization: `Bearer ${login.body.data.accessToken}` } });
      expect(dashboard.status).toBe(200);
    } finally { await close(isolated.server); }
  });

  it("creates the designated administrator on first Google sign-in", async () => {
    const isolated = await listen(testConfig, { googleVerifier: async () => googleClaims("new-owner", SINGLE_ADMIN_EMAIL.toUpperCase()) });
    try {
      const login = await request(isolated.base, "/api/v1/auth/google", { credential: "new-owner".padEnd(120, "x") });
      expect(login.status).toBe(200);
      expect(login.body.data.user).toMatchObject({ email: SINGLE_ADMIN_EMAIL, role: "ADMIN" });
      expect(isolated.store.users.get(login.body.data.user.id)?.permissions).toEqual(["*"]);
    } finally { await close(isolated.server); }
  });

  it("demotes old staff and does not require legacy authenticator enrollment", async () => {
    const store = new CommerceStore();
    const staff = store.createUser({ name: "Former staff", email: "former.staff@gmail.com", role: "ADMIN", permissions: ["*"] });
    Object.assign(staff, { totpEnabled: true, totpSecretEncrypted: "legacy-enrollment" });
    const oldAdminToken = signAccessToken({ sub: staff.id, role: "ADMIN", permissions: ["*"], authVersion: 0 }, testConfig.JWT_SECRET);
    const isolated = await listen(testConfig, { store, googleVerifier: async () => googleClaims("former-staff", staff.email) });
    const adminPage = (token: string) => fetch(`${isolated.base}/api/v1/admin/storefront-config`, { headers: { authorization: `Bearer ${token}` } });
    try {
      expect([401, 403]).toContain((await adminPage(oldAdminToken)).status);
      const login = await request(isolated.base, "/api/v1/auth/google", { credential: "former".padEnd(120, "x") });
      expect(login.status).toBe(200);
      expect(login.body.data.user).toMatchObject({ id: staff.id, role: "CUSTOMER" });
      expect(store.users.get(staff.id)?.permissions).toEqual([]);
      expect((await adminPage(login.body.data.accessToken)).status).toBe(403);
      expect((await adminPage(oldAdminToken)).status).toBe(401);
      const returning = await request(isolated.base, "/api/v1/auth/google", { credential: "former".padEnd(120, "x") });
      expect(returning.status).toBe(200);
      expect(returning.body.data.user.role).toBe("CUSTOMER");
      for (const path of ["/api/v1/auth/admin-2fa/setup", "/api/v1/auth/admin-2fa/verify"]) {
        const removed = await fetch(`${isolated.base}${path}`, { method: "POST", headers: { authorization: `Bearer ${login.body.data.accessToken}`, "content-type": "application/json" }, body: "{}" });
        expect(removed.status).toBe(404);
      }
    } finally { await close(isolated.server); }
  });

  it("uses the verified Google email when a stored administrator email is stale", async () => {
    let verifiedEmail = SINGLE_ADMIN_EMAIL;
    const isolated = await listen(testConfig, { googleVerifier: async () => googleClaims("stable-owner-subject", verifiedEmail) });
    try {
      const credential = "same-subject".padEnd(120, "x");
      const ownerLogin = await request(isolated.base, "/api/v1/auth/google", { credential });
      expect(ownerLogin.body.data.user.role).toBe("ADMIN");
      verifiedEmail = "different@gmail.com";
      const customerLogin = await request(isolated.base, "/api/v1/auth/google", { credential });
      expect(customerLogin.status).toBe(200);
      expect(customerLogin.body.data.user).toMatchObject({ id: ownerLogin.body.data.user.id, role: "CUSTOMER" });
      const oldAccess = await fetch(`${isolated.base}/api/v1/auth/me`, { headers: { authorization: `Bearer ${ownerLogin.body.data.accessToken}` } });
      expect(oldAccess.status).toBe(401);
    } finally { await close(isolated.server); }
  });

  it("never trusts privileged permissions in a customer access token", async () => {
    const store = new CommerceStore();
    const customer = store.createUser({ name: "Customer", email: "customer@gmail.com", role: "CUSTOMER", permissions: ["*"] });
    const isolated = await listen(testConfig, { store });
    try {
      const token = signAccessToken({ sub: customer.id, role: "CUSTOMER", permissions: ["*"], authVersion: 0 }, testConfig.JWT_SECRET);
      const denied = await fetch(`${isolated.base}/api/v1/admin/storefront-config`, { headers: { authorization: `Bearer ${token}` } });
      expect(denied.status).toBe(403);
      expect(customer.role).toBe("CUSTOMER");
    } finally { await close(isolated.server); }
  });

  it("rotates Google refresh sessions and rejects reused refresh tokens", async () => {
    const isolated = await listen({ ...testConfig }, {
      googleVerifier: async () => googleClaims("session-sub", "session@example.com"),
    });
    try {
      const login = await request(isolated.base, "/api/v1/auth/google", { credential: "session".padEnd(120, "x") });
      expect(login.status).toBe(200);
      const cookie = login.headers.get("set-cookie")!.split(";")[0]!;
      const refresh = () => fetch(`${isolated.base}/api/v1/auth/refresh`, { method: "POST", headers: { cookie } });
      const rotated = await refresh();
      expect(rotated.status).toBe(200);
      expect(rotated.headers.get("set-cookie")).toBeTruthy();
      expect((await rotated.json()).data.accessToken).toBeTruthy();
      expect((await refresh()).status).toBe(401);
    } finally { await close(isolated.server); }
  });

  it("uses the Firebase project and stable Google subject for account deletion", async () => {
    const loginCredential = "delete-login".padEnd(120, "x"),
      wrongCredential = "delete-wrong".padEnd(120, "x"),
      linkedCredential = "delete-linked".padEnd(120, "x");
    const verifiedAudiences: string[] = [];
    const isolated = await listen(
      {
        ...testConfig,

      },
      {
        googleVerifier: async (credential, audience) => {
          verifiedAudiences.push(audience);
          if (credential === wrongCredential)
            return googleClaims("attacker-subject", "delete@example.com");
          if (credential === linkedCredential)
            return googleClaims("delete-subject", "changed@example.com");
          return googleClaims("delete-subject", "delete@example.com");
        },
      },
    );
    try {
      const login = await request(isolated.base, "/api/v1/auth/google", {
        credential: loginCredential,
      });
      expect(login.status).toBe(200);
      isolated.store.integrations.set("auth-google-disabled-after-link", {
        id: "auth-google-disabled-after-link",
        kind: "AUTH",
        provider: "google",
        enabled: false,
        priority: 1,
        environment: "TEST",
        encryptedCredentials: "",
        publicConfig: {
          clientId: "replacement-client.apps.googleusercontent.com",
        },
        updatedAt: new Date().toISOString(),
      });
      const authMethodsResponse = await fetch(
        `${isolated.base}/api/v1/account/auth-methods`,
        {
          headers: {
            authorization: `Bearer ${login.body.data.accessToken}`,
          },
        },
      );
      const authMethods = (await authMethodsResponse.json()) as any;
      expect(authMethods.data).not.toHaveProperty("password");
      expect(authMethods.data.google).toEqual({
        linked: true,
        enabled: true,
      });
      const remove = async (credential: string) => {
        const response = await fetch(`${isolated.base}/api/v1/account`, {
          method: "DELETE",
          headers: {
            authorization: `Bearer ${login.body.data.accessToken}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            confirmation: "DELETE",
            googleCredential: credential,
          }),
        });
        return {
          status: response.status,
          body: (await response.json()) as any,
        };
      };
      const wrong = await remove(wrongCredential);
      expect(wrong.status).toBe(401);
      expect(wrong.body.error.code).toBe("REAUTHENTICATION_REQUIRED");

      const linked = await remove(linkedCredential);
      expect(linked.status).toBe(200);
      expect(linked.body.data.deleted).toBe(true);
      expect(verifiedAudiences).toEqual([
        "test-commerce",
        "test-commerce",
        "test-commerce",
      ]);
    } finally {
      await close(isolated.server);
    }
  });
});

describe("account deletion throttling", () => {
  it("limits repeated reauthentication attempts per customer account", async () => {
    const isolated = await listen({ ...testConfig }, {
      googleVerifier: async (credential) => googleClaims(credential, `${credential.slice(0, 20)}@example.com`),
    });
    try {
      const login = async (subject: string) => {
        const result = await request(isolated.base, "/api/v1/auth/google", { credential: subject.padEnd(120, "x") });
        expect(result.status).toBe(200);
        return result.body.data.accessToken as string;
      };
      const firstToken = await login("delete-limit-1"),
        secondToken = await login("delete-limit-2"),
        removeWithWrongGoogle = async (accessToken: string) => {
          const response = await fetch(`${isolated.base}/api/v1/account`, {
            method: "DELETE",
            headers: {
              authorization: `Bearer ${accessToken}`,
              "content-type": "application/json",
            },
            body: JSON.stringify({
              confirmation: "DELETE",
              googleCredential: "unrelated-subject".padEnd(120, "x"),
            }),
          });
          return {
            status: response.status,
            headers: response.headers,
            body: (await response.json()) as any,
          };
        };

      for (let attempt = 0; attempt < 8; attempt++) {
        const result = await removeWithWrongGoogle(firstToken);
        expect(result.status).toBe(401);
        expect(result.body.error.code).toBe("REAUTHENTICATION_REQUIRED");
      }
      const limited = await removeWithWrongGoogle(firstToken);
      expect(limited.status).toBe(429);
      expect(limited.body.error).toMatchObject({
        code: "RATE_LIMITED",
        details: { retryAfterSeconds: expect.any(Number) },
      });
      expect(Number(limited.headers.get("retry-after"))).toBeGreaterThan(0);
      expect(isolated.store.users.size).toBe(2);

      const otherAccount = await removeWithWrongGoogle(secondToken);
      expect(otherAccount.status).toBe(401);
      expect(otherAccount.body.error.code).toBe("REAUTHENTICATION_REQUIRED");
    } finally {
      await close(isolated.server);
    }
  });
});

describe("production mobile OTP availability", () => {
  it("does not advertise or accept OTP when no live SMS delivery is configured", async () => {
    const { server, base } = await listen({
      ...testConfig,
      NODE_ENV: "production",
    });
    try {
      const providers = await request(base, "/api/v1/auth/providers"),
        otp = await request(base, "/api/v1/auth/mobile/request", {
          mobile: "+919866666666",
        });
      expect(providers.body.data.mobileOtp.enabled).toBe(false);
      expect(otp.status).toBe(404);
      expect(otp.body.error.code).toBe("MOBILE_OTP_DISABLED");
    } finally {
      await close(server);
    }
  });
});
