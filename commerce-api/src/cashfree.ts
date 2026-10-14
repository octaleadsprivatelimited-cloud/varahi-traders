import crypto from "node:crypto";
import type { PaymentProvider } from "./contracts.js";
import { AppError } from "./errors.js";
import type { GatewayStatus } from "./payment-lifecycle.js";

export function cashfreeKey(value: string) {
  const hex = crypto.createHash("sha256").update(value).digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}
export function verifyCashfreeSignature(
  raw: Buffer,
  signature: string,
  timestamp: string,
  secret: string,
) {
  if (!secret || !/^\d+$/.test(timestamp)) return false;
  const expected = crypto
    .createHmac("sha256", secret)
    .update(timestamp)
    .update(raw)
    .digest("base64");
  const a = Buffer.from(expected),
    b = Buffer.from(signature);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
export class CashfreePaymentProvider implements PaymentProvider {
  private base: string;
  constructor(
    private credentials: {
      clientId: string;
      clientSecret: string;
      environment: "TEST" | "LIVE";
    },
    private request: typeof fetch = fetch,
  ) {
    if (!credentials.clientId || !credentials.clientSecret)
      throw new AppError(
        503,
        "PAYMENT_NOT_CONFIGURED",
        "Configure Cashfree in admin Integrations before accepting online payments",
      );
    this.base =
      credentials.environment === "LIVE"
        ? "https://api.cashfree.com/pg"
        : "https://sandbox.cashfree.com/pg";
  }
  private async call(path: string, body?: unknown, key?: string): Promise<any> {
    let response: Response;
    try {
      response = await this.request(this.base + path, {
        method: body ? "POST" : "GET",
        headers: {
          "content-type": "application/json",
          "x-api-version": "2025-01-01",
          "x-client-id": this.credentials.clientId,
          "x-client-secret": this.credentials.clientSecret,
          ...(key ? { "x-idempotency-key": cashfreeKey(key) } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(15000),
      });
    } catch {
      throw new AppError(
        503,
        "PAYMENT_PROVIDER_ERROR",
        "Cashfree could not be reached. Check payment status before retrying.",
        { retryable: true },
      );
    }
    const data = await response.json().catch(() => null);
    if (!response.ok)
      throw new AppError(
        response.status >= 500 || response.status === 429 ? 503 : 422,
        "PAYMENT_PROVIDER_ERROR",
        "Cashfree could not complete this request",
        {
          retryable: response.status >= 500 || response.status === 429,
          providerCode: data?.code,
        },
      );
    if (!data)
      throw new AppError(
        502,
        "INVALID_PROVIDER_RESPONSE",
        "Cashfree returned an invalid response",
      );
    return data;
  }
  async createOrder(input: Parameters<PaymentProvider["createOrder"]>[0]) {
    if (!input.customer || !/^\+91[6-9]\d{9}$/.test(input.customer.phone))
      throw new AppError(
        422,
        "INVALID_MOBILE",
        "Enter a valid 10-digit Indian mobile number",
      );
    const externalId = `rs_${cashfreeKey(input.idempotencyKey)}`;
    const data = await this.call(
      "/orders",
      {
        order_id: externalId,
        order_amount: input.amount.amount,
        order_currency: input.amount.currency,
        customer_details: {
          customer_id: input.orderId,
          customer_phone: input.customer.phone.slice(3),
          customer_email: input.customer.email,
          customer_name: input.customer.name,
        },
      },
      input.idempotencyKey,
    );
    if (
      data.order_id !== externalId ||
      typeof data.payment_session_id !== "string"
    )
      throw new AppError(
        502,
        "INVALID_PROVIDER_RESPONSE",
        "Cashfree did not return a payment session",
      );
    return {
      externalId,
      clientToken: data.payment_session_id,
      environment: this.credentials.environment,
    };
  }
  async resumeOrder(externalId: string) {
    const data = await this.call(`/orders/${encodeURIComponent(externalId)}`);
    if (data.order_status === "PAID")
      throw new AppError(
        409,
        "PAYMENT_ALREADY_PAID",
        "Payment has already completed. Verify its status to continue.",
      );
    if (["EXPIRED", "TERMINATED"].includes(data.order_status)) return null;
    if (
      data.order_id !== externalId ||
      data.order_status !== "ACTIVE" ||
      typeof data.payment_session_id !== "string"
    )
      throw new AppError(
        502,
        "INVALID_PROVIDER_RESPONSE",
        "Cashfree payment session is unavailable",
      );
    return {
      externalId,
      clientToken: data.payment_session_id,
      environment: this.credentials.environment,
    };
  }
  async verifyWebhook(_raw: Buffer, _signature: string): Promise<never> {
    throw new AppError(
      400,
      "WEBHOOK_TIMESTAMP_REQUIRED",
      "Cashfree verification requires the timestamp header",
    );
  }
  async lookup(externalId: string): Promise<GatewayStatus> {
    const data = await this.call(
      `/orders/${encodeURIComponent(externalId)}/payments`,
    );
    if (!Array.isArray(data))
      throw new AppError(
        502,
        "INVALID_PROVIDER_RESPONSE",
        "Cashfree payment list is invalid",
      );
    const paid = data.find((p) => p.payment_status === "SUCCESS");
    if (!paid) return { status: "PENDING" };
    return {
      status: "CAPTURED",
      gatewayPaymentId: String(paid.cf_payment_id),
      amount: Number(paid.payment_amount),
      currency: paid.payment_currency,
    };
  }
  async lookupRefund(externalOrderId: string, refundId: string) {
    const data = await this.call(
      `/orders/${encodeURIComponent(externalOrderId)}/refunds/${encodeURIComponent(refundId)}`,
    );
    if (data.refund_id !== refundId || data.order_id !== externalOrderId)
      throw new AppError(
        502,
        "INVALID_PROVIDER_RESPONSE",
        "Cashfree refund reference does not match",
      );
    return {
      amount: Number(data.refund_amount),
      status: String(data.refund_status),
      refundId,
    };
  }
  async refund(input: Parameters<PaymentProvider["refund"]>[0]) {
    if (!input.externalOrderId)
      throw new AppError(
        422,
        "PAYMENT_REFERENCE_REQUIRED",
        "Cashfree order reference is required",
      );
    const refundId = `ref_${cashfreeKey(input.idempotencyKey)}`;
    const data = await this.call(
      `/orders/${encodeURIComponent(input.externalOrderId)}/refunds`,
      {
        refund_id: refundId,
        refund_amount: input.amount.amount,
        refund_note: "Customer refund",
      },
      input.idempotencyKey,
    );
    if (data.refund_id !== refundId)
      throw new AppError(
        502,
        "INVALID_PROVIDER_RESPONSE",
        "Cashfree refund reference is invalid",
      );
    return {
      refundId,
      status:
        data.refund_status === "SUCCESS"
          ? ("SUCCEEDED" as const)
          : data.refund_status === "CANCELLED" ||
              data.refund_status === "FAILED"
            ? ("FAILED" as const)
            : ("PENDING" as const),
    };
  }
}
