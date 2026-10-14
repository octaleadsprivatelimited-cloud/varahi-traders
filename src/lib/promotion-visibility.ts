export function canShowOfferOnPath(pathname: string) {
  return pathname === "/" || pathname === "/shop" || /^\/product\/[^/]+\/?$/.test(pathname);
}

export function popupFrequencyAllows(frequency: "ONCE" | "DAILY" | "EVERY_VISIT", seen: string | null, now = Date.now()) {
  if (frequency === "EVERY_VISIT" || !seen) return true;
  if (frequency === "ONCE") return false;
  const timestamp = Number(seen);
  return !Number.isFinite(timestamp) || now - timestamp >= 86400000;
}
