import type { StoreProduct } from "./store-products";

// Hostinger runs the public API and SSR in one process. Read the public DTOs
// directly: a request to the externally reachable app need not have loopback HTTP.
const readerKey = Symbol.for("varahi.publicCatalogReader");
type CatalogReader = () => StoreProduct[];
const inProcessReader = () => (globalThis as unknown as Record<symbol, CatalogReader | undefined>)[readerKey];
const apiOrigin = () => `http://127.0.0.1:${process.env.COMMERCE_API_PORT || process.env.PORT || "4010"}`;

/** The HTTP fallback is for Vite development with its separate API process. */
export async function readPublicCatalog(): Promise<StoreProduct[]> {
  const reader = inProcessReader();
  if (reader) return reader();
  const response = await fetch(`${apiOrigin()}/api/v1/products`, { signal: AbortSignal.timeout(10000) });
  if (!response.ok) throw new Error("The catalog could not be loaded. Please try again.");
  const { data } = await response.json() as { data: StoreProduct[] };
  return data;
}

export async function readPublicProduct(id: string): Promise<StoreProduct | null> {
  const reader = inProcessReader();
  if (reader) {
    const products = reader();
    return products.find((product) => product.id === id) || products.find((product) => product.slug === id) || null;
  }
  const response = await fetch(`${apiOrigin()}/api/v1/products/${encodeURIComponent(id)}`, { signal: AbortSignal.timeout(10000) });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error("The product could not be loaded. Please try again.");
  const { data } = await response.json() as { data: StoreProduct };
  return data;
}
