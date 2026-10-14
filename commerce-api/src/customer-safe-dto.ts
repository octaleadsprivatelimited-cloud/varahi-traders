import type { StoredOrder, StoredPayment } from "./store.js";
import { createHash, timingSafeEqual } from "node:crypto";

export const customerOrderHistory = (order: StoredOrder) => order.history.map(event => ({ to: event.to, at: event.at }));
export function checkoutOrderDto(order: StoredOrder) {
  return {
    id: order.id, number: order.number, status: order.status,
    lines: order.lines.map(line => ({ variantId: line.variantId, name: line.name, sku: line.sku, quantity: line.quantity, unitPrice: line.unitPrice, tax: line.tax })),
    subtotal: order.subtotal, tax: order.tax, shipping: order.shipping, discount: order.discount, total: order.total,
    couponDiscount: order.invoiceSnapshot?.discounts?.coupon ?? order.discount,
    onlinePaymentDiscount: order.invoiceSnapshot?.discounts?.onlinePayment ?? 0,
    shippingSelection: order.shippingSelection, history: customerOrderHistory(order), createdAt: order.createdAt,
  };
}
export function paymentAttemptDto(payment: (StoredPayment & { environment?: string }) | null | undefined) {
  return payment ? {
    externalId: payment.externalId, clientToken: payment.clientToken, environment: payment.environment,
    provider: payment.provider, status: payment.status, amount: payment.amount, currency: payment.currency,
    gatewayTransactionId: payment.gatewayTransactionId,
  } : null;
}
const contactValue = (value: string) => {
  const trimmed = value.trim().toLowerCase();
  const phone = trimmed.replace(/[\s()-]/g, "").match(/^(?:\+91)?([6-9]\d{9})$/);
  return phone ? `+91${phone[1]}` : trimmed;
};
export function trackingContactMatches(order: StoredOrder, supplied: string) {
  const digest = (value: string) => createHash("sha256").update(value).digest();
  const contact = order.invoiceSnapshot?.contact;
  const expected = [contact?.email, contact?.phone].filter((value): value is string => Boolean(value)).map(value => digest(contactValue(value)));
  if (order.trackingVerificationHash && /^[a-f0-9]{64}$/i.test(order.trackingVerificationHash)) expected.push(Buffer.from(order.trackingVerificationHash, "hex"));
  const candidate = digest(contactValue(supplied));
  return Boolean(supplied.trim()) && expected.some(value => timingSafeEqual(value, candidate));
}
