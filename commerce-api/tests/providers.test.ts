import crypto from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  RazorpayPaymentProvider,
  ShiprocketShippingProvider,
} from "../src/providers.js";

describe("Razorpay payment adapter", () => {
  it("creates provider orders in minor currency units without exposing the secret", async () => {
    const request = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) => new Response(JSON.stringify({ id: "order_live_123" }), { status: 200, headers: { "content-type": "application/json" } }));
    const provider = new RazorpayPaymentProvider({ keyId: "rzp_live_public", keySecret: "private-secret" }, request as typeof fetch);
    const result = await provider.createOrder({ orderId: "internal-order", amount: { amount: 1250.45, currency: "INR" }, idempotencyKey: "checkout-unique-key" });
    expect(result).toEqual({ externalId: "order_live_123", clientToken: "rzp_live_public" });
    const [url, init] = request.mock.calls[0]!;
    expect(url).toBe("https://api.razorpay.com/v1/orders");
    expect(JSON.parse(String(init?.body))).toMatchObject({ amount: 125045, notes: { internalOrderId: "internal-order" } });
    expect(JSON.stringify(result)).not.toContain("private-secret");
  });

  it("accepts valid signed events and rejects tampering", async () => {
    const provider = new RazorpayPaymentProvider({ keyId: "key", keySecret: "webhook-secret" });
    const raw = Buffer.from(JSON.stringify({ id: "evt_1", event: "payment.captured", payload: { payment: { entity: { id: "pay_1" } } } }));
    const signature = crypto.createHmac("sha256", "webhook-secret").update(raw).digest("hex");
    await expect(provider.verifyWebhook(raw, signature)).resolves.toMatchObject({ eventId: "evt_1", type: "payment.captured", paymentId: "pay_1" });
    await expect(provider.verifyWebhook(Buffer.from(`${raw.toString()} `), signature)).rejects.toMatchObject({ code: "INVALID_WEBHOOK_SIGNATURE" });
  });

  it("sends idempotent partial refund requests", async () => {
    const request = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) => new Response(JSON.stringify({ id: "rfnd_1" }), { status: 200, headers: { "content-type": "application/json" } }));
    const provider = new RazorpayPaymentProvider({ keyId: "key", keySecret: "secret" }, request as typeof fetch);
    await expect(provider.refund({ paymentId: "pay_1", amount: { amount: 99.5, currency: "INR" }, idempotencyKey: "refund-order-line-1" })).resolves.toEqual({ refundId: "rfnd_1" });
    const [, init] = request.mock.calls[0]!;
    expect(init?.headers).toMatchObject({ "x-razorpay-idempotency-key": "refund-order-line-1" });
    expect(JSON.parse(String(init?.body)).amount).toBe(9950);
  });
  it("normalizes gateway lookup data and retryable outages",async()=>{const lookup=vi.fn(async()=>new Response(JSON.stringify({items:[{id:"pay_123",status:"captured",amount:125045,currency:"INR"}]}),{status:200,headers:{"content-type":"application/json"}})),provider=new RazorpayPaymentProvider({keyId:"key",keySecret:"secret"},lookup as typeof fetch);await expect(provider.lookup("order_123")).resolves.toMatchObject({status:"CAPTURED",gatewayPaymentId:"pay_123",amount:1250.45});const outage=new RazorpayPaymentProvider({keyId:"key",keySecret:"secret"},vi.fn(async()=>new Response(JSON.stringify({error:{code:"SERVER_ERROR"}}),{status:503,headers:{"content-type":"application/json"}})) as typeof fetch);await expect(outage.createOrder({orderId:"internal",amount:{amount:100,currency:"INR"},idempotencyKey:"key"})).rejects.toMatchObject({code:"PAYMENT_PROVIDER_ERROR",details:{category:"GATEWAY_UNAVAILABLE",retryable:true}})});
  it("classifies actionable declines and transport failures without leaking secrets", async () => {
    const decline = new RazorpayPaymentProvider(
      { keyId: "key", keySecret: "secret" },
      vi.fn(async () => new Response(JSON.stringify({ error: { code: "BAD_REQUEST_ERROR", reason: "insufficient_funds" } }), { status: 400, headers: { "content-type": "application/json" } })) as typeof fetch,
    );
    await expect(decline.createOrder({ orderId: "order", amount: { amount: 500, currency: "INR" }, idempotencyKey: "decline-key" })).rejects.toMatchObject({
      code: "PAYMENT_PROVIDER_ERROR",
      details: { category: "INSUFFICIENT_FUNDS", retryable: false, recommendedAction: "CHANGE_METHOD" },
    });
    const network = new RazorpayPaymentProvider(
      { keyId: "key", keySecret: "secret" },
      vi.fn(async () => { throw new TypeError("connection reset"); }) as typeof fetch,
    );
    await expect(network.createOrder({ orderId: "order", amount: { amount: 500, currency: "INR" }, idempotencyKey: "network-key" })).rejects.toMatchObject({
      code: "PAYMENT_PROVIDER_ERROR",
      details: { category: "NETWORK_ERROR", retryable: true },
    });
  });
});

describe("Shiprocket shipping adapter", () => {
  it("assigns the exact selected courier when generating the AWB", async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ shipment_id: 16016920 }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ response: { data: { awb_code: "19041424751540" } } }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        ),
      );
    const provider = new ShiprocketShippingProvider(
      {
        token: "shiprocket-token",
        pickupPostcode: "500001",
        pickupLocation: "Primary",
      },
      request as typeof fetch,
    );

    await expect(
      provider.createShipment({
        orderId: "order-123",
        service: "10",
        idempotencyKey: "ship-order-123",
        shippingAddress: {
          name: "Test Customer",
          line1: "1 Test Road",
          city: "Hyderabad",
          state: "Telangana",
          postalCode: "500081",
          country: "India",
          email: "customer@example.com",
          phone: "+919876543210",
          cod: true,
        },
        items: [
          { name: "Test product", sku: "SKU-1", quantity: 1, price: 499 },
        ],
        orderTotal: { amount: 589.75, currency: "INR" },
      }),
    ).resolves.toMatchObject({
      shipmentId: "16016920",
      awb: "19041424751540",
    });

    expect(request).toHaveBeenCalledTimes(2);
    const [, createInit] = request.mock.calls[0]!;
    expect(JSON.parse(String(createInit?.body))).toMatchObject({
      payment_method: "COD",
      sub_total: 589.75,
    });
    const [assignmentUrl, assignmentInit] = request.mock.calls[1]!;
    expect(assignmentUrl).toBe(
      "https://apiv2.shiprocket.in/v1/external/courier/assign/awb",
    );
    expect(JSON.parse(String(assignmentInit?.body))).toEqual({
      shipment_id: 16016920,
      courier_id: 10,
    });
  });
});
