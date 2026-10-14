import { describe, expect, it } from "vitest";
import { buildMerchantFeed, buildRobots, buildSitemap, merchantPrice, publicHttpUrl } from "../src/catalog-discovery.js";
import type { StoredProduct } from "../src/store.js";

const origin = "https://srivarahitraders.example";
const product = (overrides: Partial<StoredProduct> = {}): StoredProduct => ({
  id: "p-1", name: "Groundnut & Sesame Oils", slug: "groundnut-sesame-oils", description: "Groundnut & sesame oils for cooking.", category: "Cooking Oils", brand: "Sri Varahi Traders", status: "ACTIVE", taxRate: 5,
  specifications: { "Identifier exists": "no" },
  media: [{ id: "image-1", type: "IMAGE", url: "/uploads/groundnut-oil.jpg", alt: "Groundnut oil bottle", position: 0 }],
  variants: [
    { id: "v-100", sku: "SVT-OIL-100", title: "500 ml", active: true, price: 129, mrp: 149, stock: 4, reserved: 1, attributes: { Volume: "500 ml" }, weightGrams: 100 },
    { id: "v-250", sku: "SVT-OIL-250", title: "1 L", active: true, price: 279.5, mrp: 299, stock: 1, reserved: 1, attributes: { Volume: "1 L" }, weightGrams: 250 },
  ],
  createdAt: "2026-09-01T00:00:00.000Z", updatedAt: "2026-09-29T00:00:00.000Z", ...overrides,
});

describe("Merchant feed", () => {
  it("uses option IDs and deep links, tax-inclusive major-unit INR, and sellable inventory", () => {
    const { xml, report } = buildMerchantFeed([product()], origin);
    expect(report).toMatchObject({ activeProducts: 1, eligibleItems: 2, excludedItems: 0, issues: [] });
    expect(xml).toContain("<g:id>v-100</g:id>");
    expect(xml).toContain("/product/groundnut-sesame-oils?variant=v-100");
    expect(xml).toContain("<g:price>135.45 INR</g:price>");
    expect(xml).toContain("<g:price>293.48 INR</g:price>");
    expect(xml).toContain("<g:availability>out_of_stock</g:availability>");
    expect(xml).toContain("Groundnut &amp; Sesame Oils");
    expect(xml).toContain("<g:unit_pricing_measure>500ml</g:unit_pricing_measure>");
    expect(xml).toContain("<g:unit_pricing_measure>1l</g:unit_pricing_measure>");
    expect(xml).not.toContain("gtin");
    expect(xml).not.toContain("<g:mpn>");
  });

  it("excludes unpublished/disabled options and reports missing required attributes", () => {
    const valid = product();
    valid.variants[1]!.active = false;
    const { xml, report } = buildMerchantFeed([valid, product({ id: "draft", status: "DRAFT" }), product({ id: "missing-photo", media: [] })], origin);
    expect(report).toMatchObject({ activeProducts: 2, eligibleItems: 1, excludedItems: 2 });
    expect(report.issues.some((issue) => issue.productId === "missing-photo" && issue.severity === "error")).toBe(true);
    expect(xml).not.toContain("variant=v-250");
    expect(xml).not.toContain("draft");
  });

  it("never invents identifiers or brands and flags identifier conflicts", () => {
    const missing = product({ brand: undefined, specifications: {} });
    expect(buildMerchantFeed([missing], origin).report.eligibleItems).toBe(0);
    const unknown = product({ specifications: {} });
    const result = buildMerchantFeed([unknown], origin);
    expect(result.report.issues.every((issue) => issue.severity === "warning")).toBe(true);
    expect(result.xml).not.toContain("identifier_exists");
    const bad = product();
    bad.variants[0]!.attributes.GTIN = "1234567890123";
    expect(buildMerchantFeed([bad], origin).report.excludedItems).toBe(1);
  });

  it("accepts an actual checksummed GTIN and never uses SKU as MPN", () => {
    const item = product({ specifications: {} });
    item.variants[0]!.attributes.GTIN = "4006381333931";
    const { xml, report } = buildMerchantFeed([item], origin);
    expect(xml).toContain("<g:gtin>4006381333931</g:gtin>");
    expect(xml).not.toContain("<g:mpn>");
    expect(report.issues.filter((issue) => issue.variantId === "v-100")).toHaveLength(0);
  });

  it("rejects nonpublic images and preserves option-specific photos", () => {
    for (const url of ["http://127.0.0.1/a.jpg", "http://192.168.1.1/a.jpg", "data:image/png,abc", "https://user:pass@example.com/a.jpg", "/favicon.svg"]) {
      const item = product(); item.media[0]!.url = url;
      expect(buildMerchantFeed([item], origin).report.eligibleItems).toBe(0);
    }
    const item = product(); item.media.push({ ...item.media[0]!, id: "specific", variantId: "v-100", url: "/uploads/groundnut-oil-100.jpg" });
    expect(buildMerchantFeed([item], origin).xml).toContain("<g:image_link>https://srivarahitraders.example/uploads/groundnut-oil-100.jpg</g:image_link>");
    expect(publicHttpUrl("http://[::1]/a.jpg", origin)).toBeUndefined();
  });

  it("prices exactly like a one-unit checkout excluding delivery and discounts", () => {
    for (const price of [0.99, 49.95, 129, 279.5, 1234.56]) for (const rate of [0, 5, 12, 18]) {
      const roundedTax = Math.round((price * rate / 100) * 100) / 100;
      const checkout = Math.round((price + roundedTax) * 100) / 100;
      expect(merchantPrice(price, rate)).toBe(checkout);
    }
  });
});

