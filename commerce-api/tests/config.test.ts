import { describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { firebaseWebDefaults } from "../src/firebase-web-config.js";
import { loadConfig } from "../src/config.js";

const production = {
  NODE_ENV: "production",
  PORT: "4010",
  DATABASE_URL: "mysql://commerce:secret@db/commerce",
  JWT_SECRET: "a".repeat(32),
  JWT_REFRESH_SECRET: "b".repeat(32),
  INTEGRATION_ENCRYPTION_KEY: "c".repeat(32),
  CORS_ORIGINS: "https://shop.customer.example",
  USE_DATABASE: "true",
  PUBLIC_UPLOAD_BASE_URL: "https://cdn.customer.example/uploads",
};

describe("production configuration safety", () => {
  it("accepts an explicit HTTPS storefront with durable persistence", () => {
    expect(loadConfig(production).NODE_ENV).toBe("production");
  });

  it("rejects local/insecure origins and memory-only production mode", () => {
    expect(() => loadConfig({ ...production, CORS_ORIGINS: "http://localhost:5180" })).toThrow(/HTTPS origins/);
    expect(() => loadConfig({ ...production, USE_DATABASE: "false" })).toThrow(/USE_DATABASE/);
    expect(() => loadConfig({ ...production, PUBLIC_UPLOAD_BASE_URL: "http://cdn.example/uploads" })).toThrow(/HTTPS/);
  });
});

async function providersFor(env: NodeJS.ProcessEnv) {
  const { app } = await createApp({ config: loadConfig(env), persistence: null });
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>(resolve => server.once("listening", resolve));
  try {
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Missing test server address");
    const response = await fetch(`http://127.0.0.1:${address.port}/api/v1/auth/providers`);
    expect(response.status).toBe(200);
    return (await response.json()).data;
  } finally { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
}

describe("Firebase project configuration", () => {
  it("keeps client Firebase disconnected until explicitly configured", async () => {
    const config = loadConfig(production);
    expect(config).toMatchObject(firebaseWebDefaults);
    expect(config.FIREBASE_PROJECT_ID).toBe("");
    const providers = await providersFor(production);
    expect(providers.google.enabled).toBe(false);
    expect(providers.firebase.enabled).toBe(false);
  });

  it.each(Object.keys(firebaseWebDefaults))("does not mix default project values with a lone %s override", async key => {
    const env = { ...production, [key]: "alternate-project-value" };
    const config = loadConfig(env);
    for (const other of Object.keys(firebaseWebDefaults)) {
      expect(config[other as keyof typeof firebaseWebDefaults]).toBe(other === key ? "alternate-project-value" : undefined);
    }
    const providers = await providersFor(env);
    expect(providers.google.enabled).toBe(false);
    expect(providers.firebase.enabled).toBe(false);
  });

  it("uses a complete alternate project without carrying over the default app ID", async () => {
    const alternate = { FIREBASE_PROJECT_ID: "alternate-store", FIREBASE_API_KEY: "AIza" + "y".repeat(30), FIREBASE_AUTH_DOMAIN: "alternate-store.firebaseapp.com" };
    const config = loadConfig({ ...production, ...alternate });
    expect(config).toMatchObject(alternate);
    expect(config.FIREBASE_APP_ID).toBeUndefined();
    const providers = await providersFor({ ...production, ...alternate });
    expect(providers.google.enabled).toBe(true);
    expect(providers.firebase).toEqual({ enabled: true, projectId: alternate.FIREBASE_PROJECT_ID, apiKey: alternate.FIREBASE_API_KEY, authDomain: alternate.FIREBASE_AUTH_DOMAIN });
  });

  it("preserves an explicitly supplied alternate app ID with the other project fields", async () => {
    const alternate = { FIREBASE_PROJECT_ID: "alternate-store", FIREBASE_API_KEY: "AIza" + "z".repeat(30), FIREBASE_AUTH_DOMAIN: "alternate-store.firebaseapp.com", FIREBASE_APP_ID: "1:123456789:web:alternate" };
    expect(loadConfig({ ...production, ...alternate })).toMatchObject(alternate);
    const providers = await providersFor({ ...production, ...alternate });
    expect(providers.firebase).toEqual({ enabled: true, projectId: alternate.FIREBASE_PROJECT_ID, apiKey: alternate.FIREBASE_API_KEY, authDomain: alternate.FIREBASE_AUTH_DOMAIN, appId: alternate.FIREBASE_APP_ID });
  });

  it("treats an explicit empty override as disabling Firebase rather than restoring defaults", async () => {
    const env = { ...production, FIREBASE_PROJECT_ID: "" };
    const config = loadConfig(env);
    expect(config.FIREBASE_PROJECT_ID).toBe("");
    expect(config.FIREBASE_API_KEY).toBeUndefined();
    expect((await providersFor(env)).google.enabled).toBe(false);
  });
});
