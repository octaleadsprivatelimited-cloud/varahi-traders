import { describe, expect, it } from "vitest";
import { resolveDatabaseUrl } from "../src/database-env.js";

describe("hosting database configuration", () => {
  const fields = { DATABASE_HOST: "localhost", DATABASE_USER: "store", DATABASE_PASSWORD: "p@ss:#/%? space", DATABASE_NAME: "store_db" };
  it("encodes raw passwords exactly once and prefers complete discrete fields", () => {
    const resolved = new URL(resolveDatabaseUrl({ ...fields, DATABASE_URL: "mysql://old:old@localhost/old" }));
    expect(decodeURIComponent(resolved.password)).toBe(fields.DATABASE_PASSWORD);
    expect(resolved.pathname).toBe("/store_db");
    expect(resolved.port).toBe("3306");
  });
  it("preserves an already encoded URL", () => {
    const DATABASE_URL = "mysql://user:p%40ss%2523@localhost:3306/store?connection_limit=5";
    expect(resolveDatabaseUrl({ DATABASE_URL })).toBe(DATABASE_URL);
  });
  it("rejects partial fields and invalid URLs without printing secrets", () => {
    expect(() => resolveDatabaseUrl({ DATABASE_PASSWORD: fields.DATABASE_PASSWORD })).toThrow(/Set all DATABASE/);
    expect(() => resolveDatabaseUrl({ DATABASE_URL: "mysql://store:p#ss@localhost/store" })).toThrow(/Invalid DATABASE_URL/);
    expect(() => resolveDatabaseUrl({ ...fields, DATABASE_PORT: "70000" })).toThrow(/Invalid DATABASE_HOST or DATABASE_PORT/);
  });
});
