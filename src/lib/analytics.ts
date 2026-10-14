import { commerceApi } from "./commerce-api";

export type AnalyticsItem = {
  item_id: string;
  item_name: string;
  item_category?: string;
  item_variant?: string;
  price: number;
  quantity: number;
};
export type AnalyticsPayload = {
  items?: AnalyticsItem[];
  value?: number;
  currency?: string;
  transaction_id?: string;
  shipping?: number;
  tax?: number;
  payment_type?: string;
  shipping_tier?: string;
  item_list_name?: string;
};
export type AnalyticsConsent = { analytics: boolean; advertising: boolean; updatedAt: number; version: 1 };
export type AnalyticsConfig = { ga4MeasurementId?: string; metaPixelId?: string; clarityProjectId?: string };
type Command = (...args: unknown[]) => void;
type QueuedCommand = Command & { queue?: unknown[][]; q?: unknown[][]; callMethod?: Command; push?: Command; loaded?: boolean; version?: string };
type AnalyticsWindow = Window & { dataLayer?: unknown[]; gtag?: Command; fbq?: QueuedCommand; _fbq?: QueuedCommand; clarity?: QueuedCommand; [key: `ga-disable-${string}`]: boolean };
const CONSENT_KEY = "varahi_tracking_consent_v1";
const PURCHASE_KEY = "varahi_analytics_purchases_v1";
const CONSENT_AGE = 180 * 24 * 60 * 60 * 1000;
const eventNames = new Set(["view_item_list", "select_item", "view_item", "add_to_cart", "remove_from_cart", "view_cart", "begin_checkout", "add_shipping_info", "add_payment_info", "purchase", "add_to_wishlist"]);
let config: AnalyticsConfig = {};
let configPromise: Promise<void> | undefined;
let gaReady = false;
let metaReady = false;
let clarityReady = false;
let clarityStopped = false;
let guarded = false;
let previousPage = "";
let lastPage = "";
const sentEvents = new Set<string>();
const browser = () => window as unknown as AnalyticsWindow;

export function readAnalyticsConsent(): AnalyticsConsent | null {
  if (typeof window === "undefined") return null;
  try {
    const value = JSON.parse(localStorage.getItem(CONSENT_KEY) || "null");
    if (value?.version === 1 && typeof value.analytics === "boolean" && typeof value.advertising === "boolean" && Number.isFinite(value.updatedAt) && value.updatedAt <= Date.now() && Date.now() - value.updatedAt < CONSENT_AGE) return value;
  } catch { /* Unavailable browser storage means optional tracking stays disabled. */ }
  return null;
}

export function openAnalyticsPreferences() {
  if (typeof window !== "undefined") window.dispatchEvent(new Event("varahi:analytics-preferences"));
}

function expireProviderCookies() {
  const domains = ["", window.location.hostname, `.${window.location.hostname}`, `.${window.location.hostname.split(".").slice(-2).join(".")}`];
  for (const cookie of document.cookie.split(";")) {
    const name = cookie.trim().split("=")[0];
    if (!/^(_ga(?:_|$)|_gid$|_gat|_fbp$|_fbc$|_clck$|_clsk$)/.test(name)) continue;
    for (const domain of domains) document.cookie = `${name}=; Max-Age=0; Path=/; SameSite=Lax${domain ? `; Domain=${domain}` : ""}`;
  }
}

export function saveAnalyticsConsent(value: { analytics: boolean; advertising: boolean }) {
  const previous = readAnalyticsConsent();
  const next: AnalyticsConsent = { ...value, updatedAt: Date.now(), version: 1 };
  try { localStorage.setItem(CONSENT_KEY, JSON.stringify(next)); } catch { return false; }
  const revoked = (previous?.analytics && !next.analytics) || (previous?.advertising && !next.advertising);
  if (revoked) {
    stopAnalytics();
    expireProviderCookies();
    // Unload SDK observers and timers as well as stopping explicit events.
    // Script tag removal alone cannot stop an already executed third-party SDK.
    window.location.reload();
  } else {
    lastPage = "";
    syncAnalyticsPage();
  }
  window.dispatchEvent(new Event("varahi:analytics-consent"));
  return true;
}

