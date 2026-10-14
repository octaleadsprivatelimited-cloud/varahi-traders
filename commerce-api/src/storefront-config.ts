import { z } from "zod";
import { additionalAnnouncement } from "./delivery-policy.js";

const optionalUrl = z.union([
  z.string().url().max(1000).refine(value => /^https?:\/\//i.test(value), "Use an HTTP or HTTPS image URL"),
  z.string().regex(/^\/(?!\/).*/).max(1000),
  z.literal(""),
]);

export const storefrontConfigSchema = z.object({
  storeName: z.string().trim().min(2).max(100),
  legalName: z.string().trim().max(160).default(""),
  businessGstin: z.union([z.string().trim().toUpperCase().regex(/^\d{2}[A-Z]{5}\d{4}[A-Z][A-Z\d]Z[A-Z\d]$/),z.literal("")]).default(""),
  businessAddress: z.string().trim().max(500).default(""),
  logoUrl: optionalUrl.default(""),
  footerLogoUrl: optionalUrl.default(""),
  faviconUrl: optionalUrl.default(""),
  fssaiLicense: z.union([z.string().regex(/^\d{14}$/), z.literal("")]).default(""),
  analyticsPromptEnabled: z.boolean().default(false),
  primaryColor: z.string().regex(/^#[0-9a-fA-F]{6}$/),
  accentColor: z.string().regex(/^#[0-9a-fA-F]{6}$/),
  backgroundColor: z.string().regex(/^#[0-9a-fA-F]{6}$/),
  currency: z.string().regex(/^[A-Z]{3}$/),
  locale: z.string().regex(/^[a-z]{2,3}(?:-[A-Z]{2})?$/),
  supportEmail: z.union([z.string().email().max(254), z.literal("")]).default(""),
  supportPhone: z.string().trim().max(30).default(""),
  freeShippingThreshold: z.number().min(0).max(100000000).multipleOf(0.01).default(999),
  manualDeliveryEnabled: z.boolean().default(false),
  codEnabled: z.boolean().default(true),
  onlinePaymentDiscountEnabled: z.boolean().default(false),
  onlinePaymentDiscountType: z.enum(["PERCENTAGE", "FIXED_AMOUNT"]).default("PERCENTAGE"),
  onlinePaymentDiscountValue: z.number().min(0).max(100000).multipleOf(0.01).default(0),
  deliveryCharge: z.number().min(0).max(100000).multipleOf(0.01).default(59),
  deliveryMinDays: z.number().int().min(1).max(60).default(3),
  deliveryMaxDays: z.number().int().min(1).max(60).default(6),
  announcement: z.string().trim().max(180).default("").transform(additionalAnnouncement),
  footerTagline: z.string().trim().max(240).default(""),
  seoTitle: z.string().trim().max(70).default(""),
  seoDescription: z.string().trim().max(170).default(""),
  primaryDomain: z.string().trim().toLowerCase().max(253).refine(value => !value || /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(value), "Enter a valid hostname").default(""),
}).refine(value => value.deliveryMaxDays >= value.deliveryMinDays, { path: ["deliveryMaxDays"], message: "Latest delivery day must be on or after the earliest day" })
  .refine(value => value.onlinePaymentDiscountType !== "PERCENTAGE" || value.onlinePaymentDiscountValue <= 100, { path: ["onlinePaymentDiscountValue"], message: "Percentage discount cannot exceed 100%" });

export type StorefrontConfig = z.infer<typeof storefrontConfigSchema>;

export const defaultStorefrontConfig: StorefrontConfig = {
  storeName: "Sri Varahi Traders", legalName: "", businessGstin:"", businessAddress:"", logoUrl: "/favicon.svg", footerLogoUrl: "", faviconUrl: "/favicon.svg", fssaiLicense: "", analyticsPromptEnabled: false,
  primaryColor: "#173f2b", accentColor: "#dc6b32", backgroundColor: "#fbf7ec",
  currency: "INR", locale: "en-IN", supportEmail: "",
  supportPhone: "", freeShippingThreshold: 999, manualDeliveryEnabled: false, deliveryCharge: 59, deliveryMinDays: 3, deliveryMaxDays: 6, announcement: "",
  codEnabled: true, onlinePaymentDiscountEnabled: false, onlinePaymentDiscountType: "PERCENTAGE", onlinePaymentDiscountValue: 0,
  footerTagline: "Cold-pressed oils for everyday Indian kitchens.", seoTitle: "Sri Varahi Traders | Cold Pressed Oils",
  seoDescription: "Explore cold-pressed groundnut, sesame, coconut and cooking oils from Sri Varahi Traders.", primaryDomain: "",
};

export function normalizeHostname(value: string | undefined) {
  const hostname = ((value || "localhost").split(",")[0] || "localhost").trim().toLowerCase().replace(/:\d+$/, "");
  return /^(?:[a-z0-9-]+\.)*[a-z0-9-]+$/.test(hostname) ? hostname : "localhost";
}

export function storefrontSettingKey(hostname: string) {
  return `storefront:${normalizeHostname(hostname)}`;
}
