import { useEffect, useState } from "react";
import { useRouter, useRouterState } from "@tanstack/react-router";
import { initializeAnalytics, prepareAnalyticsNavigation, readAnalyticsConsent, saveAnalyticsConsent, syncAnalyticsPage } from "../../lib/analytics";
import { useStorefrontConfig } from "../../lib/storefront-config";
import { canShowOfferOnPath } from "../../lib/promotion-visibility";

export function AnalyticsConsent() {
  const router = useRouter();
  const { analyticsPromptEnabled } = useStorefrontConfig();
  const pathname = useRouterState({ select: state => state.location.pathname });
  const [visible, setVisible] = useState(false);
  const [manuallyOpened, setManuallyOpened] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  const [analytics, setAnalytics] = useState(false);
  const [advertising, setAdvertising] = useState(false);
  const [canClose, setCanClose] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    const current = readAnalyticsConsent();
    setAnalytics(current?.analytics || false);
    setAdvertising(current?.advertising || false);
    setCanClose(Boolean(current));
    const open = () => {
      const choice = readAnalyticsConsent();
      setAnalytics(choice?.analytics || false);
      setAdvertising(choice?.advertising || false);
      setCanClose(Boolean(choice));
      setManuallyOpened(true);
      setVisible(true);
    };
    window.addEventListener("varahi:analytics-preferences", open);
    void initializeAnalytics();
    const unsubscribe = router.subscribe("onBeforeNavigate", event => prepareAnalyticsNavigation(event.toLocation.href));
    return () => { unsubscribe(); window.removeEventListener("varahi:analytics-preferences", open); };
  }, [router]);
  useEffect(() => {
    if (!manuallyOpened) setVisible(!dismissed && analyticsPromptEnabled && canShowOfferOnPath(pathname) && !readAnalyticsConsent());
  }, [analyticsPromptEnabled, manuallyOpened, pathname, dismissed]);
  useEffect(() => { syncAnalyticsPage(); }, [pathname]);
  const save = (choice: { analytics: boolean; advertising: boolean }) => {
    if (saveAnalyticsConsent(choice)) { setVisible(false); setManuallyOpened(false); setCanClose(true); setError(""); }
    else setError("Your browser could not save this choice. Optional tracking remains off.");
  };
  if (!visible) return null;
  return <aside className="analytics-consent" aria-label="Cookie and tracking preferences" data-clarity-mask="true">
    <div className="analytics-consent-heading"><h2>Your privacy choices</h2>{(canClose || manuallyOpened) && <button type="button" className="analytics-consent-close" aria-label="Close privacy preferences" onClick={() => { setVisible(false); setDismissed(true); setManuallyOpened(false); }}>×</button>}</div>
    <p>Essential storage keeps sign-in and your basket working. With your permission, we also use Google Analytics and Microsoft Clarity to understand shopping, and Meta Pixel to measure advertising. Optional tools stay off until you choose.</p>
    <div className="analytics-consent-options">
      <label><input type="checkbox" checked={analytics} onChange={event => setAnalytics(event.target.checked)} /><span><strong>Analytics</strong><small>Shopping events and masked storefront recordings. Account and checkout recordings are excluded.</small></span></label>
      <label><input type="checkbox" checked={advertising} onChange={event => setAdvertising(event.target.checked)} /><span><strong>Advertising</strong><small>Meta Pixel measures product views, cart activity and purchases for advertising.</small></span></label>
    </div>
    <p className="analytics-consent-note">Change this anytime through Cookie preferences in the footer. Turning off an active tool reloads this page. <a href="/privacy">Read our privacy policy</a>.</p>
    {error && <p role="alert">{error}</p>}
    <div className="analytics-consent-actions"><button type="button" onClick={() => save({ analytics: false, advertising: false })}>Essential only</button><button type="button" onClick={() => save({ analytics, advertising })}>Save choices</button><button type="button" onClick={() => save({ analytics: true, advertising: true })}>Accept all</button></div>
  </aside>;
}
