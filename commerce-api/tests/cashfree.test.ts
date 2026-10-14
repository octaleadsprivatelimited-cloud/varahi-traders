import crypto from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  CashfreePaymentProvider,
  cashfreeKey,
  verifyCashfreeSignature,
} from "../src/cashfree.js";
import { mobileNumber } from "../src/schemas.js";
const credentials = {
  clientId: "test-app",
  clientSecret: "test-secret",
  environment: "TEST" as const,
};
const response = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status });
describe("Cashfree gateway", () => {
  it("uses server totals, normalized phone, sandbox and stable UUID idempotency", async () => {
    const key = "checkout:private-order-key";
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        response({
          order_id: `rs_${cashfreeKey(key)}`,
          payment_session_id: "session_123",
        }),
      );
    const gateway = new CashfreePaymentProvider(credentials, request);
    const result = await gateway.createOrder({
      orderId: "internal-id",
      customer: {
        name: "Customer",
        email: "customer@example.com",
        phone: "+919876543210",
      },
      amount: { amount: 499.25, currency: "INR" },
      idempotencyKey: key,
    });
    expect(result).toMatchObject({
      clientToken: "session_123",
      environment: "TEST",
    });
    const [url, init] = request.mock.calls[0]!;
    expect(url).toBe("https://sandbox.cashfree.com/pg/orders");
    expect(JSON.parse(String(init?.body))).toMatchObject({
      order_amount: 499.25,
      customer_details: { customer_phone: "9876543210" },
    });
    expect(
      (init?.headers as Record<string, string>)["x-idempotency-key"],
    ).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-a[0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });
  it("does not treat failed attempts as order failure and verifies success amounts", async () => {
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(response([{ payment_status: "FAILED" }]))
      .mockResolvedValueOnce(
        response([
          {
            payment_status: "SUCCESS",
            cf_payment_id: 123,
            payment_amount: 499.25,
            payment_currency: "INR",
          },
        ]),
      );
    const gateway = new CashfreePaymentProvider(credentials, request);
    expect(await gateway.lookup("order")).toEqual({ status: "PENDING" });
    expect(await gateway.lookup("order")).toEqual({
      status: "CAPTURED",
      gatewayPaymentId: "123",
      amount: 499.25,
      currency: "INR",
    });
  });
  it("keeps accepted refunds pending and uses the gateway order reference", async () => {
    const key = "refund:internal-id";
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        response({
          refund_id: `ref_${cashfreeKey(key)}`,
          refund_status: "PENDING",
        }),
      );
    const result = await new CashfreePaymentProvider(
      credentials,
      request,
    ).refund({
      paymentId: "transaction",
      externalOrderId: "gateway-order",
      amount: { amount: 100, currency: "INR" },
      idempotencyKey: key,
    });
    expect(result.status).toBe("PENDING");
    expect(request.mock.calls[0]![0]).toBe(
      "https://sandbox.cashfree.com/pg/orders/gateway-order/refunds",
    );
  });
  it("authenticates the timestamp and exact raw body", () => {
    const raw = Buffer.from('{"amount":100.00}'),
      timestamp = String(Date.now());
    const signature = crypto
      .createHmac("sha256", credentials.clientSecret)
      .update(timestamp)
      .update(raw)
      .digest("base64");
    expect(
      verifyCashfreeSignature(
        raw,
        signature,
        timestamp,
        credentials.clientSecret,
      ),
    ).toBe(true);
    expect(
      verifyCashfreeSignature(
        Buffer.from('{"amount":100}'),
        signature,
        timestamp,
        credentials.clientSecret,
      ),
    ).toBe(false);
    expect(
      verifyCashfreeSignature(raw, signature, "", credentials.clientSecret),
    ).toBe(false);
  });
  it("rejects missing credentials and marks uncertain failures retryable", async () => {
    expect(
      () => new CashfreePaymentProvider({ ...credentials, clientSecret: "" }),
    ).toThrow();
    const request = vi
      .fn<typeof fetch>()
      .mockRejectedValue(new Error("network"));
    await expect(
      new CashfreePaymentProvider(credentials, request).lookup("order"),
    ).rejects.toMatchObject({
      code: "PAYMENT_PROVIDER_ERROR",
      details: { retryable: true },
    });
  });
});
it("normalizes ten Indian mobile digits and rejects wrong lengths and countries", () => {
  expect(mobileNumber.parse("9876543210")).toBe("+919876543210");
  expect(mobileNumber.parse("+919876543210")).toBe("+919876543210");
  for (const value of [
    "987654321",
    "98765432100",
    "+19876543210",
    "1234567890",
    "98765abc10",
  ])
    expect(mobileNumber.safeParse(value).success).toBe(false);
});
