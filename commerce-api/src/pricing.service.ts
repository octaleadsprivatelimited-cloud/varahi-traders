import type { CartLine, PriceResult } from "./contracts.js";
export interface CatalogReader {
  variants(
    ids: string[],
  ): Promise<
    Array<{ id: string; price: number; taxRate: number; available: number }>
  >;
}
export class PricingService {
  constructor(private catalog: CatalogReader) {}
  async calculate(
    lines: CartLine[],
    shipping: number,
    coupon?: {
      type: "PERCENT" | "FIXED";
      value: number;
      max?: number;
      minimum?: number;
    },
  ): Promise<PriceResult> {
    if (!lines.length) throw new Error("EMPTY_CART");
    const variants = await this.catalog.variants(lines.map((x) => x.variantId));
    const map = new Map(variants.map((x) => [x.id, x]));
    let subtotal = 0,
      tax = 0;
    for (const line of lines) {
      if (
        !Number.isInteger(line.quantity) ||
        line.quantity < 1 ||
        line.quantity > 20
      )
        throw new Error("INVALID_QUANTITY");
      const item = map.get(line.variantId);
      if (!item || item.available < line.quantity)
        throw new Error("UNAVAILABLE_ITEM");
      subtotal += item.price * line.quantity;
      tax += (item.price * line.quantity * item.taxRate) / 100;
    }
    let discount = 0;
    if (coupon && subtotal >= (coupon.minimum ?? 0))
      discount =
        coupon.type === "PERCENT"
          ? (subtotal * coupon.value) / 100
          : coupon.value;
    if (coupon?.max) discount = Math.min(discount, coupon.max);
    discount = Math.min(discount, subtotal);
    const total =
      Math.round((subtotal - discount + tax + shipping) * 100) / 100;
    return {
      subtotal,
      discount,
      tax: Math.round(tax * 100) / 100,
      shipping,
      total,
      currency: "INR",
    };
  }
}
