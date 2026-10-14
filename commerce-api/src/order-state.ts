import { AppError } from "./errors.js";

const transitions: Record<string, ReadonlySet<string>> = {
  PENDING: new Set(["PAYMENT_PENDING", "CANCELLED", "FAILED"]),
  PAYMENT_PENDING: new Set(["PAID", "CANCELLED", "FAILED"]),
  PAID: new Set(["CONFIRMED", "REFUND_PENDING"]),
  CONFIRMED: new Set(["PROCESSING", "CANCELLED"]),
  PROCESSING: new Set(["PACKED", "CANCELLED"]),
  PACKED: new Set(["SHIPPED"]),
  SHIPPED: new Set(["OUT_FOR_DELIVERY", "DELIVERED"]),
  OUT_FOR_DELIVERY: new Set(["DELIVERED", "SHIPPED"]),
  DELIVERED: new Set(["RETURN_REQUESTED"]),
  RETURN_REQUESTED: new Set(["RETURN_APPROVED", "DELIVERED"]),
  RETURN_APPROVED: new Set(["RETURNED"]),
  RETURNED: new Set(["REFUND_PENDING"]),
  REFUND_PENDING: new Set(["REFUNDED", "RETURNED", "FAILED"]),
  FAILED: new Set(["PAYMENT_PENDING"]),
  CANCELLED: new Set(),
  REFUNDED: new Set(),
};

export function assertOrderTransition(from: string, to: string) {
  if (from === to) return;
  if (!transitions[from]?.has(to))
    throw new AppError(
      409,
      "INVALID_ORDER_TRANSITION",
      `Order cannot move from ${from} to ${to}`,
    );
}
