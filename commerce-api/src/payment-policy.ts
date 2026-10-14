export type OnlinePaymentOffer = {
  onlinePaymentDiscountEnabled: boolean;
  onlinePaymentDiscountType: "PERCENTAGE" | "FIXED_AMOUNT";
  onlinePaymentDiscountValue: number;
};

/** Offers reduce merchandise after coupons, never tax or delivery, and cannot exceed that balance. */
export function onlinePaymentDiscount(settings: OnlinePaymentOffer, eligible: boolean, subtotal: number, couponDiscount: number, otherCharges = 0) {
  if (!eligible || !settings.onlinePaymentDiscountEnabled || settings.onlinePaymentDiscountValue <= 0) return 0;
  const balance = Math.max(0, Math.round((subtotal - couponDiscount) * 100) / 100);
  const amount = settings.onlinePaymentDiscountType === "PERCENTAGE"
    ? balance * settings.onlinePaymentDiscountValue / 100
    : settings.onlinePaymentDiscountValue;
  // Cashfree requires at least ₹1 payable; an offer must not create an unusable zero-value payment.
  const payableLimit = Math.max(0, balance + otherCharges - 1);
  return Math.round(Math.min(balance, amount, payableLimit) * 100) / 100;
}
