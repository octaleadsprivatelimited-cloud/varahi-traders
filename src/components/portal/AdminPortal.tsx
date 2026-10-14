import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Activity,
  AlertTriangle,
  ArrowDownRight,
  ArrowUpRight,
  BarChart3,
  Box,
  ChevronRight,
  CircleDollarSign,
  Code2,
  CreditCard,
  ExternalLink,
  FileText,
  Globe2,
  LayoutDashboard,
  LifeBuoy,
  MoreHorizontal,
  Package,
  Plus,
  RefreshCw,
  RotateCcw,
  Save,
  Search,
  Settings,
  ShieldCheck,
  ShoppingCart,
  Truck,
  Users,
  Zap,
} from "lucide-react";
import { PortalShell } from "./PortalShell";
import { AdminCouponsWorkspace } from "./AdminCouponsWorkspace";
import { money } from "@/data/commerce";
import { CommerceApiError, commerceApi, sessionExpiredEvent } from "@/lib/commerce-api";
import {
  hasPortalPermission,
  loadPortalSession,
  logoutPortalSession,
  type PortalSession,
} from "@/lib/portal-auth";
import { toast, Toaster } from "sonner";
import { Navigate, useLocation, useNavigate } from "@tanstack/react-router";
import { defaultStorefrontConfig, publishStorefrontConfig, type StorefrontConfig } from "@/lib/storefront-config";
import { BrandingSettingsForm, brandingFields, type BrandingKind } from "./BrandingSettingsForm";
import { AdminPromotionsWorkspace } from "./AdminPromotionsWorkspace";
import { AdminInventoryWorkspace, AdminProductsWorkspace } from "./AdminProductsWorkspace";
import { AdminIntegrationsWorkspace } from "./AdminIntegrationsWorkspace";
import { AdminAcquisitionPanel } from "./AdminAcquisitionPanel";
import {
  AdminCustomerOperations,
  type CustomerOperationsTab,
} from "./customer-ops";

const navDefinitions: Array<[string, React.ReactNode, string[]]> = [
  ["Overview", <LayoutDashboard />, []],
  ["Products", <Package />, ["products:read", "products:create", "products:update"]],
  ["Orders", <ShoppingCart />, ["orders:read", "orders:update"]],
  ["Customers", <Users />, ["customers:read", "customers:update"]],
  ["Returns", <RotateCcw />, ["returns:read", "returns:update"]],
  ["Support", <LifeBuoy />, ["support:read", "support:update"]],
  ["Inventory", <Box />, ["inventory:read", "inventory:update"]],
  ["Payments", <CreditCard />, ["payments:read", "orders:refund"]],
  ["Shipping", <Truck />, ["shipping:create", "orders:read"]],
  ["Marketing", <Zap />, ["marketing:update"]],
  ["Analytics", <BarChart3 />, ["analytics:read"]],
  ["Integrations", <Code2 />, ["settings:read", "settings:update"]],
  ["Settings", <Settings />, ["settings:read", "settings:update"]],
];

type AdminAnalytics = {
  revenue: number;
  orders: number;
  averageOrderValue: number;
  customers: number;
  failedOrders: number;
  refunds: number;
};

type InventoryCountResponse = {
  items: unknown[];
  pagination: { total: number };
};

