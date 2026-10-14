import crypto from "node:crypto";
import { Prisma } from "@prisma/client";
import { defaultStorefrontConfig } from "./storefront-config.js";
const object = (value: unknown): Record<string, any> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
export function orderConfirmationId(orderId: string) {
  const hash = crypto.createHash("sha256").update(`order-confirmation:${orderId}`).digest("hex");
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-${hash.slice(12, 16)}-${hash.slice(16, 20)}-${hash.slice(20, 32)}`;
}
/** Transactional outbox: one confirmation per accepted order, including payment retries. */
export async function queueOrderConfirmation(tx: Prisma.TransactionClient, orderId: string) {
  const order = await tx.order.findUnique({ where: { id: orderId }, include: { items: true } });
  if (!order || !["CONFIRMED", "PAID"].includes(order.status)) return;
  const snapshot = object(order.addressSnapshot), contact = object(snapshot.contact), shipping = object(snapshot.shipping);
  const destination = typeof contact.email === "string" ? contact.email.trim() : "";
  if (!destination) return;
  const business = { ...defaultStorefrontConfig, ...object(snapshot.notificationBusiness) };
  await tx.notification.upsert({
    where: { id: orderConfirmationId(orderId) }, update: {},
    create: {
      id: orderConfirmationId(orderId), userId: order.userId, channel: "EMAIL", template: "order.confirmed", destination, status: "QUEUED",
      payload: {
        orderId: order.id, orderNumber: order.number, placedAt: order.createdAt.toISOString(), storeName: business.storeName, currency: order.currency,
        customer: { name: String(contact.name || ""), email: destination, phone: String(contact.phone || "") },
        address: [shipping.line1, shipping.line2, shipping.city, shipping.state, shipping.postalCode, shipping.country].filter(Boolean).join(", "),
        paymentLabel: snapshot.paymentMethod === "cod" ? "Cash on delivery — payable on delivery" : "Paid online",
        items: order.items.map(item => ({ name: item.name, sku: item.sku, quantity: item.quantity, unitPrice: Number(item.unitPrice) })),
        charges: { subtotal: Number(order.subtotal), discount: Number(order.discount), couponDiscount: object(snapshot.discounts).coupon ?? Number(order.discount), onlinePaymentDiscount: object(snapshot.discounts).onlinePayment ?? 0, shipping: Number(order.shipping), tax: Number(order.tax), total: Number(order.total) },
        business: { legalName: business.legalName || business.storeName, address: business.businessAddress, gstin: business.businessGstin, email: business.supportEmail, phone: business.supportPhone },
      },
    },
  });
}
