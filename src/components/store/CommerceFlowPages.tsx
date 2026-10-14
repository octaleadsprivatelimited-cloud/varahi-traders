import { Link, useNavigate } from "@tanstack/react-router";
import { loadPortalSession } from "@/lib/portal-auth";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  ArrowLeft,
  ArrowRight,
  Check,
  Clock3,
  LockKeyhole,
  Minus,
  Plus,
  ShieldCheck,
  ShoppingBag,
  Truck,
} from "lucide-react";
import { trackCommerceEvent } from "@/lib/analytics";
import { analyticsItemsForCart, analyticsPurchase, commerceAmount, discountedCommerceItems, purchaseIsConfirmed, type AnalyticsOrder } from "@/lib/commerce-analytics";
import { useCommerceImpression } from "@/lib/commerce-analytics-hooks";
import { money } from "@/data/commerce";
import { useCommerceCart } from "@/lib/commerce-cart";
import { commerceApi, CommerceApiError, saveAccessToken } from "@/lib/commerce-api";
import { canAutofillDelivery, checkoutAutofill, checkoutMobileInput, defaultCheckoutAddress, deliveryFields, fillUntouchedFields, type CheckoutAddress, type CheckoutContact, type CheckoutProfile, type SavedCheckoutAddress } from "@/lib/checkout-autofill";
import { prepareFirebaseAuth, firebaseGoogleCredential, firebaseAuthMessage } from "@/lib/firebase-auth";
import { StoreBrand, useStorefrontConfig } from "@/lib/storefront-config";
import { StorePage } from "./StoreHeader";
import { customerTransactionPath, loginReturnPath } from "@/lib/transactions";
import { toast, Toaster } from "sonner";
import { usePostalLookup } from "@/lib/postal-lookup";
import { freeDeliveryQualifies } from "@/lib/delivery-policy";

type AppliedCoupon = { code: string; discount: number; freeShipping: boolean; appliesTo: "ALL_PRODUCTS" | "SELECTED_PRODUCTS" };
type DeliveryRate = {
  service: string;
  label: string;
  etaDays: number;
  etaMinDays?: number;
  baseAmount: number;
  shipping: number;
  currency: string;
  total: number;
};
type CheckoutQuote = {
  provider: string;
  rates: DeliveryRate[];
  selectedShipping: {
    service: string;
    label: string;
    etaDays: number;
    etaMinDays?: number;
    quotedAmount: number;
    chargedAmount: number;
    currency: string;
  };
  subtotal: number;
  tax: number;
  discount: number;
  couponDiscount: number;
  onlinePaymentDiscount: number;
  onlinePaymentOffer: { type: "PERCENTAGE" | "FIXED_AMOUNT"; value: number } | null;
  shipping: number;
  total: number;
  currency: string;
  freeShipping: boolean;
};
type PendingPayment = {
  analytics: ReturnType<typeof analyticsPurchase>;
  orderNumber: string;
  total: number;
  etaDays: number;
  message: string;
  attemptToken: string;
};
const newCheckoutKey = () =>
  typeof window === "undefined"
    ? crypto.randomUUID()
    : sessionStorage.getItem("varahi_commerce_checkout_key") || crypto.randomUUID();
