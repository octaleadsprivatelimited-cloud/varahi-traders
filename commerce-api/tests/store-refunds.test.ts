import crypto from "node:crypto";
import { describe, expect, it } from "vitest";
import { AppError } from "../src/errors.js";
import { CommerceStore } from "../src/store.js";

function capturedOrder(store: CommerceStore, total = 100) {
  return store.createOrder({
    status: "PAID",
    lines: [
      {
        variantId: "variant-1",
        name: "Test product",
        sku: "TEST-1",
        quantity: 1,
        unitPrice: total,
        tax: 0,
      },
    ],
    subtotal: total,
    tax: 0,
    shipping: 0,
    discount: 0,
    total,
    idempotencyKey: `checkout-${crypto.randomUUID()}`,
    payment: {
      externalId: `pay-${crypto.randomUUID()}`,
      provider: "development",
      status: "CAPTURED",
      amount: total,
      currency: "INR",
      refundedAmount: 0,
      refunds: [],
    },
  });
}

function expectAppError(action: () => unknown, code: string) {
  try {
    action();
    throw new Error("Expected operation to fail");
  } catch (error) {
    expect(error).toBeInstanceOf(AppError);
    expect((error as AppError).code).toBe(code);
  }
}

describe("in-memory refund reservations", () => {
  it("reprocesses PENDING keys and returns completed keys without duplicating audit", () => {
    const store = new CommerceStore();
    const order = capturedOrder(store);
    const key = `refund:${order.id}:same-request`;

    const first = store.beginRefund(order.id, 40, key, "Partial refund");
    expect(first).toMatchObject({ duplicate: false, process: true });
    expect(first.refund.status).toBe("PENDING");

    const pendingRetry = store.beginRefund(
      order.id,
      40,
      key,
      "Partial refund",
    );
    expect(pendingRetry).toMatchObject({ duplicate: true, process: true });
    expect(pendingRetry.refund.id).toBe(first.refund.id);

    store.completeRefund(order.id, first.refund.id, "provider-refund-1");
    const auditCount = store.auditLogs.length;
    const succeededRetry = store.beginRefund(
      order.id,
      40,
      key,
      "Partial refund",
    );
    expect(succeededRetry).toMatchObject({
      duplicate: true,
      process: false,
      refund: { status: "SUCCEEDED" },
    });
    store.completeRefund(order.id, first.refund.id, "provider-refund-1");
    expect(store.auditLogs).toHaveLength(auditCount);
    expectAppError(
      () =>
        store.completeRefund(
          order.id,
          first.refund.id,
          "different-provider-reference",
        ),
      "REFUND_REFERENCE_CONFLICT",
    );
  });

  it("atomically re-reserves FAILED keys only while capacity remains", () => {
    const store = new CommerceStore();
    const order = capturedOrder(store);
    const failedKey = `refund:${order.id}:failed-request`;

    const failed = store.beginRefund(
      order.id,
      40,
      failedKey,
      "Gateway failed",
    );
    store.failRefund(order.id, failed.refund.id);
    expect(failed.refund.status).toBe("FAILED");

    const retry = store.beginRefund(
      order.id,
      40,
      failedKey,
      "Gateway failed",
    );
    expect(retry).toMatchObject({
      duplicate: true,
      process: true,
      refund: { status: "PENDING" },
    });
    store.failRefund(order.id, retry.refund.id);

    const other = store.beginRefund(
      order.id,
      70,
      `refund:${order.id}:other-request`,
      "Another accepted refund",
    );
    store.completeRefund(order.id, other.refund.id, "provider-refund-2");
    expect(order.payment?.status).toBe("PARTIALLY_REFUNDED");
    expectAppError(
      () =>
        store.beginRefund(
          order.id,
          40,
          failedKey,
          "Gateway failed",
        ),
      "REFUND_AMOUNT_INVALID",
    );
    expect(failed.refund.status).toBe("FAILED");
  });

  it("rejects same-key request changes and invalid internal amounts", () => {
    const store = new CommerceStore();
    const order = capturedOrder(store);
    const key = `refund:${order.id}:conflict-request`;
    store.beginRefund(order.id, 10, key, "Original reason");

    expectAppError(
      () => store.beginRefund(order.id, 11, key, "Original reason"),
      "IDEMPOTENCY_CONFLICT",
    );
    expectAppError(
      () => store.beginRefund(order.id, 10, key, "Changed reason"),
      "IDEMPOTENCY_CONFLICT",
    );
    for (const amount of [0, -1, Number.NaN, Number.POSITIVE_INFINITY])
      expectAppError(
        () =>
          store.beginRefund(
            order.id,
            amount,
            `refund:${order.id}:${String(amount)}`,
            "Invalid amount",
          ),
        "REFUND_AMOUNT_INVALID",
      );
  });
});
