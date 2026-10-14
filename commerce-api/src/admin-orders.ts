import type {
  StoredOrder,
  StoredRefund,
  StoredShipment,
  StoredUser,
} from "./store.js";

const roundMoney = (value: number) => Math.round(value * 100) / 100;

export type AdminRefundDto = {
  id: string;
  reference: string | null;
  amount: number;
  status: StoredRefund["status"];
  reason: string;
  createdAt: string;
};

export const adminRefundDto = (refund: StoredRefund): AdminRefundDto => ({
  id: refund.id,
  reference: refund.externalId || null,
  amount: refund.amount,
  status: refund.status,
  reason: refund.reason,
  createdAt: refund.createdAt,
});

const adminShipmentDto = (shipment?: StoredShipment) =>
  shipment
    ? {
        id: shipment.id,
        reference: shipment.externalId || null,
        provider: shipment.provider,
        awb: shipment.awb || null,
        courier: shipment.courier || null,
        trackingUrl: shipment.trackingUrl || null,
        status: shipment.status,
        createdAt: shipment.createdAt,
        events: shipment.events.map((event) => ({ ...event })),
      }
    : null;

export function adminOrderDto(order: StoredOrder, customer?: StoredUser) {
  const snapshot = order.invoiceSnapshot || {};
  const contact = snapshot.contact || {};
  const address = snapshot.shipping || {};
  const payment = order.payment;
  const refunds = payment?.refunds || [];
  const capturedAmount = payment?.amount ?? order.total;
  const refundedAmount = roundMoney(
    refunds
      .filter((refund) => refund.status === "SUCCEEDED")
      .reduce((sum, refund) => sum + refund.amount, 0),
  );
  const committedRefundAmount = roundMoney(
    refunds
      .filter((refund) => ["PENDING", "SUCCEEDED"].includes(refund.status))
      .reduce((sum, refund) => sum + refund.amount, 0),
  );

  return {
    id: order.id,
    number: order.number,
    status: order.status,
    createdAt: order.createdAt,
    customer: {
      id: customer?.id || order.userId || null,
      name: contact.name || customer?.name || "Customer",
      email: contact.email || customer?.email || null,
      phone: contact.phone || customer?.mobile || null,
    },
    address: {
      line1: address.line1 || null,
      line2: address.line2 || null,
      city: address.city || null,
      state: address.state || null,
      postalCode: address.postalCode || null,
      country: address.country || null,
      gstin: snapshot.gstin || null,
    },
    lineItems: order.lines.map((line) => ({
      variantId: line.variantId,
      name: line.name,
      sku: line.sku,
      quantity: line.quantity,
      unitPrice: line.unitPrice,
      tax: line.tax,
      lineSubtotal: roundMoney(line.unitPrice * line.quantity),
      lineTotal: roundMoney(line.unitPrice * line.quantity + line.tax),
    })),
    totals: {
      subtotal: order.subtotal,
      discount: order.discount,
      tax: order.tax,
      shipping: order.shipping,
      total: order.total,
      currency: payment?.currency || "INR",
    },
    payment: payment
      ? {
          provider: payment.provider || "payment-provider",
          status: payment.status || "CREATED",
          transactionReference: payment.gatewayTransactionId || null,
          amount: capturedAmount,
          currency: payment.currency || "INR",
          refundedAmount,
          refundableAmount: ["CAPTURED", "PARTIALLY_REFUNDED"].includes(
            payment.status || "",
          )
            ? roundMoney(Math.max(0, capturedAmount - committedRefundAmount))
            : 0,
          refunds: refunds.map(adminRefundDto),
        }
      : {
          provider: "cod",
          status: "COD_PENDING",
          transactionReference: null,
          amount: order.total,
          currency: "INR",
          refundedAmount: 0,
          refundableAmount: 0,
          refunds: [] as AdminRefundDto[],
        },
    shipping: {
      selection: order.shippingSelection
        ? { ...order.shippingSelection }
        : null,
      shipment: adminShipmentDto(order.shipment),
    },
    history: order.history.map((entry) => ({
      from: entry.from || null,
      to: entry.to,
      at: entry.at,
      actor: entry.actor || null,
      source: entry.source || null,
    })),
  };
}

export type AdminOrderDto = ReturnType<typeof adminOrderDto>;
