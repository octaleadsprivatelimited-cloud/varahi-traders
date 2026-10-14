import { AppError } from "./errors.js";

export type CouponRule = {
  code: string;
  type: "PERCENTAGE" | "FIXED_AMOUNT" | "FREE_SHIPPING";
  value: number;
  minimumSpend: number;
  maximumDiscount?: number;
  startsAt: number;
  endsAt: number;
  enabled: boolean;
  usageLimit?: number;
  used: number;
  appliesTo?: "ALL_PRODUCTS" | "SELECTED_PRODUCTS";
  productIds?: string[];
};

export function couponBenefit(
  coupon: CouponRule | undefined,
  lines: Array<{ productId: string; unitPrice: number; quantity: number }>,
  now = Date.now(),
) {
  if (!coupon || !coupon.enabled || coupon.startsAt > now || coupon.endsAt < now ||
      (coupon.usageLimit !== undefined && coupon.used >= coupon.usageLimit)) {
    throw new AppError(422, "COUPON_NOT_APPLICABLE", "Coupon is invalid, expired or unavailable");
  }
  const selected = coupon.appliesTo === "SELECTED_PRODUCTS";
  const eligible = new Set(coupon.productIds || []);
  const eligibleSubtotal = Math.round(lines.reduce((sum, line) =>
    sum + (!selected || eligible.has(line.productId) ? line.unitPrice * line.quantity : 0), 0) * 100) / 100;
  if (eligibleSubtotal <= 0)
    throw new AppError(422, "COUPON_NOT_APPLICABLE", "This coupon does not apply to the products in your bag");
  if (eligibleSubtotal < coupon.minimumSpend)
    throw new AppError(422, "COUPON_MINIMUM_SPEND", `Spend at least ₹${coupon.minimumSpend.toFixed(2)} on eligible products to use this coupon`);
  const discount = Math.round(Math.min(eligibleSubtotal,
    coupon.type === "PERCENTAGE" ? Math.min(eligibleSubtotal * coupon.value / 100, coupon.maximumDiscount ?? Infinity) :
    coupon.type === "FIXED_AMOUNT" ? coupon.value : 0) * 100) / 100;
  return { discount, eligibleSubtotal, freeShipping: coupon.type === "FREE_SHIPPING", appliesTo: selected ? "SELECTED_PRODUCTS" as const : "ALL_PRODUCTS" as const };
}
