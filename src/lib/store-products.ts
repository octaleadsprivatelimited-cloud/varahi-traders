import { useEffect, useSyncExternalStore } from "react";
import {
  type Product,
  type VariantOption,
} from "@/data/commerce";
import { commerceApi } from "./commerce-api";

export type StoreProduct = {
  id: string;
  slug: string;
  name: string;
  category: string;
  taxRate?: number;
  description?: string;
  brand?: string;
  specifications?: Record<string, string>;
  seoTitle?: string;
  seoDescription?: string;
  status: "DRAFT" | "ACTIVE" | "ARCHIVED";
  media?: Array<{
    url: string;
    alt: string;
    type: "IMAGE" | "VIDEO";
    position: number;
    variantId?: string;
  }>;
  variants: Array<{
    id: string;
    sku: string;
    title?: string;
    price: number;
    mrp: number;
    stock: number;
    reserved?: number;
    attributes: Record<string, string>;
  }>;
};

const tones = ["#d7c5ac", "#c4c7b6", "#a5a28f", "#b9aaa0", "#d4c9b9", "#8d9288"];
const glyphs = ["◒", "◐", "▰", "◉", "◕", "◇"];

export function mapProduct(item: StoreProduct, index: number): Product {
  const available = [...item.variants].sort((left, right) => Number(left.price) - Number(right.price) || (left.title || "").localeCompare(right.title || "")).map((entry) => ({
    ...entry,
    available: Math.max(0, entry.stock - (entry.reserved || 0)),
  }));
  const variant = available.find((entry) => entry.available > 0) || available[0];
  const optionValues = new Map<string, Set<string>>();
  available.forEach((entry) =>
    Object.entries(entry.attributes).forEach(([name, value]) => {
      if (!optionValues.has(name)) optionValues.set(name, new Set());
      optionValues.get(name)!.add(value);
    }),
  );
  const options: VariantOption[] = [...optionValues].map(([name, values]) => ({
    name,
    values: [...values],
  }));
  const images =
    item.media
      ?.filter((media) => media.type === "IMAGE")
      .sort((a, b) => a.position - b.position) || [];
  const image = images.find((media) => !media.variantId) || images[0];
  return {
    id: item.id,
    slug: item.slug,
    name: item.name,
    category: item.category,
    taxRate: item.taxRate || 0,
    price: variant?.price || 0,
    mrp: variant?.mrp || variant?.price || 0,

    badge: available.some((entry) => entry.available > 0) ? undefined : "Sold out",
    tone: tones[index % tones.length]!,
    glyph: glyphs[index % glyphs.length]!,
    image: image?.url,
    imageAlt: image?.alt || item.name,
    images: images.map(({ url, alt }) => ({ url, alt: alt || item.name })),
    description: item.description,
    brand: item.brand,
    specifications: item.specifications,
    seoTitle: item.seoTitle,
    seoDescription: item.seoDescription,
    options,
    variants: available.map((entry) => {
      const variantImage = images.find((media) => media.variantId === entry.id);
      return {
        id: entry.id,
        sku: entry.sku,
        title: entry.title,
        options: entry.attributes,
        price: entry.price,
        mrp: entry.mrp,
        stock: entry.available,
        image: variantImage?.url || image?.url,
        imageAlt: variantImage?.alt || image?.alt || item.name,
      };
    }),
  };
}

const emptyCatalog: Product[] = [];
let catalog: Product[] = emptyCatalog;
let catalogLoaded = false;
let catalogRequest: Promise<void> | undefined;
const catalogListeners = new Set<() => void>();
const catalogChangeKey = "varahi_commerce_catalog_changed_at";
let catalogRefreshTimer: number | undefined;

function loadCatalog() {
  if (catalogRequest) return catalogRequest;
  catalogRequest = commerceApi<StoreProduct[]>("/api/v1/products")
    .then((products) => {
      catalog = products.map(mapProduct);
      catalogLoaded = true;
      catalogListeners.forEach((listener) => listener());
    })
    .catch(() => undefined)
    .finally(() => {
      catalogRequest = undefined;
    });
  return catalogRequest;
}

function refreshOnFocus() {
  void loadCatalog();
}

function refreshFromAnotherTab(event: StorageEvent) {
  if (event.key === catalogChangeKey) void loadCatalog();
}

/** Refresh every mounted storefront consumer after an admin catalog mutation. */
export function notifyStoreCatalogChanged() {
  void loadCatalog();
  if (typeof window !== "undefined") {
    localStorage.setItem(catalogChangeKey, String(Date.now()));
  }
}

function subscribe(listener: () => void) {
  catalogListeners.add(listener);
  void loadCatalog();
  if (typeof window !== "undefined" && catalogListeners.size === 1) {
    window.addEventListener("focus", refreshOnFocus);
    window.addEventListener("storage", refreshFromAnotherTab);
    catalogRefreshTimer = window.setInterval(() => void loadCatalog(), 30_000);
  }
  return () => {
    catalogListeners.delete(listener);
    if (typeof window !== "undefined" && catalogListeners.size === 0) {
      window.removeEventListener("focus", refreshOnFocus);
      window.removeEventListener("storage", refreshFromAnotherTab);
      if (catalogRefreshTimer !== undefined) window.clearInterval(catalogRefreshTimer);
      catalogRefreshTimer = undefined;
    }
  };
}

/** The live catalog snapshot also keeps cart mutations independent of hook timing. */
export function getStoreProductsSnapshot() {
  return catalog;
}

export function useStoreProducts(initialProducts?: Product[]) {
  useEffect(() => {
    if (!catalogLoaded && initialProducts) {
      catalog = initialProducts;
      catalogLoaded = true;
      catalogListeners.forEach((listener) => listener());
    }
  }, [initialProducts]);
  return useSyncExternalStore(
    subscribe,
    () => catalogLoaded ? catalog : initialProducts || emptyCatalog,
    () => initialProducts || emptyCatalog,
  );
}
