import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { Link } from "@tanstack/react-router";
import { commerceApi } from "./commerce-api";

export type StorefrontConfig = {
  storeName: string; legalName: string; businessGstin: string; businessAddress: string;
  logoUrl: string; footerLogoUrl: string; faviconUrl: string; fssaiLicense: string;
  analyticsPromptEnabled: boolean; assetCleanupPending?: boolean;
  primaryColor: string; accentColor: string; backgroundColor: string;
  currency: string; locale: string; supportEmail: string; supportPhone: string;
  freeShippingThreshold: number; announcement: string; footerTagline: string;
  manualDeliveryEnabled: boolean; deliveryCharge: number; deliveryMinDays: number; deliveryMaxDays: number; settingsLoaded?: boolean;
  codEnabled: boolean; onlinePaymentDiscountEnabled: boolean; onlinePaymentDiscountType: "PERCENTAGE" | "FIXED_AMOUNT"; onlinePaymentDiscountValue: number;
  seoTitle: string; seoDescription: string; primaryDomain: string;
};
export const defaultStorefrontConfig: StorefrontConfig = {
  storeName: "Sri Varahi Traders", legalName: "", businessGstin: "", businessAddress: "",
  logoUrl: "/favicon.svg", footerLogoUrl: "", faviconUrl: "/favicon.svg", fssaiLicense: "",
  analyticsPromptEnabled: false, primaryColor: "#173f2b", accentColor: "#dc6b32", backgroundColor: "#fbf7ec",
  currency: "INR", locale: "en-IN", supportEmail: "", supportPhone: "",
  freeShippingThreshold: 999, manualDeliveryEnabled: false, deliveryCharge: 59, deliveryMinDays: 3, deliveryMaxDays: 6, announcement: "",
  codEnabled: true, onlinePaymentDiscountEnabled: false, onlinePaymentDiscountType: "PERCENTAGE", onlinePaymentDiscountValue: 0,
  footerTagline: "Cold-pressed oils for everyday Indian kitchens.",
  seoTitle: "Sri Varahi Traders | Cold Pressed Oils",
  seoDescription: "Explore cold-pressed groundnut, sesame, coconut and cooking oils from Sri Varahi Traders.",
  primaryDomain: "",
};
const StorefrontContext = createContext(defaultStorefrontConfig);
const StorefrontProviderContext = createContext(false);
export const storefrontUpdatedEvent = "varahi_commerce:storefront-updated";
export function publishStorefrontConfig(value: StorefrontConfig) {
  window.dispatchEvent(new CustomEvent(storefrontUpdatedEvent, { detail: value }));
  try { localStorage.setItem("varahi_commerce_storefront_revision", crypto.randomUUID()); } catch { /* Focus and periodic refresh still work when storage is unavailable. */ }
}
export function StorefrontProvider({ children, initialConfig }: { children: ReactNode; initialConfig?: StorefrontConfig | null }) {
  const [config, setConfig] = useState<StorefrontConfig>(() => ({ ...defaultStorefrontConfig, ...initialConfig, settingsLoaded: Boolean(initialConfig) }));
  useEffect(() => {
    let active = true, sequence = 0;
    const load = async () => {
      const request = ++sequence;
      try {
        const value = await commerceApi<StorefrontConfig>("/api/v1/storefront/config");
        if (active && request === sequence) setConfig({ ...defaultStorefrontConfig, ...value, settingsLoaded: true });
      } catch { /* Keep the last published settings during temporary failures. */ }
    };
    const updated = (event: Event) => {
      ++sequence;
      setConfig({ ...defaultStorefrontConfig, ...(event as CustomEvent<StorefrontConfig>).detail, settingsLoaded: true });
    };
    void load();
    window.addEventListener("focus", load);
    window.addEventListener(storefrontUpdatedEvent, updated);
    const storage = (event: StorageEvent) => { if (event.key === "varahi_commerce_storefront_revision") void load(); };
    window.addEventListener("storage", storage);
    const refresh = setInterval(() => { if (document.visibilityState === "visible") void load(); }, 30_000);
    return () => { active = false; clearInterval(refresh); window.removeEventListener("storage", storage); window.removeEventListener("focus", load); window.removeEventListener(storefrontUpdatedEvent, updated); };
  }, [initialConfig]);
  useEffect(() => {
    const root = document.documentElement;
    root.style.setProperty("--store-primary", config.primaryColor);
    root.style.setProperty("--store-accent", config.accentColor);
    root.style.setProperty("--store-background", config.backgroundColor);
    root.lang = config.locale;
    for (const rel of ["icon", "apple-touch-icon"]) {
      const icon = document.querySelector<HTMLLinkElement>(`link[rel="${rel}"]`);
      icon?.setAttribute("href", config.faviconUrl || "/favicon.svg");
      icon?.removeAttribute("type");
    }
    document.querySelector('meta[name="theme-color"]')?.setAttribute("content", config.primaryColor);
  }, [config]);
  return <StorefrontProviderContext.Provider value={true}><StorefrontContext.Provider value={config}>{children}</StorefrontContext.Provider></StorefrontProviderContext.Provider>;
}
export const useStorefrontConfig = () => useContext(StorefrontContext);
export const useHasStorefrontProvider = () => useContext(StorefrontProviderContext);
export function StoreBrand({ footer = false }: { footer?: boolean }) {
  const config = useStorefrontConfig();
  const url = footer ? config.footerLogoUrl || config.logoUrl : config.logoUrl;
  const initials = config.storeName.split(/\s+/).map(part => part[0]).join("").slice(0, 2).toUpperCase();
  return <Link to="/" className={`brand${footer ? " footer-brand" : ""}`}>
    {url ? <img key={url} src={url} alt={config.storeName} /> : <i>{initials}</i>}
    <span>{config.storeName}</span>
  </Link>;
}