/** Only known storefront paths can be sent. Unknown/private route strings are never exported. */
export function analyticsPath(pathname: string): string | null {
  const path = pathname.replace(/\/+$/, "") || "/";
  if (["/", "/shop", "/cart", "/checkout", "/privacy", "/terms", "/shipping-returns", "/contact"].includes(path)) return path;
  if (/^\/product\/[a-zA-Z0-9][a-zA-Z0-9_-]{0,119}$/.test(path)) return path;
  return null;
}

function safeUrl() {
  const path = analyticsPath(window.location.pathname);
  return path ? `${window.location.origin}${path}` : "";
}
function passiveTrackingAllowed(url = new URL(window.location.href)) {
  if (!analyticsPath(url.pathname) || url.search || url.hash || url.pathname === "/checkout") return false;
  // SDKs can read document.referrer themselves, so do not load recording/pixel
  // scripts in a document whose referrer can contain account/payment details.
  if (document.referrer) {
    try {
      const referrer = new URL(document.referrer);
      if (referrer.search || referrer.hash || (referrer.origin === url.origin && !analyticsPath(referrer.pathname))) return false;
    } catch { return false; }
  }
  return true;
}
function metaAllowed(url = new URL(window.location.href)) {
  // The pixel automatically attaches the current URL. Never expose query/hash
  // values, including a payment-return query, even in custom ecommerce events.
  return Boolean(analyticsPath(url.pathname)) && !url.search && !url.hash && (!document.referrer || passiveTrackingAllowed(new URL(`${url.origin}/`)));
}
function addScript(id: string, src: string) {
  if (document.getElementById(id)) return;
  const script = document.createElement("script");
  script.id = id; script.async = true; script.src = src; script.referrerPolicy = "no-referrer";
  document.head.appendChild(script);
}
function optionalCommand(command: Command | undefined, ...args: unknown[]) {
  try { command?.(...args); } catch { /* Optional providers must never interrupt navigation. */ }
}
function stopClarity() {
  if (clarityReady && !clarityStopped) {
    optionalCommand(browser().clarity, "stop");
    clarityStopped = true;
  }
}
export function stopAnalytics() {
  if (typeof window === "undefined") return;
  if (config.ga4MeasurementId) browser()[`ga-disable-${config.ga4MeasurementId}`] = true;
  optionalCommand(browser().fbq, "consent", "revoke");
  stopClarity();
}
function beforeLocationChange(value: string | URL | null | undefined) {
  const target = new URL(String(value || window.location.href), window.location.href);
  if (!analyticsPath(target.pathname)) stopAnalytics();
  if (!passiveTrackingAllowed(target)) stopClarity();
  if (!metaAllowed(target)) optionalCommand(browser().fbq, "consent", "revoke");
  if (gaReady) optionalCommand(browser().gtag, "set", { page_location: analyticsPath(target.pathname) ? `${target.origin}${analyticsPath(target.pathname)}` : `${target.origin}/`, page_referrer: "" });
}
function installNavigationGuard() {
  if (guarded) return;
  guarded = true;
  // Runs synchronously before history changes and before private route rendering.
  for (const method of ["pushState", "replaceState"] as const) {
    const original = window.history[method].bind(window.history);
    window.history[method] = (data: unknown, unused: string, url?: string | URL | null) => {
      beforeLocationChange(url);
      original(data, unused, url);
    };
  }
  window.addEventListener("popstate", () => beforeLocationChange(window.location.href), true);
  window.addEventListener("hashchange", () => beforeLocationChange(window.location.href), true);
  window.addEventListener("storage", (event) => {
    if (event.key === CONSENT_KEY) { stopAnalytics(); window.location.reload(); }
  });
}
export function prepareAnalyticsNavigation(href: string) { if (typeof window !== "undefined") beforeLocationChange(href); }

