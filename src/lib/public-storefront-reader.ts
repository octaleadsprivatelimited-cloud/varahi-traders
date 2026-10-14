import type { StorefrontConfig } from "./storefront-config";

const readerKey = Symbol.for("varahi.publicStorefrontReader");
type Reader = (hostname?: string) => Promise<StorefrontConfig>;
export async function readPublicStorefront(hostname?: string): Promise<StorefrontConfig | null> {
  const reader = (globalThis as unknown as Record<symbol, Reader | undefined>)[readerKey];
  try {
    if (reader) return await reader(hostname);
    const origin = `http://127.0.0.1:${process.env.COMMERCE_API_PORT || process.env.PORT || "4010"}`;
    const response = await fetch(`${origin}/api/v1/storefront/config`, { signal: AbortSignal.timeout(3000) });
    if (!response.ok) return null;
    return ((await response.json()) as { data: StorefrontConfig }).data;
  } catch { return null; }
}
