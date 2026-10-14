import { useCallback, useEffect, useMemo, useState } from "react";
import { AlertTriangle, Archive, Plus, Save, TicketPercent } from "lucide-react";
import { toast } from "sonner";
import { commerceApi } from "../../lib/commerce-api";

type CouponType = "PERCENTAGE" | "FIXED_AMOUNT" | "FREE_SHIPPING";
type ProductScope = "ALL_PRODUCTS" | "SELECTED_PRODUCTS";
type Coupon = {
  code: string; type: CouponType; value: number; minimumSpend: number; maximumDiscount?: number;
  startsAt: number | string; endsAt: number | string; enabled: boolean; usageLimit?: number;
  perUserLimit: number; used: number; appliesTo?: ProductScope; productIds?: string[];
};
type FormState = {
  code: string; type: CouponType; value: string; minimumSpend: string; maximumDiscount: string;
  startsAt: string; endsAt: string; enabled: boolean; usageLimit: string; perUserLimit: string;
  appliesTo: ProductScope; productIds: string[];
};
type ProductOption = { id: string; name: string; status: string };
type ProductPage = { items: ProductOption[]; pagination: { totalPages: number } };
const localDate = (value: number | string) => {
  const date = new Date(value), offset = date.getTimezoneOffset() * 60000;
  return new Date(date.getTime() - offset).toISOString().slice(0, 16);
};
const fresh = (): FormState => ({ code: "", type: "PERCENTAGE", value: "10", minimumSpend: "0", maximumDiscount: "", startsAt: localDate(Date.now()), endsAt: localDate(Date.now() + 30 * 86400000), enabled: true, usageLimit: "", perUserLimit: "1", appliesTo: "ALL_PRODUCTS", productIds: [] });
const statusOf = (coupon: Coupon) => !coupon.enabled ? "Paused" : new Date(coupon.startsAt) > new Date() ? "Scheduled" : new Date(coupon.endsAt) < new Date() ? "Expired" : "Active";

