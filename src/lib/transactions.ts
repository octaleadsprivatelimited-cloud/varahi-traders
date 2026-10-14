export type CustomerPayment = {
  id: string; orderId: string; orderNumber: string; orderStatus: string; provider: string;
  status: string; amount: number; currency: string; providerReference?: string | null;
  transactionId?: string | null; refundedAmount: number;
  refunds: Array<{ id: string; reference?: string | null; amount: number; status: string; createdAt: string }>;
  events: Array<{ id: string; type: string; errorCode?: string; errorDescription?: string; createdAt: string }>;
  createdAt: string; verifiedAt?: string | null;
};
export function transactionState(paymentStatus: string | undefined, orderStatus: string) {
  const status = paymentStatus?.toUpperCase();
  if (status === "REFUNDED") return { kind: "refunded", title: "Payment refunded", message: "The gateway has recorded a refund. See the refund references below." };
  if (status === "PARTIALLY_REFUNDED") return { kind: "refunded", title: "Payment partially refunded", message: "Part of this payment has been refunded. The amounts and references are shown below." };
  if (status === "CAPTURED" || status === "SUCCESS") return { kind: "success", title: "Payment received", message: "Your payment has been confirmed. Follow the order status for delivery updates." };
  if (status === "FAILED" || status === "CANCELLED" || ["CANCELLED", "PAYMENT_FAILED"].includes(orderStatus))
    return { kind: "failed", title: "Payment not completed", message: "This order does not have a confirmed payment. If your bank shows a debit, contact support with the order number before trying another payment." };
  if (!status) return { kind: "cod", title: "Order details", message: "There is no online payment transaction recorded for this order. See the order status and invoice for details." };
  return { kind: "pending", title: status === "AUTHORIZED" ? "Payment awaiting capture" : "Payment awaiting confirmation", message: "We have not received a final payment confirmation yet. Refresh to check for an update. Please avoid paying again while confirmation is pending." };
}
export function customerTransactionPath(orderNumber: string) {
  return `/transaction/${encodeURIComponent(orderNumber)}`;
}
export function collectedPayments(payments: CustomerPayment[]) {
  return payments.filter(payment => ["CAPTURED", "SUCCESS", "REFUNDED", "PARTIALLY_REFUNDED"].includes(payment.status))
    .reduce((total, payment) => total + payment.amount, 0);
}
export function settledRefundAmount(payment: CustomerPayment) {
  if (payment.refunds.length) return payment.refunds.filter(refund => ["SUCCEEDED", "SUCCESS"].includes(refund.status))
    .reduce((total, refund) => total + refund.amount, 0);
  return ["REFUNDED", "PARTIALLY_REFUNDED"].includes(payment.status) ? payment.refundedAmount : 0;
}
export function confirmedOrLatestPayment(payments: CustomerPayment[]) {
  const sorted = [...payments].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return sorted.find(payment => ["CAPTURED", "SUCCESS", "REFUNDED", "PARTIALLY_REFUNDED"].includes(payment.status)) || sorted[0];
}
export function loginReturnPath(search: string) {
  const value = new URLSearchParams(search).get("returnTo");
  return value && /^\/transaction\/[^/?#]+$/.test(value) ? value : null;
}
