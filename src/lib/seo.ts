import { productPath } from "./product-url";
import type { Product, Variant } from "@/data/commerce";
import { priceIncludingTax } from "./catalog-price";

export const storeOrigin = import.meta.env.VITE_PUBLIC_SITE_URL || "http://localhost:5180";
const absoluteUrl = (path: string) => new URL(path, storeOrigin).href;
const jsonLd = (value: unknown) => JSON.stringify(value).replace(/</g, "\\u003c");

const isSampleProduct = (product: Product) => Object.entries(product.specifications || {}).some(([key, value]) =>
  key.trim().toLowerCase().replace(/\s+/g, " ") === "catalog purpose" && value.trim().toLowerCase() === "sample",
);

export function pageSeo(path: string, title: string, description: string) {
  const url = absoluteUrl(path);
  return {
    meta: [
      { title }, { name: "description", content: description },
      { property: "og:title", content: title }, { property: "og:description", content: description },
      { property: "og:type", content: "website" }, { property: "og:url", content: url },
      { property: "og:site_name", content: "Sri Varahi Traders" }, { property: "og:locale", content: "en_IN" },
      { name: "twitter:card", content: "summary" },
    ],
    links: [{ rel: "canonical", href: url }],
  };
}

export function productSeo(product: Product) {
  const path = productPath(product);
  const description = product.seoDescription || product.description?.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").slice(0, 160) || `Explore ${product.name} at Sri Varahi Traders. Compare available pack sizes, current prices and delivery options.`;
  const title = product.seoTitle || `${product.name} | Buy Online | Sri Varahi Traders`;
  const head = pageSeo(path, title, description);
  if (isSampleProduct(product)) {
    const sampleHead = pageSeo(path, `${product.name} | Sample Preview | Sri Varahi Traders`, description);
    return {
      ...sampleHead,
      meta: [...sampleHead.meta, { name: "robots", content: "noindex, follow" }],
      scripts: [],
    };
  }
  const brand = product.brand ? { "@type": "Brand", name: product.brand } : undefined;
  const variants = product.variants || [];
  const variantSchema = (variant: Variant) => ({
    "@type": "Product", "@id": `${absoluteUrl(path)}#${encodeURIComponent(variant.id)}`,
    name: [product.name, variant.title].filter(Boolean).join(" — "),
    description: product.description, sku: variant.sku || variant.id,
    image: variant.image ? absoluteUrl(variant.image) : undefined,
    brand, inProductGroupWithID: product.id,
    size: variant.options.Weight || variant.options.Size || variant.title,
    offers: {
      "@type": "Offer", url: `${absoluteUrl(path)}?variant=${encodeURIComponent(variant.id)}`,
      priceCurrency: "INR", price: priceIncludingTax(variant.price, product.taxRate).toFixed(2),
      availability: variant.stock > 0 ? "https://schema.org/InStock" : "https://schema.org/OutOfStock",
      itemCondition: "https://schema.org/NewCondition",
      seller: { "@type": "Organization", name: "Sri Varahi Traders", url: storeOrigin },
    },
  });
  const productData = variants.length > 1 ? {
    "@context": "https://schema.org", "@type": "ProductGroup", "@id": absoluteUrl(path),
    name: product.name, description: product.description, url: absoluteUrl(path),
    image: product.image ? absoluteUrl(product.image) : undefined,
    brand, productGroupID: product.id, variesBy: ["https://schema.org/size"],
    hasVariant: variants.map(variantSchema),
  } : variants[0] ? { "@context": "https://schema.org", ...variantSchema(variants[0]) } : undefined;
  const breadcrumbs = {
    "@context": "https://schema.org", "@type": "BreadcrumbList",
    itemListElement: [
      { "@type": "ListItem", position: 1, name: "Sri Varahi Traders", item: storeOrigin },
      { "@type": "ListItem", position: 2, name: "Shop oils", item: absoluteUrl("/shop") },
      { "@type": "ListItem", position: 3, name: product.name, item: absoluteUrl(path) },
    ],
  };
  return {
    ...head,
    meta: [...head.meta, ...(product.image ? [{ property: "og:image", content: absoluteUrl(product.image) }] : [])],
    scripts: [{ type: "application/ld+json", children: jsonLd([...(productData ? [productData] : []), breadcrumbs]) }],
  };
}

export const storeStructuredData = {
  type: "application/ld+json",
  children: jsonLd([
    { "@context": "https://schema.org", "@type": "Organization", "@id": `${storeOrigin}/#organization`, name: "Sri Varahi Traders", url: storeOrigin },
    { "@context": "https://schema.org", "@type": "WebSite", "@id": `${storeOrigin}/#website`, name: "Sri Varahi Traders", url: storeOrigin, inLanguage: "en-IN", publisher: { "@id": `${storeOrigin}/#organization` } },
  ]),
};
