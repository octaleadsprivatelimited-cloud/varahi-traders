import type { StoredProduct, StoredVariant } from "./store.js";

const publicPages = ["/", "/shop", "/contact", "/shipping-returns", "/privacy", "/terms"];
const sitemapPageSize = 10000;
const escapeXml = (value: unknown) => String(value).replace(/[<>&"']/g, (character) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&apos;" })[character]!);
const plainText = (value: string) => value.replace(/<[^>]*>/g, " ").replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();

export function isSampleProduct(product: Pick<StoredProduct, "specifications">) {
  return Object.entries(product.specifications || {}).some(([key, value]) =>
    key.trim().toLowerCase().replace(/\s+/g, " ") === "catalog purpose" && value.trim().toLowerCase() === "sample",
  );
}

/** Stored catalog amounts are INR major units, excluding GST, as in checkout. */
export function merchantPrice(price: number, taxRate: number) {
  const tax = Math.round(price * taxRate) / 100;
  return Math.round((price + tax) * 100) / 100;
}

export function publicHttpUrl(value: string | undefined, origin: string) {
  if (!value) return undefined;
  try {
    const url = new URL(value, origin);
    const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.href.length > 2000) return undefined;
    if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host === "::1" || host.startsWith("fc") && host.includes(":") || host.startsWith("fd") && host.includes(":") || host.startsWith("fe80:")) return undefined;
    if (/^(0|10|127)\./.test(host) || /^192\.168\./.test(host) || /^169\.254\./.test(host) || /^172\.(1[6-9]|2\d|3[01])\./.test(host)) return undefined;
    url.hash = "";
    return url.href;
  } catch { return undefined; }
}

function imageFor(product: StoredProduct, variant?: StoredVariant) {
  const images = product.media.filter((media) => media.type === "IMAGE").sort((left, right) => left.position - right.position);
  return images.find((image) => image.variantId === variant?.id)?.url || images.find((image) => !image.variantId)?.url;
}

const field = (attributes: Record<string, string>, name: string) => Object.entries(attributes).find(([key]) => key.toLowerCase().replace(/[ _-]/g, "") === name.toLowerCase().replace(/[ _-]/g, ""))?.[1]?.trim();

function validGtin(value: string) {
  if (!/^(\d{8}|\d{12}|\d{13}|\d{14})$/.test(value) || /^0+$/.test(value)) return false;
  const digits = [...value].map(Number);
  const check = digits.pop();
  const sum = digits.reverse().reduce((total, digit, index) => total + digit * (index % 2 === 0 ? 3 : 1), 0);
  return (10 - sum % 10) % 10 === check;
}

export type MerchantReport = {
  activeProducts: number;
  eligibleItems: number;
  excludedItems: number;
  issues: Array<{ productId: string; variantId?: string; message: string; severity: "error" | "warning" }>;
};

