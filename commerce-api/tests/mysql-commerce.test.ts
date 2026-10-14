import crypto from "node:crypto";
import { describe, expect, it } from "vitest";
import { PrismaPersistence } from "../src/persistence.js";
import { orderConfirmationId } from "../src/order-confirmation.js";
import { CommerceStore } from "../src/store.js";
describe.skipIf(process.env.RUN_DB_TESTS !== "1")(
  "MySQL commerce operations",
  () => {
    it("serializes OTP issuance and consumes each challenge only once", async () => {
      const p = new PrismaPersistence(),
        mobile = "+919812340099",
        now = Date.now(),
        hash = "a".repeat(64);
      try {
        await p.deleteMobileOtpChallenge(mobile);
        const results = await Promise.all(
          [1, 2].map(() =>
            p.reserveMobileOtpChallenge({
              mobile,
              codeHash: hash,
              now,
              expiresAt: now + 300000,
              resendAt: now + 30000,
            }),
          ),
        );
        expect(results.filter((r) => r.created)).toHaveLength(1);
        const checks = await Promise.all(
          [1, 2].map(() =>
            p.consumeMobileOtpChallenge({
              mobile,
              submittedHash: hash,
              now,
              maxAttempts: 5,
            }),
          ),
        );
        expect(checks.filter((r) => r.outcome === "VERIFIED")).toHaveLength(1);
      } finally {
        await p.deleteMobileOtpChallenge(mobile);
        await p.db.setting.deleteMany({ where: { key: `otp-lock:${mobile}` } });
        await p.disconnect();
      }
    });
    it("runs customer search, facets and reports with JSON-safe numeric counts", async () => {
      const p = new PrismaPersistence();
      try {
        for (const query of [
          { page: 1, limit: 10 },
          { page: 1, limit: 10, search: "customer" },
          { page: 1, limit: 10, tag: "vip" },
        ]) {
          const result = await p.listAdminCustomersPage(query);
          expect(() => JSON.stringify(result)).not.toThrow();
          expect(typeof result.pagination.total).toBe("number");
        }
        const segments = await p.listAdminCustomerSegments();
        expect(() => JSON.stringify(segments)).not.toThrow();
      } finally {
        await p.disconnect();
      }
    });
    it("loads customer details and per-currency spending after refunds on supported databases", async () => {
      const p = new PrismaPersistence(), id = crypto.randomUUID();
      try {
        await p.db.user.create({ data: {
          id, email: `metrics-${id}@example.com`, name: "Currency metric fixture", role: "CUSTOMER",
          orders: { create: [
            { number: `METRIC-INR-${id}`, status: "DELIVERED", currency: "INR", subtotal: 1000, tax: 0, shipping: 0, total: 1000, addressSnapshot: {}, idempotencyKey: `metric-inr:${id}`,
              payments: { create: { provider: "test", status: "CAPTURED", amount: 1000, currency: "INR", idempotencyKey: `metric-pay:${id}`, refunds: { create: { amount: 100, status: "SUCCEEDED", idempotencyKey: `metric-refund:${id}` } } } } },
            { number: `METRIC-USD-${id}`, status: "DELIVERED", currency: "USD", subtotal: 100, tax: 0, shipping: 0, total: 100, addressSnapshot: {}, idempotencyKey: `metric-usd:${id}` },
          ] },
        } });
        const result = await p.listAdminCustomersPage({ page: 1, limit: 20, search: `metrics-${id}`, sortBy: "lastOrderAt", sortOrder: "desc" });
        expect(result.items).toHaveLength(1);
        const customer = result.items[0]!;
        expect(customer.metrics.totalSpent).toBe(900);
        expect(customer.metrics.spendByCurrency).toEqual(expect.arrayContaining([
          expect.objectContaining({ currency: "INR", totalSpent: 900, paidOrderCount: 1 }),
          expect.objectContaining({ currency: "USD", totalSpent: 100, paidOrderCount: 1 }),
        ]));
        expect((await p.getAdminCustomerDetail(id)).metrics.totalSpent).toBe(900);
        expect(() => JSON.stringify(result)).not.toThrow();
      } finally {
        await p.db.refund.deleteMany({ where: { payment: { order: { userId: id } } } });
        await p.db.payment.deleteMany({ where: { order: { userId: id } } });
        await p.db.order.deleteMany({ where: { userId: id } });
        await p.db.user.deleteMany({ where: { id } });
        await p.disconnect();
      }
    });
    it("persists manual courier details and delivery events without inventing tracking numbers", async () => {
      const p = new PrismaPersistence(), id = crypto.randomUUID();
      try {
        await p.db.order.create({ data: { id, number: `MANUAL-${id}`, status: "PACKED", subtotal: 100, tax: 0, shipping: 59, total: 159, idempotencyKey: `manual-test:${id}`, addressSnapshot: {} } });
        await p.saveShipment(id, "manual", { shipmentId: `manual:${id}`, courier: "Test delivery partner" });
        for (const [from, to] of [["PACKED", "SHIPPED"], ["SHIPPED", "OUT_FOR_DELIVERY"], ["OUT_FOR_DELIVERY", "DELIVERED"]])
          await p.transitionOrder(id, from!, to!);
        const tracking = await p.trackingDetails(id);
        expect(tracking).toMatchObject({ courier: "Test delivery partner", awb: null, status: "DELIVERED" });
        expect(tracking?.events.map(event => event.status)).toEqual(expect.arrayContaining(["SHIPPED", "OUT_FOR_DELIVERY", "DELIVERED"]));
      } finally {
        await p.db.trackingEvent.deleteMany({ where: { shipment: { orderId: id } } });
        await p.db.shipment.deleteMany({ where: { orderId: id } });
        await p.db.orderHistory.deleteMany({ where: { orderId: id } });
        await p.db.auditLog.deleteMany({ where: { resource: "order", resourceId: id } });
        await p.db.order.deleteMany({ where: { id } });
        await p.disconnect();
      }
    });
    it("reconciles verified captures once and commits reserved stock atomically", async () => {
      const p = new PrismaPersistence(),
        store = new CommerceStore();
      let userId = "";
      let orderId = "",
        variantId = "",
        original: { onHand: number; reserved: number } | undefined;
      try {
        await p.hydrate(store);
        const product = store.listProducts().at(-1)!,
          variant = product.variants[0]!;
        variantId = variant.id;
        original = await p.db.inventory.findUniqueOrThrow({
          where: { variantId },
        });
        const customer = await p.db.user.create({ data: { email: `mysql-test-${crypto.randomUUID()}@example.com`, name: "Database test customer" } });
        userId = customer.id;
        const order = store.createOrder({
          userId,
          status: "PAYMENT_PENDING",
          lines: [
            {
              variantId,
              name: product.name,
              sku: variant.sku,
              quantity: 1,
              unitPrice: variant.price,
              tax: 0,
            },
          ],
          subtotal: variant.price,
          discount: 1,
          tax: 0,
          shipping: 0,
          total: variant.price - 1,
          idempotencyKey: `mysql-verify-${crypto.randomUUID()}`,
        });
        orderId = order.id;
        await p.saveOrderAndReservations(order, { contact: { name: "Test Buyer", email: customer.email, phone: "+919876543210" }, shipping: { line1: "Test Road", city: "Hyderabad", postalCode: "500081" }, paymentMethod: "cashfree", discounts: { coupon: 0, onlinePayment: 1, onlineOffer: { type: "FIXED_AMOUNT", value: 1 } } }, "cashfree");
        expect(await p.db.notification.count({ where: { id: orderConfirmationId(order.id) } })).toBe(0);
        const payment = await p.createPaymentAttempt(
          order.id,
          "cashfree",
          `cf_${order.id}`,
          order.total,
          `verify_${order.id}`,
        );
        await expect(
          p.reconcilePayment(payment.id, {
            status: "CAPTURED",
            amount: order.total,
            currency: "USD",
            gatewayPaymentId: "cf_test",
          }),
        ).rejects.toMatchObject({ code: "PAYMENT_AMOUNT_MISMATCH" });
        const status = {
          status: "CAPTURED",
          amount: order.total,
          currency: "INR",
          gatewayPaymentId: `cf_${order.id}`,
        };
        await p.reconcilePayment(payment.id, status);
        await p.reconcilePayment(payment.id, status);
        for (const type of ["FAILED", "CANCELLED"] as const) {
          const lateClientEvent = {
            orderNumber: order.number,
            providerOrderId: payment.externalId!,
            type,
            gatewayPaymentId: `late-${type}-${order.id}`,
          };
          const first = await p.recordPaymentClientEvent(lateClientEvent);
          const repeated = await p.recordPaymentClientEvent(lateClientEvent);
          for (const recorded of [first, repeated])
            expect(recorded).toMatchObject({
              status: "CAPTURED",
              gatewayTransactionId: status.gatewayPaymentId,
            });
          expect(await p.db.paymentTransaction.count({
            where: { paymentId: payment.id, kind: type },
          })).toBe(1);
        }
        expect(await p.db.payment.findUniqueOrThrow({ where: { id: payment.id } }))
          .toMatchObject({ status: "CAPTURED", gatewayTransactionId: status.gatewayPaymentId });
        const emails = await p.db.notification.findMany({ where: { id: orderConfirmationId(order.id) } });
        expect(emails).toHaveLength(1);
        expect(emails[0]?.payload).toMatchObject({ orderNumber: order.number, paymentLabel: "Paid online", customer: { name: "Test Buyer", phone: "+919876543210" }, charges: { total: order.total, onlinePaymentDiscount: 1, couponDiscount: 0 } });
        await p.refreshOrder(store, order.id);
        expect(store.orders.get(order.id)?.invoiceSnapshot?.discounts).toMatchObject({ onlinePayment: 1, onlineOffer: { type: "FIXED_AMOUNT", value: 1 } });
        expect(store.orders.get(order.id)?.total).toBe(variant.price - 1);
        const inventory = await p.db.inventory.findUniqueOrThrow({
          where: { variantId },
        });
        expect(inventory.onHand).toBe(original.onHand - 1);
        expect(inventory.reserved).toBe(original.reserved);
        expect(
          (await p.db.order.findUniqueOrThrow({ where: { id: order.id } }))
            .status,
        ).toBe("PAID");
        const report = await p.listAdminCustomersPage({ page: 1, limit: 100 });
      expect(report.summary.spendByCurrency).toEqual(expect.arrayContaining([expect.objectContaining({ currency: "INR", totalSpent: expect.any(Number) })]));
      const stale = await p.reconcilePayment(payment.id, {
          status: "PENDING",
        });
        expect(stale.status).toBe("CAPTURED");
      } finally {
        if (orderId) {
          await p.db.notification.deleteMany({ where: { id: orderConfirmationId(orderId) } });
          await p.db.paymentTransaction.deleteMany({
            where: { payment: { orderId } },
          });
          await p.db.payment.deleteMany({ where: { orderId } });
          await p.db.order.deleteMany({ where: { id: orderId } });
        }
        if (userId) await p.db.user.delete({ where: { id: userId } });
        if (original)
          await p.db.inventory.update({
            where: { variantId },
            data: { onHand: original.onHand, reserved: original.reserved },
          });
        await p.disconnect();
      }
    });
  },
);
