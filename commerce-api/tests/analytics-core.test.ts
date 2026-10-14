import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("../../src/lib/commerce-api", () => ({ commerceApi: vi.fn(async () => ({ ga4MeasurementId: "G-TEST1234", metaPixelId: "123456789", clarityProjectId: "abc12345" })) }));
const analyticsModule = "../../src/lib/analytics.ts";
const consentKey = "varahi_tracking_consent_v1";
let storage: Map<string, string>;
let scripts: Array<Record<string, unknown>>;
let win: any;
let doc: any;
const grant = (analytics = true, advertising = true) => storage.set(consentKey, JSON.stringify({ version: 1, analytics, advertising, updatedAt: Date.now() }));
const commands = () => (win.dataLayer || []).map((args: IArguments) => Array.from(args));
const purchase = { transaction_id: "RUC-2026001", value: 99, currency: "INR", shipping: 15, tax: 5, items: [{ item_id: "variant_123", item_name: "Turmeric powder", price: 99, quantity: 1 }] };
beforeEach(() => {
  vi.resetModules();
  storage = new Map(); scripts = [];
  const localStorage = { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value), removeItem: (key: string) => storage.delete(key) };
  win = { location: Object.assign(new URL("https://srivarahitraders.example/shop"), { reload: vi.fn() }), addEventListener: vi.fn(), dispatchEvent: vi.fn(), history: { pushState: vi.fn((_data, _unused, url) => { win.location = Object.assign(new URL(String(url), win.location.href), { reload: vi.fn() }); }), replaceState: vi.fn() } };
  doc = { referrer: "", cookie: "", getElementById: (id: string) => scripts.find(script => script.id === id), createElement: () => ({}), head: { appendChild: (script: Record<string, unknown>) => scripts.push(script) }, body: { setAttribute: vi.fn() } };
  vi.stubGlobal("window", win); vi.stubGlobal("document", doc); vi.stubGlobal("localStorage", localStorage);
});
afterEach(() => vi.unstubAllGlobals());
describe("consent-aware analytics delivery", () => {
  it("loads no provider script and never replays a denied commerce event", async () => {
    const analytics = await import(analyticsModule);
    await analytics.initializeAnalytics();
    expect(scripts).toHaveLength(0);
    expect(analytics.trackCommerceEvent("add_to_cart", purchase)).toBe(false);
    grant(); analytics.syncAnalyticsPage();
    expect(scripts).toHaveLength(3);
    expect(commands().filter((item: unknown[]) => item[1] === "add_to_cart")).toHaveLength(0);
    expect(commands().filter((item: unknown[]) => item[1] === "page_view")).toHaveLength(1);
    analytics.syncAnalyticsPage();
    expect(commands().filter((item: unknown[]) => item[1] === "page_view")).toHaveLength(1);
  });
  it("separates analytics and advertising consent and never enables Google ad storage", async () => {
    grant(true, false);
    const analytics = await import(analyticsModule); await analytics.initializeAnalytics();
    expect(scripts.map(script => script.id)).toEqual(["varahi-ga4", "varahi-clarity"]);
    expect(commands().find((item: unknown[]) => item[0] === "consent")?.[2]).toMatchObject({ ad_storage: "denied", ad_user_data: "denied", analytics_storage: "granted" });
    expect(doc.body.setAttribute).toHaveBeenCalledWith("data-clarity-mask", "true");
  });
  it("does not load on private routes or emit private-route commerce events", async () => {
    grant(); win.location.pathname = "/account";
    const analytics = await import(analyticsModule); await analytics.initializeAnalytics();
    expect(scripts).toHaveLength(0);
    expect(analytics.trackCommerceEvent("purchase", purchase)).toBe(false);
    for (const path of ["/admin", "/admin/orders", "/login", "/track", "/account", "/transaction/FW-123", "/unknown/customer-email"]) expect(analytics.analyticsPath(path)).toBeNull();
  });
  it("stops recordings and pixel before a private history transition", async () => {
    grant(); const analytics = await import(analyticsModule); await analytics.initializeAnalytics();
    const original = win.history.pushState;
    original({}, "", "/account");
    expect(win["ga-disable-G-TEST1234"]).toBe(true);
    expect(win.clarity.q).toContainEqual(["stop"]);
    expect(win.fbq.queue).toContainEqual(["consent", "revoke"]);
    analytics.syncAnalyticsPage();
    expect(analytics.trackCommerceEvent("view_cart", purchase)).toBe(false);
    expect(commands().filter((item: unknown[]) => item[1] === "page_view")).toHaveLength(1);
  });
  it("scrubs URL queries and never records checkout or exposes payment-return parameters to Pixel", async () => {
    grant(); win.location = Object.assign(new URL("https://srivarahitraders.example/checkout?order=private&email=customer@example.com#secret"), { reload: vi.fn() });
    const analytics = await import(analyticsModule); await analytics.initializeAnalytics();
    expect(scripts.map(script => script.id)).toEqual(["varahi-ga4"]);
    analytics.trackCommerceEvent("purchase", purchase);
    expect(JSON.stringify(commands())).not.toMatch(/customer@example|private|#secret/);
    expect(commands().filter((item: unknown[]) => item[1] === "purchase")[0][2]).toMatchObject({ page_location: "https://srivarahitraders.example/checkout" });
  });
  it("deduplicates confirmed purchases per provider across reloads, while late ad consent can send its first purchase", async () => {
    grant(true, false); let analytics = await import(analyticsModule); await analytics.initializeAnalytics();
    expect(analytics.trackCommerceEvent("purchase", purchase)).toBe(true);
    expect(analytics.trackCommerceEvent("purchase", purchase)).toBe(false);
    grant(true, true); analytics.syncAnalyticsPage();
    expect(analytics.trackCommerceEvent("purchase", purchase)).toBe(true);
    expect(commands().filter((item: unknown[]) => item[1] === "purchase")).toHaveLength(1);
    expect(win.fbq.queue.filter((item: unknown[]) => item[2] === "Purchase")).toHaveLength(1);
    vi.resetModules(); analytics = await import(analyticsModule); await analytics.initializeAnalytics();
    expect(analytics.trackCommerceEvent("purchase", purchase)).toBe(false);
  });
  it("revocation disables SDKs, clears their cookies and reloads to discard observers", async () => {
    grant(); const analytics = await import(analyticsModule); await analytics.initializeAnalytics();
    doc.cookie = "_ga=existing; _fbp=existing; cart=essential";
    analytics.saveAnalyticsConsent({ analytics: false, advertising: false });
    expect(win["ga-disable-G-TEST1234"]).toBe(true);
    expect(win.location.reload).toHaveBeenCalledOnce();
    expect(win.clarity.q).toContainEqual(["stop"]);
    expect(analytics.trackCommerceEvent("add_to_cart", purchase)).toBe(false);
    expect(doc.cookie).toMatch(/_fbp=; Max-Age=0/);
  });
  it("ignores forged/expired consent and strips unapproved or personal payload fields", async () => {
    const analytics = await import(analyticsModule);
    storage.set(consentKey, JSON.stringify({ version: 1, analytics: true, advertising: true, updatedAt: 1 }));
    expect(analytics.readAnalyticsConsent()).toBeNull();
    const result = analytics.sanitizeAnalyticsPayload({ ...purchase, value: Number.NaN, email: "private@example.com", address: "private address", items: [{ ...purchase.items[0], email: "private@example.com", price: 1.234567 }] } as any);
    expect(result.items?.[0].price).toBe(1.234567);
    expect(result).not.toHaveProperty("value");
    expect(JSON.stringify(result)).not.toContain("private");
    expect(analytics.sanitizeAnalyticsPayload({ item_list_name: "customer@example.com", items: [{ ...purchase.items[0], item_name: "customer@example.com" }] })).toEqual({ items: [] });
  });
  it("does not let a third-party SDK failure break successful checkout", async () => {
    grant(); const analytics = await import(analyticsModule); await analytics.initializeAnalytics();
    win.gtag = () => { throw new Error("Blocked third-party SDK"); };
    expect(() => analytics.trackCommerceEvent("purchase", purchase)).not.toThrow();
    expect(analytics.trackCommerceEvent("purchase", purchase)).toBe(false);
  });
});