/** No fake products, fallback imagery, invented identifiers, or private fields enter this feed. */
export function buildMerchantFeed(products: Iterable<StoredProduct>, origin: string, storeName = "Sri Varahi Traders") {
  const report: MerchantReport = { activeProducts: 0, eligibleItems: 0, excludedItems: 0, issues: [] };
  const items: string[] = [];
  for (const product of products) {
    if (product.status !== "ACTIVE") continue;
    report.activeProducts += 1;
    const variants = product.variants.filter((variant) => variant.active);
    if (isSampleProduct(product)) {
      report.excludedItems += variants.length;
      report.issues.push({ productId: product.id, severity: "warning", message: "Sample product intentionally excluded from Google Merchant and search sitemaps. Publish genuine product information before removing Catalog purpose = Sample." });
      continue;
    }
    if (!variants.length) report.issues.push({ productId: product.id, severity: "error", message: "Publish at least one active product option." });
    for (const variant of variants) {
      const errors: string[] = [];
      const warnings: string[] = [];
      const title = plainText([product.name, variant.title].filter(Boolean).join(" — "));
      const description = plainText(product.description);
      const link = publicHttpUrl(`/product/${encodeURIComponent(product.slug)}?variant=${encodeURIComponent(variant.id)}`, origin);
      const image = publicHttpUrl(imageFor(product, variant), origin);
      const price = merchantPrice(variant.price, product.taxRate);
      const brand = plainText(product.brand || "");
      // Product-level identifiers are safe only for a single-option product.
      const identifierFields = variants.length === 1 ? { ...product.specifications, ...variant.attributes } : variant.attributes;
      const gtin = field(product.specifications, `gtin:${variant.sku}`) || field(identifierFields, "gtin") || field(identifierFields, "ean") || field(identifierFields, "barcode");
      const mpn = field(product.specifications, `mpn:${variant.sku}`) || field(identifierFields, "mpn");
      const explicitlyNoIdentifiers = /^(no|false)$/i.test(field(identifierFields, "identifier_exists") || field(product.specifications, "identifier_exists") || "");
      if (!variant.id || variant.id.length > 50) errors.push("Product option ID must contain 1–50 characters.");
      if (!product.name.trim() || title.length > 150) errors.push("Add a product name and option title totalling at most 150 characters.");
      if (!description) errors.push("Add an accurate product description.");
      if (!link) errors.push("Configure a public store URL.");
      if (!image || /\.(svg|gif)(\?|$)/i.test(image) || /(?:placeholder|favicon)/i.test(image)) errors.push("Add a public product photo in JPEG, PNG, WebP, BMP or TIFF format; avoid placeholders.");
      if (!Number.isFinite(price) || price <= 0 || !Number.isFinite(product.taxRate) || product.taxRate < 0 || product.taxRate > 100) errors.push("Add a valid positive price and GST rate.");
      if (brand.length > 70) errors.push("Brand must be at most 70 characters.");
      if (!brand && !explicitlyNoIdentifiers) errors.push("Add the actual brand, or confirm Identifier exists = no in specifications only if no identifiers were assigned.");
      if (gtin && !validGtin(gtin)) errors.push("Correct the GTIN/barcode; use the manufacturer-assigned value with a valid check digit.");
      if (mpn && mpn.length > 70) errors.push("Manufacturer part number must be at most 70 characters.");
      if (explicitlyNoIdentifiers && (gtin || mpn)) errors.push("Identifier exists = no conflicts with the supplied GTIN or MPN.");
      if (!gtin && !mpn && !explicitlyNoIdentifiers) warnings.push("Confirm manufacturer identifiers: add the assigned GTIN or MPN, or explicitly confirm none exist. Google may reject incomplete identifiers.");
      if (!image?.startsWith("https:")) warnings.push("Use an HTTPS product image accessible to Googlebot.");
      for (const message of errors) report.issues.push({ productId: product.id, variantId: variant.id, severity: "error", message });
      for (const message of warnings) report.issues.push({ productId: product.id, variantId: variant.id, severity: "warning", message });
      if (errors.length) { report.excludedItems += 1; continue; }
      const tag = (name: string, value: unknown) => `<g:${name}>${escapeXml(value)}</g:${name}>`;
      const quantity = Object.entries(variant.attributes).find(([key]) => /^(volume|net volume|weight|net weight|size)$/i.test(key))?.[1]?.trim();
      const measure = quantity?.match(/^(\d+(?:\.\d+)?)\s*(ml|l|g|kg)$/i);
      const additionalImages = product.media.filter((media) => media.type === "IMAGE" && (!media.variantId || media.variantId === variant.id)).map((media) => publicHttpUrl(media.url, origin)).filter((url): url is string => Boolean(url && url !== image)).slice(0, 10);
      items.push(`<item>${tag("id", variant.id)}${tag("title", title)}${tag("description", description.slice(0, 5000))}${tag("link", link)}${tag("image_link", image)}${additionalImages.map((url) => tag("additional_image_link", url)).join("")}${tag("availability", variant.stock - variant.reserved > 0 ? "in_stock" : "out_of_stock")}${tag("price", `${price.toFixed(2)} INR`)}${tag("condition", "new")}${brand ? tag("brand", brand) : ""}${gtin ? tag("gtin", gtin) : ""}${mpn ? tag("mpn", mpn) : ""}${explicitlyNoIdentifiers ? tag("identifier_exists", "no") : ""}${tag("item_group_id", product.id)}${tag("product_type", product.category)}${measure ? tag("unit_pricing_measure", `${measure[1]}${measure[2]!.toLowerCase()}`) : ""}</item>`);
      report.eligibleItems += 1;
    }
  }
  return { xml: `<?xml version="1.0" encoding="UTF-8"?><rss version="2.0" xmlns:g="http://base.google.com/ns/1.0"><channel><title>${escapeXml(storeName)}</title><link>${escapeXml(origin)}</link><description>Current product options, prices and availability</description>${items.join("")}</channel></rss>`, report };
}

export function buildSitemap(products: Iterable<StoredProduct>, origin: string, path = "/sitemap.xml") {
  const pages: Array<{ path: string; updated?: string; image?: string }> = publicPages.map((page) => ({ path: page }));
  for (const product of products) if (product.status === "ACTIVE" && !isSampleProduct(product) && product.variants.some((variant) => variant.active)) {
    pages.push({ path: `/product/${encodeURIComponent(product.slug)}`, updated: product.updatedAt, image: publicHttpUrl(imageFor(product), origin) });
  }
  const totalPages = Math.ceil(pages.length / sitemapPageSize);
  if (path === "/sitemap.xml" && totalPages > 1) return `<?xml version="1.0" encoding="UTF-8"?><sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${Array.from({ length: totalPages }, (_, index) => `<sitemap><loc>${escapeXml(`${origin}/sitemap-${index + 1}.xml`)}</loc></sitemap>`).join("")}</sitemapindex>`;
  const match = path.match(/^\/sitemap-(\d+)\.xml$/);
  const pageNumber = match ? Number(match[1]) : 1;
  if (pageNumber < 1 || pageNumber > totalPages || (path !== "/sitemap.xml" && !match)) return undefined;
  return `<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:image="http://www.google.com/schemas/sitemap-image/1.1">${pages.slice((pageNumber - 1) * sitemapPageSize, pageNumber * sitemapPageSize).map((page) => {
    const updated = page.updated && new Date(page.updated);
    return `<url><loc>${escapeXml(origin + page.path)}</loc>${updated && Number.isFinite(updated.getTime()) ? `<lastmod>${updated.toISOString()}</lastmod>` : ""}${page.image ? `<image:image><image:loc>${escapeXml(page.image)}</image:loc></image:image>` : ""}</url>`;
  }).join("")}</urlset>`;
}

export function buildRobots(origin: string) {
  // Public login/cart pages remain crawlable so crawlers can read their noindex tags.
  return `User-agent: *\nAllow: /\nDisallow: /api/\nDisallow: /webhooks/\nDisallow: /admin/\nDisallow: /account/\nDisallow: /transaction/\nSitemap: ${origin}/sitemap.xml\n`;
}
