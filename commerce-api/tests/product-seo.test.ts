import { expect, it } from "vitest";

// Browser modules are tested without pulling them into the API production TS build.
const seoModulePath = "../../src/lib/seo.ts";
const pricesModulePath = "../../src/lib/catalog-price.ts";
const { productSeo } = await import(seoModulePath);
const { priceIncludingTax } = await import(pricesModulePath);

it("matches gross storefront prices and parent canonicals with distinct purchasable option URLs", () => {
  const product = {
    id: "groundnut-oil", slug: "cold-pressed-groundnut-oil", name: "Groundnut Oil", description: "Cold pressed groundnut oil", category: "Cooking oils", brand: "Sri Varahi Traders", price: 99, mrp: 119, taxRate: 5,
    image: "/uploads/groundnut-oil.jpg", rating: 5, reviews: 999, tone: "", glyph: "",
    variants: [
      { id: "groundnut-250", sku: "P50", title: "250 ml", options: { Volume: "250 ml" }, price: 99, mrp: 119, stock: 10, image: "/uploads/groundnut-250.jpg" },
      { id: "groundnut-500", sku: "P100", title: "500 ml", options: { Volume: "500 ml" }, price: 189, mrp: 219, stock: 0, image: "/uploads/groundnut-500.jpg" },
    ],
  };
  const head = productSeo(product);
  expect(head.links).toEqual([{ rel: "canonical", href: "http://localhost:5180/product/cold-pressed-groundnut-oil" }]);
  const [schema, breadcrumbs] = JSON.parse(head.scripts[0].children);
  expect(schema["@type"]).toBe("ProductGroup");
  expect(schema.hasVariant[0].offers).toMatchObject({ price: "103.95", priceCurrency: "INR", url: "http://localhost:5180/product/cold-pressed-groundnut-oil?variant=groundnut-250" });
  expect(schema.hasVariant[1].offers.availability).toBe("https://schema.org/OutOfStock");
  expect(schema.hasVariant[0].image).toBe("http://localhost:5180/uploads/groundnut-250.jpg");
  expect(schema).not.toHaveProperty("aggregateRating");
  expect(breadcrumbs["@type"]).toBe("BreadcrumbList");
  expect(priceIncludingTax(product.variants[0]!.price, product.taxRate)).toBe(Number(schema.hasVariant[0].offers.price));
});

it("escapes merchant-provided script delimiters in server-rendered JSON-LD", () => {
  const head = productSeo({ id: "safe", name: "</script><script>alert(1)</script>", category: "Cooking Oils", price: 1, mrp: 1, rating: 0, reviews: 0, tone: "", glyph: "", variants: [] });
  expect(head.scripts[0].children).not.toContain("</script>");
  expect(head.meta.some((meta: { title?: string }) => meta.title?.includes("Sri Varahi Traders"))).toBe(true);
});

it("marks explicit sample previews noindex and emits no product or offer schema", () => {
  const sample = { id: "sample", name: "Sesame Oil (Sample)", category: "Cooking Oils", price: 129, mrp: 149, rating: 0, reviews: 0, tone: "", glyph: "", specifications: { " Catalog  purpose ": " SAMPLE " }, variants: [{ id: "sample-100", sku: "SAMPLE-100", options: { Volume: "500 ml" }, price: 129, mrp: 149, stock: 0 }] };
  const head = productSeo(sample);
  expect(head.meta).toContainEqual({ name: "robots", content: "noindex, follow" });
  expect(head.scripts).toEqual([]);
  expect(head.links).toContainEqual({ rel: "canonical", href: "http://localhost:5180/product/sample" });

  const real = productSeo({ ...sample, specifications: { "Catalog purpose": "Retail" } });
  expect(real.meta).not.toContainEqual({ name: "robots", content: "noindex, follow" });
  expect(real.scripts[0].children).toContain('"@type":"Product"');
  expect(real.scripts[0].children).toContain("OutOfStock");
});
