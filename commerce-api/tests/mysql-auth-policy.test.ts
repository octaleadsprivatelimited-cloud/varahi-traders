import crypto from "node:crypto";
import { describe, expect, it } from "vitest";
import { PrismaPersistence } from "../src/persistence.js";
import { SINGLE_ADMIN_EMAIL } from "../src/auth-policy.js";

describe.skipIf(process.env.RUN_DB_TESTS !== "1")("MySQL sole-administrator policy", () => {
  it("preserves the customer and its orders while role transitions replace permissions and revoke sessions", async (context) => {
    const p = new PrismaPersistence();
    let userId = "", orderId = "";
    try {
      // This test owns this exact account. Never overwrite a developer's existing owner.
      if (await p.db.user.findUnique({ where: { email: SINGLE_ADMIN_EMAIL } })) {
        console.warn("Skipping role-policy database test: the designated administrator already exists. Use an isolated test database for this coverage.");
        context.skip();
      }
      const user = await p.db.user.create({ data: { email: SINGLE_ADMIN_EMAIL, name: "Role policy test customer", role: "CUSTOMER", totpEnabled: true, totpSecret: Buffer.from("legacy-enrollment") } });
      userId = user.id;
      const order = await p.db.order.create({ data: { number: `ROLE-${crypto.randomUUID()}`, userId, status: "CONFIRMED", subtotal: 50, tax: 0, shipping: 0, total: 50, addressSnapshot: {}, idempotencyKey: `role-policy-${crypto.randomUUID()}` } });
      orderId = order.id;
      const customerSession = crypto.randomUUID();
      await p.saveSession(customerSession, userId, Date.now() + 60000);
      const admin = await p.reconcileGoogleRole(userId, SINGLE_ADMIN_EMAIL);
      expect(admin).toMatchObject({ id: userId, role: "ADMIN", permissions: ["*"], totpEnabled: false, authVersion: user.authVersion + 1 });
      expect(admin.totpSecretEncrypted).toBeUndefined();
      expect(await p.getSession(customerSession)).toBeNull();
      expect(await p.db.userRoleAssignment.count({ where: { userId } })).toBe(1);
      expect((await p.db.order.findUniqueOrThrow({ where: { id: orderId } })).userId).toBe(userId);

      const adminSession = crypto.randomUUID();
      await p.saveSession(adminSession, userId, Date.now() + 60000);
      const returning = await p.reconcileGoogleRole(userId, SINGLE_ADMIN_EMAIL);
      expect(returning.authVersion).toBe(admin.authVersion);
      expect(await p.getSession(adminSession)).not.toBeNull();
      const demoted = await p.reconcileGoogleRole(userId, "other@gmail.com");
      expect(demoted).toMatchObject({ id: userId, role: "CUSTOMER", permissions: [], authVersion: (admin.authVersion || 0) + 1 });
      expect(await p.db.userRoleAssignment.count({ where: { userId } })).toBe(0);
      expect(await p.getSession(adminSession)).toBeNull();
      expect((await p.db.order.findUniqueOrThrow({ where: { id: orderId } })).userId).toBe(userId);
    } finally {
      if (orderId) await p.db.order.delete({ where: { id: orderId } });
      if (userId) {
        await p.db.auditLog.deleteMany({ where: { userId } });
        await p.db.user.delete({ where: { id: userId } });
      }
      await p.disconnect();
    }
  });
});
