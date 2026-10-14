export type Money = { amount: number; currency: "INR" | string };
export interface PaymentProvider {
  createOrder(input: {
    orderId: string;
    customer?: { name: string; email: string; phone: string };
    amount: Money;
    idempotencyKey: string;
  }): Promise<{ externalId: string; clientToken?: string; environment?: "TEST" | "LIVE" }>;
  verifyWebhook(
    raw: Buffer,
    signature: string,
  ): Promise<{ eventId: string; type: string; paymentId?: string }>;
  refund(input: {
    paymentId: string;
    externalOrderId?: string;
    amount: Money;
    idempotencyKey: string;
  }): Promise<{ refundId: string; status?: "PENDING" | "SUCCEEDED" | "FAILED" }>;
  lookup(externalOrderId:string):Promise<import("./payment-lifecycle.js").GatewayStatus>;
}
export interface ShippingProvider {
  rates(input: {
    origin: string;
    destination: string;
    weightGrams: number;
    cod: boolean;
  }): Promise<
    Array<{ service: string; label: string; amount: Money; etaDays: number; etaMinDays?: number }>
  >;
  createShipment(input: {
    orderId: string;
    service: string;
    idempotencyKey: string;
    shippingAddress?: Record<string, unknown>;
    items?: Array<{ name: string; sku: string; quantity: number; price: number }>;
    orderTotal?: Money;
  }): Promise<{ shipmentId: string; awb: string; trackingUrl?: string }>;
  verifyWebhook(
    raw: Buffer,
    signature: string,
  ): Promise<{
    eventId: string;
    awb: string;
    status: string;
    occurredAt: Date;
  }>;
}
export type CartLine = { variantId: string; quantity: number };
export type PriceResult = {
  subtotal: number;
  discount: number;
  tax: number;
  shipping: number;
  total: number;
  currency: "INR";
};
