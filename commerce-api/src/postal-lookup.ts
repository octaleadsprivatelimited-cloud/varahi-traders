import { AppError } from "./errors.js";

type PostalArea = { name: string; district: string; state: string };
export type PostalLocation = { postalCode: string; country: "IN"; city: string; state: string; areas: PostalArea[] };
const text = (value: unknown, limit = 100) => typeof value === "string" && value.trim().length <= limit ? value.trim() : "";

/** Fixed upstreams receive only a public PIN code, never customer details. */
export function createPostalLookup(request: typeof fetch = fetch) {
  const cache = new Map<string, { expires: number; value: PostalLocation | null }>();
  const pending = new Map<string, Promise<PostalLocation>>();
  let primaryBackoff = 0;
  return async function lookup(postalCode: string): Promise<PostalLocation> {
    if (!/^[1-9]\d{5}$/.test(postalCode)) throw new AppError(400, "INVALID_PIN_CODE", "Enter a valid 6-digit Indian PIN code");
    const cached = cache.get(postalCode);
    if (cached && cached.expires > Date.now()) {
      if (cached.value) return cached.value;
      throw new AppError(404, "PIN_CODE_NOT_FOUND", "PIN code not found. Check the digits or enter your city and state manually.");
    }
    const existing = pending.get(postalCode); if (existing) return existing;
    const task = (async () => {
      let foundMissing = false;
      const providers = [
        { url: `https://api.pincodeapi.in/api/v1/pincode/${postalCode}`, primary: true },
        { url: `https://api.postalpincode.in/pincode/${postalCode}`, primary: false },
      ];
      for (const provider of providers) {
        if (provider.primary && primaryBackoff > Date.now()) continue;
        try {
          const response = await request(provider.url, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(3500), redirect: "error" });
          if (response.status === 429 && provider.primary) primaryBackoff = Date.now() + 30_000;
          if (response.status === 404) { foundMissing = true; continue; }
          if (!response.ok) continue;
          const data = await response.json();
          const records = provider.primary ? data?.data?.post_offices : data?.[0]?.PostOffice;
          if (!Array.isArray(records)) {
            if ((!provider.primary && data?.[0]?.Status === "Error") || (provider.primary && data?.success === false)) foundMissing = true;
            continue;
          }
          const areas: PostalArea[] = records.slice(0, 200).flatMap((record: Record<string, unknown>) => {
            if (String(record.pincode || record.Pincode || "") !== postalCode) return [];
            const name = text(record.office_name || record.Name, 120), district = text(record.district || record.District), state = text(record.state || record.State);
            return name && district && state ? [{ name, district, state }] : [];
          });
          if (!areas.length) { if (!records.length) foundMissing = true; continue; }
          const unique = [...new Map(areas.map(area => [`${area.name}:${area.district}:${area.state}`, area])).values()];
          const cities = new Set(unique.map(area => area.district)), states = new Set(unique.map(area => area.state));
          const value: PostalLocation = { postalCode, country: "IN", city: cities.size === 1 ? unique[0]!.district : "", state: states.size === 1 ? unique[0]!.state : "", areas: unique };
          if (cache.size >= 2000) cache.delete(cache.keys().next().value!);
          cache.set(postalCode, { expires: Date.now() + 86_400_000, value });
          return value;
        } catch { /* Try the other fixed provider; manual address entry remains available. */ }
      }
      if (foundMissing) {
        if (cache.size >= 2000) cache.delete(cache.keys().next().value!);
        cache.set(postalCode, { expires: Date.now() + 300_000, value: null });
        throw new AppError(404, "PIN_CODE_NOT_FOUND", "PIN code not found. Check the digits or enter your city and state manually.");
      }
      throw new AppError(503, "PIN_LOOKUP_UNAVAILABLE", "Automatic lookup is unavailable. Enter your city and state manually.");
    })();
    pending.set(postalCode, task);
    try { return await task; } finally { pending.delete(postalCode); }
  };
}
