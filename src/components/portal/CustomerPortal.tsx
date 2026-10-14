import { productPath } from "@/lib/product-url";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  AlertCircle,
  CheckCircle2,
  CreditCard,
  Download,
  Gift,
  Heart,
  LayoutDashboard,
  LifeBuoy,
  MapPin,
  Package,
  RefreshCw,
  RotateCcw,
  Settings,
  ShieldCheck,
  Trash2,
  Wallet,
} from "lucide-react";
import { PortalShell } from "./PortalShell";
import {
  commerceApi,
  CommerceApiError,
  commerceDownload,
  clearAccessToken,
  sessionExpiredEvent,
} from "@/lib/commerce-api";
import { prepareFirebaseAuth, firebaseGoogleCredential, firebaseAuthMessage } from "@/lib/firebase-auth";
import {
  loadPortalSession,
  logoutPortalSession,
  type PortalSession,
} from "@/lib/portal-auth";
import { money } from "@/data/commerce";
import { checkoutMobileInput } from "@/lib/checkout-autofill";
import { usePostalLookup } from "@/lib/postal-lookup";
import { toast, Toaster } from "sonner";
import { Navigate, useLocation } from "@tanstack/react-router";
import { CustomerReturnsWorkspace } from "./customer-service/CustomerReturnsWorkspace";
import { CustomerSupportWorkspace } from "./customer-service/CustomerSupportWorkspace";
import type { CustomerOrder } from "./customer-service/types";
import { collectedPayments, customerTransactionPath, settledRefundAmount, type CustomerPayment } from "@/lib/transactions";

const nav: [string, React.ReactNode][] = [
  ["My overview", <LayoutDashboard />],
  ["My orders", <Package />],
  ["Wishlist", <Heart />],
  ["Addresses", <MapPin />],
  ["Payments", <Wallet />],
  ["Returns", <RotateCcw />],
  ["Support", <LifeBuoy />],
  ["Profile settings", <Settings />],
];
type AccountUser = PortalSession;
type AccountAuthMethods = {
  google: { linked: boolean; enabled: boolean };
};
type DeletionCredential = { googleCredential: string };

const accountTabs = new Set(nav.map(([label]) => label));
const date = (value: string) =>
  new Intl.DateTimeFormat("en-IN", {
    day: "2-digit",
    month: "short",
    year: "numeric",
  }).format(new Date(value));
const paymentMoney = (value: number, currency: string) =>
  new Intl.NumberFormat("en-IN", {
    style: "currency",
    currency: currency || "INR",
    maximumFractionDigits: 2,
  }).format(value);