export function AdminCouponsWorkspace() {
  const [items, setItems] = useState<Coupon[]>([]), [form, setForm] = useState<FormState>(fresh);
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  const [products, setProducts] = useState<ProductOption[]>([]), [productSearch, setProductSearch] = useState("");
  const [productsLoading, setProductsLoading] = useState(true), [productsError, setProductsError] = useState("");
  const [editingCode, setEditingCode] = useState("");
  const editing = !!editingCode;
  const load = useCallback(() => commerceApi<Coupon[]>("/api/v1/admin/coupons").then(setItems).catch(reason => setError(reason instanceof Error ? reason.message : "Coupons could not be loaded")), []);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    let cancelled = false;
    const loadProducts = async () => {
      try {
        const options: ProductOption[] = [];
        let page = 1, totalPages = 1;
        do {
          const result = await commerceApi<ProductPage>(`/api/v1/admin/products?status=ALL&sortBy=name&sortOrder=asc&limit=100&page=${page}`);
          options.push(...result.items);
          totalPages = result.pagination.totalPages;
          page++;
        } while (page <= totalPages && !cancelled);
        if (!cancelled) setProducts(options);
      } catch (reason) {
        if (!cancelled) setProductsError(reason instanceof Error ? reason.message : "Products could not be loaded. Reload this page to try again.");
      } finally { if (!cancelled) setProductsLoading(false); }
    };
    void loadProducts();
    return () => { cancelled = true; };
  }, []);
  const visibleProducts = useMemo(() => products.filter(product => product.name.toLowerCase().includes(productSearch.trim().toLowerCase())), [products, productSearch]);
  const missingSelections = form.productIds.filter(id => !products.some(product => product.id === id));
  const field = <K extends keyof FormState>(key: K, value: FormState[K]) => setForm(current => ({ ...current, [key]: value }));
  const toggleProduct = (id: string) => setForm(current => ({ ...current, productIds: current.productIds.includes(id) ? current.productIds.filter(value => value !== id) : [...current.productIds, id] }));
  const edit = (coupon: Coupon) => {
    setProductSearch(""); setError(""); setEditingCode(coupon.code);
    setForm({ code: coupon.code, type: coupon.type, value: String(coupon.value), minimumSpend: String(coupon.minimumSpend), maximumDiscount: coupon.maximumDiscount === undefined ? "" : String(coupon.maximumDiscount), startsAt: localDate(coupon.startsAt), endsAt: localDate(coupon.endsAt), enabled: coupon.enabled, usageLimit: coupon.usageLimit === undefined ? "" : String(coupon.usageLimit), perUserLimit: String(coupon.perUserLimit || 1), appliesTo: coupon.appliesTo || "ALL_PRODUCTS", productIds: coupon.productIds || [] });
  };
  const save = async () => {
    if (!editing && items.some(item => item.code === form.code.trim().toUpperCase())) { setError("This code already exists. Choose it from All coupons to edit."); return; }
    if (form.appliesTo === "SELECTED_PRODUCTS" && !form.productIds.length) { setError("Select at least one product."); return; }
    setBusy(true); setError("");
    try {
      const payload = { code: form.code.trim().toUpperCase(), type: form.type, value: form.type === "FREE_SHIPPING" ? 0 : Number(form.value), minimumSpend: Number(form.minimumSpend), maximumDiscount: form.maximumDiscount ? Number(form.maximumDiscount) : undefined, startsAt: new Date(form.startsAt).toISOString(), endsAt: new Date(form.endsAt).toISOString(), enabled: form.enabled, usageLimit: form.usageLimit ? Number(form.usageLimit) : undefined, perUserLimit: Number(form.perUserLimit), appliesTo: form.appliesTo, productIds: form.appliesTo === "SELECTED_PRODUCTS" ? form.productIds : [] };
      await commerceApi<Coupon>("/api/v1/admin/coupons", { method: "PUT", body: JSON.stringify(payload) });
      toast.success(`Coupon ${payload.code} saved`); setForm(fresh()); setEditingCode(""); await load();
    } catch (reason) { const message = reason instanceof Error ? reason.message : "Coupon could not be saved"; setError(message); toast.error(message); }
    finally { setBusy(false); }
  };
  const archive = async (code: string) => {
    if (!window.confirm(`Pause coupon ${code}? Existing order history will be preserved.`)) return;
    try {
      await commerceApi(`/api/v1/admin/coupons/${encodeURIComponent(code)}`, { method: "DELETE" });
      toast.success(`${code} paused`); if (form.code === code) { setForm(fresh()); setEditingCode(""); } await load();
    } catch (reason) { toast.error(reason instanceof Error ? reason.message : "Coupon could not be paused"); }
  };
  return <div className="coupon-admin">
    <div className="editor-top"><div><p className="portal-eyebrow">Discounts</p><h2>Coupons</h2><span>Create controlled offers that are revalidated securely at checkout.</span></div><button className="secondary" onClick={() => { setForm(fresh()); setEditingCode(""); setProductSearch(""); setError(""); }}><Plus /> New coupon</button></div>
    {error && <p className="settings-error" role="alert"><AlertTriangle />{error}</p>}
    <div className="coupon-admin-grid">
      <form className="panel coupon-editor" onSubmit={event => { event.preventDefault(); void save(); }}>
        <div className="panel-head"><div><h2>{editing ? `Edit ${form.code}` : "Create coupon"}</h2><p>Codes are case-insensitive</p></div></div>
        <div className="coupon-fields">
          <label>Coupon code<input required minLength={3} maxLength={40} value={form.code} disabled={editing} placeholder="WELCOME10" onChange={event => field("code", event.target.value.toUpperCase().replace(/[^A-Z0-9_-]/g, ""))} /></label>
          <label>Discount type<select value={form.type} onChange={event => field("type", event.target.value as CouponType)}><option value="PERCENTAGE">Percentage</option><option value="FIXED_AMOUNT">Fixed amount</option><option value="FREE_SHIPPING">Free shipping</option></select></label>
          {form.type !== "FREE_SHIPPING" && <label>{form.type === "PERCENTAGE" ? "Percentage" : "Amount (₹)"}<input required type="number" min="0" max={form.type === "PERCENTAGE" ? 100 : 10000000} step="0.01" value={form.value} onChange={event => field("value", event.target.value)} /></label>}
          <label>Minimum eligible spend (₹)<input required type="number" min="0" step="0.01" value={form.minimumSpend} onChange={event => field("minimumSpend", event.target.value)} /></label>
          {form.type === "PERCENTAGE" && <label>Maximum discount (₹)<input type="number" min="0.01" step="0.01" placeholder="No cap" value={form.maximumDiscount} onChange={event => field("maximumDiscount", event.target.value)} /></label>}
          <label>Starts at<input required type="datetime-local" value={form.startsAt} onChange={event => field("startsAt", event.target.value)} /></label>
          <label>Ends at<input required type="datetime-local" value={form.endsAt} onChange={event => field("endsAt", event.target.value)} /></label>
          <label>Total usage limit<input type="number" min="1" placeholder="Unlimited" value={form.usageLimit} onChange={event => field("usageLimit", event.target.value)} /></label>
          <label>Uses per customer<input required type="number" min="1" max="100" value={form.perUserLimit} onChange={event => field("perUserLimit", event.target.value)} /></label>
          <label className="coupon-scope-field">Applies to<select value={form.appliesTo} onChange={event => field("appliesTo", event.target.value as ProductScope)}><option value="ALL_PRODUCTS">All products</option><option value="SELECTED_PRODUCTS">Selected products</option></select></label>
          {form.appliesTo === "SELECTED_PRODUCTS" && <fieldset className="coupon-product-picker">
            <legend>Choose eligible products</legend>
            <p>All pack sizes of the selected products qualify. Minimum spend is calculated from these items only.</p>
            <label>Search products<input type="search" value={productSearch} onChange={event => setProductSearch(event.target.value)} placeholder="Search by product name" /></label>
            <div className="coupon-selection-count"><span>{form.productIds.length} selected</span><button type="button" disabled={!form.productIds.length} onClick={() => field("productIds", [])}>Clear selection</button></div>
            {productsLoading ? <p role="status">Loading products…</p> : productsError ? <p role="alert">{productsError}</p> : <div className="coupon-product-options">
              {visibleProducts.map(product => <label key={product.id}><input type="checkbox" checked={form.productIds.includes(product.id)} disabled={!form.productIds.includes(product.id) && form.productIds.length >= 500} onChange={() => toggleProduct(product.id)} /><span>{product.name}{product.status !== "ACTIVE" && <small>{product.status.toLowerCase()}</small>}</span></label>)}
              {!visibleProducts.length && <p>No matching products.</p>}
              {missingSelections.map(id => <label key={id}><input type="checkbox" checked onChange={() => toggleProduct(id)} /><span>Unavailable product — uncheck to remove</span></label>)}
            </div>}
            {form.type === "FREE_SHIPPING" && <p>Free shipping applies to the order when the eligible items meet the minimum spend.</p>}
          </fieldset>}
          <label className="coupon-switch"><input type="checkbox" checked={form.enabled} onChange={event => field("enabled", event.target.checked)} /> Coupon enabled</label>
        </div>
        <button className="primary coupon-save" disabled={busy || form.code.length < 3 || (form.appliesTo === "SELECTED_PRODUCTS" && (!form.productIds.length || productsLoading || !!productsError || !!missingSelections.length))}><Save />{busy ? "Saving…" : "Save coupon"}</button>
      </form>
      <section className="panel coupon-list"><div className="panel-head"><div><h2>All coupons</h2><p>{items.length} configured</p></div></div>
        {items.length === 0 ? <div className="module-empty"><TicketPercent /><h3>No coupons yet</h3><p>Create your first offer using the form.</p></div> : items.map(coupon => <article key={coupon.code}>
          <div className="coupon-icon"><TicketPercent /></div><div><button className="coupon-edit" onClick={() => edit(coupon)}>{coupon.code}</button><span>{coupon.type === "PERCENTAGE" ? `${coupon.value}% off` : coupon.type === "FIXED_AMOUNT" ? `₹${coupon.value} off` : "Free shipping"}</span><small>{coupon.appliesTo === "SELECTED_PRODUCTS" ? `${coupon.productIds?.length || 0} selected products` : "All products"}</small><small>{coupon.used}{coupon.usageLimit ? ` / ${coupon.usageLimit}` : ""} uses · {coupon.perUserLimit || 1} per customer</small></div>
          <em className={`coupon-status ${statusOf(coupon).toLowerCase()}`}>{statusOf(coupon)}</em><button aria-label={`Pause coupon ${coupon.code}`} onClick={() => void archive(coupon.code)}><Archive /></button>
        </article>)}
      </section>
    </div>
  </div>;
}