export async function initializeAnalytics() {
  if (typeof window === "undefined") return;
  installNavigationGuard();
  if (!configPromise) configPromise = commerceApi<AnalyticsConfig>("/api/v1/storefront/analytics").then((value) => {
    // Validate even the public endpoint response before constructing script URLs.
    config = {
      ga4MeasurementId: /^G-[A-Z0-9]{4,20}$/.test(value.ga4MeasurementId || "") ? value.ga4MeasurementId : undefined,
      metaPixelId: /^\d{5,25}$/.test(value.metaPixelId || "") ? value.metaPixelId : undefined,
      clarityProjectId: /^[a-z0-9]{5,20}$/.test(value.clarityProjectId || "") ? value.clarityProjectId : undefined,
    };
    syncAnalyticsPage();
  }).catch(() => { /* Storefront remains usable if analytics configuration is unavailable. */ });
  await configPromise;
}
function startProviders() {
  const consent = readAnalyticsConsent();
  if (!consent || !analyticsPath(window.location.pathname)) { stopAnalytics(); return; }
  const win = browser();
  if (consent.analytics && config.ga4MeasurementId) {
    win[`ga-disable-${config.ga4MeasurementId}`] = false;
    if (!gaReady) {
      win.dataLayer ||= [];
      // gtag's documented command queue uses Arguments, not an event object.
      // eslint-disable-next-line prefer-rest-params -- the provider expects its documented Arguments queue.
      win.gtag = function () { win.dataLayer!.push(arguments); };
      win.gtag("consent", "default", { analytics_storage: "granted", ad_storage: "denied", ad_user_data: "denied", ad_personalization: "denied" });
      win.gtag("js", new Date());
      win.gtag("set", { allow_google_signals: false, allow_ad_personalization_signals: false, ads_data_redaction: true, url_passthrough: false });
      win.gtag("config", config.ga4MeasurementId, { send_page_view: false, page_location: safeUrl(), page_referrer: "", page_title: "Sri Varahi Traders", allow_google_signals: false, allow_ad_personalization_signals: false });
      addScript("varahi-ga4", `https://www.googletagmanager.com/gtag/js?id=${config.ga4MeasurementId}`);
      gaReady = true;
    }
  }
  if (consent.advertising && config.metaPixelId && metaAllowed()) {
    if (!metaReady) {
      const fbq: QueuedCommand = (...args: unknown[]) => { if (fbq.callMethod) fbq.callMethod(...args); else fbq.queue!.push(args); };
      fbq.queue = []; fbq.push = fbq; fbq.loaded = true; fbq.version = "2.0";
      win.fbq = fbq; win._fbq = fbq;
      fbq("set", "autoConfig", false, config.metaPixelId);
      fbq("init", config.metaPixelId);
      fbq("consent", "grant");
      addScript("varahi-meta-pixel", "https://connect.facebook.net/en_US/fbevents.js");
      metaReady = true;
    } else win.fbq?.("consent", "grant");
  }
  if (consent.analytics && config.clarityProjectId && passiveTrackingAllowed() && !clarityReady && !clarityStopped) {
    // Mask the whole document before the SDK can observe text or customer UI.
    document.body.setAttribute("data-clarity-mask", "true");
    const clarity: QueuedCommand = (...args: unknown[]) => { clarity.q!.push(args); };
    clarity.q = [];
    win.clarity = clarity;
    clarity("consentv2", { analytics_Storage: "granted", ad_Storage: "denied" });
    addScript("varahi-clarity", `https://www.clarity.ms/tag/${config.clarityProjectId}`);
    clarityReady = true;
  }
}
export function syncAnalyticsPage() {
  try { syncPage(); } catch { /* Tracking cannot make a storefront page fail. */ }
}
function syncPage() {
  if (typeof window === "undefined") return;
  startProviders();
  const consent = readAnalyticsConsent();
  const page = safeUrl();
  if (!consent || !page) { lastPage = ""; previousPage = ""; return; }
  const pageKey = `${page}:${Boolean(consent.analytics && gaReady)}:${Boolean(consent.advertising && metaReady && metaAllowed())}`;
  if (lastPage === pageKey) return;
  if (consent.analytics && gaReady) browser().gtag?.("event", "page_view", { page_location: page, page_referrer: previousPage, page_title: `Sri Varahi Traders | ${analyticsPath(window.location.pathname)}`, send_to: config.ga4MeasurementId });
  if (consent.advertising && metaReady && metaAllowed()) browser().fbq?.("trackSingle", config.metaPixelId, "PageView");
  lastPage = pageKey;
  previousPage = page;
}
function safeText(value: unknown, max = 100) {
  if (typeof value !== "string") return undefined;
  const text = value.trim();
  if (!text || text.length > max || /[@<>\r\n]|https?:|\b\d{10,}\b|(?:token|password|secret)=/i.test(text)) return undefined;
  return text;
}
export function sanitizeAnalyticsPayload(input: AnalyticsPayload): AnalyticsPayload {
  const payload: AnalyticsPayload = {};
  if (input.items) payload.items = input.items.slice(0, 100).flatMap((item) => {
    const item_id = safeText(item.item_id), item_name = safeText(item.item_name);
    if (!item_id || !item_name || !Number.isFinite(item.price) || item.price < 0 || !Number.isInteger(item.quantity) || item.quantity < 1 || item.quantity > 10000) return [];
    return [{ item_id, item_name, price: item.price, quantity: item.quantity, ...(safeText(item.item_category) ? { item_category: safeText(item.item_category) } : {}), ...(safeText(item.item_variant) ? { item_variant: safeText(item.item_variant) } : {}) }];
  });
  for (const key of ["value", "shipping", "tax"] as const) if (typeof input[key] === "number" && Number.isFinite(input[key]) && input[key]! >= 0) payload[key] = input[key];
  if (input.currency === "INR") payload.currency = "INR";
  if (typeof input.transaction_id === "string" && /^[a-zA-Z0-9_-]{1,80}$/.test(input.transaction_id)) payload.transaction_id = input.transaction_id;
  for (const key of ["payment_type", "shipping_tier", "item_list_name"] as const) if (safeText(input[key], 60)) payload[key] = safeText(input[key], 60);
  return payload;
}
function alreadySent(key: string, persistent: boolean) {
  if (sentEvents.has(key)) return true;
  if (persistent) {
    try { return (JSON.parse(localStorage.getItem(PURCHASE_KEY) || "[]") as string[]).includes(key); } catch { return false; }
  }
  return false;
}
function rememberSent(key: string, persistent: boolean) {
  sentEvents.add(key);
  if (persistent) {
    try {
      const existing = JSON.parse(localStorage.getItem(PURCHASE_KEY) || "[]");
      localStorage.setItem(PURCHASE_KEY, JSON.stringify([...(Array.isArray(existing) ? existing : []), key].slice(-250)));
    } catch { /* The in-memory guard still prevents duplicates this page load. */ }
  }
}
export function trackCommerceEvent(name: string, input: AnalyticsPayload, options?: { dedupeKey?: string }): boolean {
  try { return dispatchCommerceEvent(name, input, options); } catch { return false; }
}
function dispatchCommerceEvent(name: string, input: AnalyticsPayload, options?: { dedupeKey?: string }): boolean {
  if (typeof window === "undefined" || !eventNames.has(name) || !analyticsPath(window.location.pathname)) return false;
  const consent = readAnalyticsConsent();
  if (!consent || (!consent.analytics && !consent.advertising)) return false;
  startProviders();
  const payload = sanitizeAnalyticsPayload(input);
  if (name === "purchase" && (!payload.transaction_id || !payload.items?.length || payload.value === undefined || payload.currency !== "INR")) return false;
  const persistent = name === "purchase";
  const dedupe = persistent ? payload.transaction_id : options?.dedupeKey;
  let sent = false;
  if (consent.analytics && gaReady) {
    const key = `ga4:${config.ga4MeasurementId}:${name}:${dedupe}`;
    if (!dedupe || !alreadySent(key, persistent)) {
      browser().gtag?.("event", name, { ...payload, page_location: safeUrl(), page_referrer: "", page_title: "Sri Varahi Traders", send_to: config.ga4MeasurementId });
      if (dedupe) rememberSent(key, persistent);
      sent = true;
    }
  }
  const metaNames: Record<string, string> = { view_item: "ViewContent", add_to_cart: "AddToCart", add_to_wishlist: "AddToWishlist", begin_checkout: "InitiateCheckout", add_payment_info: "AddPaymentInfo", purchase: "Purchase" };
  if (consent.advertising && metaReady && metaAllowed() && metaNames[name]) {
    const key = `meta:${config.metaPixelId}:${name}:${dedupe}`;
    if (!dedupe || !alreadySent(key, persistent)) {
      const event = { content_type: "product", content_ids: payload.items?.map(item => item.item_id), contents: payload.items?.map(item => ({ id: item.item_id, quantity: item.quantity, item_price: item.price })), num_items: payload.items?.reduce((sum, item) => sum + item.quantity, 0), currency: payload.currency, value: payload.value };
      browser().fbq?.("trackSingle", config.metaPixelId, metaNames[name], event, payload.transaction_id ? { eventID: payload.transaction_id } : undefined);
      if (dedupe) rememberSent(key, persistent);
      sent = true;
    }
  }
  return sent;
}