function Dashboard({
  onNavigate,
  can,
}: {
  onNavigate: (tab: string) => void;
  can: (...permissions: string[]) => boolean;
}) {
  const [analytics, setAnalytics] = useState<AdminAnalytics | null>(null);
  const [orders, setOrders] = useState<AdminOrdersResponse | null>(null);
  const [lowStock, setLowStock] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const [analyticsResult, ordersResult, inventoryResult] = await Promise.all([
        can("analytics:read")
          ? commerceApi<AdminAnalytics>("/api/v1/admin/analytics")
          : Promise.resolve(null),
        can("orders:read")
          ? commerceApi<AdminOrdersResponse>("/api/v1/admin/orders?page=1&pageSize=5")
          : Promise.resolve(null),
        can("inventory:read")
          ? commerceApi<InventoryCountResponse>(
              "/api/v1/admin/inventory?page=1&limit=1&lowStock=true",
            )
          : Promise.resolve(null),
      ]);
      setAnalytics(analyticsResult);
      setOrders(ordersResult);
      setLowStock(inventoryResult?.pagination.total ?? null);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Dashboard data could not be loaded");
    } finally {
      setLoading(false);
    }
  }, [can]);

  useEffect(() => {
    void load();
  }, [load]);

  const summary = orders?.summary;
  const metrics: Array<[string, string, string, boolean, React.ReactNode]> = [
    ["Revenue", money(analytics?.revenue ?? summary?.orderValue ?? 0), "Completed orders", true, <CircleDollarSign />],
    ["Orders", String(analytics?.orders ?? summary?.totalOrders ?? 0), `${summary?.activeCount ?? 0} active`, true, <ShoppingCart />],
    ["Customers", String(analytics?.customers ?? 0), "Registered customers", true, <Users />],
    ["Low stock", lowStock === null ? "—" : `${lowStock} items`, "Available at threshold", lowStock === 0, <AlertTriangle />],
  ];
  const actions: Array<[React.ReactNode, string, string, string]> = [
    [<Plus />, "Add a product", "Create products and variants", "Products"],
    [<FileText />, "Review orders", `${summary?.activeCount ?? 0} active orders`, "Orders"],
    [<RefreshCw />, "Manage inventory", `${lowStock ?? 0} low-stock SKUs`, "Inventory"],
    [<ExternalLink />, "View storefront", "Open the customer site", "storefront"],
  ];

  return (
    <>
      {error && (
        <p className="settings-error" role="alert">
          <AlertTriangle /> {error}
          <button type="button" onClick={() => void load()}>Try again</button>
        </p>
      )}
      <div className="metric-grid">
        {metrics.map(([l, v, d, up, icon]) => (
          <article className="metric" key={String(l)}>
            <div>
              <span>{icon}</span>
              <small>{loading ? "Loading…" : "Live"}</small>
            </div>
            <p>{l}</p>
            <h3>{v}</h3>
            <em className={up ? "up" : "down"}>
              {up ? <ArrowUpRight /> : <ArrowDownRight />}
              {d}
            </em>
          </article>
        ))}
      </div>
      <div className="admin-grid">
        <section className="panel sales-panel">
          <div className="panel-head">
            <div>
              <h2>Revenue overview</h2>
              <p>Authoritative commerce totals</p>
            </div>
            <button type="button" onClick={() => void load()} disabled={loading}>
              <RefreshCw className={loading ? "spin" : undefined} /> Refresh
            </button>
          </div>
          <div className="sales-total">
            <span>
              <b>{money(analytics?.revenue ?? summary?.orderValue ?? 0)}</b>
              <small>Total revenue</small>
            </span>
            <span>
              <b>{analytics?.orders ?? summary?.totalOrders ?? 0}</b>
              <small>Orders</small>
            </span>
            <span>
              <b>{money(analytics?.averageOrderValue ?? 0)}</b>
              <small>Avg. order</small>
            </span>
          </div>
          <div className="live-breakdown">
            <span><b>{summary?.activeCount ?? 0}</b><small>Active orders</small></span>
            <span><b>{summary?.readyToShip ?? 0}</b><small>Ready to ship</small></span>
            <span><b>{analytics?.failedOrders ?? 0}</b><small>Failed orders</small></span>
            <span><b>{analytics?.refunds ?? 0}</b><small>Refunded orders</small></span>
          </div>
        </section>
        <section className="panel actions">
          <div className="panel-head">
            <div>
              <h2>Quick actions</h2>
              <p>Common store tasks</p>
            </div>
          </div>
          {actions.map(([i, t, s, destination]) => (
            <button
              key={String(t)}
              type="button"
              onClick={() => destination === "storefront" ? window.location.assign("/") : onNavigate(destination)}
              disabled={destination !== "storefront" && !navDefinitions.some(([label]) => label === destination)}
            >
              {i}
              <span>
                <b>{t}</b>
                <small>{s}</small>
              </span>
              <ChevronRight />
            </button>
          ))}
        </section>
      </div>
      <Orders rows={orders?.items ?? []} onViewAll={() => onNavigate("Orders")} />
    </>
  );
}
function Orders({ rows, onViewAll }: { rows: AdminOrderDTO[]; onViewAll: () => void }) {
  return (
    <section className="panel orders">
      <div className="panel-head">
        <div>
          <h2>Recent orders</h2>
          <p>Latest activity across your store</p>
        </div>
          <button type="button" onClick={onViewAll}>
            View all <ChevronRight />
        </button>
      </div>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Order</th>
              <th>Customer</th>
              <th>Product / variant</th>
              <th>Total</th>
              <th>Payment</th>
              <th>Fulfilment</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {rows.length ? rows.map((order) => {
              const line = order.lineItems[0];
              return (
                <tr key={order.id}>
                  <td>{order.number}</td>
                  <td>{order.customer?.name || order.customer?.email || "Guest"}</td>
                  <td>{line ? `${line.name || line.sku || "Product"}${line.quantity > 1 ? ` × ${line.quantity}` : ""}` : "—"}</td>
                  <td>{money(order.totals.total)}</td>
                  <td className="status-cell"><span className={`status ${String(order.payment?.status || "pending").toLowerCase()}`}>{order.payment?.status || "Pending"}</span></td>
                  <td className="status-cell"><span className={`status ${order.status.toLowerCase()}`}>{order.status.replaceAll("_", " ")}</span></td>
                  <td><button type="button" aria-label={`Open ${order.number}`} onClick={onViewAll}><MoreHorizontal /></button></td>
                </tr>
              );
            }) : (
              <tr><td colSpan={7}>No orders have been placed yet.</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function WhiteLabelSettings() {
  const [form, setForm] = useState<StorefrontConfig>(defaultStorefrontConfig);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [authRequired, setAuthRequired] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [loadAttempt, setLoadAttempt] = useState(0);
  const formRef = useRef(form);
  const editVersionRef = useRef(0);

  useEffect(() => {
    setLoading(true); setError(""); setAuthRequired(false);
    commerceApi<StorefrontConfig>("/api/v1/admin/storefront-config")
      .then((saved) => {
        formRef.current = saved;
        setForm(saved);
        setLoaded(true);
      })
      .catch((reason) => {
        if (reason instanceof CommerceApiError && reason.status === 401) setAuthRequired(true);
        setError(
          reason instanceof Error
            ? reason.message
            : "Settings could not be loaded",
        );
      })
      .finally(() => setLoading(false));
  }, [loadAttempt]);

  const updateForm = (patch: Partial<StorefrontConfig>) => {
    editVersionRef.current += 1;
    setForm((current) => {
      const next = { ...current, ...patch };
      formRef.current = next;
      return next;
    });
  };

  const save = async (successMessage: string) => {
    const snapshot = formRef.current;
    const submittedVersion = editVersionRef.current;
    setSaving(true);
    setError("");
    try {
      const saved = await commerceApi<StorefrontConfig>(
        "/api/v1/admin/storefront-config",
        { method: "PUT", body: JSON.stringify(snapshot) },
      );

      // Keep edits made while the request was in flight instead of replacing
      // them with the older server response. The next save will publish them.
      if (editVersionRef.current === submittedVersion) {
        formRef.current = saved;
        setForm(saved);
      }
      publishStorefrontConfig(saved);
      if (saved.assetCleanupPending) toast.warning("Settings saved. Previous upload cleanup is pending; publish again to retry.");
      toast.success(successMessage);
    } catch (reason) {
      const message =
        reason instanceof Error
          ? reason.message
          : "Settings could not be saved";
      setError(message);
      toast.error(message);
    } finally {
      setSaving(false);
    }
  };

  const uploadBranding = async (kind: BrandingKind, file: File) => {
    if (file.size > 10 * 1024 * 1024) { toast.error("Image must be 10 MB or smaller"); return; }
    setSaving(true);
    setError("");
    try {
      const body = new FormData();
      body.append("image", file);
      const saved = await commerceApi<StorefrontConfig>(`/api/v1/admin/storefront-config/assets/${kind}`, { method: "POST", body });
      updateForm({ [brandingFields[kind]]: saved[brandingFields[kind]] });
      publishStorefrontConfig(saved);
      if (saved.assetCleanupPending) toast.warning("Logo published. Previous upload cleanup is pending; publish settings again to retry.");
      else toast.success("Image published. Unused previous uploads removed.");
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : "Logo could not be uploaded";
      setError(message); toast.error(message);
    } finally { setSaving(false); }
  };

  if (loading) {
    return (
      <div className="module-empty">
        <RefreshCw />
        <h3>Loading store configuration…</h3>
      </div>
    );
  }

  if (authRequired) {
    return (
      <div className="module-empty">
        <ShieldCheck />
        <h3>Administrator sign-in required</h3>
        <p>{error}</p>
        <a className="primary" href="/login">
          Sign in
        </a>
      </div>
    );
  }
  if (!loaded) return <div className="module-empty"><AlertTriangle /><h3>Settings could not be loaded</h3><p>{error}</p><button className="primary" onClick={() => setLoadAttempt(value => value + 1)}>Try again</button></div>;

  return (
    <>
      <section className="panel form-panel" id="delivery-rules">
        <div className="panel-head"><div><h2>Checkout &amp; delivery</h2><p>One delivery policy for the top bar, product pages, bag and checkout</p></div></div>
        <label className="website-setting-switch"><input type="checkbox" role="switch" checked={form.manualDeliveryEnabled} onChange={event => updateForm({ manualDeliveryEnabled: event.target.checked })} /><span><b>Use fixed delivery charges</b><small>Arrange dispatch yourself. Checkout also needs at least one available payment method.</small></span></label>
        <div className="form-row">
          <label>Delivery charge (₹)<input type="number" min="0" max="100000" step="0.01" value={form.deliveryCharge} onChange={event => updateForm({ deliveryCharge: Number(event.target.value) })} /></label>
          <label>Free delivery from (₹)<input type="number" min="0" max="100000000" step="0.01" value={form.freeShippingThreshold} onChange={event => updateForm({ freeShippingThreshold: Number(event.target.value) })} /></label>
        </div>
        <div className="form-row">
          <label>Earliest delivery (business days)<input type="number" min="1" max="60" value={form.deliveryMinDays} onChange={event => updateForm({ deliveryMinDays: Number(event.target.value) })} /></label>
          <label>Latest delivery (business days)<input type="number" min="1" max="60" value={form.deliveryMaxDays} onChange={event => updateForm({ deliveryMaxDays: Number(event.target.value) })} /></label>
        </div>
        <p className="delivery-rules-help">The free-delivery threshold applies to the item subtotal before GST. Set the threshold or delivery charge to 0 for free delivery on every order. Saving replaces the active policy; already placed orders keep their confirmed charges.</p>
        <button className="primary" type="button" disabled={saving || !Number.isFinite(form.deliveryCharge) || form.deliveryMaxDays < form.deliveryMinDays} onClick={() => void save("Delivery pricing and checkout availability updated")}><Save />{saving ? "Saving…" : "Save delivery settings"}</button>
      </section>
      <section className="panel form-panel" id="payment-rules">
        <div className="panel-head"><div><h2>Payments &amp; online offers</h2><p>Choose payment methods and optionally reward customers who pay online</p></div></div>
        <label className="website-setting-switch"><input type="checkbox" role="switch" checked={form.codEnabled} onChange={event => updateForm({ codEnabled: event.target.checked })} /><span><b>Enable cash on delivery</b><small>Switch off to accept online payments only. If no live online provider is configured, checkout stays closed.</small></span></label>
        <label className="website-setting-switch"><input type="checkbox" role="switch" checked={form.onlinePaymentDiscountEnabled} onChange={event => updateForm({ onlinePaymentDiscountEnabled: event.target.checked })} /><span><b>Enable online-payment discount</b><small>Optional. Cash-on-delivery orders never receive this offer.</small></span></label>
        <div className="form-row">
          <label>Online discount format<select value={form.onlinePaymentDiscountType} onChange={event => updateForm({ onlinePaymentDiscountType: event.target.value as StorefrontConfig["onlinePaymentDiscountType"], onlinePaymentDiscountValue: 0 })}><option value="PERCENTAGE">Percentage (%)</option><option value="FIXED_AMOUNT">Fixed amount (₹)</option></select></label>
          <label>{form.onlinePaymentDiscountType === "PERCENTAGE" ? "Online discount (%)" : "Online discount (₹)"}<input type="number" min="0" max={form.onlinePaymentDiscountType === "PERCENTAGE" ? 100 : 100000} step="0.01" value={form.onlinePaymentDiscountValue} onChange={event => updateForm({ onlinePaymentDiscountValue: Number(event.target.value) })} /></label>
        </div>
        <p className="delivery-rules-help">{form.onlinePaymentDiscountEnabled && form.onlinePaymentDiscountValue > 0 ? `Offer: ${form.onlinePaymentDiscountType === "PERCENTAGE" ? `${form.onlinePaymentDiscountValue}%` : money(form.onlinePaymentDiscountValue)} off when paying online.` : "No online discount is active."} The offer applies to the item subtotal after coupons, excluding GST and delivery, and is capped at the remaining item value with at least ₹1 payable online. Set 0 or switch it off to remove the offer. Saving replaces the active offer; existing orders keep their confirmed totals.</p>
        <button className="primary" type="button" disabled={saving || !Number.isFinite(form.onlinePaymentDiscountValue) || form.onlinePaymentDiscountValue < 0 || form.onlinePaymentDiscountValue > (form.onlinePaymentDiscountType === "PERCENTAGE" ? 100 : 100000)} onClick={() => void save("Payment methods and online offer updated")}><Save />{saving ? "Saving…" : "Save payment settings"}</button>
      </section>
      <BrandingSettingsForm
        form={form}
        error={error}
        saving={saving}
        onChange={updateForm}
        onSave={() => void save("White-label storefront updated")}
        onUpload={uploadBranding}
      />
      <section className="panel form-panel invoice-identity">
        <div className="panel-head">
          <div>
            <h2>Invoice identity</h2>
            <p>Business details printed on order documents</p>
          </div>
        </div>
        <div className="form-row">
          <label>
            Business GSTIN
            <input
              value={form.businessGstin}
              onChange={(event) =>
                updateForm({
                  businessGstin: event.target.value.toUpperCase(),
                })
              }
              maxLength={15}
              placeholder="36AAAAA0000A1Z5"
            />
          </label>
        </div>
        <label>
          Registered business address
          <textarea
            value={form.businessAddress}
            onChange={(event) =>
              updateForm({ businessAddress: event.target.value })
            }
          />
        </label>
        <button
          className="primary"
          onClick={() => void save("Invoice and checkout settings saved")}
          disabled={saving}
        >
          <Save />
          {saving ? "Saving…" : "Save invoice details"}
        </button>
      </section>
    </>
  );
}

function MarketingWorkspace() {
  const location = useLocation();
  const [view, setView] = useState<"coupons" | "campaigns">(() => new URLSearchParams(location.searchStr).get("view") === "campaigns" ? "campaigns" : "coupons");
  return <div><div className="marketing-tabs" role="tablist"><button role="tab" aria-selected={view === "coupons"} className={view === "coupons" ? "active" : ""} onClick={() => setView("coupons")}>Coupons</button><button role="tab" aria-selected={view === "campaigns"} className={view === "campaigns" ? "active" : ""} onClick={() => setView("campaigns")}>Banners &amp; popups</button></div>{view === "coupons" ? <AdminCouponsWorkspace /> : <AdminPromotionsWorkspace />}</div>;
}

export function AdminPortal() {
  const [session, setSession] = useState<PortalSession | null>(null);
  const [sessionState, setSessionState] = useState<"checking" | "allowed" | "denied" | "signin" | "customer">("checking");
  const [sessionError, setSessionError] = useState("");
  const [signingOut, setSigningOut] = useState(false);
  const location = useLocation();
  const navigate = useNavigate();

  useEffect(() => {
    let active = true;
    const sessionExpired = () => {
      active = false;
      setSession(null);
      setSessionState("signin");
    };
    window.addEventListener(sessionExpiredEvent, sessionExpired);
    loadPortalSession()
      .then((value) => {
        if (!active) return;
        if (value.role === "CUSTOMER") {
          setSessionState("customer");
          return;
        }
        setSession(value);
        setSessionState("allowed");
      })
      .catch((reason) => {
        if (!active) return;
        if (reason instanceof CommerceApiError && reason.status === 401) {
          setSessionState("signin");
          return;
        }
        setSessionError(
          reason instanceof Error ? reason.message : "Administrator sign-in is required.",
        );
        setSessionState("denied");
      });
    return () => {
      active = false;
      window.removeEventListener(sessionExpiredEvent, sessionExpired);
    };
  }, []);

  const can = (...permissions: string[]) =>
    Boolean(session && hasPortalPermission(session, ...permissions));
  const availableNav = useMemo(
    () =>
      session
        ? navDefinitions
            .filter(([, , permissions]) =>
              permissions.length ? hasPortalPermission(session, ...permissions) : true,
            )
            .map(([label, icon]) => [label, icon] as [string, React.ReactNode])
        : [],
    [session],
  );
  const requestedSection = location.pathname.startsWith("/admin/")
    ? location.pathname.slice(7).replace(/\/$/, "")
    : new URLSearchParams(location.searchStr).get("tab")?.toLowerCase().replaceAll(" ", "-") || "overview";
  const active = availableNav.find(([label]) => label.toLowerCase().replaceAll(" ", "-") === requestedSection)?.[0]
    ?? availableNav[0]?.[0] ?? "Overview";
  const handleNavigate = (label: string) => {
    void navigate({
      to: "/admin/$section",
      params: { section: label.toLowerCase().replaceAll(" ", "-") },
    });
  };
  const signOut = async () => {
    setSigningOut(true);
    try {
      await logoutPortalSession();
      window.location.assign("/login");
    } catch (reason) {
      toast.error(reason instanceof Error ? reason.message : "Sign out failed");
      setSigningOut(false);
    }
  };

  if (sessionState === "signin") return <Navigate to="/login" replace />;
  if (sessionState === "customer") return <Navigate to="/account" replace />;
  if (sessionState === "checking")
    return (
      <div className="portal-access" role="status" aria-live="polite">
        <RefreshCw className="spin" />
        <h1>Checking administrator access…</h1>
        <p>Verifying your secure session and permissions.</p>
      </div>
    );
  if (sessionState === "denied" || !session)
    return (
      <div className="portal-access">
        <ShieldCheck />
        <h1>Administrator sign-in required</h1>
        <p>{sessionError || "Sign in with an authorized staff account to continue."}</p>
        <a className="primary" href="/login">Sign in securely</a>
      </div>
    );

  const customerOperations = ["Customers", "Returns", "Support"].includes(active);
  return (
    <>
      <Toaster position="bottom-right" richColors />
      <PortalShell
        title={active === "Overview" ? `Welcome, ${session.name.split(/\s+/)[0]}` : active}
        subtitle={
          active === "Overview"
            ? "Here’s what’s happening with your store today."
            : active === "Products"
              ? "Manage catalog, product types, pricing and variants."
              : active === "Integrations"
                ? "Connect and secure every external service."
                : customerOperations
                  ? "Serve customers with live, connected store records."
                : "Manage your commerce operations."
        }
        nav={availableNav}
        active={active}
        onNavigate={handleNavigate}
        userName={session.name}
        userRole={session.role.replaceAll("_", " ").toLowerCase()}
        onLogout={() => void signOut()}
        signingOut={signingOut}
      >
        {active === "Products" ? (
          <AdminProductsWorkspace />
        ) : active === "Integrations" ? (
          <AdminIntegrationsWorkspace />
        ) : active === "Overview" ? (
          <Dashboard onNavigate={handleNavigate} can={can} />
        ) : active === "Settings" ? (
          <WhiteLabelSettings />
        ) : active === "Marketing" ? (
          <MarketingWorkspace />
        ) : active === "Orders" ? (
          <AdminOrdersPanel />
        ) : active === "Inventory" ? (
          <AdminInventoryWorkspace />
        ) : customerOperations ? (
          <AdminCustomerOperations module={active as CustomerOperationsTab} />
        ) : (
          <ModuleView module={active} onNavigate={handleNavigate} />
        )}
      </PortalShell>
    </>
  );
}

type AdminOrderContact = {
  id?: string | null;
  name?: string | null;
  email?: string | null;
  phone?: string | null;
};

type AdminOrderAddress = {
  line1?: string | null;
  line2?: string | null;
  city?: string | null;
  state?: string | null;
  postalCode?: string | null;
  country?: string | null;
  gstin?: string | null;
};

type AdminOrderRefund = {
  id?: string;
  amount?: number;
  status?: string;
  reason?: string;
  reference?: string | null;
  createdAt?: string;
};

type AdminOrderDTO = {
  id: string;
  number: string;
  status: string;
  createdAt?: string;
  customer: AdminOrderContact;
  address: AdminOrderAddress;
  lineItems: Array<{
    variantId?: string;
    name?: string;
    sku?: string;
    quantity: number;
    unitPrice: number;
    tax?: number;
    lineSubtotal?: number;
    lineTotal?: number;
  }>;
  totals: {
    subtotal: number;
    tax: number;
    shipping: number;
    discount: number;
    total: number;
    currency: string;
  };
  payment: {
    provider?: string;
    status?: string;
    transactionReference?: string | null;
    amount?: number;
    currency?: string;
    refundedAmount: number;
    refundableAmount: number;
    refunds: AdminOrderRefund[];
  };
  shipping: {
    selection?: {
      provider?: string;
      service?: string;
      label?: string;
      etaDays?: number;
      quotedAmount?: number;
      chargedAmount?: number;
      currency?: string;
      quotedAt?: string;
    } | null;
    shipment?: {
      id?: string;
      reference?: string | null;
      provider?: string;
      courier?: string | null;
      status?: string;
      awb?: string | null;
      trackingUrl?: string | null;
      createdAt?: string;
      events?: Array<{
        status: string;
        location?: string;
        occurredAt: string;
      }>;
    } | null;
  };
  history?: Array<{
    id?: string;
    from?: string;
    to?: string;
    status?: string;
    label?: string;
    source?: string;
    actor?: string;
    at?: string;
    createdAt?: string;
  }>;
};

type AdminOrdersResponse = {
  items: AdminOrderDTO[];
  pagination: {
    page: number;
    pageSize: number;
    total: number;
    totalPages: number;
  };
  summary: {
    totalOrders: number;
    activeCount: number;
    readyToShip: number;
    orderValue: number;
    currency: string;
  };
};

const adminOrderTransitions: Record<string, string[]> = {
  PENDING: ["CANCELLED"],
  PAYMENT_PENDING: ["CANCELLED"],
  PAID: ["CONFIRMED"],
  CONFIRMED: ["PROCESSING", "CANCELLED"],
  PROCESSING: ["PACKED", "CANCELLED"],
  PACKED: [],
  SHIPPED: ["OUT_FOR_DELIVERY", "DELIVERED"],
  OUT_FOR_DELIVERY: ["DELIVERED", "SHIPPED"],
  DELIVERED: ["RETURN_REQUESTED"],
  RETURN_REQUESTED: ["RETURN_APPROVED"],
  RETURN_APPROVED: ["RETURNED"],
  RETURNED: [],
  REFUND_PENDING: [],
  FAILED: [],
};

const adminOrderFilterStatuses = [
  "PENDING",
  "PAYMENT_PENDING",
  "PAID",
  "CONFIRMED",
  "PROCESSING",
  "PACKED",
  "SHIPPED",
  "OUT_FOR_DELIVERY",
  "DELIVERED",
  "RETURN_REQUESTED",
  "RETURN_APPROVED",
  "RETURNED",
  "REFUND_PENDING",
  "REFUNDED",
  "FAILED",
  "CANCELLED",
];

const adminOrdersPageSize = 20;

function orderContact(order: AdminOrderDTO) {
  return order.customer || {};
}

function orderAddress(order: AdminOrderDTO) {
  return order.address || {};
}

function orderRefunds(order: AdminOrderDTO) {
  return order.payment.refunds || [];
}

function refundedTotal(order: AdminOrderDTO) {
  return Number(order.payment.refundedAmount || 0);
}

function orderStatusLabel(value?: string) {
  if (!value) return "Not available";
  return value.replaceAll("_", " ").toLowerCase().replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function orderDate(value?: string) {
  if (!value) return "Not recorded";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("en-IN", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
}

function addressText(address: AdminOrderAddress) {
  return [
    address.line1,
    address.line2,
    address.city,
    address.state,
    address.postalCode,
    address.country,
  ]
    .filter(Boolean)
    .join(", ");
}

function newOperationKey() {
  return `admin-${Date.now()}-${crypto.randomUUID()}`;
}

function AdminOrdersPanel() {
  const [orders, setOrders] = useState<AdminOrderDTO[]>([]);
  const [selectedId, setSelectedId] = useState("");
  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("ALL");
  const [page, setPage] = useState(1);
  const [pagination, setPagination] = useState<AdminOrdersResponse["pagination"]>({
    page: 1,
    pageSize: adminOrdersPageSize,
    total: 0,
    totalPages: 0,
  });
  const [summary, setSummary] = useState<AdminOrdersResponse["summary"]>({
    totalOrders: 0,
    activeCount: 0,
    readyToShip: 0,
    orderValue: 0,
    currency: "INR",
  });
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [actionError, setActionError] = useState("");
  const [actionSuccess, setActionSuccess] = useState("");
  const [busyAction, setBusyAction] = useState("");
  const [refundMode, setRefundMode] = useState<"PARTIAL" | "FULL">("PARTIAL");
  const [refundAmount, setRefundAmount] = useState("");
  const [refundReason, setRefundReason] = useState("");
  const [refundConfirmed, setRefundConfirmed] = useState(false);
  const [refundKey, setRefundKey] = useState(newOperationKey);
  const orderRequestSequence = useRef(0);

  const loadOrders = async (preferredId?: string) => {
    const requestId = ++orderRequestSequence.current;
    setLoading(true);
    setLoadError("");
    try {
      const query = new URLSearchParams({
        page: String(page),
        pageSize: String(adminOrdersPageSize),
      });
      if (debouncedSearch) query.set("search", debouncedSearch);
      if (statusFilter !== "ALL") query.set("status", statusFilter);
      const response = await commerceApi<AdminOrdersResponse>(
        `/api/v1/admin/orders?${query.toString()}`,
      );
      if (requestId !== orderRequestSequence.current) return;

      const totalPages = Math.max(0, Number(response.pagination.totalPages || 0));
      if (response.pagination.total > 0 && page > Math.max(1, totalPages)) {
        setPage(Math.max(1, totalPages));
        return;
      }

      setOrders(response.items);
      setPagination(response.pagination);
      setSummary(response.summary);
      setSelectedId((current) => {
        const wanted = preferredId || current;
        return response.items.some((order) => order.id === wanted)
          ? wanted
          : response.items[0]?.id || "";
      });
    } catch (error) {
      if (requestId !== orderRequestSequence.current) return;
      setLoadError(error instanceof Error ? error.message : "Orders could not be loaded");
      setOrders([]);
      setSelectedId("");
    } finally {
      if (requestId === orderRequestSequence.current) setLoading(false);
    }
  };

  useEffect(() => {
    const timer = window.setTimeout(() => {
      setDebouncedSearch(search.trim());
      setPage(1);
    }, 300);
    return () => window.clearTimeout(timer);
  }, [search]);

  useEffect(() => {
    void loadOrders();
    return () => {
      orderRequestSequence.current += 1;
    };
    // loadOrders intentionally reads the current server query state.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [debouncedSearch, page, statusFilter]);

  useEffect(() => {
    setRefundMode("PARTIAL");
    setRefundAmount("");
    setRefundReason("");
    setRefundConfirmed(false);
    setRefundKey(newOperationKey());
    setActionError("");
    setActionSuccess("");
  }, [selectedId]);

  const selectedOrder = orders.find((order) => order.id === selectedId);
  const resultStart = pagination.total
    ? (pagination.page - 1) * pagination.pageSize + 1
    : 0;
  const resultEnd = pagination.total
    ? Math.min(pagination.page * pagination.pageSize, pagination.total)
    : 0;
  const visiblePage = Math.max(1, pagination.page || page);
  const visibleTotalPages = Math.max(1, pagination.totalPages || 0);

  const runStatusAction = async (status: string) => {
    if (!selectedOrder) return;
    const action = `status:${status}`;
    setBusyAction(action);
    setActionError("");
    setActionSuccess("");
    try {
      await commerceApi(`/api/v1/admin/orders/${selectedOrder.id}/status`, {
        method: "PATCH",
        body: JSON.stringify({ status }),
      });
      const message = `${selectedOrder.number} moved to ${orderStatusLabel(status)}`;
      setActionSuccess(message);
      toast.success(message);
      await loadOrders(selectedOrder.id);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Order status could not be updated";
      setActionError(message);
      toast.error(message);
    } finally {
      setBusyAction("");
    }
  };

  const createShipment = async (details?: { courier: string; awb?: string; trackingUrl?: string }) => {
    if (!selectedOrder || selectedOrder.status !== "PACKED") return;
    setBusyAction("shipment");
    setActionError("");
    setActionSuccess("");
    try {
      await commerceApi(`/api/v1/admin/orders/${selectedOrder.id}/shipment`, {
        method: "POST",
        body: JSON.stringify({
          service: selectedOrder.shipping.selection?.service || "STANDARD",
          ...details,
        }),
      });
      const message = `Shipment created for ${selectedOrder.number}`;
      setActionSuccess(message);
      toast.success(message);
      await loadOrders(selectedOrder.id);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Shipment could not be created";
      setActionError(message);
      toast.error(message);
    } finally {
      setBusyAction("");
    }
  };

  const changeRefundForm = (patch: {
    mode?: "PARTIAL" | "FULL";
    amount?: string;
    reason?: string;
  }) => {
    if (patch.mode) setRefundMode(patch.mode);
    if (patch.amount !== undefined) setRefundAmount(patch.amount);
    if (patch.reason !== undefined) setRefundReason(patch.reason);
    setRefundConfirmed(false);
    setRefundKey(newOperationKey());
    setActionError("");
    setActionSuccess("");
  };

  const submitRefund = async () => {
    if (!selectedOrder) return;
    const refundable = Math.max(0, selectedOrder.payment.refundableAmount || 0);
    const amount = refundMode === "FULL" ? refundable : Number(refundAmount);
    if (!Number.isFinite(amount) || amount <= 0 || amount > refundable) {
      setActionError(`Enter an amount between ₹0.01 and ${money(refundable)}.`);
      return;
    }
    if (refundReason.trim().length < 3) {
      setActionError("Add a short reason for the refund.");
      return;
    }
    if (!refundConfirmed) {
      setActionError("Confirm the refund amount before submitting.");
      return;
    }
    setBusyAction("refund");
    setActionError("");
    setActionSuccess("");
    try {
      const result = await commerceApi<{ refund: { status: string } }>(`/api/v1/admin/orders/${selectedOrder.id}/refunds`, {
        method: "POST",
        headers: { "Idempotency-Key": refundKey },
        body: JSON.stringify({ amount, reason: refundReason.trim() }),
      });
      const message = result.refund.status === "SUCCEEDED" ? `${money(amount)} refunded for ${selectedOrder.number}` : result.refund.status === "FAILED" ? "The refund was rejected by the payment provider" : `${money(amount)} refund submitted; awaiting gateway confirmation`;
      setActionSuccess(message);
      toast.success(message);
      setRefundConfirmed(false);
      setRefundAmount("");
      setRefundReason("");
      setRefundKey(newOperationKey());
      await loadOrders(selectedOrder.id);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Refund could not be processed";
      setActionError(message);
      toast.error(message);
    } finally {
      setBusyAction("");
    }
  };

  if (loading && !orders.length)
    return (
      <div className="module-empty admin-orders-state">
        <RefreshCw className="spin" />
        <h3>Loading live orders…</h3>
        <p>Fetching order, payment and fulfilment details.</p>
      </div>
    );

  if (loadError && !orders.length)
    return (
      <div className="module-empty admin-orders-state" role="alert">
        <AlertTriangle />
        <h3>Orders could not be loaded</h3>
        <p>{loadError}</p>
        <div>
          <button className="primary" type="button" onClick={() => void loadOrders()}>
            <RefreshCw /> Retry
          </button>
          <a className="secondary" href="/login">Sign in</a>
        </div>
      </div>
    );

  if (
    !orders.length &&
    !loading &&
    !search.trim() &&
    statusFilter === "ALL" &&
    summary.totalOrders === 0
  )
    return (
      <div className="module-empty admin-orders-state">
        <ShoppingCart />
        <h3>No orders yet</h3>
        <p>Customer orders will appear here automatically after checkout.</p>
        <a className="secondary" href="/shop">View storefront</a>
      </div>
    );

  return (
    <div className="admin-orders-workspace">
      <div className="editor-top admin-orders-heading">
        <div>
          <p className="portal-eyebrow">Live fulfilment workspace</p>
          <h2>Orders</h2>
          <span>Review customers, payments, delivery and refunds from one place.</span>
        </div>
        <button
          className="secondary"
          type="button"
          onClick={() => void loadOrders(selectedId)}
          disabled={loading || Boolean(busyAction)}
        >
          <RefreshCw className={loading ? "spin" : ""} /> Refresh
        </button>
      </div>

      <div className="admin-order-metrics">
        <article className="panel"><ShoppingCart /><span><small>Total orders</small><b>{summary.totalOrders}</b></span></article>
        <article className="panel"><Activity /><span><small>Active</small><b>{summary.activeCount}</b></span></article>
        <article className="panel"><Package /><span><small>Ready to ship</small><b>{summary.readyToShip}</b></span></article>
        <article className="panel"><CircleDollarSign /><span><small>Order value</small><b>{money(summary.orderValue)}</b></span></article>
      </div>

      <section className="panel admin-order-browser">
        <div className="admin-order-toolbar">
          <label>
            <Search />
            <input
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Search order, customer or SKU"
              aria-label="Search orders"
            />
          </label>
          <select
            value={statusFilter}
            onChange={(event) => {
              setStatusFilter(event.target.value);
              setPage(1);
            }}
            aria-label="Filter orders by status"
          >
            <option value="ALL">All statuses</option>
            {adminOrderFilterStatuses.map((status) => <option key={status} value={status}>{orderStatusLabel(status)}</option>)}
          </select>
          <small aria-live="polite">
            {loading ? "Updating… · " : ""}
            {pagination.total ? `${resultStart}–${resultEnd} of ${pagination.total}` : "0 orders"}
          </small>
        </div>

        <div className="admin-order-layout">
          <div className="admin-order-list-column">
            <div className="admin-order-list" aria-label="Order list" aria-busy={loading}>
              {orders.length ? orders.map((order) => {
                const contact = orderContact(order);
                const itemCount = order.lineItems.reduce((total, line) => total + line.quantity, 0);
                return (
                  <button
                    type="button"
                    className={order.id === selectedId ? "active" : ""}
                    key={order.id}
                    onClick={() => setSelectedId(order.id)}
                    aria-pressed={order.id === selectedId}
                  >
                    <span><b>{order.number}</b><small>{orderDate(order.createdAt)}</small></span>
                    <span><strong>{contact.name || contact.email || "Guest customer"}</strong><small>{itemCount} item{itemCount === 1 ? "" : "s"}</small></span>
                    <span><b>{money(order.totals.total)}</b><em className={`status ${order.status.toLowerCase()}`}>{orderStatusLabel(order.status)}</em></span>
                    <ChevronRight />
                  </button>
                );
              }) : (
                <div className="admin-order-no-results">
                  <Search />
                  <b>No matching orders</b>
                  <small>Clear the search or choose another status.</small>
                </div>
              )}
            </div>
            <nav className="admin-order-pagination" aria-label="Order list pages">
              <button
                className="secondary"
                type="button"
                onClick={() => setPage((current) => Math.max(1, current - 1))}
                disabled={loading || visiblePage <= 1}
                aria-label="Previous orders page"
              >
                Previous
              </button>
              <span aria-live="polite">
                Page {visiblePage} of {visibleTotalPages}
                <small>{pagination.total ? `${resultStart}–${resultEnd} of ${pagination.total} orders` : "No orders"}</small>
              </span>
              <button
                className="secondary"
                type="button"
                onClick={() => setPage((current) => Math.min(visibleTotalPages, current + 1))}
                disabled={loading || visiblePage >= visibleTotalPages}
                aria-label="Next orders page"
              >
                Next
              </button>
            </nav>
          </div>

          {selectedOrder ? (
            <AdminOrderDetail
              order={selectedOrder}
              busyAction={busyAction}
              actionError={actionError}
              actionSuccess={actionSuccess}
              refundMode={refundMode}
              refundAmount={refundAmount}
              refundReason={refundReason}
              refundConfirmed={refundConfirmed}
              onStatus={runStatusAction}
              onShipment={createShipment}
              onRefundMode={(mode) => changeRefundForm({ mode })}
              onRefundAmount={(amount) => changeRefundForm({ amount })}
              onRefundReason={(reason) => changeRefundForm({ reason })}
              onRefundConfirmed={setRefundConfirmed}
              onRefund={submitRefund}
              onRefundReconcile={async (id) => {
                setBusyAction("refund-status");
                try {
                  const result = await commerceApi<{ status: string }>(`/api/v1/admin/refunds/${id}/reconcile`, { method: "POST" });
                  toast.success(`Refund status: ${result.status}`);
                  await loadOrders(selectedOrder.id);
                } catch (error) { toast.error(error instanceof Error ? error.message : "Could not check refund"); }
                finally { setBusyAction(""); }
              }}
            />
          ) : (
            <div className="admin-order-no-selection"><FileText /><p>Select an order to review its details.</p></div>
          )}
        </div>
      </section>
    </div>
  );
}

type AdminOrderDetailProps = {
  order: AdminOrderDTO;
  busyAction: string;
  actionError: string;
  actionSuccess: string;
  refundMode: "PARTIAL" | "FULL";
  refundAmount: string;
  refundReason: string;
  refundConfirmed: boolean;
  onStatus: (status: string) => Promise<void>;
  onShipment: (details?: { courier: string; awb?: string; trackingUrl?: string }) => Promise<void>;
  onRefundMode: (mode: "PARTIAL" | "FULL") => void;
  onRefundAmount: (amount: string) => void;
  onRefundReason: (reason: string) => void;
  onRefundConfirmed: (confirmed: boolean) => void;
  onRefund: () => Promise<void>;
  onRefundReconcile: (id: string) => Promise<void>;
};

function AdminOrderDetail({
  order,
  busyAction,
  actionError,
  actionSuccess,
  refundMode,
  refundAmount,
  refundReason,
  refundConfirmed,
  onStatus,
  onShipment,
  onRefundMode,
  onRefundAmount,
  onRefundReason,
  onRefundConfirmed,
  onRefund,
  onRefundReconcile,
}: AdminOrderDetailProps) {
  const [manualDispatch, setManualDispatch] = useState({ courier: "", awb: "", trackingUrl: "" });
  useEffect(() => { setManualDispatch({ courier: "", awb: "", trackingUrl: "" }); }, [order.id]);
  const contact = orderContact(order);
  const address = orderAddress(order);
  const refunds = orderRefunds(order);
  const refunded = refundedTotal(order);
  const refundable = Math.max(0, Number(order.payment.refundableAmount || 0));
  const manualShipping = order.shipping.selection?.provider === "manual";
  const nextStatuses = (adminOrderTransitions[order.status] || []).filter(status => !manualShipping || status !== "SHIPPED");
  const paymentReference = order.payment.transactionReference;
  const shipment = order.shipping.shipment;
  const shippingSelection = order.shipping.selection;
  const trackingNumber = shipment?.awb;
  const canRefund = refundable > 0;
  const timeline = [
    ...(order.history || []).map((event, index) => ({
        id: event.id || `${event.to || event.status}-${index}`,
        label: event.label || orderStatusLabel(event.to || event.status),
        description: [event.from ? `From ${orderStatusLabel(event.from)}` : "Order created", event.source, event.actor ? `by ${event.actor}` : ""].filter(Boolean).join(" · "),
        at: event.at || event.createdAt,
      })),
    ...(shipment?.events || []).map((event, index) => ({
      id: `shipment-${event.status}-${index}`,
      label: orderStatusLabel(event.status),
      description: event.location ? `Shipment update · ${event.location}` : "Shipment update",
      at: event.occurredAt,
    })),
    ...refunds.map((refund, index) => ({
      id: refund.id || `refund-${index}`,
      label: `${orderStatusLabel(refund.status)} refund · ${money(Number(refund.amount || 0))}`,
      description: refund.reason || "Refund update",
      at: refund.createdAt,
    })),
  ].sort((left, right) => new Date(left.at || 0).getTime() - new Date(right.at || 0).getTime());

  return (
    <article className="admin-order-detail">
      <header>
        <div>
          <p className="portal-eyebrow">Order detail</p>
          <h2>{order.number}</h2>
          <small>Placed {orderDate(order.createdAt)}</small>
        </div>
        <span className={`status ${order.status.toLowerCase()}`}>{orderStatusLabel(order.status)}</span>
      </header>

      {(actionError || actionSuccess) && (
        <p className={actionError ? "admin-order-alert error" : "admin-order-alert success"} role={actionError ? "alert" : "status"}>
          {actionError ? <AlertTriangle /> : <ShieldCheck />}
          {actionError || actionSuccess}
        </p>
      )}

      <section className="admin-order-actions">
        <div><h3>Next action</h3><p>Only valid transitions for this order are available.</p></div>
        <div>
          {nextStatuses.map((status) => (
            <button
              className={status === "CANCELLED" || status === "FAILED" ? "secondary danger" : "secondary"}
              type="button"
              key={status}
              disabled={Boolean(busyAction)}
              onClick={() => void onStatus(status)}
            >
              {busyAction === `status:${status}` ? <RefreshCw className="spin" /> : <ChevronRight />}
              {orderStatusLabel(status)}
            </button>
          ))}
          {order.status === "PACKED" && (
            <button className="primary" type="button" disabled={Boolean(busyAction) || (manualShipping && manualDispatch.courier.trim().length < 2)} onClick={() => void onShipment(manualShipping ? { courier: manualDispatch.courier.trim(), awb: manualDispatch.awb.trim() || undefined, trackingUrl: manualDispatch.trackingUrl.trim() || undefined } : undefined)}>
              {busyAction === "shipment" ? <RefreshCw className="spin" /> : <Truck />}
              {busyAction === "shipment" ? "Saving dispatch…" : manualShipping ? "Record dispatch" : "Create shipment"}
            </button>
          )}
          {!nextStatuses.length && order.status !== "PACKED" && <small>No manual status action is available.</small>}
        </div>
      </section>

      {manualShipping && order.status === "PACKED" ? <section className="manual-shipment-fields">
        <p>Arrange delivery with your courier, then record the dispatch. Leave tracking blank if the service does not issue a tracking number.</p>
        <label>Courier / delivery partner<input value={manualDispatch.courier} onChange={event => setManualDispatch(current => ({ ...current, courier: event.target.value }))} maxLength={100} /></label>
        <label>Tracking number (optional)<input value={manualDispatch.awb} onChange={event => setManualDispatch(current => ({ ...current, awb: event.target.value }))} maxLength={80} /></label>
        <label>Courier tracking URL (optional)<input type="url" placeholder="https://…" value={manualDispatch.trackingUrl} onChange={event => setManualDispatch(current => ({ ...current, trackingUrl: event.target.value }))} /></label>
      </section> : null}

      <div className="admin-order-info-grid">
        <section>
          <h3><Users /> Customer</h3>
          <b>{contact.name || "Guest customer"}</b>
          <p>{contact.email || "No email recorded"}</p>
          <p>{contact.phone || "No mobile recorded"}</p>
          {address.gstin && <p>GSTIN: {address.gstin}</p>}
        </section>
        <section>
          <h3><Globe2 /> Delivery address</h3>
          <p>{addressText(address) || "No delivery address recorded"}</p>
        </section>
        <section>
          <h3><CreditCard /> Payment</h3>
          <b>{orderStatusLabel(order.payment.status || "NOT_RECORDED")}</b>
          <p>{orderStatusLabel(order.payment.provider || "Provider not recorded")}</p>
          <p className="admin-order-reference">{paymentReference || "No gateway transaction ID"}</p>
          <p>{money(Number(order.payment.amount || 0))} {order.payment.currency || order.totals.currency}</p>
        </section>
        <section>
          <h3><Truck /> Shipping</h3>
          <b>{shipment?.courier || shipment?.provider || shippingSelection?.provider || "Not booked"}</b>
          <p>{shippingSelection?.label || shippingSelection?.service || "Service not selected"}</p>
          <p>{trackingNumber ? `Tracking: ${trackingNumber}` : "No tracking number yet"}</p>
          {shipment?.trackingUrl && <p><a href={shipment.trackingUrl} target="_blank" rel="noreferrer">Open courier tracking</a></p>}
          {shipment?.status && <span className={`status ${shipment.status.toLowerCase()}`}>{orderStatusLabel(shipment.status)}</span>}
        </section>
      </div>

      <section className="admin-order-lines">
        <div className="admin-order-section-title"><h3>Items</h3><small>{order.lineItems.length} line{order.lineItems.length === 1 ? "" : "s"}</small></div>
        <div className="table-wrap">
          <table>
            <thead><tr><th>Product / variant</th><th>SKU</th><th>Qty</th><th>Unit price</th><th>Total</th></tr></thead>
            <tbody>
              {order.lineItems.map((line, index) => (
                <tr key={line.variantId || `${line.sku}-${index}`}>
                  <td><b>{line.name || "Product"}</b><small>{line.variantId || "Variant not recorded"}</small></td>
                  <td>{line.sku || "—"}</td>
                  <td>{line.quantity}</td>
                  <td>{money(line.unitPrice)}</td>
                  <td>{money(Number(line.lineTotal ?? line.unitPrice * line.quantity))}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <div className="admin-order-lower-grid">
        <section className="admin-order-totals">
          <h3>Order totals</h3>
          <dl>
            <div><dt>Subtotal</dt><dd>{money(order.totals.subtotal)}</dd></div>
            <div><dt>GST</dt><dd>{money(Number(order.totals.tax || 0))}</dd></div>
            <div><dt>Shipping</dt><dd>{money(Number(order.totals.shipping || 0))}</dd></div>
            <div><dt>Discount</dt><dd>−{money(Number(order.totals.discount || 0))}</dd></div>
            {refunded > 0 && <div className="refund-row"><dt>Refunded</dt><dd>−{money(refunded)}</dd></div>}
            <div className="total-row"><dt>Total</dt><dd>{money(order.totals.total)}</dd></div>
          </dl>
        </section>
        <section className="admin-order-timeline">
          <h3>Timeline</h3>
          {timeline.length ? timeline.slice().reverse().map((event, index) => (
            <div key={event.id}>
              <i className={index === 0 ? "current" : ""}><Activity /></i>
              <span><b>{event.label}</b>{event.description && <p>{event.description}</p>}<small>{orderDate(event.at)}</small></span>
            </div>
          )) : <p className="admin-order-muted">No timeline events recorded.</p>}
        </section>
      </div>

      <section className="admin-order-refund">
        <div className="admin-order-section-title">
          <div><h3>Refunds</h3><p>Refundable balance: {money(refundable)}</p></div>
          <RefreshCw />
        </div>
        {refunds.length > 0 && (
          <div className="admin-refund-history">
            {refunds.map((refund, index) => (
              <span key={refund.id || index}><b>{money(Number(refund.amount || 0))}</b><small>{orderStatusLabel(refund.status)} · {orderDate(refund.createdAt)}</small>{refund.status === "PENDING" && refund.id && <button type="button" disabled={Boolean(busyAction)} onClick={() => void onRefundReconcile(refund.id!)}>Check refund status</button>}</span>
            ))}
          </div>
        )}
        {canRefund ? (
          <div className="admin-refund-form">
            <div className="admin-refund-mode" role="group" aria-label="Refund type">
              <button type="button" className={refundMode === "PARTIAL" ? "active" : ""} aria-pressed={refundMode === "PARTIAL"} onClick={() => onRefundMode("PARTIAL")}>Partial refund</button>
              <button type="button" className={refundMode === "FULL" ? "active" : ""} aria-pressed={refundMode === "FULL"} onClick={() => onRefundMode("FULL")}>Full refund</button>
            </div>
            <label>
              Refund amount
              <span className="admin-refund-amount"><i>₹</i><input type="number" min="0.01" max={refundable} step="0.01" value={refundMode === "FULL" ? refundable : refundAmount} disabled={refundMode === "FULL" || Boolean(busyAction)} onChange={(event) => onRefundAmount(event.target.value)} /></span>
            </label>
            <label>
              Reason
              <textarea value={refundReason} disabled={Boolean(busyAction)} onChange={(event) => onRefundReason(event.target.value)} placeholder="Reason shown in the refund audit record" />
            </label>
            <label className="admin-refund-confirm">
              <input type="checkbox" checked={refundConfirmed} disabled={Boolean(busyAction)} onChange={(event) => onRefundConfirmed(event.target.checked)} />
              <span>I confirm this {refundMode.toLowerCase()} refund. This sends money through the payment gateway and cannot be undone here.</span>
            </label>
            <button className="primary admin-refund-submit" type="button" disabled={!refundConfirmed || Boolean(busyAction)} onClick={() => void onRefund()}>
              {busyAction === "refund" ? <RefreshCw className="spin" /> : <CreditCard />}
              {busyAction === "refund" ? "Processing securely…" : `Refund ${refundMode === "FULL" ? money(refundable) : refundAmount ? money(Number(refundAmount)) : "amount"}`}
            </button>
          </div>
        ) : (
          <p className="admin-order-muted">{refundable <= 0 ? "This order has been fully refunded." : "A captured online payment is required before a refund can be issued."}</p>
        )}
      </section>
    </article>
  );
}

function ModuleView({ module, onNavigate }: { module: string; onNavigate: (tab: string) => void }) {
  const [records, setRecords] = useState<Record<string, unknown>[]>([]);
  const [analytics, setAnalytics] = useState<AdminAnalytics | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState("");
  const [reconcilingId, setReconcilingId] = useState("");
  const load = useCallback(async () => {
    const path = module === "Payments"
      ? "/api/v1/admin/payments"
      : module === "Analytics"
        ? "/api/v1/admin/analytics"
        : "";
    if (!path) return;
    setLoading(true); setLoadError("");
    try {
      if (module === "Analytics") {
        setAnalytics(await commerceApi<AdminAnalytics>(path));
        setRecords([]);
      } else {
        setRecords(await commerceApi<Record<string, unknown>[]>(path));
      }
    }
    catch (error) { setLoadError(error instanceof Error ? error.message : "Records could not be loaded"); }
    finally { setLoading(false); }
  }, [module]);
  useEffect(() => { void load(); }, [load]);
  const reconcilePayment = async (paymentId: string) => {
    setReconcilingId(paymentId);
    setLoadError("");
    try {
      await commerceApi("/api/v1/admin/payments/reconcile", {
        method: "POST",
        body: JSON.stringify({ paymentId }),
      });
      toast.success("Payment reconciled with the gateway");
      await load();
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : "Payment could not be reconciled";
      setLoadError(message);
      toast.error(message);
    } finally {
      setReconcilingId("");
    }
  };
  const cards: [string, string, string][] = analytics ? [
    ["Revenue", money(analytics.revenue), "Completed commerce value"],
    ["Orders", String(analytics.orders), `${analytics.failedOrders} failed`],
    ["Average order", money(analytics.averageOrderValue), "Across valid orders"],
    ["Customers", String(analytics.customers), `${analytics.refunds} refunded orders`],
  ] : [];
  const isShipping = module === "Shipping";
  const canRefresh = module === "Payments" || module === "Analytics";
  return (
    <div>
      <div className="editor-top">
        <div>
          <p className="portal-eyebrow">Commerce operations</p>
          <h2>{module}</h2>
          <span>
            Manage and monitor {module.toLowerCase()} from this workspace.
          </span>
        </div>
        {canRefresh ? <button className="secondary" type="button" onClick={() => void load()} disabled={loading}>
          <RefreshCw className={loading ? "spin" : undefined} /> Refresh
        </button> : null}
      </div>
      <div className="metric-grid">
        {cards.map(([label, value, note]) => (
          <article className="metric" key={label}>
            <div>
              <span>
                <Activity />
              </span>
              <small>Live</small>
            </div>
            <p>{label}</p>
            <h3>{value}</h3>
            <em className="up">{note}</em>
          </article>
        ))}
      </div>
      {module === "Analytics" && <AdminAcquisitionPanel onNavigate={onNavigate} />}
      {loadError ? <p className="settings-error" role="alert"><AlertTriangle />{loadError}<button type="button" onClick={() => void load()}>Try again</button></p> : null}
      <section className="panel orders">
        <div className="panel-head">
          <div>
            <h2>{module} workspace</h2>
            <p>{isShipping ? "Shipping actions are attached to each order and configured through integrations." : "Live records from the commerce API"}</p>
          </div>
          {isShipping ? <button type="button" onClick={() => onNavigate("Orders")}><ShoppingCart /> Open orders</button> : null}
        </div>
        {loading ? <div className="module-empty"><RefreshCw className="spin" /><h3>Loading live records…</h3></div> : records.length ? <div className="table-wrap"><table><thead><tr>{Object.keys(records[0]).slice(0, 7).map(key => <th key={key}>{key.replace(/([A-Z])/g, " $1")}</th>)}{module === "Payments" ? <th>Action</th> : null}</tr></thead><tbody>{records.map((record, index) => {
          const paymentId = String(record.id || "");
          return <tr key={String(record.id || record.variantId || index)}>{Object.entries(record).slice(0, 7).map(([key, value]) => <td key={key}>{formatAdminCell(key, value)}</td>)}{module === "Payments" ? <td><button className="secondary" type="button" disabled={!paymentId || !record.externalId || Boolean(reconcilingId)} onClick={() => void reconcilePayment(paymentId)}>{reconcilingId === paymentId ? <RefreshCw className="spin" /> : <RefreshCw />}{reconcilingId === paymentId ? "Checking…" : "Reconcile"}</button></td> : null}</tr>;
        })}</tbody></table></div> : isShipping ? <div className="module-empty"><Truck /><h3>Fulfilment is managed from orders</h3><p>Create shipments on paid or confirmed orders, and configure courier credentials in Integrations.</p><div><button className="primary" type="button" onClick={() => onNavigate("Orders")}>Open orders</button><button className="secondary" type="button" onClick={() => onNavigate("Integrations")}>Configure couriers</button></div></div> : module === "Analytics" && analytics ? <div className="module-empty compact"><BarChart3 /><h3>Analytics are live</h3><p>Values above are calculated from current orders and customers, without sample data.</p></div> : <div className="module-empty"><Search /><h3>No {module.toLowerCase()} found</h3><p>New records will appear here automatically.</p></div>}
      </section>
    </div>
  );
}

function formatAdminCell(key: string, value: unknown) {
  if (value === null || value === undefined || value === "") return "—";
  if (typeof value === "object") return JSON.stringify(value);
  if (typeof value === "number" && ["amount", "total", "refundedAmount"].includes(key)) {
    return money(value);
  }
  if (typeof value === "string" && /(?:At|Date)$/.test(key)) {
    const date = new Date(value);
    if (!Number.isNaN(date.getTime())) return orderDate(value);
  }
  return String(value);
}
