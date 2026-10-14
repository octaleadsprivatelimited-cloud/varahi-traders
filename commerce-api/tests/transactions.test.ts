import { expect, it } from "vitest";
const modulePath = "../../src/lib/transactions.ts";
const { transactionState, collectedPayments, confirmedOrLatestPayment, settledRefundAmount, loginReturnPath } = await import(modulePath);
const payment = (status: string, createdAt = "2026-10-14T01:00:00Z") => ({ id: status, orderId: "order1", orderNumber: "SVT-1", orderStatus: "PAID", provider: "cashfree", status, amount: 100, currency: "INR", refundedAmount: 0, refunds: [], events: [], createdAt });
it("shows confirmed, failed, pending, captured and refund states without treating authorization as collection", () => {
  expect(transactionState("CAPTURED", "PAID").kind).toBe("success");
  expect(transactionState("AUTHORIZED", "PAYMENT_PENDING").kind).toBe("pending");
  expect(transactionState("CREATED", "PAYMENT_PENDING").kind).toBe("pending");
  expect(transactionState("FAILED", "PAYMENT_PENDING").kind).toBe("failed");
  expect(transactionState("REFUNDED", "PAID").kind).toBe("refunded");
  expect(transactionState("PARTIALLY_REFUNDED", "PAID").kind).toBe("refunded");
  expect(transactionState(undefined, "CONFIRMED").kind).toBe("cod");
  expect(collectedPayments([payment("AUTHORIZED"), payment("CREATED"), payment("FAILED"), payment("CAPTURED")])).toBe(100);
});
it("keeps a confirmed payment visible when a later failed attempt exists", () => {
  expect(confirmedOrLatestPayment([payment("FAILED", "2026-10-14T02:00:00Z"), payment("CAPTURED")])?.status).toBe("CAPTURED");
  expect(confirmedOrLatestPayment([payment("FAILED"), payment("CREATED", "2026-10-14T02:00:00Z")])?.status).toBe("CREATED");
});
it("counts only successful refunds and keeps pending refunds separate", () => {
  const record = { ...payment("PARTIALLY_REFUNDED"), refundedAmount: 70, refunds: [
    { id: "one", amount: 30, status: "SUCCEEDED", createdAt: "2026-10-14T01:00:00Z" },
    { id: "two", amount: 40, status: "PENDING", createdAt: "2026-10-14T01:00:00Z" },
    { id: "three", amount: 15, status: "FAILED", createdAt: "2026-10-14T01:00:00Z" },
  ] };
  expect(settledRefundAmount(record)).toBe(30);
  expect(settledRefundAmount({ ...payment("CAPTURED"), refundedAmount: 50 })).toBe(0);
});
it("returns Google sign-in only to an internal transaction page", () => {
  expect(loginReturnPath("?returnTo=%2Ftransaction%2FSVT-123")).toBe("/transaction/SVT-123");
  for (const value of ["//evil.test", "https://evil.test", "/login", "/transaction/one?email=secret", "/transaction/one#secret"]) expect(loginReturnPath(`?returnTo=${encodeURIComponent(value)}`)).toBeNull();
});
