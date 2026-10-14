import { afterEach, expect, it, vi } from "vitest";

const modulePath = "../../src/lib/public-catalog-reader.ts";
const { readPublicCatalog, readPublicProduct } = await import(modulePath);
const readerKey = Symbol.for("varahi.publicCatalogReader");
const registry = globalThis as unknown as Record<symbol, (() => unknown[]) | undefined>;

afterEach(() => {
  delete registry[readerKey];
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

it("renders the empty live catalog even when loopback HTTP is unavailable", async () => {
  const fetch = vi.fn().mockRejectedValue(new Error("fetch failed"));
  vi.stubGlobal("fetch", fetch);
  registry[readerKey] = () => [];
  expect(await readPublicCatalog()).toEqual([]);
  expect(await readPublicProduct("not-published")).toBeNull();
  expect(fetch).not.toHaveBeenCalled();
});

it("reads fresh public product snapshots without a stale server cache", async () => {
  let catalog = [{ id: "turmeric", name: "Turmeric powder", status: "ACTIVE", variants: [] }];
  registry[readerKey] = () => catalog;
  expect((await readPublicProduct("turmeric"))?.name).toBe("Turmeric powder");
  catalog = [];
  expect(await readPublicProduct("turmeric")).toBeNull();
  expect(await readPublicCatalog()).toEqual([]);
});

it("uses the separate API process during development and retains product 404 semantics", async () => {
  vi.stubEnv("COMMERCE_API_PORT", "4101");
  const fetch = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({ data: [] }))).mockResolvedValueOnce(new Response("", { status: 404 }));
  vi.stubGlobal("fetch", fetch);
  expect(await readPublicCatalog()).toEqual([]);
  expect(await readPublicProduct("missing")).toBeNull();
  expect(fetch.mock.calls[0]?.[0]).toBe("http://127.0.0.1:4101/api/v1/products");
  expect(fetch.mock.calls[1]?.[0]).toBe("http://127.0.0.1:4101/api/v1/products/missing");
});

it("does not silently substitute sample or empty products after an API failure", async () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("unavailable", { status: 503 })));
  await expect(readPublicCatalog()).rejects.toThrow("catalog could not be loaded");
});
