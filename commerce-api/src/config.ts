import { z } from "zod";
import { resolveDatabaseUrl } from "./database-env.js";
import { firebaseWebDefaults } from "./firebase-web-config.js";
const schema = z.object({
  NODE_ENV: z
    .enum(["development", "test", "production"])
    .default("development"),
  PORT: z.coerce.number().int().min(1).max(65535).default(4010),
  DATABASE_URL: z.string().min(1),
  JWT_SECRET: z.string().min(32),
  JWT_REFRESH_SECRET: z.string().min(32),
  INTEGRATION_ENCRYPTION_KEY: z.string().min(32),
  CORS_ORIGINS: z.string().default("http://localhost:5180"),
  TRUST_PROXY: z.string().default(""),
  USE_DATABASE: z.enum(["true", "false"]).default("false").transform(value => value === "true"),
  FIREBASE_PROJECT_ID: z.string().optional(),
  FIREBASE_API_KEY: z.string().optional(),
  FIREBASE_AUTH_DOMAIN: z.string().optional(),
  FIREBASE_APP_ID: z.string().optional(),
  UPLOAD_DIR: z.string().default("uploads"),
  PUBLIC_UPLOAD_BASE_URL: z.string().url().default("http://localhost:4010/uploads"),
});
export type AppConfig = z.infer<typeof schema>;
export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  // Override the complete Firebase configuration together, never mix projects.
  const firebaseDefaults = Object.keys(firebaseWebDefaults).some(key => env[key] !== undefined)
    ? {} : firebaseWebDefaults;
  const parsed = schema.safeParse({ ...firebaseDefaults, ...env, DATABASE_URL: resolveDatabaseUrl(env) });
  if (!parsed.success)
    throw new Error(
      `Invalid environment configuration: ${parsed.error.issues.map((x) => x.path.join(".")).join(", ")}`,
    );
  const config = parsed.data;
  if (config.NODE_ENV === "production") {
    const origins = config.CORS_ORIGINS.split(",").map((value) => value.trim());
    const unsafeOrigin = origins.find((origin) => {
      try {
        const url = new URL(origin);
        return url.protocol !== "https:" || url.hostname === "localhost" || url.hostname === "127.0.0.1";
      } catch {
        return true;
      }
    });
    if (unsafeOrigin)
      throw new Error("Invalid production configuration: CORS_ORIGINS must contain only explicit HTTPS origins");
    if (!config.USE_DATABASE)
      throw new Error("Invalid production configuration: USE_DATABASE must be true");
    if (!config.PUBLIC_UPLOAD_BASE_URL.startsWith("https://"))
      throw new Error("Invalid production configuration: PUBLIC_UPLOAD_BASE_URL must use HTTPS");
  }
  return config;
}
