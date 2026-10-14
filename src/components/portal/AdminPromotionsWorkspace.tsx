import { useCallback, useEffect, useState } from "react";
import { AlertTriangle, Plus, Save, X, Zap } from "lucide-react";
import { toast } from "sonner";
import { commerceApi } from "@/lib/commerce-api";
import { emptyPromotions, type Banner, type Popup, type PromotionConfig } from "@/lib/promotions";

export function AdminPromotionsWorkspace() {
  const [config, setConfig] = useState<PromotionConfig>(emptyPromotions);
  const [coupons, setCoupons] = useState<Record<string, unknown>[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [dirty, setDirty] = useState(false);
  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const [campaigns, offers] = await Promise.all([
        commerceApi<PromotionConfig>("/api/v1/admin/promotions"),
        commerceApi<Record<string, unknown>[]>("/api/v1/admin/coupons"),
      ]);
      setConfig(campaigns);
      setCoupons(offers);
      setDirty(false);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Promotions could not be loaded");
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => { void load(); }, [load]);
  const update = (change: (current: PromotionConfig) => PromotionConfig) => {
    setConfig(change);
    setDirty(true);
  };
  const save = async () => {
    setSaving(true);
    try {
      setConfig(await commerceApi<PromotionConfig>("/api/v1/admin/promotions", { method: "PUT", body: JSON.stringify(config) }));
      setDirty(false);
      window.dispatchEvent(new Event("varahi_commerce:promotions-updated"));
      toast.success("Campaigns published");
    } catch (reason) {
      toast.error(reason instanceof Error ? reason.message : "Campaigns could not be saved");
    } finally { setSaving(false); }
  };
  const addBanner = () => update(current => ({ ...current, banners: [...current.banners, { id: crypto.randomUUID(), name: "New banner", enabled: true, startsAt: "", endsAt: "", audience: "ALL", eyebrow: "Featured", headline: "A new offer for your customers", body: "Describe the collection or offer here.", buttonLabel: "Shop now", buttonUrl: "/shop", imageUrl: "", placement: "HOME_HERO", backgroundColor: "#ded1bf" }] }));
  const addPopup = () => update(current => ({ ...current, popups: [...current.popups, { id: crypto.randomUUID(), name: "New popup", enabled: true, startsAt: "", endsAt: "", audience: "ALL", headline: "Welcome offer", body: "Save on your first order.", couponCode: "WELCOME10", buttonLabel: "Shop now", buttonUrl: "/shop", delaySeconds: 4, frequency: "ONCE" }] }));
  const banner = (id: string, patch: Partial<Banner>) => update(current => ({ ...current, banners: current.banners.map(item => item.id === id ? { ...item, ...patch } : item) }));
  const popup = (id: string, patch: Partial<Popup>) => update(current => ({ ...current, popups: current.popups.map(item => item.id === id ? { ...item, ...patch } : item) }));
  const createCoupon = async () => {
    const code = `OFFER${Math.floor(10 + Math.random() * 80)}`;
    try {
      const saved = await commerceApi<Record<string, unknown>>("/api/v1/admin/coupons", { method: "PUT", body: JSON.stringify({ code, type: "PERCENTAGE", value: 10, minimumSpend: 1000, maximumDiscount: 1500, startsAt: new Date().toISOString(), endsAt: new Date(Date.now() + 30 * 86400000).toISOString(), enabled: true, usageLimit: 1000 }) });
      setCoupons(items => [saved, ...items.filter(item => item.code !== saved.code)]);
      toast.success(`Coupon ${code} created`);
    } catch (reason) { toast.error(reason instanceof Error ? reason.message : "Coupon could not be created"); }
  };
  if (loading) return <div className="module-empty" role="status"><h3>Loading promotion settings…</h3></div>;
  if (error) return <div className="module-empty"><AlertTriangle /><h3>Promotions could not be loaded</h3><p>{error}</p><button className="primary" onClick={() => void load()}>Try again</button></div>;
  return <div>
    <div className="editor-top"><div><p className="portal-eyebrow">Promotion studio</p><h2>Offers, coupons &amp; campaigns</h2><span>Create banners and popup offers with buttons, targeting and frequency rules.</span></div><div><button className="secondary" onClick={addPopup} disabled={saving || config.popups.length >= 8}><Plus /> Popup</button><button className="secondary" onClick={addBanner} disabled={saving || config.banners.length >= 12}><Plus /> Banner</button><button className="primary" onClick={() => void save()} disabled={saving || !dirty}><Save />{saving ? "Publishing…" : "Publish all"}</button></div></div>
    <section className="panel campaign-editor"><div className="panel-head"><div><h2>Welcome popup</h2><p>Control all welcome and coupon popups without deleting their content.</p></div></div><div className="campaign-form"><label className="welcome-popup-toggle"><input type="checkbox" role="switch" checked={config.welcomePopupEnabled} disabled={saving} onChange={event => update(current => ({ ...current, welcomePopupEnabled: event.target.checked }))} /> Show welcome and offer popups</label><p>{config.welcomePopupEnabled ? "Popups can appear while customers browse the shop. They stay hidden on sign-in, cart, checkout, customer account and admin pages." : "All popup offers are off. In-page banners remain available and your saved campaigns are retained."}</p><p role="status">{dirty ? "Unsaved changes. Select Publish all to apply them to the website." : "These settings are published."}</p></div></section>
    <fieldset className="campaign-edit-fields" disabled={saving}>
      <section className="panel"><div className="panel-head"><div><h2>Coupon offers</h2><p>Discounts validated securely during checkout</p></div><button onClick={() => void createCoupon()}><Plus /> Quick coupon</button></div><div className="campaign-list">{coupons.map(item => <article key={String(item.code)}><div><Zap /><span><b>{String(item.code)}</b><small>{String(item.type).replaceAll("_", " ")} · {String(item.value)}</small></span></div><em>{item.enabled ? "Active" : "Paused"}</em></article>)}</div></section>
      <section className="panel campaign-editor"><div className="panel-head"><div><h2>Clickable banners</h2><p>Welcome popups and in-page promotions</p></div></div>{config.banners.map(item => <div className="campaign-form" key={item.id}>
        <div className="campaign-form-head"><label><input type="checkbox" checked={item.enabled} onChange={event => banner(item.id, { enabled: event.target.checked })} /> Active</label><button aria-label={`Delete banner ${item.name}`} onClick={() => update(current => ({ ...current, banners: current.banners.filter(x => x.id !== item.id) }))}><X /></button></div>
        <div className="form-row"><label>Campaign name<input value={item.name} onChange={event => banner(item.id, { name: event.target.value })} /></label><label>Placement<select value={item.placement} onChange={event => banner(item.id, { placement: event.target.value as Banner["placement"] })}><option value="HOME_HERO">Home welcome popup</option><option value="HOME_INLINE">Home in-page banner</option><option value="SHOP_TOP">Shop in-page banner</option></select></label></div>
        <label>Headline<input value={item.headline} onChange={event => banner(item.id, { headline: event.target.value })} /></label><label>Message<textarea value={item.body} onChange={event => banner(item.id, { body: event.target.value })} /></label>
        <div className="form-row"><label>Button label<input value={item.buttonLabel} onChange={event => banner(item.id, { buttonLabel: event.target.value })} /></label><label>Button URL<input value={item.buttonUrl} onChange={event => banner(item.id, { buttonUrl: event.target.value })} /></label></div>
      </div>)}</section>
      <section className="panel campaign-editor"><div className="panel-head"><div><h2>Popup offers</h2><p>Frequency-controlled coupon campaigns</p></div></div>{config.popups.map(item => <div className="campaign-form" key={item.id}>
        <div className="campaign-form-head"><label><input type="checkbox" checked={item.enabled} onChange={event => popup(item.id, { enabled: event.target.checked })} /> Active</label><button aria-label={`Delete popup ${item.name}`} onClick={() => update(current => ({ ...current, popups: current.popups.filter(x => x.id !== item.id) }))}><X /></button></div>
        <div className="form-row"><label>Headline<input value={item.headline} onChange={event => popup(item.id, { headline: event.target.value })} /></label><label>Coupon code<input value={item.couponCode} onChange={event => popup(item.id, { couponCode: event.target.value.toUpperCase() })} /></label></div>
        <label>Message<textarea value={item.body} onChange={event => popup(item.id, { body: event.target.value })} /></label>
        <div className="form-row"><label>Button label<input value={item.buttonLabel} onChange={event => popup(item.id, { buttonLabel: event.target.value })} /></label><label>Button URL<input value={item.buttonUrl} onChange={event => popup(item.id, { buttonUrl: event.target.value })} /></label></div>
        <div className="form-row"><label>Delay seconds<input type="number" min="0" max="120" value={item.delaySeconds} onChange={event => popup(item.id, { delaySeconds: Number(event.target.value) })} /></label><label>Frequency<select value={item.frequency} onChange={event => popup(item.id, { frequency: event.target.value as Popup["frequency"] })}><option value="ONCE">Once per browser</option><option value="DAILY">Once a day</option><option value="EVERY_VISIT">Each visit</option></select></label></div>
      </div>)}</section>
    </fieldset>
  </div>;
}
