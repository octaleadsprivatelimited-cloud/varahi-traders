import { useCallback, useEffect, useState } from "react";
import { AlertTriangle, ExternalLink, RefreshCw } from "lucide-react";
import { commerceApi } from "@/lib/commerce-api";

type Readiness = {
  analytics: { ga4MeasurementId?: string; metaPixelId?: string; clarityProjectId?: string };
  feed: {
    activeProducts: number;
    eligibleItems: number;
    excludedItems: number;
    issues: Array<{ productId: string; variantId?: string; message: string; severity: "error" | "warning" }>;
  };
  businessMissing: string[];
};

export function AdminAcquisitionPanel({ onNavigate }: { onNavigate: (tab: string) => void }) {
  const [data, setData] = useState<Readiness>();
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try { setData(await commerceApi<Readiness>("/api/v1/admin/analytics/marketing")); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "Could not check marketing setup"); }
    finally { setLoading(false); }
  }, []);
  useEffect(() => { void load(); }, [load]);

  return <section className="panel form-panel acquisition-panel">
    <div className="panel-head">
      <div><h2>Website tracking and Google product listings</h2><p>Configuration and product-feed readiness. Confirm incoming events and listing approval in each provider.</p></div>
      <button type="button" onClick={() => void load()} disabled={loading} aria-label="Refresh marketing readiness"><RefreshCw className={loading ? "spin" : undefined} /></button>
    </div>
    {error && <p className="settings-error" role="alert"><AlertTriangle />{error}</p>}
    {!data && loading && <p>Checking setup…</p>}
    {data && <>
      <dl className="acquisition-status">
        <div><dt>Google Analytics 4</dt><dd>{data.analytics.ga4MeasurementId || "Not configured"}</dd></div>
        <div><dt>Meta Pixel</dt><dd>{data.analytics.metaPixelId || "Not configured"}</dd></div>
        <div><dt>Microsoft Clarity</dt><dd>{data.analytics.clarityProjectId || "Not configured"}</dd></div>
      </dl>
      <p>Optional trackers run after the visitor’s consent. Saved IDs do not prove that a provider has received data.</p>
      <button type="button" className="secondary" onClick={() => onNavigate("Integrations")}>Configure tracking IDs</button>
      <h3>Merchant Center feed</h3>
      <p>{data.feed.activeProducts} published products · {data.feed.eligibleItems} eligible variants · {data.feed.excludedItems} excluded variants</p>
      {data.feed.activeProducts === 0 && <p className="acquisition-warning">Publish real products with descriptions, images, prices and inventory before submitting the feed.</p>}
      <p>Google reviews your account and products separately. This feed does not automatically create listings or guarantee approval.</p>
      <div className="acquisition-links">
        <a href="/merchant-feed.xml" target="_blank" rel="noreferrer">Product feed <ExternalLink size={14} /></a>
        <a href="/sitemap.xml" target="_blank" rel="noreferrer">Sitemap <ExternalLink size={14} /></a>
        <a href="/robots.txt" target="_blank" rel="noreferrer">Crawler rules <ExternalLink size={14} /></a>
      </div>
      {data.businessMissing.length > 0 && <p className="acquisition-warning">Complete your business settings: {data.businessMissing.join(", ")}.</p>}
      {data.feed.issues.length > 0 && <ul className="acquisition-issues">{data.feed.issues.slice(0, 30).map((issue, index) => <li key={`${issue.productId}:${issue.variantId}:${index}`}><strong>{issue.severity === "error" ? "Needs correction" : "Check"}:</strong> {issue.message} <small>({issue.variantId || issue.productId})</small></li>)}</ul>}
      {data.feed.issues.length > 30 && <p>{data.feed.issues.length - 30} additional issues. Correct the listed products and refresh.</p>}
      <div className="acquisition-actions"><button type="button" className="secondary" onClick={() => onNavigate("Products")}>Manage products</button><button type="button" className="secondary" onClick={() => onNavigate("Settings")}>Business settings</button></div>
    </>}
  </section>;
}
