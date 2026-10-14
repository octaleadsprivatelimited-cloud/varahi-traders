import { products as previewProducts, type Product, type Variant } from "../data/commerce";
import type { AnalyticsItem } from "./analytics";

/** Storefront and checkout API amounts are already in rupees, never paise. */
export const commerceAmount = (amount: number) => Math.round(amount * 100) / 100;

export function productAnalyticsItem(product: Product, variant?: Variant, quantity = 1): AnalyticsItem | undefined {
  // The SSR preview catalog is replaced by the API catalog. Do not report its
  // placeholder products, prices or stock as live commerce impressions.
  if (previewProducts.includes(product)) return undefined;
  const option = variant || product.variants?.find((item) => item.stock > 0) || product.variants?.[0];
  if (!option) return undefined;
  return {
    item_id: option.id,
    item_name: product.name,
    item_category: product.category,
    item_variant: option.title || Object.values(option.options).join(" / "),
    price: option.price,
    quantity,
  };
}

export function analyticsItemsForProducts(products: Product[]): AnalyticsItem[] {
  return products.flatMap((product) => {
    const item = productAnalyticsItem(product);
    return item ? [item] : [];
  });
}

export type AnalyticsCartLine = {
  product: Product;
  variant?: Variant;
  entry: { quantity: number };
  unresolved: boolean;
};

export function analyticsItemsForCart(lines: AnalyticsCartLine[]): AnalyticsItem[] {
  return lines.flatMap((line) => {
    const item = !line.unresolved && line.variant
      ? productAnalyticsItem(line.product, line.variant, line.entry.quantity)
      : undefined;
    return item ? [item] : [];
  });
}

/** Allocate order-level discounts proportionally; GA4 value excludes tax/shipping. */
export function discountedCommerceItems(items: AnalyticsItem[], discount: number): AnalyticsItem[] {
  const subtotal = items.reduce((sum, item) => sum + item.price * item.quantity, 0);
  if (subtotal <= 0 || discount <= 0) return items;
  const ratio = Math.max(0, subtotal - discount) / subtotal;
  return items.map((item) => ({ ...item, price: Number((item.price * ratio).toFixed(6)) }));
}

export type AnalyticsOrder = {
  number: string;
  status: string;
  total: number;
  subtotal: number;
  discount: number;
  shipping: number;
  tax: number;
  lines: Array<{ variantId: string; name: string; unitPrice: number; quantity: number }>;
};

export function purchaseIsConfirmed(provider: string, orderStatus: string, verifiedPaymentStatus?: string) {
  return provider === "cod"
    ? ["CONFIRMED", "PROCESSING", "PACKED", "SHIPPED", "OUT_FOR_DELIVERY", "DELIVERED"].includes(orderStatus)
    : verifiedPaymentStatus === "CAPTURED";
}

export function analyticsPurchase(order: AnalyticsOrder) {
  // Pick only public merchandise fields. Never pass an order object, invoice,
  // contact, shipping address or payment token into a third-party SDK.
  const items = order.lines.map((line) => ({
    item_id: line.variantId,
    item_name: line.name,
    price: line.unitPrice,
    quantity: line.quantity,
  }));
  return {
    transaction_id: order.number,
    currency: "INR",
    value: commerceAmount(Math.max(0, order.subtotal - order.discount)),
    shipping: order.shipping,
    tax: order.tax,
    items: discountedCommerceItems(items, order.discount),
  };
}
