import { Link } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { StorePage } from "./StoreHeader";
import { useStorefrontConfig } from "@/lib/storefront-config";
import { openAnalyticsPreferences } from "@/lib/analytics";
import { deliveryAnnouncement, deliveryEstimate } from "@/lib/delivery-policy";

export type InformationPageKind = "privacy" | "terms" | "shipping" | "contact";
type PolicyPage = { eyebrow: string; title: string; sections: ReadonlyArray<readonly [string, ReactNode]> };

export function InformationPage({ kind }: { kind: InformationPageKind }) {
  const store = useStorefrontConfig();
  const supportLink = store.supportEmail ? <a href={`mailto:${store.supportEmail}`}>{store.supportEmail}</a> : <span>Client contact details will be added before launch.</span>;
  const pages = {
    privacy: {
      eyebrow: "Your information",
      title: "Privacy policy",
      sections: [
        ["Who handles your information", <>{store.legalName || store.storeName} operates this store. This policy explains how we handle information when you browse, sign in, place an order or contact us. For privacy requests, contact {supportLink}.</>],
        ["Information we collect", "Google sign-in through Firebase provides your name, email address and account identifier. We also collect information you provide, including your phone number, delivery address, order details and support messages. We keep payment references and statuses, account activity and technical logs that can include your IP address and browser information. Do not include sensitive payment credentials in support messages."],
        ["How we use it", "We use information to authenticate your account, manage your basket and orders, arrange delivery, send order and account updates, answer support requests, resolve payment or product issues, prevent misuse and maintain business records. Browsing and shopping activity also helps us show product recommendations and offers."],
        ["Service providers and payments", "Google/Firebase supports authentication, and our hosting and database services support operation of the store. When used, payment providers such as Cashfree receive the information needed to process payments, couriers receive delivery details, and our email provider receives the information needed to send messages. Payment providers handle full card and bank credentials; the store keeps transaction references and status information. Providers may process data in other countries under their own terms. Information may also be disclosed where legally required."],
        ["Cookies and browser storage", "We use a sign-in cookie and browser storage for sessions, your basket, wishlist, recently viewed products and first-party recommendations or offers. You can clear or restrict cookies and site storage in your browser, but this can sign you out or reset saved preferences and your basket. Clearing browser data does not delete your account or order records."],
        ["Optional analytics and advertising", <>When configured and you opt in, Google Analytics 4 measures visits and shopping events; Microsoft Clarity provides masked recordings and heatmaps of public storefront interactions. Advertising consent separately enables Meta Pixel to measure visits and shopping conversions. These providers can receive device and browser information, IP addresses and cookie identifiers. Our ecommerce event payloads exclude your name, email, phone number, delivery address and payment credentials. Private account, login and admin pages are excluded, and Clarity does not record checkout. You can reject optional tracking or change your choice at any time using <button type="button" className="inline-policy-button" onClick={openAnalyticsPreferences}>Cookie preferences</button>. Withdrawing consent stops future optional collection; it does not erase information already received by providers. See the <a href="https://policies.google.com/privacy" target="_blank" rel="noreferrer">Google</a>, <a href="https://www.facebook.com/privacy/policy/" target="_blank" rel="noreferrer">Meta</a> and <a href="https://privacy.microsoft.com/privacystatement" target="_blank" rel="noreferrer">Microsoft</a> privacy policies for their practices.</>],
        ["Communications", <>Order, account and support messages relate to your use of the store. If you have requested promotional messages, you can contact {supportLink} to withdraw that request. Withdrawing marketing permission does not stop messages needed to service an existing order.</>],
        ["Retention and account deletion", "We retain information for account services, orders, support, security and applicable record-keeping obligations. You can request account deletion from your account profile after verifying your Google sign-in, or contact us for help. Deletion removes or redacts store account information, while transaction records and some security, audit, provider or backup records may remain where needed. It does not delete your Google account or automatically erase records held by Firebase or other providers."],
        ["Your requests and policy changes", <>Contact {supportLink} to request access, correction or deletion, or to raise a privacy concern. We may verify your identity before handling a request. We will publish policy changes here with an updated date.</>],
      ],
    },
    terms: {
      eyebrow: "Shopping with us",
      title: "Terms and conditions",
      sections: [
        ["The store and your account", <>{store.legalName || store.storeName} operates this store. Use your own Google account and provide accurate contact and delivery information. You are responsible for keeping your Google account secure and notifying us about unauthorised activity. Do not misuse the store, submit fraudulent orders or interfere with another customer’s account.</>],
        ["Products and food information", "Check the product description, quantity, pack size, ingredients and allergen information before ordering, and follow the storage and best-before instructions on the packaging. Natural ingredients may vary slightly in appearance between batches; this does not limit your rights if a product is unsafe, defective or materially different from its description."],
        ["Prices and payment", `Prices are displayed in ${store.currency}. Review the item prices, discounts, applicable taxes, delivery charges and final total at checkout before placing an order. Available payment methods are shown at checkout. Online payments are subject to confirmation by the payment provider; cash-on-delivery orders, when offered, remain payable on delivery.`],
        ["Orders and delivery", "Orders are subject to stock availability, delivery coverage and applicable payment checks. Review your address and phone number carefully before confirming. Delivery information and available tracking updates can be checked through your account. Contact us if an order is delayed, missing or shows an incorrect status."],
        ["Cancellations, returns and refunds", <>We do not offer cancellation refunds, returns or exchanges because you changed your mind or selected the wrong product after confirming an order. If we cannot fulfil an order, amounts paid for the unfulfilled part will be refunded. Product, delivery and payment problems are handled under our <Link to="/shipping-returns">returns and refund policy</Link>, including remedies required by law.</>],
        ["Support and consumer rights", <>Contact {supportLink} or use <Link to="/account" search={{ tab: "Support" }}>order support</Link> with your order number and a description of the issue. These terms are subject to applicable Indian law and do not exclude statutory consumer rights or your right to approach the appropriate consumer authority.</>],
        ["Privacy and updates", <>Our <Link to="/privacy">privacy policy</Link> explains how we use your information. Updated shopping terms apply to orders placed after publication; they do not remove rights relating to an existing order.</>],
      ],
    },
    shipping: {
      eyebrow: "Shipping, returns and refunds",
      title: "Our no-refund policy",
      sections: [
        ["No change-of-mind returns or refunds", "We do not accept returns, exchanges or refunds for a change of mind, personal taste preferences or a product selected by mistake. Please check the product details, pack size, quantity and delivery address before confirming your order. This policy does not take away remedies required by applicable consumer law."],
        ["Shipping and tracking", <>{deliveryAnnouncement(store)}. {store.manualDeliveryEnabled ? <>Estimated delivery: {deliveryEstimate(store)} after dispatch. </> : null}The free-delivery threshold applies to the item subtotal before GST. Final charges and available services are shown at checkout. You can check available shipment updates in <Link to="/account" search={{ tab: "My orders" }}>your orders</Link> or on the <Link to="/track">Track order</Link> page. Contact support if an order has not arrived or tracking appears incorrect.</>],
        ["Damaged, incorrect or undelivered orders", "Report damaged, defective, expired, wrong, missing or misdescribed goods, and undelivered orders, so we can investigate. Required remedies, including returns or refunds, remain available under applicable law. This also applies to late delivery where the law requires a remedy. Do not consume a product you believe is unsafe."],
        ["How to report a problem", <>Contact {supportLink} or <Link to="/account" search={{ tab: "Support" }}>order support</Link> as soon as you notice the issue. Include your order ID, the affected items and a description; photographs of the product and packaging help if available. Delivered-order issues can also be submitted in your account’s Returns section. A request starts a review and is not an automatic refund approval.</>],
        ["Return instructions and resolution", "Keep the affected product and packaging where safe to do so, and contact us before sending anything back. We will explain any collection or return instructions and the appropriate remedy after reviewing the issue. For a confirmed product or fulfilment fault requiring a return, we cover reasonable return shipping arranged with us. Statutory rights are not conditional on an unopened package."],
        ["Payment errors and orders we cannot fulfil", "The change-of-mind restriction does not apply to duplicate payments, money received for a failed order, or an order we cancel because we cannot fulfil it. Contact us with the order or transaction reference so we can reconcile the payment and arrange any amount due back. Never share your card PIN, CVV or OTP."],
        ["Refunds that are required", "Where a refund is due, we will confirm the amount and processing details and initiate it through the original payment method where possible. For cash-on-delivery or unavailable payment methods, we will agree a suitable alternative with you. Bank or payment-provider processing times can vary; we will provide available refund references. Applicable legal timelines and consumer rights continue to apply."],
      ],
    },
    contact: {
      eyebrow: "Customer care",
      title: "We’re here to help.",
      sections: [
        ["Email", supportLink],
        ...(store.supportPhone ? [["Phone", <a href={`tel:${store.supportPhone}`}>{store.supportPhone}</a>] as const] : []),
        ["Order help", <>Use <Link to="/account" search={{ tab: "Support" }}>order support</Link> or email us. Include your order number but never send passwords, OTPs or complete payment credentials.</>],
      ],
    },
  } as const satisfies Record<InformationPageKind, PolicyPage>;
  const page = pages[kind];
  return (
    <StorePage>
      <main className="information-page">
        <header>
          <p className="eyebrow">{page.eyebrow}</p>
          <h1>{page.title}</h1>
          <p>Last updated <time dateTime="2026-10-14">14 October 2026</time> · {store.legalName || store.storeName}</p>
        </header>
        <nav className="information-nav" aria-label="Store policies">
          <Link to="/privacy" aria-current={kind === "privacy" ? "page" : undefined}>Privacy policy</Link>
          <Link to="/terms" aria-current={kind === "terms" ? "page" : undefined}>Terms and conditions</Link>
          <Link to="/shipping-returns" aria-current={kind === "shipping" ? "page" : undefined}>Returns and refund policy</Link>
          <Link to="/contact" aria-current={kind === "contact" ? "page" : undefined}>Contact us</Link>
        </nav>
        <div>
          {page.sections.map(([title, copy]) => (
            <section key={title}><h2>{title}</h2><p>{copy}</p></section>
          ))}
          {(store.businessAddress || store.businessGstin) && <section>
            <h2>Business details</h2>
            <p>{store.legalName || store.storeName}{store.businessAddress && <><br />{store.businessAddress}</>}{store.businessGstin && <><br />GSTIN: {store.businessGstin}</>}</p>
          </section>}
        </div>
      </main>
    </StorePage>
  );
}
