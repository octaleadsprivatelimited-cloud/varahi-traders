import { ImagePlus, Save, Trash2 } from "lucide-react";
import { Link } from "@tanstack/react-router";
import type { StorefrontConfig } from "@/lib/storefront-config";

export const brandingFields = { logo: "logoUrl", footer: "footerLogoUrl", favicon: "faviconUrl" } as const;
export type BrandingKind = keyof typeof brandingFields;
type Props = {
  form: StorefrontConfig; error: string; saving: boolean;
  onChange: (patch: Partial<StorefrontConfig>) => void; onSave: () => void;
  onUpload: (kind: BrandingKind, file: File) => Promise<void>;
};
export function BrandingSettingsForm({ form, error, saving, onChange, onSave, onUpload }: Props) {
  const text = (key: keyof StorefrontConfig, value: string) => onChange({ [key]: value });
  return <div>
    <div className="editor-top"><div><p className="portal-eyebrow">Store settings</p><h2>Identity, logos &amp; website controls</h2><span>Manage the branding customers see across your website.</span></div><button className="primary" onClick={onSave} disabled={saving}><Save />{saving ? "Saving…" : "Publish settings"}</button></div>
    {error && <p className="settings-error" role="alert">{error}</p>}
    <fieldset className="branding-settings-fields" disabled={saving}>
      <div className="editor-layout"><div>
        <section className="panel form-panel"><div className="panel-head"><div><h2>Brand identity</h2><p>Business details shown in the footer and customer documents</p></div></div>
          <div className="form-row"><label>Store name<input value={form.storeName} onChange={e => text("storeName", e.target.value)} /></label><label>Legal business name<input value={form.legalName} onChange={e => text("legalName", e.target.value)} /><small>The footer copyright displays this in capital letters.</small></label></div>
          <div className="form-row"><label>FSSAI licence number<input value={form.fssaiLicense} inputMode="numeric" maxLength={14} onChange={e => text("fssaiLicense", e.target.value.replace(/\D/g, ""))} /></label><label>Business GSTIN (optional)<input value={form.businessGstin} maxLength={15} onChange={e => text("businessGstin", e.target.value.toUpperCase())} /></label></div>
          <label>Business postal address<textarea value={form.businessAddress} onChange={e => text("businessAddress", e.target.value)} autoComplete="street-address" rows={3} /></label>
        </section>
        <section className="panel form-panel"><div className="panel-head"><div><h2>Logos &amp; browser icon</h2><p>Upload a replacement to publish it immediately. Other unsaved fields stay in this form.</p></div></div>
          <div className="branding-assets">{(["logo", "footer", "favicon"] as const).map(kind => {
            const field = brandingFields[kind];
            const url = form[field] || (kind === "footer" ? form.logoUrl : "");
            const label = kind === "logo" ? "Header logo" : kind === "footer" ? "Footer logo" : "Favicon & mobile icon";
            return <article className="branding-asset" key={kind}>
              <div className={`branding-asset-preview ${kind === "favicon" ? "favicon-preview" : ""}`}>{url ? <img src={url} alt={`${label} preview`} /> : <ImagePlus />}</div>
              <h3>{label}</h3><p>{kind === "footer" && !form.footerLogoUrl ? "Uses your header logo." : kind === "favicon" ? "A square icon for browser tabs and mobile shortcuts." : "Use a transparent image for a clean fit."}</p>
              <label className="branding-upload"><ImagePlus />Upload replacement<input type="file" accept="image/png,image/jpeg,image/webp,image/avif,image/heic,image/heif" onChange={event => {
                const file = event.target.files?.[0]; event.target.value = "";
                if (file) void onUpload(kind, file);
              }} /></label>
              <button type="button" className="branding-remove" disabled={!form[field]} onClick={() => onChange({ [field]: "" })}><Trash2 />{kind === "footer" ? "Use header logo" : "Reset image"}</button>
              <details><summary>Use an image URL</summary><label>Image URL<input value={form[field]} onChange={e => text(field, e.target.value)} placeholder="https://… or /uploads/…" /></label></details>
            </article>;
          })}</div>
          <p className="branding-help">PNG, JPEG, WebP, AVIF or HEIC · up to 10 MB. Replaced website uploads are deleted once they are no longer used by a logo, product or campaign. URL edits and resets apply when you publish settings.</p>
        </section>
        <section className="panel form-panel"><div className="panel-head"><div><h2>Popups &amp; notifications</h2><p>Choose what appears while customers browse.</p></div></div>
          <label className="website-setting-switch"><input type="checkbox" role="switch" checked={form.analyticsPromptEnabled} onChange={e => onChange({ analyticsPromptEnabled: e.target.checked })} /><span><b>Show the analytics permission popup</b><small>Off by default. Customers can still open Cookie preferences in the footer. Optional tracking only runs after consent.</small></span></label>
          <div className="branding-welcome-link"><div><b>Welcome notification on / off</b><p>Turn welcome and offer popups on or off, edit their message and choose how often they appear.</p></div><Link to="/admin/$section" params={{ section: "marketing" }} search={{ view: "campaigns" }}>Manage welcome popup</Link></div>
        </section>
        <section className="panel form-panel"><div className="panel-head"><div><h2>Contact &amp; messaging</h2><p>Support channels and storefront copy</p></div></div>
          <div className="form-row"><label>Support email<input type="email" value={form.supportEmail} onChange={e => text("supportEmail", e.target.value)} /></label><label>Support phone<input value={form.supportPhone} onChange={e => text("supportPhone", e.target.value)} /></label></div>
          <label>Additional announcement (optional)<input value={form.announcement} onChange={e => text("announcement", e.target.value)} /><small>Delivery prices are generated automatically from Checkout &amp; delivery settings.</small></label><label>Footer tagline<textarea value={form.footerTagline} onChange={e => text("footerTagline", e.target.value)} /></label>
        </section>
        <section className="panel form-panel"><div className="panel-head"><div><h2>Search &amp; domain</h2><p>SEO defaults for this storefront</p></div></div>
          <label>Primary domain<input value={form.primaryDomain} onChange={e => text("primaryDomain", e.target.value)} placeholder="srivarahitraders.example" /></label><label>SEO title<input value={form.seoTitle} maxLength={70} onChange={e => text("seoTitle", e.target.value)} /></label><label>SEO description<textarea value={form.seoDescription} maxLength={170} onChange={e => text("seoDescription", e.target.value)} /></label>
        </section>
      </div><aside><section className="panel form-panel sticky"><div className="panel-head"><div><h2>Theme &amp; region</h2><p>Brand preview</p></div></div>
        <div className="settings-preview" style={{ background: form.backgroundColor, color: form.primaryColor, borderColor: form.accentColor }}>{form.logoUrl ? <img src={form.logoUrl} alt="Store logo preview" /> : <i style={{ background: form.accentColor }}>{form.storeName.split(/\s+/).map(part => part[0]).join("").slice(0, 2)}</i>}<strong>{form.storeName}</strong><small>{form.footerTagline}</small></div>
        {([['primaryColor', 'Primary colour'], ['accentColor', 'Accent colour'], ['backgroundColor', 'Background']] as const).map(([key, label]) => <label key={key}>{label}<span className="color-field"><input type="color" value={form[key]} onChange={e => text(key, e.target.value)} /><input value={form[key]} onChange={e => text(key, e.target.value)} /></span></label>)}
        <div className="form-row"><label>Currency<select value={form.currency} onChange={e => text("currency", e.target.value)}>{["INR", "USD", "EUR", "GBP", "AED"].map(value => <option key={value}>{value}</option>)}</select></label><label>Locale<select value={form.locale} onChange={e => text("locale", e.target.value)}>{["en-IN", "en-US", "en-GB", "ar-AE"].map(value => <option key={value}>{value}</option>)}</select></label></div>
      </section></aside></div>
    </fieldset>
  </div>;
}
