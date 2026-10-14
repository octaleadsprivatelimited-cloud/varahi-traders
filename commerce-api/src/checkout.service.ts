import type { CartLine, PaymentProvider } from "./contracts.js";
import { PricingService } from "./pricing.service.js";
export interface CheckoutStore {
  transaction<T>(work: (tx: CheckoutStore) => Promise<T>): Promise<T>;
  findOrderByKey(key: string): Promise<{ id: string; total: number } | null>;
  reserve(lines: CartLine[]): Promise<void>;
  createOrder(input: {
    userId?: string;
    lines: CartLine[];
    total: number;
    idempotencyKey: string;
  }): Promise<{ id: string; total: number }>;
}
export class CheckoutService {
  constructor(
    private pricing: PricingService,
    private store: CheckoutStore,
    private payments: PaymentProvider,
  ) {}
  async create(input: {
    userId?: string;
    lines: CartLine[];
    shipping: number;
    idempotencyKey: string;
  }) {
    if (!input.idempotencyKey) throw new Error("IDEMPOTENCY_KEY_REQUIRED");
    const existing = await this.store.findOrderByKey(input.idempotencyKey);
    if (existing) return existing;
    const price = await this.pricing.calculate(input.lines, input.shipping);
    const order = await this.store.transaction(async (tx) => {
      const duplicate = await tx.findOrderByKey(input.idempotencyKey);
      if (duplicate) return duplicate;
      await tx.reserve(input.lines);
      return tx.createOrder({
        userId: input.userId,
        lines: input.lines,
        total: price.total,
        idempotencyKey: input.idempotencyKey,
      });
    });
    const payment = await this.payments.createOrder({
      orderId: order.id,
      amount: { amount: order.total, currency: "INR" },
      idempotencyKey: `payment:${input.idempotencyKey}`,
    });
    return { order, price, payment };
  }
}