describe("Search discovery", () => {
  it("excludes explicitly marked samples while retaining real out-of-stock products", () => {
    const sample = product({ id: "sample-preview", slug: "sample-preview", specifications: { " CATALOG   PURPOSE ": " sample ", "Identifier exists": "no" } });
    sample.variants = sample.variants.map((variant) => ({ ...variant, id: `sample-${variant.id}`, stock: 0, reserved: 0 }));
    const real = product({ id: "real-sold-out", slug: "real-sold-out", name: "Sample size oil bottle" });
    real.variants = real.variants.map((variant) => ({ ...variant, stock: 0, reserved: 0, sku: `SAMPLE-${variant.sku}` }));
    const result = buildMerchantFeed([sample, real], origin);
    expect(result.report).toMatchObject({ activeProducts: 2, eligibleItems: 2, excludedItems: 2 });
    expect(result.report.issues).toContainEqual(expect.objectContaining({ productId: "sample-preview", severity: "warning" }));
    expect(result.xml).not.toContain("sample-preview");
    expect(result.xml).toContain("real-sold-out");
    expect((result.xml.match(/<g:availability>out_of_stock<\/g:availability>/g) || []).length).toBe(2);
    const sitemap = buildSitemap([sample, real], origin)!;
    expect(sitemap).not.toContain("sample-preview");
    expect(sitemap).toContain("real-sold-out");
    expect((sitemap.match(/<url>/g) || []).length).toBe(7);
  });

  it("does not infer sample status from unrelated specifications or names", () => {
    const cases: Array<Record<string, string>> = [{ Purpose: "Sample" }, { "Catalog purpose": "Sample packaging" }, { "Catalog purpose": "Retail" }];
    for (const specifications of cases) {
      const item = product({ name: "Sample size oil bottle", specifications: { ...specifications, "Identifier exists": "no" } });
      expect(buildMerchantFeed([item], origin).report.eligibleItems).toBe(2);
      expect(buildSitemap([item], origin)).toContain("/product/groundnut-sesame-oils");
    }
  });

  it("includes all live product URLs beyond 100, excludes private pages and drafts", () => {
    const products = Array.from({ length: 105 }, (_, index) => product({ id: `internal-${index}`, slug: `product-${index}` }));
    const xml = buildSitemap([...products, product({ id: "draft", status: "DRAFT" })], origin)!;
    expect((xml.match(/<url>/g) || []).length).toBe(111);
    expect(xml).toContain("product-104");
    expect(xml).toContain("<lastmod>2026-09-29T00:00:00.000Z</lastmod>");
    expect(xml).toContain("<image:loc>https://srivarahitraders.example/uploads/groundnut-oil.jpg</image:loc>");
    for (const value of ["/admin", "/account", "/checkout", "?variant=", "/product/draft"]) expect(xml).not.toContain(value);
  });

  it("splits large catalogs and handles malformed dates without breaking indexing", () => {
    const products = Array.from({ length: 10000 }, (_, index) => product({ id: `id-${index}`, slug: `p-${index}`, updatedAt: "invalid" }));
    const index = buildSitemap(products, origin)!;
    expect(index).toContain("<sitemapindex");
    const second = buildSitemap(products, origin, "/sitemap-2.xml")!;
    expect((second.match(/<url>/g) || []).length).toBe(6);
    expect(second).not.toContain("lastmod");
    expect(buildSitemap(products, origin, "/sitemap-99.xml")).toBeUndefined();
    expect(buildRobots(origin)).toContain(`Sitemap: ${origin}/sitemap.xml`);
    expect(buildRobots(origin)).not.toContain("Disallow: /product");
  });
});
