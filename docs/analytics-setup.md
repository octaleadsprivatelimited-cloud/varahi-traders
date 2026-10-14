# Sri Varahi Traders analytics setup and checks

Use Varahi’s approved owner account for the Google Analytics, Microsoft Clarity and Meta business assets. Do not configure assets owned by another signed-in account. Tracking IDs are public identifiers; no API secret or personal account password belongs in these settings.

## Connect providers

In the live site's **Admin → Integrations → LIVE → Analytics**, enable the relevant card and save its public ID:

- **Google Analytics 4:** Measurement ID (`G-…`) from the website data stream. Set the stream URL to `https://<Varahi-domain>`. Disable **Enhanced Measurement** for this stream, including browser-history page changes, form interactions and site search. This application emits its own page views and ecommerce events. `send_page_view: false` by itself does not disable GA4's enhanced history tracking. Google signals, advertising personalization and ad storage stay disabled in this implementation.
- **Microsoft Clarity:** Project ID from Settings → Setup. Set the correct site URL, strict masking and cookie consent required in Clarity. The application sends Consent V2 with analytics storage granted only after analytics opt-in; advertising storage remains denied. Do not unmask account, checkout or personal information.
- **Meta Pixel:** Pixel/dataset ID from the business's Events Manager. Keep automatic events and automatic advanced matching disabled. Only the application's explicit merchandise and conversion payloads should be sent. A Pixel ID is not a Conversions API token; this implementation does not require a server token.

The public endpoint `/api/v1/storefront/analytics` exposes only enabled, validated public IDs for the current deployment environment. TEST cards never run in production. An empty response means optional providers remain disconnected.

## What is measured

GA4: public storefront page views, product/list views and selection, wishlist additions, add/remove cart, cart views, checkout start, shipping/payment steps and confirmed purchases. Purchase value excludes tax and shipping; those amounts are separate. Merchandise IDs match the product variant identifiers used by the Merchant feed. An order acknowledgement or unverified online payment is not a purchase. Purchase deduplication is per provider and order, persisted in this browser with a bounded history.

Meta: PageView, ViewContent, AddToWishlist, AddToCart, InitiateCheckout, AddPaymentInfo and Purchase after advertising opt-in. No automatic advanced matching, user IDs or contact data are sent.

Clarity: masked public storefront layout and interactions after analytics opt-in. It does not load on checkout, account, admin, login or tracking pages. Recording stops before navigating into those pages or a URL with a query/fragment. After stopping, Clarity resumes only on a new full document load; it is not restarted inside a private SPA session.

No third-party analytics SDK loads before consent. Rejected events are discarded, not replayed if consent is later granted. Unknown/private routes are blocked. GA4 uses cleaned URLs with no queries/fragments, sanitized page titles and no personal referrers. Pixel and Clarity are additionally blocked in documents with potentially sensitive URL or referrer parameters because their SDKs can read the browser URL themselves. Search text, personal names, email, mobile, addresses, payment tokens and credentials are not ecommerce event parameters.

Users can reopen **Cookie preferences** from the footer or privacy policy. Withdrawing active consent disables dispatch, clears the site's accessible provider cookies and reloads the document to unload SDK listeners. This cannot erase data already received by a provider, and browsers cannot delete cookies belonging to another origin.

## Verification after connection

1. In a clean browser session, decline optional tracking. Confirm there are no requests to Google Analytics/Tag Manager, Facebook Pixel or Clarity. Account/login traffic to Google Firebase is authentication, separate from analytics.
2. Grant analytics only. Confirm GA4 and Clarity load, while Meta does not. In GA4 Realtime/DebugView, navigate home → shop → product and confirm one `page_view` per route. Enhanced Measurement must stay off.
3. Grant advertising and use Meta Events Manager's Test Events/Pixel Helper to check a product view and cart addition. Disable blockers for this controlled verification only. Do not place a real order just to test analytics.
4. Use a safe staging order or an existing confirmed test order to verify the purchase contains item IDs, quantity, item revenue, currency, tax, shipping and an order number, with no customer contact/address data. Reopen/reload it: each provider receives at most one purchase from this browser. Clearing browser storage removes this local deduplication history.
5. Navigate to checkout/account/admin and verify Clarity recording stops and private page data is absent. Payment-return query strings must not appear in provider payloads.
6. Reopen Cookie preferences and withdraw consent. Confirm reload, no subsequent provider scripts, and normal shopping/login behavior.

Provider dashboards can take time to populate and ad blockers can prevent browser collection. A configured card confirms configuration, not verified delivery. No visitor data needs to be fabricated to populate a dashboard.

## Primary documentation

- [GA4 manual page views and enhanced history behavior](https://developers.google.com/analytics/devguides/collection/ga4/views)
- [GA4 ecommerce events](https://developers.google.com/analytics/devguides/collection/ga4/ecommerce)
- [Google tag privacy controls](https://developers.google.com/tag-platform/security/guides/privacy)
- [Clarity Consent V2](https://learn.microsoft.com/en-us/clarity/setup-and-installation/clarity-consent-api-v2)
- [Clarity content masking API](https://learn.microsoft.com/en-us/clarity/setup-and-installation/clarity-api)
- [Meta Pixel implementation and consent](https://developers.facebook.com/docs/meta-pixel/implementation/gdpr/)
