import { useEffect, useRef } from "react";
import { initializeAnalytics, readAnalyticsConsent, trackCommerceEvent, type AnalyticsItem } from "./analytics";
import { commerceAmount } from "./commerce-analytics";

/** Once per displayed set; denied-consent events are deliberately not replayed. */
export function useCommerceImpression(name: string, items: AnalyticsItem[], itemListName?: string, enabled = true) {
  const previous = useRef("");
  const signature = JSON.stringify({ name, items, itemListName });
  useEffect(() => {
    if (!enabled) {
      previous.current = "";
      return;
    }
    const displayed = JSON.parse(signature) as { name: string; items: AnalyticsItem[]; itemListName?: string };
    if (!displayed.items.length || signature === previous.current) return;
    if (previous.current && (displayed.name === "begin_checkout" || displayed.name === "view_cart")) return;
    const consentAtView = readAnalyticsConsent();
    if (!consentAtView || (!consentAtView.analytics && !consentAtView.advertising)) {
      previous.current = signature;
      return;
    }
    let current = true;
    // Wait only for a previously consented current view's public configuration.
    // A later consent grant must never replay earlier merchandise impressions.
    void initializeAnalytics().then(() => {
      if (!current || readAnalyticsConsent()?.updatedAt !== consentAtView.updatedAt) return;
      previous.current = signature;
      trackCommerceEvent(displayed.name, {
        items: displayed.items,
        currency: "INR",
        value: commerceAmount(displayed.items.reduce((sum, item) => sum + item.price * item.quantity, 0)),
        ...(displayed.itemListName ? { item_list_name: displayed.itemListName } : {}),
      });
    });
    return () => { current = false; };
  }, [enabled, signature]);
}