function useCoupon(lines: ReturnType<typeof useCommerceCart>["lines"]) {
  const cartKey = JSON.stringify(lines.map(({ variant, entry, unitPrice, unresolved }) => ({ variantId: variant?.id, quantity: entry.quantity, unitPrice, unresolved })));
  const [input, setInput] = useState("");
  const [result, setResult] = useState<{ coupon: AppliedCoupon; cartKey: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const sequence = useRef(0);
  const invalidate = useCallback(() => { sequence.current++; }, []);
  const apply = useCallback(async (code: string, announce = true) => {
    const normalized = code.trim().toUpperCase();
    const currentLines = JSON.parse(cartKey) as Array<{ variantId?: string; quantity: number; unresolved: boolean }>;
    if (!normalized || !currentLines.length || currentLines.some(line => !line.variantId || line.unresolved)) {
      if (announce) toast.error(!normalized ? "Enter a coupon code" : "Wait for your bag to load before applying a coupon");
      return;
    }
    const request = ++sequence.current;
    setBusy(true); setError(""); setResult(null);
    try {
      const coupon = await commerceApi<AppliedCoupon>("/api/v1/coupons/validate", {
        method: "POST",
        body: JSON.stringify({ code: normalized, lines: currentLines.map(({ variantId, quantity }) => ({ variantId, quantity })) }),
      });
      if (request !== sequence.current) return;
      setResult({ coupon, cartKey }); setInput(coupon.code);
      sessionStorage.setItem("varahi_commerce_coupon", coupon.code);
      if (announce) toast.success(`${coupon.code} applied`);
    } catch (reason) {
      if (request !== sequence.current) return;
      setResult(null); sessionStorage.removeItem("varahi_commerce_coupon");
      const message = reason instanceof Error ? reason.message : "Coupon could not be applied";
      setError(message);
      if (announce) toast.error(message);
    } finally { if (request === sequence.current) setBusy(false); }
  }, [cartKey]);
  const remove = () => {
    sequence.current++; setResult(null); setInput(""); setError(""); setBusy(false);
    sessionStorage.removeItem("varahi_commerce_coupon");
  };
  useEffect(() => {
    setResult(null); setBusy(false); setError("");
    const saved = sessionStorage.getItem("varahi_commerce_coupon");
    if (saved) void apply(saved, false);
    return invalidate;
  }, [apply, invalidate]);
  return { input, setInput, applied: result?.cartKey === cartKey ? result.coupon : null, busy, error, apply: (code = input) => apply(code), remove };
}
function CouponEntry({ coupon }: { coupon: ReturnType<typeof useCoupon> }) {
  return <div className="store-coupon-entry">
    <form onSubmit={event => { event.preventDefault(); if (!coupon.busy) { if (coupon.applied) coupon.remove(); else void coupon.apply(); } }}>
      <input aria-label="Coupon code" placeholder="Coupon code" value={coupon.input} onChange={event => coupon.setInput(event.target.value.toUpperCase())} disabled={coupon.busy || !!coupon.applied} maxLength={40} />
      <button disabled={coupon.busy}>{coupon.busy ? "Checking…" : coupon.applied ? "Remove" : "Apply"}</button>
    </form>
    {coupon.error && <small role="alert">{coupon.error}</small>}
    {coupon.applied?.appliesTo === "SELECTED_PRODUCTS" && <small>Discount applies to eligible products only.</small>}
    {coupon.applied?.freeShipping && <small>Free shipping coupon applied.</small>}
  </div>;
}
export function CartPage() {
  const cart = useCommerceCart();
  useCommerceImpression("view_cart", analyticsItemsForCart(cart.lines));
  const storefront = useStorefrontConfig();
  const coupon = useCoupon(cart.lines);
  const qualifiesForFreeShipping =
    storefront.settingsLoaded !== false && (coupon.applied?.freeShipping ||
    freeDeliveryQualifies(storefront, cart.subtotal) || (storefront.manualDeliveryEnabled && storefront.deliveryCharge === 0));
  const estimatedShipping = qualifiesForFreeShipping ? 0 : storefront.manualDeliveryEnabled ? storefront.deliveryCharge : 0;
  const estimatedTotal = Math.max(
    0,
    cart.subtotal - (coupon.applied?.discount || 0) + estimatedShipping,
  );
  return (
    <StorePage>
      <main className="cart-page">
        <div className="flow-title">
          <p className="eyebrow">Your selection</p>
          <h1>Shopping bag</h1>
          <span>
            {cart.count} {cart.count === 1 ? "item" : "items"}
          </span>
        </div>
        {!cart.lines.length ? (
          <div className="empty-cart">
            <ShoppingBag />
            <h2>Your bag is waiting.</h2>
            <p>Explore cold-pressed oils for everyday cooking.</p>
            <Link to="/shop">
              Discover the oil collection <ArrowRight />
            </Link>
          </div>
        ) : (
          <div className="cart-layout">
            <section className="cart-page-lines">
              {cart.lines.map(
                ({ product, entry, index, variant, unitPrice, available, unresolved }) => (
                <article key={index}>
                  <div
                    className="line-art"
                    style={{ background: product.tone }}
                  >
                    {variant?.image || product.image ? (
                      <img
                        src={variant?.image || product.image}
                        alt={variant?.imageAlt || product.imageAlt || product.name}
                      />
                    ) : (
                      product.glyph
                    )}
                  </div>
                  <div>
                    <small>{product.category}</small>
                    <h2>{product.name}</h2>
                    {variant && (
                      <p>
                        {variant.title || Object.entries(variant.options)
                          .map(([k, v]) => `${k}: ${v}`)
                          .join(" · ")}
                      </p>
                    )}
                    {unresolved && (
                      <p role="alert">This option changed. Remove it and select an available option again.</p>
                    )}
                    <button onClick={() => cart.update(index, 0)}>
                      Remove
                    </button>
                  </div>
                  <div className="line-qty">
                    <button
                      onClick={() => cart.update(index, entry.quantity - 1)}
                    >
                      <Minus />
                    </button>
                    <span>{entry.quantity}</span>
                    <button
                      onClick={() => cart.update(index, entry.quantity + 1)}
                      disabled={unresolved || entry.quantity >= available}
                      aria-label={`Increase ${product.name} quantity`}
                    >
                      <Plus />
                    </button>
                  </div>
                  <strong>{money(unitPrice * entry.quantity)}</strong>
                </article>
                ),
              )}
            </section>
            <aside className="order-summary">
              <h2>Order summary</h2>
              <div>
                <span>Subtotal before GST</span>
                <b>{money(cart.subtotal)}</b>
              </div>
              <div>
                <span>Shipping</span>
                <b>
                  {qualifiesForFreeShipping
                    ? "Complimentary"
                    : storefront.manualDeliveryEnabled ? money(storefront.deliveryCharge) : "Calculated at checkout"}
                </b>
              </div>
              <div>
                <span>Estimated GST</span>
                <b>Calculated at checkout</b>
              </div>
              {coupon.applied&&<div className="coupon-saving"><span>Coupon {coupon.applied.code}</span><b>−{money(coupon.applied.discount)}</b></div>}
              <hr />
              <div className="summary-total">
                <span>Estimated total before GST</span>
                <b>{money(estimatedTotal)}</b>
              </div>
              <CouponEntry coupon={coupon} />
              <Link to="/checkout">
                Proceed to checkout <ArrowRight />
              </Link>
              <p>
                <LockKeyhole /> Secure and encrypted checkout
              </p>
            </aside>
          </div>
        )}
      </main>
      <Toaster richColors />
    </StorePage>
  );
}

export function CheckoutPage() {
  const cart = useCommerceCart();
  const storefront = useStorefrontConfig();
  const coupon = useCoupon(cart.lines);
  const checkoutKey = useRef(newCheckoutKey());
  const editedDetails = useRef(new Set<string>());
  const checkoutProfile = useRef<CheckoutProfile | null>(null);
  const [savedAddresses, setSavedAddresses] = useState<SavedCheckoutAddress[]>([]);
  const [selectedAddressId, setSelectedAddressId] = useState("");
  const [savedDetailsStatus, setSavedDetailsStatus] = useState<"loading" | "ready" | "guest" | "error">("loading");
  const [savedDetailsAttempt, setSavedDetailsAttempt] = useState(0);
  const quoteRequestSequence = useRef(0);
  const [lookupPin, setLookupPin] = useState("");
  const postalEdits = useRef(new Set<string>());
  const [step, setStep] = useState(1),
    [placed, setPlaced] = useState(false),
    [orderNumber, setOrderNumber] = useState(""),
    [confirmedTotal, setConfirmedTotal] = useState(0),
    [estimatedDelivery, setEstimatedDelivery] = useState(""),
    [postalCode, setPostalCode] = useState(""),
    [gstin,setGstin]=useState(""),
    [contact, setContact] = useState<CheckoutContact>({ name: "", email: "", phone: "" }),
    [address, setAddress] = useState<CheckoutAddress>({ line1: "", line2: "", city: "", state: "", country: "IN" }),
    [paymentProvider, setPaymentProvider] = useState("cod"),
    [cashfreeEnabled, setCashfreeEnabled] = useState(false),
    [codEnabled, setCodEnabled] = useState(false),
    [checkoutAvailability, setCheckoutAvailability] = useState<"loading" | "ready" | "unavailable" | "error">("loading"),
    [selectedService, setSelectedService] = useState(""),
    [quote, setQuote] = useState<CheckoutQuote | null>(null),
    [quoteBusy, setQuoteBusy] = useState(false),
    [quoteError, setQuoteError] = useState(""),
    [pendingPayment, setPendingPayment] = useState<PendingPayment | null>(null),
    [paymentSubmitted, setPaymentSubmitted] = useState<PendingPayment | null>(null),
    [busy, setBusy] = useState(false);
  useCommerceImpression("begin_checkout", analyticsItemsForCart(cart.lines), undefined, checkoutAvailability === "ready");
  const postalLookup = usePostalLookup(lookupPin, location => {
    const suggestion = { ...(location.city ? { city: location.city } : {}), ...(location.state ? { state: location.state } : {}) };
    setAddress(current => fillUntouchedFields(current, suggestion, postalEdits.current));
    for (const field of Object.keys(suggestion)) editedDetails.current.add(field);
  });

  const checkCheckoutAvailability = useCallback(async () => {
    setCheckoutAvailability(current => current === "ready" ? current : "loading");
    try {
      const result = await commerceApi<{ cashfree: { enabled: boolean }; cod: { enabled: boolean }; checkout: { enabled: boolean } }>("/api/v1/payments/providers");
      setCashfreeEnabled(result.cashfree.enabled);
      setCodEnabled(result.cod.enabled);
      setPaymentProvider(current => current === "cod" && result.cod.enabled || current === "cashfree" && result.cashfree.enabled ? current : result.cashfree.enabled ? "cashfree" : result.cod.enabled ? "cod" : "");
      setCheckoutAvailability(result.checkout?.enabled === true ? "ready" : "unavailable");
    } catch {
      setCashfreeEnabled(false);
      setCodEnabled(false);
      setCheckoutAvailability("error");
    }
  }, []);

  useEffect(() => {
    sessionStorage.setItem("varahi_commerce_checkout_key", checkoutKey.current);
    void checkCheckoutAvailability();
    const refresh = () => { void checkCheckoutAvailability(); };
    window.addEventListener("focus", refresh);
    const timer = setInterval(() => { if (document.visibilityState === "visible") refresh(); }, 30_000);
    return () => { window.removeEventListener("focus", refresh); clearInterval(timer); };
  }, [checkCheckoutAvailability, storefront.manualDeliveryEnabled, storefront.codEnabled]);

  useEffect(() => {
    // Delivery setup must be ready before opening the checkout form or loading
    // saved personal details. This does not bypass the store's readiness gate.
    if (checkoutAvailability !== "ready") return;
    let cancelled = false;
    setSavedDetailsStatus("loading");
    const loadSavedDetails = async () => {
      try {
        const profile = await loadPortalSession();
        if (cancelled) return;
        checkoutProfile.current = profile;
        setContact((current) => fillUntouchedFields(current, checkoutAutofill(profile).contact, editedDetails.current));
        const addresses = await commerceApi<SavedCheckoutAddress[]>("/api/v1/account/addresses");
        if (cancelled) return;
        const available = addresses.filter((item) => item.country.toUpperCase() === "IN");
        setSavedAddresses(available);
        const preferred = defaultCheckoutAddress(available);
        if (preferred && canAutofillDelivery(editedDetails.current)) {
          const values = checkoutAutofill(profile, preferred);
          setAddress((current) => canAutofillDelivery(editedDetails.current) ? values.address! : current);
          setPostalCode((current) => canAutofillDelivery(editedDetails.current) ? values.postalCode! : current);
          setContact((current) => fillUntouchedFields(current, values.contact, editedDetails.current));
          setSelectedAddressId(preferred.id);
        }
        setSavedDetailsStatus("ready");
      } catch (error) {
        if (cancelled) return;
        setSavedDetailsStatus(error instanceof CommerceApiError && error.status === 401 ? "guest" : "error");
      }
    };
    void loadSavedDetails();
    return () => { cancelled = true; };
  }, [checkoutAvailability, savedDetailsAttempt]);

  const changeContact = (field: keyof CheckoutContact, value: string) => {
    editedDetails.current.add(field);
    setContact((current) => ({ ...current, [field]: value }));
  };
  const changeAddress = (field: keyof CheckoutAddress, value: string) => {
    postalEdits.current.add(field);
    editedDetails.current.add(field);
    setSelectedAddressId("");
    setAddress((current) => ({ ...current, [field]: value }));
  };
  const chooseSavedAddress = (id: string) => {
    setLookupPin("");
    setSelectedAddressId(id);
    for (const field of deliveryFields) editedDetails.current.add(field);
    const selected = savedAddresses.find((item) => item.id === id);
    if (!selected) {
      setAddress({ line1: "", line2: "", city: "", state: "", country: "IN" });
      setPostalCode("");
      return;
    }
    const values = checkoutAutofill(checkoutProfile.current || contact, selected);
    setAddress(values.address!);
    setPostalCode(values.postalCode!);
    editedDetails.current.add("phone");
    setContact((current) => ({ ...current, phone: values.contact.phone }));
  };

  const checkoutLines = () =>
    cart.lines.map(({ product, entry, variant, available, unresolved }) => {
      if (unresolved || !variant)
        throw new Error(
          `${product.name} has changed. Remove it from your bag and select an available option again.`,
        );
      if (entry.quantity > available)
        throw new Error(
          `Only ${available} of ${product.name} (${variant.title || Object.values(variant.options).join(" / ")}) is available.`,
        );
      return { variantId: variant.id, quantity: entry.quantity };
    });

  const requestQuote = async (
    provider = paymentProvider,
    service = selectedService,
    showError = true,
  ) => {
    const sequence = ++quoteRequestSequence.current;
    setQuoteBusy(true);
    setQuoteError("");
    try {
      const body = {
        lines: checkoutLines(),
        postalCode,
        paymentProvider: provider,
        couponCode: coupon.applied?.code,
        shippingService: service || undefined,
      };
      let nextQuote: CheckoutQuote;
      try {
        nextQuote = await commerceApi<CheckoutQuote>("/api/v1/checkout/quote", {
          method: "POST",
          body: JSON.stringify(body),
        });
      } catch (error) {
        if (
          service &&
          error instanceof CommerceApiError &&
          error.code === "SHIPPING_SERVICE_UNAVAILABLE"
        ) {
          nextQuote = await commerceApi<CheckoutQuote>(
            "/api/v1/checkout/quote",
            {
              method: "POST",
              body: JSON.stringify({ ...body, shippingService: undefined }),
            },
          );
        } else {
          throw error;
        }
      }
      if (sequence !== quoteRequestSequence.current) return null;
      setQuote(nextQuote);
      setSelectedService(nextQuote.selectedShipping.service);
      return nextQuote;
    } catch (error) {
      if (sequence !== quoteRequestSequence.current) return null;
      const message =
        error instanceof CommerceApiError && error.code === "SHIPPING_NOT_CONFIGURED"
          ? "Delivery is temporarily unavailable. Please try again later or contact the store."
          : error instanceof Error
          ? error.message
          : "Delivery rates could not be calculated";
      setQuote(null);
      setQuoteError(message);
      if (showError) toast.error(message);
      return null;
    } finally {
      if (sequence === quoteRequestSequence.current) setQuoteBusy(false);
    }
  };

  const validateDeliveryDetails = () => {
    if (!/^[1-9]\d{5}$/.test(postalCode)) {
      toast.error("Enter a valid 6-digit PIN code");
      return false;
    }
    if (!/^[6-9]\d{9}$/.test(contact.phone)) {
      toast.error("Enter a valid 10-digit Indian mobile number. The +91 country code is already selected.");
      return false;
    }
    if (
      contact.name.trim().length < 2 ||
      !/^\S+@\S+\.\S+$/.test(contact.email) ||
      address.line1.trim().length < 3 ||
      address.city.trim().length < 2 ||
      address.state.trim().length < 2
    ) {
      toast.error("Complete your contact and delivery address");
      return false;
    }
    return true;
  };

  const continueToDelivery = async () => {
    if (!validateDeliveryDetails()) return;
    if (await requestQuote(paymentProvider, "")) setStep(2);
  };

  const chooseDelivery = async (service: string) => {
    setSelectedService(service);
    await requestQuote(paymentProvider, service);
  };

  const choosePayment = (provider: string) => {
    setPaymentProvider(provider);
  };

  useEffect(() => {
    if (step >= 2 && !coupon.busy) void requestQuote(paymentProvider, selectedService);
  // Requote only when the applied coupon changes; requestQuote reads current checkout state.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [coupon.applied?.code, coupon.applied?.discount, coupon.applied?.freeShipping, coupon.busy]);
  useEffect(() => {
    if (step >= 2 && paymentProvider) void requestQuote(paymentProvider, selectedService);
  // An admin pricing update replaces the displayed quote; placement also revalidates it.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [paymentProvider, storefront.deliveryCharge, storefront.freeShippingThreshold, storefront.deliveryMinDays, storefront.deliveryMaxDays, storefront.onlinePaymentDiscountEnabled, storefront.onlinePaymentDiscountType, storefront.onlinePaymentDiscountValue]);

  const continueToPayment = () => {
    if (!quote || quoteBusy || coupon.busy || !selectedService) return;
    trackCommerceEvent("add_shipping_info", {
      items: discountedCommerceItems(analyticsItemsForCart(cart.lines), quote.discount),
      currency: quote.currency,
      value: commerceAmount(Math.max(0, quote.subtotal - quote.discount)),
      shipping_tier: quote.selectedShipping.service,
    });
    setStep(3);
  };

  const subtotal = quote?.subtotal ?? cart.subtotal,
    tax = quote?.tax ?? 0,
    discount = quote?.discount ?? coupon.applied?.discount ?? 0,
    shipping = quote?.shipping,
    total = quote?.total ?? Math.max(0, subtotal - discount);
  const completeOrder = (number: string, orderTotal: number, etaDays: number, analytics: ReturnType<typeof analyticsPurchase>) => {
    trackCommerceEvent("purchase", analytics, { dedupeKey: `purchase:${number}` });
    setOrderNumber(number);
    setConfirmedTotal(orderTotal);
    setEstimatedDelivery(
      new Date(Date.now() + etaDays * 86_400_000).toLocaleDateString(
        storefront.locale,
        { day: "numeric", month: "long", year: "numeric" },
      ),
    );
    setPendingPayment(null);
    setPaymentSubmitted(null);
    cart.clear();
    setPlaced(true);
  };
  const openCashfree = async (payment: { externalId: string; clientToken?: string; environment?: "TEST" | "LIVE"; attemptToken: string }, _number: string) => {
    if (!payment.clientToken) throw new Error("Payment session is unavailable. Please retry.");
    if (!(window as any).Cashfree) await new Promise<void>((resolve, reject) => {
      const script = document.createElement("script");
      script.src = "https://sdk.cashfree.com/js/v3/cashfree.js";
      script.async = true;
      script.onload = () => resolve();
      script.onerror = () => { script.remove(); reject(new Error("Cashfree checkout could not be loaded")); };
      document.head.appendChild(script);
    });
    const gateway = (window as any).Cashfree({ mode: payment.environment === "LIVE" ? "production" : "sandbox" });
    const result = await gateway.checkout({ paymentSessionId: payment.clientToken, redirectTarget: "_modal" });
    if (result?.error) throw new Error(result.error.message || "Payment was not completed. You can retry safely.");
  };
  const placeOrder = async () => {
    if (coupon.busy) return;
    if (!validateDeliveryDetails()) {
      setStep(1);
      return;
    }
    setBusy(true);
    try {
      const reviewedTotal = quote?.total;
      const latestQuote = await requestQuote(
        paymentProvider,
        selectedService,
        false,
      );
      if (!latestQuote)
        throw new Error(
          quoteError || "Please refresh the delivery quote before paying",
        );
      if (reviewedTotal !== undefined && Math.abs(reviewedTotal - latestQuote.total) > 0.001) {
        toast.info("Order pricing has changed. Review the updated total and place your order again.");
        return;
      }
      const result = await commerceApi<{ order: AnalyticsOrder; payment: { externalId: string; clientToken?: string; environment?: "TEST" | "LIVE" } | null; paymentAttemptToken:string|null; shipping?: { etaDays: number }; paymentFailure?:{message:string;fallbackOptions:string[]} }>(
        "/api/v1/checkout",
        {
          method: "POST",
          headers: { "idempotency-key": checkoutKey.current },
          body: JSON.stringify({ lines: checkoutLines(), postalCode, paymentProvider, shippingService: latestQuote.selectedShipping.service, expectedTotal: latestQuote.total, contact: { ...contact, phone: normalizeMobile(contact.phone) }, shippingAddress: address, couponCode: coupon.applied?.code, gstin:gstin||undefined }),
        },
      );
      const orderAnalytics = analyticsPurchase(result.order);
      trackCommerceEvent("add_payment_info", {
        items: orderAnalytics.items,
        currency: orderAnalytics.currency,
        value: orderAnalytics.value,
        payment_type: paymentProvider === "cod" ? "Cash on delivery" : "Cashfree",
      }, { dedupeKey: `payment-info:${result.order.number}` });
      setOrderNumber(result.order.number);
      const etaDays = result.shipping?.etaDays ?? latestQuote.selectedShipping.etaDays;
      sessionStorage.removeItem("varahi_commerce_checkout_key");
      // The server has reserved inventory and created the order. Keeping these
      // lines in the bag would let the customer accidentally order them twice.
      cart.clear();
      if (result.paymentFailure) {
        const message =
          "The selected payment gateway is temporarily unavailable. Your saved order can be retried safely below.";
        setPendingPayment({
          analytics: orderAnalytics,
          orderNumber: result.order.number,
          total: result.order.total,
          etaDays,
          message,
          attemptToken: result.paymentAttemptToken!,
        });
        toast.error(message);
        return;
      }
      if (paymentProvider !== "cod") {
        if (!result.payment) {
          setPendingPayment({
            analytics: orderAnalytics,
            orderNumber: result.order.number,
            total: result.order.total,
            etaDays,
            message:
              "The payment attempt could not be opened. Your order is saved and can be retried safely below.",
            attemptToken: result.paymentAttemptToken!,
          });
          return;
        }
        try {
          await openCashfree({ ...result.payment, attemptToken: result.paymentAttemptToken! }, result.order.number);
        } catch (error) {
          const message =
            error instanceof Error
              ? error.message
              : "The payment attempt could not be completed.";
          setPendingPayment({
            analytics: orderAnalytics,
            orderNumber: result.order.number,
            total: result.order.total,
            etaDays,
            message,
            attemptToken: result.paymentAttemptToken!,
          });
          toast.error(message);
          return;
        }
        const submitted = {
          analytics: orderAnalytics,
          orderNumber: result.order.number,
          total: result.order.total,
          etaDays,
          message:
            "Your payment was submitted and is awaiting secure gateway confirmation.",
          attemptToken: result.paymentAttemptToken!,
        };
        setPaymentSubmitted(submitted);
        await verifySubmittedPayment(submitted);
        return;
      }
      if (purchaseIsConfirmed("cod", result.order.status)) completeOrder(result.order.number, result.order.total, etaDays, orderAnalytics);
    } catch (error) {
      if (error instanceof CommerceApiError && error.code === "CHECKOUT_PRICE_CHANGED")
        await requestQuote(paymentProvider, selectedService, false);
      toast.error(
        error instanceof Error
          ? error.message
          : "Checkout could not be completed",
      );
    } finally {
      setBusy(false);
    }
  };
  const verifySubmittedPayment = async (submitted: PendingPayment) => {
    setBusy(true);
    try {
      const result = await commerceApi<{ status: string; orderStatus: string }>("/api/v1/payments/verify", { method: "POST", body: JSON.stringify({ orderNumber: submitted.orderNumber, provider: "cashfree", attemptToken: submitted.attemptToken }) });
      if (purchaseIsConfirmed("cashfree", result.orderStatus, result.status)) completeOrder(submitted.orderNumber, submitted.total, submitted.etaDays, submitted.analytics);
      else toast.info("Payment is still awaiting confirmation. Please check again shortly.");
    } catch (error) { toast.error(error instanceof Error ? error.message : "Payment verification is temporarily unavailable"); }
    finally { setBusy(false); }
  };
  const retryPayment = async () => {
    if (!pendingPayment) return;
    setBusy(true);
    try {
      const result = await commerceApi<{
        order: { number: string; status: string };
        payment: { externalId: string; clientToken?: string; environment?: "TEST" | "LIVE" };
        paymentAttemptToken: string;
      }>("/api/v1/payments/retry", {
        method: "POST",
        body: JSON.stringify({
          orderNumber: pendingPayment.orderNumber,
          provider: "cashfree",
          attemptToken: pendingPayment.attemptToken,
        }),
      });
      await openCashfree({ ...result.payment, attemptToken: result.paymentAttemptToken }, result.order.number);
      setPendingPayment(null);
      const submitted = {
        ...pendingPayment,
        attemptToken: result.paymentAttemptToken,
        orderNumber: result.order.number,
        message:
          "Your payment was submitted and is awaiting secure gateway confirmation.",
      };
      setPaymentSubmitted(submitted);
      await verifySubmittedPayment(submitted);
    } catch (error) {
      toast.error(
        error instanceof Error
          ? error.message
          : "The payment retry could not be completed",
      );
    } finally {
      setBusy(false);
    }
  };
  if (checkoutAvailability !== "ready")
    return (
      <StorePage>
        <main className="confirmation">
          <div role="status">
            <ShoppingBag />
            <h1>{checkoutAvailability === "loading" ? "Checking checkout…" : checkoutAvailability === "error" ? "Checkout could not be loaded." : "Checkout is temporarily unavailable."}</h1>
            <p>{checkoutAvailability === "loading" ? "Checking payment and delivery availability for your order." : checkoutAvailability === "error" ? "Please check your connection and try again. Your bag is unchanged." : "Ordering is temporarily paused while payment or delivery options are unavailable. Your items will stay in your bag."}</p>
            {checkoutAvailability === "error" ? <button type="button" onClick={() => void checkCheckoutAvailability()}>Try again</button> : null}
            {checkoutAvailability !== "loading" ? <Link to="/cart">Return to your bag <ArrowRight /></Link> : null}
          </div>
        </main>
      </StorePage>
    );
  if (placed)
    return (
      <StorePage>
        <main className="confirmation">
          <div>
            <Check />
            <p className="eyebrow">Order confirmed</p>
            <h1>Thank you, {contact.name.split(" ")[0] || "there"}.</h1>
            <p>
              Your order <b>#{orderNumber}</b> has been received. You can follow
              its progress on the order tracking page.
            </p>
            <div>
              <span>
                Order total <b>{money(confirmedTotal)}</b>
              </span>
              <span>
                Estimated delivery <b>{estimatedDelivery}</b>
              </span>
            </div>
            <Link to="/track">
              Track your order <ArrowRight />
            </Link>
            <a href={customerTransactionPath(orderNumber)}>View transaction &amp; invoice</a>
          </div>
        </main>
      </StorePage>
    );
  if (paymentSubmitted)
    return (
      <StorePage>
        <Toaster richColors />
        <main className="confirmation">
          <div>
            <Clock3 />
            <p className="eyebrow">Verification in progress</p>
            <h1>Payment submitted.</h1>
            <p>
              Order <b>#{paymentSubmitted.orderNumber}</b> is saved and the
              payment gateway is confirming the transaction. We will update
              the order as soon as the verified result arrives.
            </p>
            <div>
              <span>
                Submitted amount <b>{money(paymentSubmitted.total)}</b>
              </span>
              <span>
                Status <b>Pending verification</b>
              </span>
            </div>
            <button disabled={busy} onClick={() => void verifySubmittedPayment(paymentSubmitted)}>{busy ? "Verifying…" : "Verify payment status"}</button>
            <Link to="/track">
              Check order status <ArrowRight />
            </Link>
            <a href={customerTransactionPath(paymentSubmitted.orderNumber)}>View transaction details</a>
          </div>
        </main>
      </StorePage>
    );
  if (pendingPayment)
    return (
      <StorePage>
        <Toaster richColors />
        <main className="confirmation">
          <div>
            <Clock3 />
            <p className="eyebrow">Payment pending</p>
            <h1>Your order is safely saved.</h1>
            <p>
              Order <b>#{pendingPayment.orderNumber}</b> was created, but payment
              has not completed. Retrying below adds a new payment attempt to
              this same order—it does not create a duplicate order.
            </p>
            <p role="alert">{pendingPayment.message}</p>
            <button disabled={busy} onClick={() => void verifySubmittedPayment(pendingPayment)}>Already paid? Verify payment</button>
            <div>
              <span>
                Amount due <b>{money(pendingPayment.total)}</b>
              </span>
              <span>
                Contact <b>{contact.email}</b>
              </span>
            </div>
            <button className="continue" onClick={retryPayment} disabled={busy}>
              {busy ? "Opening secure payment…" : "Retry secure payment"}{" "}
              <LockKeyhole />
            </button>
            <Link to="/track">
              Track saved order <ArrowRight />
            </Link>
            <a href={customerTransactionPath(pendingPayment.orderNumber)}>View transaction details</a>
          </div>
        </main>
      </StorePage>
    );
  return (
    <div className="checkout-shell">
      <Toaster richColors position="bottom-center" />
      <header>
        <StoreBrand />
        <span>
          <LockKeyhole /> Secure checkout
        </span>
      </header>
      <main>
        <section>
          <Link to="/cart" className="back-link">
            <ArrowLeft /> Return to bag
          </Link>
          <div className="checkout-steps">
            {["Contact", "Delivery", "Payment"].map((x, i) => (
              <button
                className={
                  step === i + 1 ? "active" : step > i + 1 ? "done" : ""
                }
                onClick={() => i + 1 < step && setStep(i + 1)}
                disabled={i + 1 > step}
                key={x}
              >
                <i>{step > i + 1 ? <Check /> : i + 1}</i>
                <span>{x}</span>
              </button>
            ))}
          </div>
          {step === 1 && (
            <div className="checkout-form">
              <p className="eyebrow">Step 1 of 3</p>
              <h1>Where should we send it?</h1>
              {savedDetailsStatus === "loading" ? <p role="status">Loading your saved details… You can also enter them below.</p> : null}
              {savedDetailsStatus === "error" ? <p role="status">Your saved details could not be loaded. Enter them below or <button type="button" onClick={() => setSavedDetailsAttempt((attempt) => attempt + 1)}>try again</button>.</p> : null}
              {savedAddresses.length ? <label>
                Delivery address
                <select value={selectedAddressId} onChange={(event) => chooseSavedAddress(event.target.value)} autoComplete="off">
                  <option value="">Enter a different address</option>
                  {savedAddresses.map((item) => <option value={item.id} key={item.id}>{item.label}{item.isDefault ? " (default)" : ""} — {item.line1}, {item.city} {item.postalCode}</option>)}
                </select>
                <small>Check your details below. You can edit every field for this order.</small>
              </label> : null}
              <label>
                Email address
                <input value={contact.email} onChange={(event) => changeContact("email", event.target.value)} type="email" autoComplete="email" required />
              </label>
              <label>
                Full name
                <input value={contact.name} onChange={(event) => changeContact("name", event.target.value)} autoComplete="name" required />
              </label>
              <label>
                Address
                <input value={address.line1} onChange={(event) => changeAddress("line1", event.target.value)} placeholder="House number and street" autoComplete="address-line1" required />
              </label>
              <label>
                Apartment, suite, etc. <small>(optional)</small>
                <input value={address.line2} onChange={(event) => changeAddress("line2", event.target.value)} autoComplete="address-line2" />
              </label>
              <div className="three-fields">
                <label>
                  City
                  <input value={address.city} onChange={(event) => changeAddress("city", event.target.value)} autoComplete="address-level2" required />
                </label>
                <label>
                  State
                  <input value={address.state} onChange={(event) => changeAddress("state", event.target.value)} autoComplete="address-level1" placeholder="State or union territory" required />
                </label>
                <label>
                  PIN code
                  <input
                    inputMode="numeric"
                    value={postalCode}
                    onChange={(event) => {
                      editedDetails.current.add("postalCode");
                      setSelectedAddressId("");
                      const pin = event.target.value.replace(/\D/g, "").slice(0, 6);
                      postalEdits.current.clear();
                      setPostalCode(pin); setLookupPin(pin);
                    }}
                    maxLength={6}
                    autoComplete="postal-code"
                    pattern="[1-9][0-9]{5}"
                    required
                  />
                </label>
              </div>
              {postalLookup.message ? <p role="status">{postalLookup.message}{!postalLookup.loading && !postalLookup.location ? <> <button type="button" onClick={postalLookup.retry}>Retry lookup</button></> : null}</p> : <p><small>Enter your PIN code to suggest the city and state. Your house number and street are still required.</small></p>}
              <label>
                Phone number <small>(required for delivery)</small>
                <div className="indian-phone-input"><span>+91</span><input aria-label="10-digit mobile number" type="tel" inputMode="numeric" autoComplete="tel-national" maxLength={20} pattern="[6-9][0-9]{9}" value={contact.phone} onChange={(event) => changeContact("phone", checkoutMobileInput(event.target.value))} placeholder="9876543210" required /></div>
              </label>
              <label>GSTIN <small>(optional, shown on invoice)</small><input value={gstin} onChange={event=>setGstin(event.target.value.toUpperCase())} maxLength={15} placeholder="22AAAAA0000A1Z5" /></label>
              <button className="continue" onClick={continueToDelivery} disabled={quoteBusy || coupon.busy || !cart.lines.length}>
                {quoteBusy ? "Checking delivery…" : "Continue to delivery"} <ArrowRight />
              </button>
            </div>
          )}
          {step === 2 && (
            <div className="checkout-form">
              <p className="eyebrow">Step 2 of 3</p>
              <h1>Choose your delivery.</h1>
              {quoteBusy && !quote && <p>Checking delivery services…</p>}
              {quoteError && <p role="alert">{quoteError}</p>}
              {quote?.rates.map((rate) => (
                <label className="delivery-choice" key={rate.service}>
                  <input
                    type="radio"
                    name="delivery"
                    checked={selectedService === rate.service}
                    onChange={() => void chooseDelivery(rate.service)}
                    disabled={quoteBusy}
                  />
                  <Truck />
                  <span>
                    <b>{rate.label}</b>
                    <small>
                      Estimated in {rate.etaMinDays && rate.etaMinDays !== rate.etaDays ? `${rate.etaMinDays}–${rate.etaDays}` : rate.etaDays}{" "}
                      {rate.etaDays === 1 ? "business day" : "business days"}
                    </small>
                  </span>
                  <strong>{rate.shipping ? money(rate.shipping) : "Free"}</strong>
                </label>
              ))}
              <button className="continue" onClick={continueToPayment} disabled={quoteBusy || coupon.busy || !quote || !selectedService}>
                {quoteBusy ? "Updating total…" : "Continue to payment"} <ArrowRight />
              </button>
            </div>
          )}
          {step === 3 && (
            <div className="checkout-form">
              <p className="eyebrow">Step 3 of 3</p>
              <h1>Payment.</h1>
              {quoteError && <p role="alert">{quoteError}</p>}
              <div className="payment-choice">
                <label>
                  <input
                    type="radio"
                    name="pay"
                    checked={paymentProvider === "cashfree"}
                    onChange={() => void choosePayment("cashfree")}
                    disabled={quoteBusy || !cashfreeEnabled}
                  />
                  <span>
                    <b>Cards, UPI & Netbanking</b>
                    <small>{cashfreeEnabled ? "Processed securely by Cashfree" : "Online payment is currently unavailable."}</small>
                    {cashfreeEnabled && storefront.onlinePaymentDiscountEnabled && storefront.onlinePaymentDiscountValue > 0 && <small className="online-offer-note">Save up to {storefront.onlinePaymentDiscountType === "PERCENTAGE" ? `${storefront.onlinePaymentDiscountValue}%` : money(storefront.onlinePaymentDiscountValue)} on items after coupons when paying online. Minimum ₹1 payable.</small>}
                  </span>
                </label>
                <label>
                  <input
                    type="radio"
                    name="pay"
                    checked={paymentProvider === "cod"}
                    onChange={() => void choosePayment("cod")}
                    disabled={quoteBusy || !codEnabled}
                  />
                  <span>
                    <b>Cash on delivery</b>
                    <small>{codEnabled ? "Pay when your order arrives" : "Cash on delivery is currently unavailable"}</small>
                  </span>
                </label>
              </div>
              <div className="payment-note">
                <ShieldCheck />
                <span>
                  <b>Your payment is protected</b>
                  <small>We never store full card or UPI credentials.</small>
                </span>
              </div>
              <p className="checkout-policy-note">
                No change-of-mind returns, exchanges or refunds. Damaged, defective, wrong, missing or undelivered orders can be reported for review; statutory remedies remain available. Read our <Link to="/shipping-returns">returns and refund policy</Link> before placing your order.
              </p>
              <button
                className="continue"
                onClick={placeOrder}
                disabled={busy || quoteBusy || coupon.busy || !quote || !cart.lines.length || (paymentProvider === "cod" ? !codEnabled : !cashfreeEnabled)}
              >
                {busy || quoteBusy
                  ? "Confirming current total…"
                  : (paymentProvider === "cod" ? "Place order " : "Pay ") +
                    money(total)}{" "}
                <LockKeyhole />
              </button>
            </div>
          )}
        </section>
        <aside>
          <h2>Your order</h2>
          {cart.lines.map(({ product, entry, variant, unitPrice }, i) => (
            <div className="checkout-line" key={i}>
              <div style={{ background: product.tone }}>
                {variant?.image || product.image ? (
                  <img
                    src={variant?.image || product.image}
                    alt={variant?.imageAlt || product.imageAlt || product.name}
                  />
                ) : (
                  product.glyph
                )}
                <i>{entry.quantity}</i>
              </div>
              <span>
                <b>{product.name}</b>
                <small>
                  {variant?.title ||
                    (variant && Object.values(variant.options).join(" / "))}
                </small>
              </span>
              <strong>{money(unitPrice * entry.quantity)}</strong>
            </div>
          ))}
          <hr />
          <p>
            <span>Subtotal before GST</span>
            <b>{money(subtotal)}</b>
          </p>
          <p>
            <span>Shipping</span>
            <b>
              {shipping === undefined
                ? "Calculated after address"
                : shipping
                  ? money(shipping)
                  : "Free"}
            </b>
          </p>
          {quote && <p><span>GST</span><b>{money(tax)}</b></p>}
          {coupon.applied&&<p className="coupon-saving"><span>Coupon {coupon.applied.code}</span><b>−{money(quote?.couponDiscount ?? coupon.applied.discount)}</b></p>}
          {quote && quote.onlinePaymentDiscount > 0 && <p className="coupon-saving"><span>Online-payment discount</span><b>−{money(quote.onlinePaymentDiscount)}</b></p>}
          <CouponEntry coupon={coupon} />
          <p className="checkout-total">
            <span>Total</span>
            <b>{money(total)}</b>
          </p>
        </aside>
      </main>
    </div>
  );
}

const normalizeMobile = (value: string) => { const clean = value.trim().replace(/[\s()-]/g, ""); return /^\d{10}$/.test(clean) ? `+91${clean}` : clean; };
function finishCustomerLogin(result: {
  accessToken: string;
  user?: { role: string };
}) {
  if (!result.accessToken)
    throw new Error("The sign-in session could not be created.");
  saveAccessToken(result.accessToken);
  window.location.assign(loginReturnPath(window.location.search) || (result.user?.role === "CUSTOMER" ? "/account" : "/admin"));
}

function authErrorMessage(
  error: unknown,
  fallback: string,
): { message: string } {
  if (!(error instanceof CommerceApiError))
    return { message: error instanceof Error ? error.message : fallback };

  switch (error.code) {
    case "INVALID_GOOGLE_TOKEN":
      return {
        message:
          "Google could not verify this sign-in. Choose your Google account and try again.",
      };
    case "GOOGLE_AUTH_UNAVAILABLE":
      return {
        message:
          "Google sign-in is temporarily unavailable. Please try again shortly.",
      };
    case "GOOGLE_AUTH_NOT_CONFIGURED":
      return {
        message:
          "Google sign-in is not configured for this store. Contact the administrator.",
      };
    case "ACCOUNT_DISABLED":
      return {
        message: "This account is disabled. Contact store support for help.",
      };
    case "RATE_LIMITED":
      return {
        message: "Too many attempts. Please wait a minute before trying again.",
      };
    case "VALIDATION_ERROR":
      return {
        message: "Some details are not valid. Review the highlighted fields.",
      };
    default:
      return { message: error.message || fallback };
  }
}

function CustomerQuickLogin() {
  const [googleStatus, setGoogleStatus] = useState<
    "loading" | "ready" | "authenticating" | "unavailable"
  >("loading");
  const [googleMessage, setGoogleMessage] = useState(
    "Preparing secure Google sign-in…",
  );
  const [googleRetryable, setGoogleRetryable] = useState(false);
  const [googleAttempt, setGoogleAttempt] = useState(0);
  const googleSigningIn = useRef(false);

  useEffect(() => {
    let cancelled = false;
    setGoogleStatus("loading");
    setGoogleMessage("Preparing secure Google sign-in…");
    setGoogleRetryable(false);
    prepareFirebaseAuth().then(() => {
      if (cancelled) return;
      setGoogleStatus("ready");
      setGoogleMessage("");
    }).catch((error) => {
      if (cancelled) return;
      setGoogleStatus("unavailable");
      setGoogleMessage(firebaseAuthMessage(error));
      setGoogleRetryable(true);
    });
    return () => { cancelled = true; };
  }, [googleAttempt]);

  const signIn = async () => {
    if (googleSigningIn.current) return;
    googleSigningIn.current = true;
    setGoogleStatus("authenticating");
    setGoogleMessage("Verifying your Google account…");
    try {
      const credential = await firebaseGoogleCredential();
      const result = await commerceApi<{ accessToken: string; user: { role: string } }>("/api/v1/auth/google", {
        method: "POST",
        body: JSON.stringify({ credential }),
      });
      finishCustomerLogin(result);
    } catch (error) {
      const message = error instanceof CommerceApiError ? authErrorMessage(error, "Google sign-in failed.").message : firebaseAuthMessage(error);
      setGoogleStatus("ready");
      setGoogleMessage(message);
      toast.error(message);
    } finally {
      googleSigningIn.current = false;
    }
  };

  return (
    <div className="quick-login">
      <div
        className={`google-login-shell is-${googleStatus}`}
        aria-busy={googleStatus === "loading" || googleStatus === "authenticating"}
      >
        <button
          type="button"
          className="google-login-button"
          disabled={googleStatus !== "ready"}
          aria-describedby={googleMessage ? "google-sign-in-status" : undefined}
          onClick={() => void signIn()}
        >
          <img src="/images/google-g.png" width="20" height="20.4" alt="" aria-hidden="true" />
          <span>Continue with Google</span>
        </button>
      </div>
      {googleMessage && (
        <p
          id="google-sign-in-status"
          className={`auth-provider-note${googleStatus === "ready" || googleStatus === "unavailable" ? " is-error" : ""}`}
          role={googleStatus === "ready" || googleStatus === "unavailable" ? "alert" : "status"}
        >
          {googleMessage}
        </p>
      )}
      {googleRetryable && (
        <button
          type="button"
          className="google-login-retry"
          onClick={() => setGoogleAttempt((current) => current + 1)}
        >
          Retry Google sign-in
        </button>
      )}
    </div>
  );
}

export function LoginPage() {
  const navigate = useNavigate();
  useEffect(() => {
    let cancelled = false;
    loadPortalSession().then((session) => {
      if (cancelled) return;
      const returnPath = loginReturnPath(window.location.search);
      if (returnPath) window.location.replace(returnPath);
      else void navigate({ to: session.role === "CUSTOMER" ? "/account" : "/admin", replace: true });
    }).catch(() => { /* Keep Google sign-in available when there is no valid session. */ });
    return () => { cancelled = true; };
  }, [navigate]);
  return (
    <StorePage>
      <Toaster richColors position="bottom-center" />
      <main className="auth-page">
        <section>
          <p className="eyebrow">Welcome to Sri Varahi Traders</p>
          <h1>Sign in or sign up.</h1>
          <p>Use your Google account for orders, returns and saved favourites. New accounts are created automatically.</p>
          <CustomerQuickLogin />
        </section>
        <aside>
          <span>“</span>
          <blockquote>
            Great flavour should earn its place in your kitchen—through pure
            oils, everyday essentials and thoughtful choices.
          </blockquote>
          <p>Sri Varahi Traders promise</p>
        </aside>
      </main>
    </StorePage>
  );
}

export function TrackPage() {
  const [order, setOrder] = useState(""),
    [contact, setContact] = useState(""),
    [tracking, setTracking] = useState<{
      number: string;
      status: string;
      history: Array<{ to: string; at: string }>;
    } | null>(null),
    [busy, setBusy] = useState(false);
  return (
    <StorePage>
      <Toaster richColors position="bottom-center" />
      <main className="track-page">
        <section>
          <p className="eyebrow">Delivery updates</p>
          <h1>Track your order.</h1>
          <p>
            Enter your order number and email or phone number for the latest
            status.
          </p>
          <form
            onSubmit={async (e) => {
              e.preventDefault();
              setBusy(true);
              try {
                setTracking(
                  await commerceApi(
                    "/api/v1/orders/track",
                    { method: "POST", body: JSON.stringify({ orderNumber: order.trim(), contact: contact.trim() }) },
                  ),
                );
              } catch (error) {
                setTracking(null);
                toast.error(
                  error instanceof Error
                    ? error.message
                    : "Order was not found",
                );
              } finally {
                setBusy(false);
              }
            }}
          >
            <label>
              Order number
              <input
                value={order}
                onChange={(e) => setOrder(e.target.value)}
                required
              />
            </label>
            <label>
              Email or phone
              <input value={contact} onChange={(event) => setContact(event.target.value)} required />
            </label>
            <button disabled={busy}>
              {busy ? "Checking…" : "Track order"} <ArrowRight />
            </button>
          </form>
        </section>
        {tracking && (
          <section className="tracking-result">
            <div>
              <span className="status shipped">
                {tracking.status.replaceAll("_", " ")}
              </span>
              <h2>Order #{tracking.number}</h2>
            </div>
            <div className="tracking-timeline">
              {tracking.history.map((event, index) => (
                <div
                  className={
                    index === tracking.history.length - 1 ? "current" : "done"
                  }
                  key={`${event.to}-${event.at}`}
                >
                  <i>
                    {index === tracking.history.length - 1 ? (
                      <Truck />
                    ) : (
                      <Check />
                    )}
                  </i>
                  <span>
                    <b>{event.to.replaceAll("_", " ")}</b>
                    <small>{new Date(event.at).toLocaleString("en-IN")}</small>
                  </span>
                </div>
              ))}
            </div>
          </section>
        )}
      </main>
    </StorePage>
  );
}