function CustomerOrdersPanel({ compact = false }: { compact?: boolean }) {
  const [orders, setOrders] = useState<CustomerOrder[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState("");
  const load = async (refresh = false) => {
    if (refresh) setRefreshing(true);
    else setLoading(true);
    setError("");
    try {
      const result = await commerceApi<CustomerOrder[]>("/api/v1/account/orders");
      setOrders(result);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Orders could not be loaded");
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  };
  useEffect(() => { void load(); }, []);
  const download = async (order: CustomerOrder) => {
    try {
      const blob = await commerceDownload(`/api/v1/orders/${order.id}/invoice`);
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = `invoice-${order.number}.pdf`;
      link.click();
      URL.revokeObjectURL(url);
    } catch (reason) {
      toast.error(reason instanceof Error ? reason.message : "Invoice could not be downloaded");
    }
  };
  const visibleOrders = compact ? orders.slice(0, 2) : orders;
  return <section className="customer-orders-workspace">
    <div className="panel customer-orders-heading"><div><h2>{compact ? "Recent orders" : "My orders"}</h2><p>Products, totals, payment and fulfilment in one place</p></div><button className="secondary" type="button" disabled={loading || refreshing} onClick={() => void load(true)}><RefreshCw className={refreshing ? "spin" : ""}/>{refreshing ? "Refreshing…" : "Refresh"}</button></div>
    {loading ? <div className="panel module-empty"><RefreshCw className="spin"/><h3>Loading your orders…</h3></div> : error ? <div className="panel module-empty"><AlertCircle/><h3>Orders could not be loaded</h3><p>{error}</p><button className="secondary" type="button" onClick={() => void load()}>Try again</button></div> : !visibleOrders.length ? <div className="panel module-empty"><Package/><h3>You have not placed an order yet</h3><p>Your confirmed orders and invoices will appear here.</p><a className="primary" href="/shop">Start shopping</a></div> : visibleOrders.map((order) => <article className="panel customer-order-card" key={order.id}>
      <header><div><small>Order</small><h3>#{order.number}</h3><span>{date(order.createdAt)}</span></div><span className={`status ${order.status.toLowerCase()}`}>{order.status.replaceAll("_", " ")}</span></header>
      <div className="customer-order-lines">{order.lines.map((line) => <div key={`${line.variantId}-${line.sku}`}><span><b>{line.name}</b><small>{line.sku} · Qty {line.quantity}</small></span><strong>{paymentMoney(line.unitPrice * line.quantity, order.currency || "INR")}</strong></div>)}</div>
      <div className="customer-order-summary"><span><small>Payment</small><b>{order.payment?.status?.replaceAll("_", " ") || "Cash on delivery"}</b></span><span><small>Delivery</small><b>{order.shipment?.status?.replaceAll("_", " ") || order.shippingSelection?.label || "Being prepared"}</b></span><span><small>Total</small><b>{paymentMoney(order.total, order.currency || "INR")}</b></span></div>
      <footer><button className="secondary" type="button" onClick={() => void download(order)}><Download/>Invoice PDF</button><a className="secondary" href={customerTransactionPath(order.number)}>Transaction details</a><a className="primary" href="/track">Track order</a>{order.shipment?.trackingUrl ? <a className="secondary" href={order.shipment.trackingUrl} target="_blank" rel="noreferrer">Courier tracking</a> : null}</footer>
    </article>)}
    {compact && orders.length > visibleOrders.length ? <a className="customer-orders-all" href="/account?tab=My%20orders">View all orders</a> : null}
  </section>;
}

type WishlistProduct = {
  slug: string;
  id: string;
  name: string;
  category: string;
  media?: Array<{ url: string; alt?: string; type: string }>;
  variants: Array<{ price: number; mrp: number; stock: number }>;
};

function WishlistPanel() {
  const [items, setItems] = useState<WishlistProduct[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [removing, setRemoving] = useState("");
  const load = async () => {
    setError("");
    try { setItems(await commerceApi<WishlistProduct[]>("/api/v1/wishlist")); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "Wishlist could not be loaded"); }
    finally { setLoading(false); }
  };
  useEffect(() => { void load(); }, []);
  const remove = async (productId: string) => {
    setRemoving(productId);
    try {
      await commerceApi(`/api/v1/wishlist/${encodeURIComponent(productId)}`, { method: "DELETE" });
      setItems((current) => current.filter((item) => item.id !== productId));
      window.dispatchEvent(new Event("varahi-commerce-wishlist"));
      toast.success("Removed from wishlist");
    } catch (reason) { toast.error(reason instanceof Error ? reason.message : "Item could not be removed"); }
    finally { setRemoving(""); }
  };
  if (loading) return <section className="panel module-empty"><RefreshCw className="spin"/><h3>Loading your wishlist…</h3></section>;
  if (error) return <section className="panel module-empty"><AlertCircle/><h3>Wishlist could not be loaded</h3><p>{error}</p><button className="secondary" type="button" onClick={() => void load()}>Try again</button></section>;
  if (!items.length) return <section className="panel module-empty"><Heart/><h3>Your wishlist is empty</h3><p>Save products from the shop to find them here.</p><a className="primary" href="/shop">Browse products</a></section>;
  return <section className="customer-wishlist"><div className="panel-head panel"><div><h2>Saved products</h2><p>{items.length} item{items.length === 1 ? "" : "s"} synchronized with your account</p></div></div><div>{items.map((item) => { const variant = item.variants.find((entry) => entry.stock > 0) || item.variants[0]; const image = item.media?.find((entry) => entry.type === "IMAGE"); return <article className="panel" key={item.id}><a href={productPath(item)}>{image ? <img src={image.url} alt={image.alt || item.name}/> : <Heart/>}<small>{item.category}</small><h3>{item.name}</h3><b>{paymentMoney(variant?.price || 0, "INR")}</b></a><button type="button" disabled={removing === item.id} onClick={() => void remove(item.id)}><Trash2/>{removing === item.id ? "Removing…" : "Remove"}</button></article>; })}</div></section>;
}

function PaymentsPanel() {
  const [payments, setPayments] = useState<CustomerPayment[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [refreshing, setRefreshing] = useState(false);
  const [signin, setSignin] = useState(false);

  const load = useCallback(async () => {
    setRefreshing(true); setError(""); setSignin(false);
    try { setPayments(await commerceApi<CustomerPayment[]>("/api/v1/account/payments")); }
    catch (reason) {
      setSignin(reason instanceof CommerceApiError && reason.status === 401);
      setError(reason instanceof Error ? reason.message : "Payment history could not be loaded");
    } finally { setLoading(false); setRefreshing(false); }
  }, []);
  useEffect(() => { void load(); }, [load]);

  if (loading)
    return (
      <section className="panel module-empty">
        <CreditCard />
        <h3>Loading payment history…</h3>
      </section>
    );
  if (error)
    return (
      <section className="panel module-empty">
        <AlertCircle />
        <h3>Payment history is unavailable</h3>
        <p>{error}</p>
        {signin ? <a className="primary" href="/login">Continue with Google</a> : <button className="primary" onClick={() => void load()} disabled={refreshing}>{refreshing ? "Checking…" : "Try again"}</button>}
      </section>
    );
  if (!payments.length)
    return (
      <section className="panel module-empty">
        <Wallet />
        <h3>No online payments yet</h3>
        <p>Your online transaction references will appear here after payment.</p>
        <a className="primary" href="/account?tab=My%20orders">View my orders</a>
        <button className="payment-refresh" onClick={() => void load()} disabled={refreshing}><RefreshCw />Refresh</button>
      </section>
    );

  const paid = collectedPayments(payments);
  const refunded = payments.reduce(
    (sum, payment) => sum + settledRefundAmount(payment),
    0,
  );
  return (
    <>
      <div className="customer-stats payment-summary">
        <article className="panel">
          <CreditCard />
          <div>
            <b>{payments.length}</b>
            <span>Online attempts</span>
          </div>
        </article>
        <article className="panel">
          <CheckCircle2 />
          <div>
            <b>{paymentMoney(paid, payments[0]?.currency || "INR")}</b>
            <span>Collected</span>
          </div>
        </article>
        <article className="panel">
          <RotateCcw />
          <div>
            <b>{paymentMoney(refunded, payments[0]?.currency || "INR")}</b>
            <span>Refunded</span>
          </div>
        </article>
      </div>
      <section className="panel orders payment-history">
        <div className="panel-head">
          <div>
            <h2>Payment history</h2>
            <p>Provider references, transaction IDs and refund status</p>
          </div>
          <button className="payment-refresh" onClick={() => void load()} disabled={refreshing}><RefreshCw />{refreshing ? "Checking…" : "Refresh status"}</button>
        </div>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Order</th>
                <th>Date</th>
                <th>Provider</th>
                <th>Gateway reference</th>
                <th>Transaction ID</th>
                <th>Amount</th>
                <th>Refunded</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {payments.map((payment) => {
                const failure = payment.events.find(
                  (event) => event.errorDescription,
                );
                return (
                  <tr key={payment.id}>
                    <td>
                      <a href="/account?tab=My%20orders">
                        {payment.orderNumber}
                      </a>
                      <br /><a href={customerTransactionPath(payment.orderNumber)}>View transaction</a>
                    </td>
                    <td>{date(payment.createdAt)}</td>
                    <td className="payment-provider">{payment.provider}</td>
                    <td>
                      <code>{payment.providerReference || "Pending"}</code>
                    </td>
                    <td>
                      <code>{payment.transactionId || "Not issued"}</code>
                    </td>
                    <td>{paymentMoney(payment.amount, payment.currency)}</td>
                    <td>
                      {settledRefundAmount(payment)
                        ? paymentMoney(settledRefundAmount(payment), payment.currency)
                        : "—"}
                    </td>
                    <td>
                      <span
                        className={`status ${payment.status.toLowerCase()}`}
                        title={failure?.errorDescription}
                      >
                        {payment.status.replaceAll("_", " ")}
                      </span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>
    </>
  );
}


function Addresses() {
  const [postalCode, setPostalCode] = useState("");
  const [city, setCity] = useState("");
  const [state, setState] = useState("");
  const postalEdits = useRef(new Set<string>());
  const postalLookup = usePostalLookup(postalCode, location => {
    if (location.city && !postalEdits.current.has("city")) setCity(location.city);
    if (location.state && !postalEdits.current.has("state")) setState(location.state);
  });
  const [addresses, setAddresses] = useState<Array<{ id: string; label: string; line1: string; line2?: string | null; phone?: string | null; city: string; state: string; postalCode: string; country: string; isDefault?: boolean }>>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [removing, setRemoving] = useState("");
  const load = useCallback(async () => {
    try { setAddresses(await commerceApi<typeof addresses>("/api/v1/account/addresses")); }
    catch (reason) { toast.error(reason instanceof Error ? reason.message : "Addresses could not be loaded"); }
    finally { setLoading(false); }
  }, []);
  useEffect(() => { void load(); }, [load]);
  const remove = async (id: string) => {
    if (!window.confirm("Remove this saved address?")) return;
    setRemoving(id);
    try {
      await commerceApi(`/api/v1/account/addresses/${encodeURIComponent(id)}`, { method: "DELETE" });
      setAddresses((current) => current.filter((item) => item.id !== id));
      toast.success("Address removed");
    } catch (reason) { toast.error(reason instanceof Error ? reason.message : "Address could not be removed"); }
    finally { setRemoving(""); }
  };
  return (
    <>
      <form
        className="panel form-panel"
        onSubmit={async (event) => {
          event.preventDefault();
          if (saving) return;
          const form = event.currentTarget;
          const data = new FormData(form);
          setSaving(true);
          try {
            await commerceApi("/api/v1/account/addresses", {
              method: "POST",
              body: JSON.stringify({
                label: data.get("label"),
                line1: data.get("line1"),
                line2: data.get("line2") || "",
                phone: data.get("phone"),
                city: data.get("city"),
                state: data.get("state"),
                postalCode: data.get("postalCode"),
                country: "IN",
                isDefault: data.get("isDefault") === "on",
              }),
            });
            toast.success("Address saved");
            form.reset();
            setPostalCode(""); setCity(""); setState(""); postalEdits.current.clear();
            await load();
          } catch (error) {
            toast.error(
              error instanceof Error
                ? error.message
                : "Address could not be saved",
            );
          } finally { setSaving(false); }
        }}
      >
        <div className="panel-head">
          <div>
            <h2>Add delivery address</h2>
            <p>Used only for checkout and delivery</p>
          </div>
        </div>
        <div className="form-row">
          <label>
            Label
            <input name="label" placeholder="Home" required />
          </label>
          <label>
            PIN code
            <input name="postalCode" inputMode="numeric" autoComplete="postal-code" maxLength={6} pattern="[1-9][0-9]{5}" value={postalCode} onChange={event => { postalEdits.current.clear(); setPostalCode(event.target.value.replace(/\D/g, "").slice(0, 6)); }} required />
          </label>
        </div>
        <p role="status">{postalLookup.message || "Enter your PIN code to suggest the city and state. You can edit the suggestions."}{postalLookup.message && !postalLookup.loading && !postalLookup.location ? <> <button type="button" onClick={postalLookup.retry}>Retry lookup</button></> : null}</p>
        <label>
          Street address
          <input name="line1" autoComplete="address-line1" required />
        </label>
        <label>Apartment, suite or landmark (optional)<input name="line2" autoComplete="address-line2" /></label>
        <label>
          Mobile number (required)
          <span className="indian-phone-input"><span>+91</span><input name="phone" type="tel" inputMode="numeric" autoComplete="tel-national" pattern="[6-9][0-9]{9}" minLength={10} maxLength={20} onChange={event => { event.currentTarget.value = checkoutMobileInput(event.currentTarget.value); }} placeholder="10-digit mobile number" required /></span>
        </label>
        <div className="form-row">
          <label>
            City
            <input name="city" autoComplete="address-level2" value={city} onChange={event => { postalEdits.current.add("city"); setCity(event.target.value); }} required />
          </label>
          <label>
            State
            <input name="state" autoComplete="address-level1" value={state} onChange={event => { postalEdits.current.add("state"); setState(event.target.value); }} required />
          </label>
        </div>
        <label className="check">
          <input name="isDefault" type="checkbox" /> Make default
        </label>
        <button className="primary" disabled={saving}>{saving ? "Saving…" : "Save address"}</button>
      </form>
      <section className="panel customer-addresses">
        <div className="panel-head"><div><h2>Saved addresses</h2><p>Choose and maintain your delivery destinations</p></div><button type="button" onClick={() => void load()}><RefreshCw/>Refresh</button></div>
        {loading ? <div className="module-empty compact"><RefreshCw className="spin"/><h3>Loading addresses…</h3></div> : addresses.length ? <div className="customer-address-grid">{addresses.map((address) => <article key={address.id}><div><MapPin/><span><b>{address.label}</b>{address.isDefault ? <em>Default</em> : null}</span></div><p>{address.line1}{address.line2 ? <><br/>{address.line2}</> : null}<br/>{address.city}, {address.state} {address.postalCode}<br/>{address.country}{address.phone ? <><br/>{address.phone}</> : null}</p><button type="button" disabled={removing === address.id} onClick={() => void remove(address.id)}><Trash2/>{removing === address.id ? "Removing…" : "Remove"}</button></article>)}</div> : <div className="module-empty compact"><MapPin/><h3>No saved addresses</h3><p>Add an address above for faster checkout.</p></div>}
      </section>
    </>
  );
}

function customerAuthError(error: unknown, fallback: string) {
  if (!(error instanceof CommerceApiError))
    return error instanceof Error ? error.message : fallback;
  switch (error.code) {
    case "INVALID_GOOGLE_TOKEN":
      return "Google could not verify this account. Choose the same Google account and try again.";
    case "GOOGLE_EMAIL_MISMATCH":
      return "Choose the Google account that uses the same email as this customer account.";
    case "GOOGLE_ALREADY_LINKED":
    case "GOOGLE_ACCOUNT_ALREADY_LINKED":
      return "A Google account is already connected.";
    case "GOOGLE_IDENTITY_IN_USE":
      return "This Google account is already connected to another customer account.";
    case "GOOGLE_AUTH_NOT_CONFIGURED":
      return "Google connection is not available for this store right now.";
    case "REAUTHENTICATION_REQUIRED":
      return "Your identity could not be confirmed. Verify with your connected Google account and try again.";
    case "RATE_LIMITED":
      return "Too many attempts. Wait a minute and try again.";
    default:
      return error.message || fallback;
  }
}

function GoogleCredentialButton({ disabled, onCredential }: {
  disabled: boolean;
  onCredential: (credential: string) => Promise<void>;
}) {
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [attempt, setAttempt] = useState(0);
  const running = useRef(false);
  useEffect(() => {
    let cancelled = false;
    setReady(false);
    setMessage("");
    prepareFirebaseAuth().then(() => { if (!cancelled) setReady(true); }).catch((error) => { if (!cancelled) setMessage(firebaseAuthMessage(error)); });
    return () => { cancelled = true; };
  }, [attempt]);
  const verify = async () => {
    if (running.current || disabled) return;
    running.current = true;
    setBusy(true);
    setMessage("");
    try { await onCredential(await firebaseGoogleCredential()); }
    catch (error) { setMessage(firebaseAuthMessage(error)); }
    finally { running.current = false; setBusy(false); }
  };
  return <div className="account-google-control" aria-busy={busy}>
    <button type="button" disabled={disabled || busy || !ready} onClick={() => void verify()}>{busy ? "Verifying Google account…" : "Verify with Google"}</button>
    {!ready && !message && <p role="status">Preparing Google verification…</p>}
    {message && <p className="account-auth-error" role="alert">{message}</p>}
    {!ready && message && <button type="button" onClick={() => setAttempt(current => current + 1)}>Retry Google verification</button>}
  </div>;
}

function ProfileSettings() {
  const [authMethods, setAuthMethods] = useState<AccountAuthMethods | null>(
    null,
  );
  const [methodsLoading, setMethodsLoading] = useState(true);
  const [methodsError, setMethodsError] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const confirmationRef = useRef("");
  const [deletionBusy, setDeletionBusy] = useState(false);
  const deletionBusyRef = useRef(false);
  const [deletionError, setDeletionError] = useState("");

  useEffect(() => {
    let cancelled = false;
    commerceApi<AccountAuthMethods>("/api/v1/account/auth-methods")
      .then((methods) => {
        if (cancelled) return;
        setAuthMethods(methods);
      })
      .catch((error) => {
        if (cancelled) return;
        setMethodsError(
          customerAuthError(
            error,
            "Your Google sign-in status could not be loaded. Refresh and try again.",
          ),
        );
      })
      .finally(() => {
        if (!cancelled) setMethodsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const removeAccount = async (credential: DeletionCredential) => {
    if (deletionBusyRef.current) return false;
    if (confirmationRef.current !== "DELETE") {
      const message = "Type DELETE before permanently deleting your account.";
      setDeletionError(message);
      toast.error(message);
      return false;
    }
    deletionBusyRef.current = true;
    setDeletionBusy(true);
    setDeletionError("");
    let deleted = false;
    try {
      const result = await commerceApi<{
        deleted: boolean;
        retainedOrders: number;
      }>("/api/v1/account", {
        method: "DELETE",
        body: JSON.stringify({ confirmation: "DELETE", ...credential }),
      });
      deleted = true;
      clearAccessToken();
      toast.success(
        `Account deleted. ${result.retainedOrders} anonymized order record${result.retainedOrders === 1 ? "" : "s"} retained by the store.`,
      );
      window.setTimeout(() => window.location.assign("/"), 900);
      return true;
    } catch (error) {
      const message = customerAuthError(
        error,
        "Your account could not be deleted. Verify your identity and try again.",
      );
      setDeletionError(message);
      toast.error(message);
      return false;
    } finally {
      if (!deleted) {
        deletionBusyRef.current = false;
        setDeletionBusy(false);
      }
    }
  };

  const canVerifyWithGoogle = Boolean(
    authMethods?.google.linked && authMethods.google.enabled,
  );

  return (
    <div className="account-settings-stack">
      <section className="panel form-panel account-security">
        <div className="panel-head">
          <div>
            <h2>Google sign-in</h2>
            <p>Your account uses Google to sign in securely.</p>
          </div>
        </div>
        {methodsLoading ? (
          <p className="account-auth-loading" role="status">
            Loading Google sign-in status…
          </p>
        ) : methodsError ? (
          <p className="account-auth-error" role="alert">
            {methodsError}
          </p>
        ) : authMethods ? (
          <>
            <div className="account-auth-methods">
              <article>
                <span className="account-google-mark" aria-hidden="true">
                  G
                </span>
                <span>
                  <strong>Google</strong>
                  <small>
                    {authMethods.google.linked
                      ? authMethods.google.enabled
                        ? "Connected and available for customer sign-in."
                        : "Connected; Google sign-in is currently paused by the store."
                      : authMethods.google.enabled
                        ? "Sign out and sign in with Google using this account’s email."
                        : "Google sign-in is not enabled for this store."}
                  </small>
                </span>
                <em
                  className={authMethods.google.linked ? "is-on" : "is-off"}
                >
                  {authMethods.google.linked ? "Connected" : "Not connected"}
                </em>
              </article>
            </div>
          </>
        ) : null}
      </section>

      <section className="panel form-panel account-danger">
        <div className="panel-head">
          <div>
            <h2>Delete your account</h2>
            <p>
              Permanently removes your profile, login, addresses, wishlist and
              customer-facing history.
            </p>
          </div>
        </div>
        <div className="deletion-notice">
          <strong>What the store retains</strong>
          <p>
            Orders, payment totals, refunds and fulfilment records remain
            available to the store owner for accounting and legal operations.
            They are disconnected from your account and delivery/contact details
            are redacted.
          </p>
        </div>
        <label>
          Type DELETE to confirm
          <input
            value={confirmation}
            onChange={(event) => {
              const value = event.target.value.toUpperCase();
              setConfirmation(value);
              confirmationRef.current = value;
              setDeletionError("");
            }}
            aria-invalid={Boolean(deletionError)}
            aria-describedby={deletionError ? "account-delete-error" : undefined}
            autoComplete="off"
          />
        </label>

        {canVerifyWithGoogle && authMethods && (
          <div className="account-delete-google">
            <p className="account-auth-note">
              Type DELETE above, then verify using the connected Google account.
            </p>
            <GoogleCredentialButton
              disabled={confirmation !== "DELETE" || deletionBusy}
              onCredential={async (googleCredential) => {
                const removed = await removeAccount({ googleCredential });
                if (!removed) throw new Error("Account deletion was not completed.");
              }}
            />
          </div>
        )}

        {!methodsLoading && !methodsError && !canVerifyWithGoogle && (
          <p className="account-auth-error" role="alert">
            Google identity verification is currently unavailable. Contact
            store support before deleting your account.
          </p>
        )}
        {deletionError && (
          <p className="account-auth-error" id="account-delete-error" role="alert">
            {deletionError}
          </p>
        )}
      </section>
    </div>
  );
}

function Overview() {
  return (
    <>
      <div className="customer-hero">
        <div>
          <p className="portal-eyebrow">Sri Varahi Traders rewards</p>
          <h2>Your account, in one place</h2>
          <p>
            Orders, returns, saved favourites and support stay synchronized
            securely.
          </p>
          <div>
            <i style={{ width: "64%" }} />
          </div>
          <span>Member</span>
          <span>Next reward</span>
        </div>
        <Gift />
      </div>
      <div className="customer-stats">
        {[
          [<Package />, "Live", "Order tracking"],
          [<Heart />, "Saved", "Wishlist"],
          [<Wallet />, money(0), "Store credit"],
          [<LifeBuoy />, "Fast", "Customer care"],
        ].map(([icon, value, label]) => (
          <article className="panel" key={String(label)}>
            {icon}
            <div>
              <b>{value}</b>
              <span>{label}</span>
            </div>
          </article>
        ))}
      </div>
      <CustomerOrdersPanel compact />
    </>
  );
}

export function CustomerPortal() {
  const [active, setActive] = useState("My overview");
  const [account, setAccount] = useState<AccountUser | null>(null);
  const [sessionState, setSessionState] = useState<"checking" | "allowed" | "denied" | "signin" | "admin">("checking");
  const [sessionError, setSessionError] = useState("");
  const [signingOut, setSigningOut] = useState(false);
  const location = useLocation();
  useEffect(() => {
    const requested = new URLSearchParams(location.searchStr).get("tab");
    setActive(
      requested && accountTabs.has(requested) ? requested : "My overview",
    );
  }, [location.searchStr]);
  useEffect(() => {
    let active = true;
    const sessionExpired = () => {
      active = false;
      setAccount(null);
      setSessionState("signin");
    };
    window.addEventListener(sessionExpiredEvent, sessionExpired);
    loadPortalSession()
      .then((user) => {
        if (!active) return;
        if (user.role !== "CUSTOMER") {
          setSessionState("admin");
          return;
        }
        setAccount(user);
        setSessionState("allowed");
      })
      .catch((reason) => {
        if (!active) return;
        if (reason instanceof CommerceApiError && reason.status === 401) {
          setSessionState("signin");
          return;
        }
        setSessionError(reason instanceof Error ? reason.message : "Customer sign-in is required.");
        setSessionState("denied");
      });
    return () => {
      active = false;
      window.removeEventListener(sessionExpiredEvent, sessionExpired);
    };
  }, []);
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
  if (sessionState === "admin") return <Navigate to="/admin" replace />;
  if (sessionState === "checking")
    return (
      <div className="portal-access" role="status" aria-live="polite">
        <ShieldCheck />
        <h1>Opening your account…</h1>
        <p>Checking your secure customer session.</p>
      </div>
    );
  if (sessionState === "denied" || !account)
    return (
      <div className="portal-access">
        <ShieldCheck />
        <h1>Customer sign-in required</h1>
        <p>{sessionError || "Sign in to view orders and manage your account."}</p>
        <a className="primary" href="/login">Sign in securely</a>
      </div>
    );
  const content =
    active === "My overview" ? (
      <Overview />
    ) : active === "My orders" ? (
      <CustomerOrdersPanel />
    ) : active === "Wishlist" ? (
      <WishlistPanel />
    ) : active === "Addresses" ? (
      <Addresses />
    ) : active === "Payments" ? (
      <PaymentsPanel />

    ) : active === "Returns" ? (
      <CustomerReturnsWorkspace />
    ) : active === "Support" ? (
      <CustomerSupportWorkspace />
    ) : active === "Profile settings" ? (
      <ProfileSettings />
    ) : (
      <section className="panel module-empty">
        <h3>{active}</h3>
        <p>
          This section is ready for your account data and configured providers.
        </p>
      </section>
    );
  return (
    <>
      <Toaster richColors />
      <PortalShell
        title={active}
        subtitle="Track orders, manage your details and get help."
        nav={nav}
        active={active}
        onNavigate={setActive}
        portalPath="/account"
        userName={account?.name || "Customer"}
        userRole={account?.email || "Customer account"}
        onLogout={() => void signOut()}
        signingOut={signingOut}
      >
        {content}
      </PortalShell>
    </>
  );
}
