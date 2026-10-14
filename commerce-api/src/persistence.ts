import crypto from "node:crypto";
import { queueOrderConfirmation } from "./order-confirmation.js";
import type { StorefrontConfig } from "./storefront-config.js";
import {
  Prisma,
  PrismaClient,
  type OrderStatus,
  type UserRole,
} from "@prisma/client";
import { AppError } from "./errors.js";
import { couponBenefit } from "./coupon-policy.js";
import { googleAccountRole, isStoreAdminEmail } from "./auth-policy.js";
import type {
  CommerceStore,
  StoredIntegration,
  StoredOrder,
  StoredProduct,
  StoredUser,
} from "./store.js";
import {
  adminCustomerDto,
  customerSegmentDefinitions,
  listAdminCustomers,
  listCustomerSegments,
  normalizeCustomerTags,
  pagination,
  type AdminCustomerQuery,
} from "./admin-customer-operations.js";

function jsonArray(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (typeof value === "string") {
    try { const parsed: unknown = JSON.parse(value); return Array.isArray(parsed) ? parsed : []; } catch { return []; }
  }
  return [];
}
const number = (value: Prisma.Decimal | number) => Number(value);
const hash = (value: string) =>
  crypto.createHash("sha256").update(value).digest("hex");
const orderOperationsInclude = {
  items: true,
  history: { orderBy: { createdAt: "desc" as const }, take: 200 },
  payments: {
    orderBy: { createdAt: "desc" as const },
    take: 1,
    include: {
      refunds: { orderBy: { createdAt: "desc" as const }, take: 100 },
    },
  },
  shipments: {
    orderBy: { createdAt: "desc" as const },
    take: 1,
    include: {
      events: { orderBy: { occurredAt: "desc" as const }, take: 200 },
    },
  },
} satisfies Prisma.OrderInclude;
type PersistedOrder = Prisma.OrderGetPayload<{
  include: typeof orderOperationsInclude;
}>;

function toStoredOrder(order: PersistedOrder): StoredOrder {
  const snapshot = order.addressSnapshot as NonNullable<
    StoredOrder["invoiceSnapshot"]
  >;
  const trackingValue = snapshot.contact?.email || snapshot.contact?.phone;
  const payment = order.payments[0];
  const refunds = payment?.refunds.slice().reverse().map((refund) => ({
    id: refund.id,
    amount: number(refund.amount),
    status: refund.status as "PENDING" | "SUCCEEDED" | "FAILED",
    reason: refund.reason || "Not provided",
    externalId: refund.externalId || undefined,
    idempotencyKey: refund.idempotencyKey,
    createdAt: refund.createdAt.toISOString(),
  }));
  const shipment = order.shipments[0];
  return {
    id: order.id,
    number: order.number,
    userId: order.userId || undefined,
    status: order.status,
    payment: payment
      ? {
          externalId: payment.externalId || undefined,
          provider: payment.provider,
          status: payment.status,
          gatewayTransactionId: payment.gatewayTransactionId || undefined,
          amount: number(payment.amount),
          currency: payment.currency,
          refundedAmount: (refunds || [])
            .filter((refund) => refund.status === "SUCCEEDED")
            .reduce((sum, refund) => sum + refund.amount, 0),
          refunds,
        }
      : null,
    trackingVerificationHash: trackingValue
      ? hash(trackingValue.trim().toLowerCase())
      : undefined,
    shippingSelection: snapshot.shippingSelection,
    shipment: shipment
      ? {
          id: shipment.id,
          provider: shipment.provider,
          externalId: shipment.externalId || undefined,
          awb: shipment.awb || undefined,
          courier: shipment.courier || undefined,
          trackingUrl: shipment.trackingUrl || undefined,
          status: shipment.status,
          createdAt: shipment.createdAt.toISOString(),
          events: shipment.events.slice().reverse().map((event) => ({
            status: event.status,
            location: event.location || undefined,
            occurredAt: event.occurredAt.toISOString(),
          })),
        }
      : undefined,
    invoiceSnapshot: snapshot,
    lines: order.items.map((item) => ({
      variantId: item.variantId,
      name: item.name,
      sku: item.sku,
      quantity: item.quantity,
      unitPrice: number(item.unitPrice),
      tax: number(item.tax),
    })),
    subtotal: number(order.subtotal),
    tax: number(order.tax),
    shipping: number(order.shipping),
    discount: number(order.discount),
    total: number(order.total),
    idempotencyKey: order.idempotencyKey,
    history: order.history.slice().reverse().map((entry) => ({
      from: entry.fromStatus || undefined,
      to: entry.toStatus,
      at: entry.createdAt.toISOString(),
      actor: entry.actorId || undefined,
      source: entry.source,
    })),
    createdAt: order.createdAt.toISOString(),
  };
}

export class PrismaPersistence {
  readonly db: PrismaClient;
  constructor(db?: PrismaClient, databaseUrl?: string) {
    this.db = db || new PrismaClient(databaseUrl ? { datasourceUrl: databaseUrl } : undefined);
  }

  async connect() {
    await this.db.$connect();
  }

  async disconnect() {
    await this.db.$disconnect();
  }

  async getSetting<T>(key: string): Promise<T | null> {
    const setting = await this.db.setting.findUnique({ where: { key } });
    return setting ? (setting.value as T) : null;
  }

  async saveSetting(key: string, value: Prisma.InputJsonValue) {
    await this.db.setting.upsert({
      where: { key },
      update: { value },
      create: { key, value },
    });
  }

  async saveSettings(entries: Array<{ key: string; value: Prisma.InputJsonValue }>) {
    await this.db.$transaction(entries.map(({ key, value }) => this.db.setting.upsert({
      where: { key }, update: { value }, create: { key, value },
    })));
  }

  async listSettings<T>(prefix: string) {
    const settings = await this.db.setting.findMany({ where: { key: { startsWith: prefix } } });
    return settings.map(setting => ({ key: setting.key, value: setting.value as T }));
  }

  async hydrate(store: CommerceStore) {
    const [
      users,
      products,
      orders,
      coupons,
      integrations,
      carts,
      wishlistItems,
      returns,
    ] = await Promise.all([
      this.db.user.findMany({
        include: {
          roleAssignments: {
            include: {
              role: {
                include: { permissions: { include: { permission: true } } },
              },
            },
          },
        },
      }),
      this.db.product.findMany({
        where: { deletedAt: null },
        include: {
          category: true,
          brand: true,
          variants: { include: { inventory: true } },
          media: { orderBy: { position: "asc" } },
        },
      }),
      this.db.order.findMany({ include: orderOperationsInclude }),
      this.db.coupon.findMany({
        include: { _count: { select: { orders: true } } },
      }),
      this.db.integrationConfig.findMany(),
      this.db.cart.findMany({ include: { items: true } }),
      this.db.wishlistItem.findMany(),
      this.db.returnRequest.findMany({
        include: {
          items: {
            include: {
              orderItem: { select: { variantId: true, name: true, sku: true } },
            },
          },
        },
      }),
    ]);
    for (const user of users) {
      const permissions = [
        ...new Set(
          user.roleAssignments.flatMap((assignment) =>
            assignment.role.permissions.map((entry) => entry.permission.key),
          ),
        ),
      ];
      store.users.set(user.id, {
        id: user.id,
        name: user.name,
        email: user.email,
        mobile: user.mobile || undefined,
        role: user.role,
        permissions,
        totpEnabled: user.totpEnabled,
        totpSecretEncrypted: user.totpSecret
          ? Buffer.from(user.totpSecret).toString("base64")
          : undefined,
        tags: normalizeCustomerTags(user.tags),
        note: user.note || undefined,
        marketingConsent: user.marketingConsent,
        marketingConsentUpdatedAt:
          user.marketingConsentUpdatedAt?.toISOString(),
        disabledAt: user.disabledAt?.toISOString(),
        authVersion: user.authVersion,
        createdAt: user.createdAt.toISOString(),
        updatedAt: user.updatedAt.toISOString(),
      });
    }
    for (const product of products) {
      store.products.set(product.id, {
        id: product.id,
        name: product.name,
        slug: product.slug,
        description: product.description,
        category: product.category.name,
        brand: product.brand?.name,
        status: product.status as StoredProduct["status"],
        taxRate: number(product.taxRate),
        hsnCode: product.hsnCode || undefined,
        specifications: product.specifications as Record<string, string>,
        seoTitle: product.seoTitle || undefined,
        seoDescription: product.seoDescription || undefined,
        media: product.media.map((item) => ({
          id: item.id,
          url: item.url,
          alt: item.alt,
          type: item.type as "IMAGE" | "VIDEO",
          position: item.position,
          variantId: item.variantId || undefined,
        })),
        createdAt: product.createdAt.toISOString(),
        updatedAt: product.updatedAt.toISOString(),
        variants: product.variants.map((variant) => ({
          id: variant.id,
          sku: variant.sku,
          title: variant.title,
          active: variant.active,
          price: number(variant.price),
          mrp: number(variant.mrp),
          stock: variant.inventory?.onHand || 0,
          reserved: variant.inventory?.reserved || 0,
          attributes: variant.attributes as Record<string, string>,
          weightGrams: variant.weightGrams,
        })),
      });
    }
    for (const order of orders) store.orders.set(order.id, toStoredOrder(order));
    for (const coupon of coupons)
      store.coupons.set(coupon.code, {
        code: coupon.code,
        type: coupon.type,
        value: number(coupon.value),
        minimumSpend: number(coupon.minimumSpend),
        maximumDiscount: coupon.maximumDiscount
          ? number(coupon.maximumDiscount)
          : undefined,
        startsAt: coupon.startsAt.getTime(),
        endsAt: coupon.endsAt.getTime(),
        enabled: coupon.enabled,
        usageLimit: coupon.usageLimit || undefined,
        perUserLimit: coupon.perUserLimit,
        appliesTo: coupon.appliesTo === "SELECTED_PRODUCTS" ? "SELECTED_PRODUCTS" : "ALL_PRODUCTS",
        productIds: Array.isArray(coupon.productIds) ? coupon.productIds.filter((id): id is string => typeof id === "string") : [],
        used: coupon._count.orders,
      });
    for (const integration of integrations)
      store.integrations.set(integration.id, {
        id: integration.id,
        kind: integration.kind,
        provider: integration.provider,
        enabled: integration.enabled,
        priority: integration.priority,
        environment: integration.environment,
        encryptedCredentials: Buffer.from(
          integration.encryptedCredentials,
        ).toString("base64"),
        publicConfig: integration.publicConfig as Record<string, unknown>,
        updatedAt: integration.updatedAt.toISOString(),
      });
    for (const cart of carts) {
      const key = cart.userId
        ? `user:${cart.userId}`
        : cart.guestToken
          ? `guest:${cart.guestToken}`
          : undefined;
      if (key)
        store.carts.set(
          key,
          new Map(cart.items.map((item) => [item.variantId, item.quantity])),
        );
    }
    for (const item of wishlistItems) {
      const list = store.wishlists.get(item.userId) || new Set<string>();
      list.add(item.productId);
      store.wishlists.set(item.userId, list);
    }
    for (const request of returns)
      store.returns.set(request.id, {
        id: request.id,
        orderId: request.orderId,
        userId: request.userId || undefined,
        reason: request.reason,
        notes: request.notes || undefined,
        status: request.status,
        createdAt: request.createdAt.toISOString(),
        updatedAt: request.updatedAt.toISOString(),
        items: request.items.map((item) => ({
          id: item.id,
          orderItemId: item.orderItemId,
          variantId: item.orderItem.variantId,
          name: item.orderItem.name,
          sku: item.orderItem.sku,
          quantity: item.quantity,
          condition: item.condition || undefined,
        })),
      });
  }

  async saveUser(user: StoredUser) {
    try {
      await this.db.user.create({
        data: {
          id: user.id,
          name: user.name,
          email: user.email,
          mobile: user.mobile,
          role: user.role as UserRole,
        },
      });
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === "P2002"
      )
        throw new AppError(
          409,
          "EMAIL_EXISTS",
          "An account already exists for this email or mobile number",
        );
      throw error;
    }
  }

  async findAuthUserByIdentity(
    provider: string,
    subject: string,
    email?: string,
    audience?: string,
  ) {
    const identity = await this.db.authIdentity.findUnique({
      where: { provider_subject: { provider, subject } },
      select: { id: true, userId: true },
    });
    if (!identity) return null;
    await this.db.authIdentity.update({
      where: { id: identity.id },
      data: {
        lastAuthenticatedAt: new Date(),
        ...(email ? { email } : {}),
        ...(audience ? { audience } : {}),
      },
    });
    return this.findAuthUser({ id: identity.userId });
  }

  async saveGoogleUser(
    user: StoredUser,
    subject: string,
    email: string,
    audience: string,
  ) {
    try {
      await this.db.$transaction(async (tx) => {
        await tx.user.create({
          data: {
            id: user.id,
            name: user.name,
            email: user.email,
            mobile: user.mobile,
            role: user.role as UserRole,
            verifiedAt: new Date(),
          },
        });
        await tx.authIdentity.create({
          data: {
            userId: user.id,
            provider: "google",
            subject,
            audience,
            email,
            lastAuthenticatedAt: new Date(),
          },
        });
      });
      return user;
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === "P2002"
      ) {
        const racedIdentity = await this.findAuthUserByIdentity(
          "google",
          subject,
          email,
          audience,
        );
        if (racedIdentity) return racedIdentity;
        throw new AppError(
          409,
          "GOOGLE_ACCOUNT_LINK_REQUIRED",
          "An account already exists with this email. Contact the store administrator to connect Google.",
        );
      }
      throw error;
    }
  }

  async userHasAuthIdentity(
    userId: string,
    provider: string,
    subject: string,
  ) {
    const identity = await this.db.authIdentity.findUnique({
      where: { provider_subject: { provider, subject } },
      select: { userId: true },
    });
    return identity?.userId === userId;
  }

  async getUserAuthIdentity(userId: string, provider: string) {
    return this.db.authIdentity.findUnique({
      where: { userId_provider: { userId, provider } },
      select: {
        userId: true,
        provider: true,
        subject: true,
        audience: true,
        email: true,
      },
    });
  }

  async linkAuthIdentity(input: {
    userId: string;
    provider: string;
    subject: string;
    audience: string;
    email: string;
  }) {
    const touch = (id: string) =>
      this.db.authIdentity.update({
        where: { id },
        data: {
          audience: input.audience,
          email: input.email,
          lastAuthenticatedAt: new Date(),
        },
        select: {
          userId: true,
          provider: true,
          subject: true,
          audience: true,
          email: true,
        },
      });
    const resolveExisting = async () => {
      const bySubject = await this.db.authIdentity.findUnique({
        where: {
          provider_subject: {
            provider: input.provider,
            subject: input.subject,
          },
        },
        select: { id: true, userId: true },
      });
      if (bySubject) {
        if (bySubject.userId !== input.userId)
          throw new AppError(
            409,
            "GOOGLE_IDENTITY_IN_USE",
            "This Google account is already connected to another customer",
          );
        return touch(bySubject.id);
      }
      const byUser = await this.db.authIdentity.findUnique({
        where: {
          userId_provider: {
            userId: input.userId,
            provider: input.provider,
          },
        },
        select: { id: true, subject: true },
      });
      if (byUser) {
        if (byUser.subject !== input.subject)
          throw new AppError(
            409,
            "GOOGLE_ACCOUNT_ALREADY_LINKED",
            "A different Google account is already connected to this customer",
          );
        return touch(byUser.id);
      }
      return null;
    };

    const existing = await resolveExisting();
    if (existing) return existing;
    try {
      return await this.db.authIdentity.create({
        data: {
          userId: input.userId,
          provider: input.provider,
          subject: input.subject,
          audience: input.audience,
          email: input.email,
          lastAuthenticatedAt: new Date(),
        },
        select: {
          userId: true,
          provider: true,
          subject: true,
          audience: true,
          email: true,
        },
      });
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === "P2002"
      ) {
        const raced = await resolveExisting();
        if (raced) return raced;
      }
      throw error;
    }
  }

  async deleteCustomerAccount(userId: string) {
    return this.db.$transaction(async (tx) => {
      const user = await tx.user.findUnique({
        where: { id: userId },
        select: { role: true, email: true, mobile: true },
      });
      if (!user)
        throw new AppError(404, "ACCOUNT_NOT_FOUND", "Account not found");
      if (user.role !== "CUSTOMER")
        throw new AppError(
          403,
          "CUSTOMER_ACCOUNT_REQUIRED",
          "Staff accounts cannot be deleted here",
        );
      const orders = await tx.order.findMany({
        where: { userId },
        select: { id: true },
      });
      const deletedAt = new Date().toISOString();
      for (const order of orders)
        await tx.order.update({
          where: { id: order.id },
          data: {
            userId: null,
            addressSnapshot: {
              redacted: true,
              deletedAt,
              retentionReason: "financial_and_fulfilment_record",
            },
          },
        });
      await tx.supportTicket.deleteMany({ where: { userId } });
      await tx.notification.deleteMany({
        where: {
          OR: [
            { userId },
            {
              userId: null,
              destination: {
                in: [user.email, ...(user.mobile ? [user.mobile] : [])],
              },
            },
          ],
        },
      });
      await tx.returnRequest.updateMany({
        where: { userId },
        data: {
          userId: null,
          reason: "Personal details removed",
          notes: null,
        },
      });
      await tx.auditLog.create({
        data: {
          userId,
          action: "customer.account_deleted",
          resource: "user",
          resourceId: userId,
          after: { retainedOrders: orders.length, personalDataRedacted: true },
        },
      });
      await tx.user.delete({ where: { id: userId } });
      return { deleted: true, retainedOrders: orders.length };
    });
  }
  async saveTotp(userId: string, encryptedSecret: string, enabled: boolean) {
    await this.db.user.update({
      where: { id: userId },
      data: {
        totpSecret: Buffer.from(encryptedSecret, "base64"),
        totpEnabled: enabled,
      },
    });
  }

  async queueNotification(input: {
    userId?: string;
    channel: string;
    template: string;
    destination: string;
    payload: Prisma.InputJsonValue;
  }) {
    return this.db.notification.create({
      data: { ...input, status: "QUEUED" },
    });
  }

  async reserveMobileOtpChallenge(input: { mobile: string; codeHash: string; expiresAt: number; resendAt: number; now: number }): Promise<{ created: true } | { created: false; retryAfterSeconds: number }> {
    return this.db.$transaction(async (tx) => {
      await tx.$executeRaw`INSERT IGNORE INTO \`Setting\` (\`key\`, \`value\`, \`encrypted\`, \`updatedAt\`) VALUES (${`otp-lock:${input.mobile}`}, '{}', false, NOW())`;
      await tx.$queryRaw`SELECT \`key\` FROM \`Setting\` WHERE \`key\` = ${`otp-lock:${input.mobile}`} FOR UPDATE`;
      const existing = await tx.$queryRaw<Array<{ resendAt: Date }>>`SELECT \`resendAt\` FROM \`MobileOtpChallenge\` WHERE \`mobile\` = ${input.mobile} FOR UPDATE`;
      const resendAt = existing[0]?.resendAt.getTime();
      if (resendAt && resendAt > input.now)
        return { created: false as const, retryAfterSeconds: Math.max(1, Math.ceil((resendAt - input.now) / 1000)) };
      await tx.mobileOtpChallenge.upsert({
        where: { mobile: input.mobile },
        create: { mobile: input.mobile, codeHash: input.codeHash, attempts: 0, expiresAt: new Date(input.expiresAt), resendAt: new Date(input.resendAt) },
        update: { codeHash: input.codeHash, attempts: 0, expiresAt: new Date(input.expiresAt), resendAt: new Date(input.resendAt) },
      });
      return { created: true as const };
    });
  }

  async consumeMobileOtpChallenge(input: { mobile: string; submittedHash: string; now: number; maxAttempts: number }): Promise<
    | { outcome: "VERIFIED" | "NOT_FOUND" | "EXPIRED" }
    | { outcome: "INVALID" | "ATTEMPTS_EXCEEDED"; attemptsRemaining: number; resendAt: number }
  > {
    return this.db.$transaction(async (tx) => {
      const rows = await tx.$queryRaw<Array<{ codeHash: string; attempts: number; expiresAt: Date; resendAt: Date }>>`SELECT \`codeHash\`, \`attempts\`, \`expiresAt\`, \`resendAt\` FROM \`MobileOtpChallenge\` WHERE \`mobile\` = ${input.mobile} FOR UPDATE`;
      const challenge = rows[0];
      if (!challenge) return { outcome: "NOT_FOUND" as const };
      if (challenge.expiresAt.getTime() <= input.now) {
        await tx.$executeRaw`DELETE FROM \`MobileOtpChallenge\` WHERE \`mobile\` = ${input.mobile}`;
        return { outcome: "EXPIRED" as const };
      }
      const attemptsRemaining = Math.max(0, input.maxAttempts - challenge.attempts);
      if (attemptsRemaining === 0)
        return { outcome: "ATTEMPTS_EXCEEDED" as const, attemptsRemaining: 0, resendAt: challenge.resendAt.getTime() };
      const expected = Buffer.from(challenge.codeHash), submitted = Buffer.from(input.submittedHash);
      const matches = expected.length === submitted.length && crypto.timingSafeEqual(expected, submitted);
      if (!matches) {
        const nextAttempts = challenge.attempts + 1, remaining = Math.max(0, input.maxAttempts - nextAttempts);
        await tx.$executeRaw`UPDATE \`MobileOtpChallenge\` SET \`attempts\` = ${nextAttempts}, \`updatedAt\` = ${new Date(input.now)} WHERE \`mobile\` = ${input.mobile}`;
        return { outcome: remaining === 0 ? "ATTEMPTS_EXCEEDED" as const : "INVALID" as const, attemptsRemaining: remaining, resendAt: challenge.resendAt.getTime() };
      }
      await tx.$executeRaw`DELETE FROM \`MobileOtpChallenge\` WHERE \`mobile\` = ${input.mobile}`;
      return { outcome: "VERIFIED" as const };
    });
  }

  async deleteMobileOtpChallenge(mobile: string, codeHash?: string) {
    if (codeHash)
      return this.db.$executeRaw`DELETE FROM \`MobileOtpChallenge\` WHERE \`mobile\` = ${mobile} AND \`codeHash\` = ${codeHash}`;
    return this.db.$executeRaw`DELETE FROM \`MobileOtpChallenge\` WHERE \`mobile\` = ${mobile}`;
  }

  async saveSession(jti: string, userId: string, expiresAt: number) {
    await this.db.session.create({
      data: {
        id: crypto.randomUUID(),
        userId,
        tokenHash: hash(jti),
        expiresAt: new Date(expiresAt),
      },
    });
  }

  async getSession(jti: string) {
    return this.db.session.findFirst({
      where: {
        tokenHash: hash(jti),
        revokedAt: null,
        expiresAt: { gt: new Date() },
      },
    });
  }

  async revokeSession(jti: string) {
    await this.db.session.updateMany({
      where: { tokenHash: hash(jti), revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }

  async consumeSession(jti: string) {
    const changed = await this.db.session.updateMany({
      where: {
        tokenHash: hash(jti),
        revokedAt: null,
        expiresAt: { gt: new Date() },
      },
      data: { revokedAt: new Date() },
    });
    return changed.count === 1;
  }

  async saveProduct(product: StoredProduct) {
    const category = await this.db.category.upsert({
      where: {
        slug: product.category.toLowerCase().replace(/[^a-z0-9]+/g, "-"),
      },
      update: { name: product.category },
      create: {
        name: product.category,
        slug: product.category.toLowerCase().replace(/[^a-z0-9]+/g, "-"),
      },
    });
    const brand = product.brand
      ? await this.db.brand.upsert({
          where: {
            slug: product.brand.toLowerCase().replace(/[^a-z0-9]+/g, "-"),
          },
          update: { name: product.brand },
          create: {
            name: product.brand,
            slug: product.brand.toLowerCase().replace(/[^a-z0-9]+/g, "-"),
          },
        })
      : undefined;
    try {
      await this.db.$transaction(async (tx) => {
      await tx.product.upsert({
        where: { id: product.id },
        update: {
          name: product.name,
          slug: product.slug,
          description: product.description,
          status: product.status,
          categoryId: category.id,
          brandId: brand?.id,
          hsnCode: product.hsnCode,
          taxRate: product.taxRate,
          specifications: product.specifications,
          seoTitle: product.seoTitle,
          seoDescription: product.seoDescription,
          deletedAt: null,
        },
        create: {
          id: product.id,
          name: product.name,
          slug: product.slug,
          description: product.description,
          status: product.status,
          categoryId: category.id,
          brandId: brand?.id,
          hsnCode: product.hsnCode,
          taxRate: product.taxRate,
          specifications: product.specifications,
          seoTitle: product.seoTitle,
          seoDescription: product.seoDescription,
        },
      });
      const variantIds = product.variants.map((variant) => variant.id);
      await tx.productVariant.updateMany({
        where: {
          productId: product.id,
          ...(variantIds.length ? { id: { notIn: variantIds } } : {}),
        },
        data: { active: false },
      });
      for (const variant of product.variants) {
        const existingVariant = await tx.productVariant.findFirst({
          where: { id: variant.id, productId: product.id },
          select: { id: true },
        });
        const variantData = {
          sku: variant.sku,
          title: variant.title,
          price: variant.price,
          mrp: variant.mrp,
          weightGrams: variant.weightGrams,
          attributes: variant.attributes,
          active: variant.active,
        };
        if (existingVariant) {
          await tx.productVariant.update({
            where: { id: variant.id },
            data: variantData,
          });
        } else {
          await tx.productVariant.create({
            data: {
              id: variant.id,
              productId: product.id,
              ...variantData,
            },
          });
        }
        await tx.inventory.upsert({
          where: { variantId: variant.id },
          update: { onHand: variant.stock, reserved: variant.reserved },
          create: {
            variantId: variant.id,
            onHand: variant.stock,
            reserved: variant.reserved,
          },
        });
      }
      const mediaIds = product.media.map((item) => item.id);
      await tx.productMedia.deleteMany({
        where: {
          productId: product.id,
          ...(mediaIds.length ? { id: { notIn: mediaIds } } : {}),
        },
      });
      const allowedVariantIds = new Set(
        product.variants.map((variant) => variant.id),
      );
      for (const item of product.media) {
        const existingMedia = await tx.productMedia.findFirst({
          where: { id: item.id, productId: product.id },
          select: { id: true },
        });
        const mediaData = {
          variantId:
            item.variantId && allowedVariantIds.has(item.variantId)
              ? item.variantId
              : null,
          url: item.url,
          alt: item.alt,
          type: item.type,
          position: item.position,
        };
        if (existingMedia) {
          await tx.productMedia.update({
            where: { id: item.id },
            data: mediaData,
          });
        } else {
          await tx.productMedia.create({
            data: {
              id: item.id,
              productId: product.id,
              ...mediaData,
            },
          });
        }
      }
      });
    } catch (error) {
      if ((error as { code?: string }).code !== "P2002") throw error;
      const target = JSON.stringify(
        (error as { meta?: { target?: unknown } }).meta?.target || "",
      ).toLowerCase();
      if (target.includes("slug"))
        throw new AppError(409, "SLUG_EXISTS", "Product slug already exists");
      if (target.includes("sku"))
        throw new AppError(
          409,
          "SKU_EXISTS",
          "A product variant with this SKU already exists",
        );
      throw new AppError(
        409,
        "CATALOG_CONFLICT",
        "The product conflicts with an existing catalog record",
      );
    }
  }

  async addProductMedia(input: {
    id: string;
    productId: string;
    url: string;
    alt: string;
    position: number;
    variantId?: string;
  }, orderedIds?: string[]) {
    return this.db.$transaction(async (tx) => {
      const media = await tx.productMedia.create({
        data: { ...input, variantId: input.variantId || null, type: "IMAGE" },
      });
      for (const [position, id] of (orderedIds || [input.id]).entries())
        await tx.productMedia.updateMany({
          where: { id, productId: input.productId },
          data: { position },
        });
      await tx.product.update({
        where: { id: input.productId },
        data: { updatedAt: new Date() },
      });
      return media;
    });
  }

  async getCustomerAccountState(userId: string) {
    const user = await this.db.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        name: true,
        email: true,
        mobile: true,
        role: true,
        disabledAt: true,
        authVersion: true,
      },
    });
    return user
      ? {
          exists: true,
          customer: user.role === "CUSTOMER",
          disabled: Boolean(user.disabledAt),
          disabledAt: user.disabledAt,
          authVersion: user.authVersion,
          user,
        }
      : {
          exists: false,
          customer: false,
          disabled: true,
          disabledAt: null,
          authVersion: -1,
          user: null,
        };
  }

  async reconcileGoogleRole(userId: string, verifiedEmail: string) {
    const role = googleAccountRole(verifiedEmail);
    await this.db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM User WHERE id = ${userId} FOR UPDATE`;
      const current = await tx.user.findUnique({ where: { id: userId } });
      if (!current || current.disabledAt)
        throw new AppError(403, "ACCOUNT_DISABLED", "This account is disabled. Contact store support for assistance");
      if (role === "ADMIN" && !isStoreAdminEmail(current.email))
        throw new AppError(409, "GOOGLE_ACCOUNT_LINK_REQUIRED", "The administrator Google account must match its store account.");
      const changed = current.role !== role;
      await tx.userRoleAssignment.deleteMany({ where: { userId } });
      if (role === "ADMIN") {
        const admin = await tx.role.upsert({ where: { name: "ADMIN" }, update: {}, create: { name: "ADMIN" } });
        const permission = await tx.permission.upsert({ where: { key: "*" }, update: {}, create: { key: "*" } });
        await tx.rolePermission.upsert({ where: { roleId_permissionId: { roleId: admin.id, permissionId: permission.id } }, update: {}, create: { roleId: admin.id, permissionId: permission.id } });
        await tx.userRoleAssignment.create({ data: { userId, roleId: admin.id } });
      }
      await tx.user.update({ where: { id: userId }, data: { role, totpEnabled: false, totpSecret: null, ...(changed ? { authVersion: { increment: 1 } } : {}) } });
      if (changed) {
        await tx.session.updateMany({ where: { userId, revokedAt: null }, data: { revokedAt: new Date() } });
        await tx.auditLog.create({ data: { userId, action: "auth.google_role_applied", resource: "user", resourceId: userId, before: { role: current.role }, after: { role } } });
      }
    });
    const user = await this.findAuthUser({ id: userId });
    if (!user) throw new AppError(401, "INVALID_TOKEN", "Account no longer exists");
    return user;
  }

  async findAuthUser(input: { id?: string; email?: string; mobile?: string }) {
    if (!input.id && !input.email && !input.mobile) return null;
    const user = await this.db.user.findFirst({
      where: input.id
        ? { id: input.id }
        : input.email
          ? { email: { equals: input.email } }
          : { mobile: input.mobile },
      include: {
        roleAssignments: {
          include: {
            role: {
              include: { permissions: { include: { permission: true } } },
            },
          },
        },
      },
    });
    if (!user) return null;
    const permissions = [
      ...new Set(
        user.roleAssignments.flatMap((assignment) =>
          assignment.role.permissions.map((entry) => entry.permission.key),
        ),
      ),
    ];
    return {
      id: user.id,
      name: user.name,
      email: user.email,
      mobile: user.mobile || undefined,
      role: user.role,
      permissions,
      totpEnabled: user.totpEnabled,
      totpSecretEncrypted: user.totpSecret
        ? Buffer.from(user.totpSecret).toString("base64")
        : undefined,
      tags: normalizeCustomerTags(user.tags),
      note: user.note || undefined,
      marketingConsent: user.marketingConsent,
      marketingConsentUpdatedAt:
        user.marketingConsentUpdatedAt?.toISOString(),
      disabledAt: user.disabledAt?.toISOString(),
      authVersion: user.authVersion,
      createdAt: user.createdAt.toISOString(),
      updatedAt: user.updatedAt.toISOString(),
    } satisfies StoredUser;
  }

  async reorderProductMedia(productId: string, mediaIds: string[]) {
    await this.db.$transaction(async (tx) => {
      for (const [position, id] of mediaIds.entries())
        await tx.productMedia.updateMany({
          where: { id, productId },
          data: { position },
        });
      await tx.product.update({
        where: { id: productId },
        data: { updatedAt: new Date() },
      });
    });
  }

  async updateProductMedia(
    productId: string,
    mediaId: string,
    data: { alt?: string; variantId?: string | null },
  ) {
    const updated = await this.db.productMedia.updateMany({
      where: { id: mediaId, productId },
      data,
    });
    if (!updated.count)
      throw new AppError(404, "MEDIA_NOT_FOUND", "Product media not found");
    await this.db.product.update({
      where: { id: productId },
      data: { updatedAt: new Date() },
    });
  }

  async deleteProductMedia(productId: string, mediaId: string) {
    const deleted = await this.db.productMedia.deleteMany({
      where: { id: mediaId, productId },
    });
    if (!deleted.count)
      throw new AppError(404, "MEDIA_NOT_FOUND", "Product media not found");
    await this.db.product.update({
      where: { id: productId },
      data: { updatedAt: new Date() },
    });
  }

  async archiveProduct(id: string) {
    await this.db.product.update({
      where: { id },
      data: { status: "ARCHIVED", deletedAt: null },
    });
  }

  async adjustInventory(
    variantId: string,
    quantity: number,
    reason: string,
    actorId: string,
    idempotencyKey: string,
  ) {
    const execute = async () =>
      this.db.$transaction(
        async (tx) => {
          const duplicate = await tx.inventoryMovement.findUnique({
            where: { idempotencyKey },
            include: { inventory: true },
          });
          if (duplicate) {
            if (
              duplicate.inventory.variantId !== variantId ||
              duplicate.quantity !== quantity ||
              duplicate.reason !== reason
            )
              throw new AppError(
                409,
                "IDEMPOTENCY_CONFLICT",
                "This idempotency key was already used for another inventory adjustment",
              );
            return {
              inventory: duplicate.inventory,
              movement: duplicate,
              replayed: true,
            };
          }
          const inventory = await tx.inventory.findUnique({
            where: { variantId },
          });
          if (!inventory || inventory.onHand + quantity < inventory.reserved)
            throw new AppError(
              409,
              "INVENTORY_ADJUSTMENT_INVALID",
              "Adjustment would reduce stock below reserved quantity",
            );
          const updated = await tx.inventory.update({
            where: { variantId },
            data: {
              onHand: { increment: quantity },
              version: { increment: 1 },
            },
          });
          const movement = await tx.inventoryMovement.create({
            data: {
              inventoryId: inventory.id,
              quantity,
              reason,
              referenceId: idempotencyKey,
              idempotencyKey,
            },
          });
          await tx.auditLog.create({
            data: {
              userId: actorId,
              action: "inventory.adjusted",
              resource: "variant",
              resourceId: variantId,
              before: { onHand: inventory.onHand },
              after: {
                onHand: updated.onHand,
                quantity,
                reason,
                referenceId: idempotencyKey,
              },
            },
          });
          return { inventory: updated, movement, replayed: false };
        },
        { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
      );
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        return await execute();
      } catch (error) {
        const code = (error as { code?: string }).code;
        if (code === "P2034") {
          if (attempt < 2) continue;
          throw new AppError(
            503,
            "INVENTORY_CONFLICT_RETRY",
            "Inventory changed concurrently; retry the same request",
          );
        }
        if (code !== "P2002") throw error;
        const duplicate = await this.db.inventoryMovement.findUnique({
          where: { idempotencyKey },
          include: { inventory: true },
        });
        if (
          !duplicate ||
          duplicate.inventory.variantId !== variantId ||
          duplicate.quantity !== quantity ||
          duplicate.reason !== reason
        )
          throw new AppError(
            409,
            "IDEMPOTENCY_CONFLICT",
            "This idempotency key was already used for another inventory adjustment",
          );
        return {
          inventory: duplicate.inventory,
          movement: duplicate,
          replayed: true,
        };
      }
    }
    throw new AppError(
      503,
      "INVENTORY_CONFLICT_RETRY",
      "Inventory changed concurrently; retry the same request",
    );
  }

  listInventoryMovements(variantId: string) {
    return this.db.inventoryMovement.findMany({
      where: { inventory: { variantId } },
      orderBy: { createdAt: "desc" },
    });
  }

  listAddresses(userId: string) {
    return this.db.address.findMany({
      where: { userId },
      orderBy: { isDefault: "desc" },
    });
  }
  async saveAddress(
    userId: string,
    input: {
      label: string;
      line1: string;
      line2?: string;
      phone?: string;
      city: string;
      state: string;
      postalCode: string;
      country: string;
      isDefault: boolean;
    },
  ) {
    return this.db.$transaction(async (tx) => {
      if (input.isDefault)
        await tx.address.updateMany({
          where: { userId },
          data: { isDefault: false },
        });
      return tx.address.create({ data: { userId, ...input } });
    });
  }
  async deleteAddress(userId: string, id: string) {
    const deleted = await this.db.address.deleteMany({ where: { id, userId } });
    if (!deleted.count)
      throw new AppError(404, "ADDRESS_NOT_FOUND", "Address not found");
  }
  async refreshOrders(store: CommerceStore) {
    const orders = await this.db.order.findMany({
      include: orderOperationsInclude,
      orderBy: { createdAt: "desc" },
    });
    const persistedIds = new Set(orders.map((order) => order.id));
    for (const id of store.orders.keys())
      if (!persistedIds.has(id)) store.orders.delete(id);
    for (const order of orders) store.orders.set(order.id, toStoredOrder(order));
  }

  async refreshOrder(store: CommerceStore, orderId: string) {
    const order = await this.db.order.findUnique({
      where: { id: orderId },
      include: orderOperationsInclude,
    });
    if (!order) {
      store.orders.delete(orderId);
      return null;
    }
    const stored = toStoredOrder(order);
    store.orders.set(order.id, stored);
    return stored;
  }

  async listAdminOrdersPage(input: {
    page: number;
    pageSize: number;
    search?: string;
    status?: OrderStatus;
  }) {
    const search = input.search?.trim();
    const where: Prisma.OrderWhereInput = {
      ...(input.status ? { status: input.status } : {}),
      ...(search
        ? {
            OR: [
              { number: { contains: search } },
              {
                addressSnapshot: {
                  path: "$.contact.name",
                  string_contains: search,
                },
              },
              {
                addressSnapshot: {
                  path: "$.contact.email",
                  string_contains: search,
                },
              },
              {
                addressSnapshot: {
                  path: "$.contact.phone",
                  string_contains: search,
                },
              },
              {
                user: {
                  is: {
                    OR: [
                      { name: { contains: search } },
                      { email: { contains: search } },
                      { mobile: { contains: search } },
                    ],
                  },
                },
              },
              {
                items: {
                  some: {
                    OR: [
                      { name: { contains: search } },
                      { sku: { contains: search } },
                    ],
                  },
                },
              },
            ],
          }
        : {}),
    };
    const terminalStatuses: OrderStatus[] = ["CANCELLED", "FAILED", "REFUNDED"];
    const [orders, filteredTotal, totalOrders, activeCount, readyToShip, orderValue] =
      await this.db.$transaction([
        this.db.order.findMany({
          where,
          include: orderOperationsInclude,
          orderBy: [{ createdAt: "desc" }, { id: "desc" }],
          skip: (input.page - 1) * input.pageSize,
          take: input.pageSize,
        }),
        this.db.order.count({ where }),
        this.db.order.count(),
        this.db.order.count({ where: { status: { notIn: terminalStatuses } } }),
        this.db.order.count({ where: { status: "PACKED" } }),
        this.db.order.aggregate({
          where: { status: { notIn: ["CANCELLED", "FAILED"] } },
          _sum: { total: true },
        }),
      ]);
    return {
      orders: orders.map(toStoredOrder),
      filteredTotal,
      summary: {
        totalOrders,
        activeCount,
        readyToShip,
        orderValue: number(orderValue._sum.total || 0),
        currency: "INR",
      },
    };
  }
  async listAdminCustomersPage(input: AdminCustomerQuery) {
    const searchedConditions: Prisma.Sql[] = [];
    if (input.search)
      searchedConditions.push(Prisma.sql`
        CONCAT_WS(' ', m.\`name\`, m.\`email\`, COALESCE(m.\`mobile\`, ''),
          CAST(m.\`tags\` AS CHAR) COLLATE utf8mb4_unicode_ci) LIKE ${`%${input.search}%`}
      `);
    const conditions = [...searchedConditions];
    if (input.status)
      conditions.push(
        input.status === "ACTIVE"
          ? Prisma.sql`m.\`disabledAt\` IS NULL`
          : Prisma.sql`m.\`disabledAt\` IS NOT NULL`,
      );
    if (input.marketing)
      conditions.push(
        input.marketing === "SUBSCRIBED"
          ? Prisma.sql`m.\`marketingConsent\` = true`
          : Prisma.sql`m.\`marketingConsent\` = false`,
      );
    if (input.tag)
      conditions.push(Prisma.sql`
        EXISTS (
          SELECT 1 FROM JSON_TABLE(JSON_EXTRACT(m.\`tags\`, '$'), '$[*]' COLUMNS(tag VARCHAR(40) PATH '$')) tag_values
          WHERE LOWER(tag) = LOWER(${input.tag})
        )
      `);
    if (input.segment === "NEW")
      conditions.push(Prisma.sql`m.\`createdAt\` >= NOW() - INTERVAL 30 DAY`);
    if (input.segment === "REPEAT")
      conditions.push(Prisma.sql`m.\`paidOrderCount\` >= 2`);
    if (input.segment === "HIGH_VALUE")
      conditions.push(Prisma.sql`m.\`totalSpent\` >= 5000`);
    if (input.segment === "AT_RISK")
      conditions.push(Prisma.sql`
        m.\`paidOrderCount\` > 0 AND
          m.\`lastPaidOrderAt\` < NOW() - INTERVAL 90 DAY
      `);
    const where = conditions.length
      ? Prisma.join(conditions, " AND ")
      : Prisma.sql`TRUE`;
    const searchedWhere = searchedConditions.length
      ? Prisma.join(searchedConditions, " AND ")
      : Prisma.sql`TRUE`;
    const sortColumn: Record<NonNullable<AdminCustomerQuery["sortBy"]>, Prisma.Sql> = {
      createdAt: Prisma.sql`m.\`createdAt\``,
      name: Prisma.sql`LOWER(m.\`name\`)`,
      orders: Prisma.sql`m.\`orderCount\``,
      spent: Prisma.sql`m.\`totalSpent\``,
      lastOrderAt: Prisma.sql`m.\`lastOrderAt\``,
    };
    const orderDirection =
      input.sortOrder === "asc" ? Prisma.sql`ASC` : Prisma.sql`DESC`;
    type CountRow = { count: number };
    type SummaryRow = {
      totalCustomers: number;
      activeCustomers: number;
      disabledCustomers: number;
      subscribedCustomers: number;
      totalSpent: Prisma.Decimal;
      spendByCurrency: Prisma.JsonValue;
    };
    type FacetRow = { facet: string; value: string; count: number };
    const [rows, countRows, summaryRows, facetRows] = await Promise.all([
      this.db.$queryRaw<PersistentCustomerRow[]>(Prisma.sql`
        WITH customer_metrics AS (${customerMetricsSql})
        SELECT m.* FROM customer_metrics m
        WHERE ${where}
        ORDER BY ${sortColumn[input.sortBy || "createdAt"]} ${orderDirection}
          , m.\`id\` ASC
        LIMIT ${input.limit} OFFSET ${(input.page - 1) * input.limit}
      `),
      this.db.$queryRaw<CountRow[]>(Prisma.sql`
        WITH customer_metrics AS (${customerMetricsSql})
        SELECT COUNT(*) AS \`count\` FROM customer_metrics m
        WHERE ${where}
      `),
      this.db.$queryRaw<SummaryRow[]>(Prisma.sql`
        WITH customer_metrics AS (${customerMetricsSql})
        SELECT
          COUNT(*) AS \`totalCustomers\`,
          COUNT(CASE WHEN m.\`disabledAt\` IS NULL THEN 1 END) AS \`activeCustomers\`,
          COUNT(CASE WHEN m.\`disabledAt\` IS NOT NULL THEN 1 END) AS \`disabledCustomers\`,
          COUNT(CASE WHEN m.\`marketingConsent\` THEN 1 END) AS \`subscribedCustomers\`,
          COALESCE(SUM(m.\`totalSpent\`), 0) AS \`totalSpent\`,
          COALESCE((
            SELECT JSON_ARRAYAGG(JSON_OBJECT(
              'currency', totals.currency,
              'totalSpent', totals.\`totalSpent\`
            ))
            FROM (
              SELECT o.\`currency\` AS currency,
                SUM(GREATEST(o.\`total\` - COALESCE((
                  SELECT SUM(r.\`amount\`) FROM \`Refund\` r
                  INNER JOIN \`Payment\` p ON p.\`id\` = r.\`paymentId\`
                  WHERE p.\`orderId\` = o.\`id\` AND r.\`status\` = 'SUCCEEDED'
                ), 0), 0)) AS \`totalSpent\`
              FROM \`Order\` o
              INNER JOIN \`User\` customer ON customer.\`id\` = o.\`userId\`
              WHERE o.\`status\` IN (
                'PAID', 'CONFIRMED', 'PROCESSING', 'PACKED', 'SHIPPED',
                'OUT_FOR_DELIVERY', 'DELIVERED', 'RETURN_REQUESTED',
                'RETURN_APPROVED', 'RETURNED', 'REFUND_PENDING'
              )
                AND customer.\`role\` = 'CUSTOMER'
              GROUP BY o.\`currency\`
            ) totals
          ), '[]') AS \`spendByCurrency\`
        FROM customer_metrics m
      `),
      this.db.$queryRaw<FacetRow[]>(Prisma.sql`
        WITH customer_metrics AS (${customerMetricsSql}),
        searched AS (SELECT * FROM customer_metrics m WHERE ${searchedWhere})
        SELECT 'statuses' AS facet,
          CASE WHEN s.\`disabledAt\` IS NULL THEN 'ACTIVE' ELSE 'DISABLED' END AS value,
          COUNT(*) AS count
        FROM searched s GROUP BY value
        UNION ALL
        SELECT 'marketing',
          CASE WHEN s.\`marketingConsent\` THEN 'SUBSCRIBED' ELSE 'NOT_SUBSCRIBED' END,
          COUNT(*)
        FROM searched s GROUP BY 2
        UNION ALL
        SELECT 'tags', tag, COUNT(*)
        FROM searched s CROSS JOIN JSON_TABLE(JSON_EXTRACT(s.\`tags\`, '$'), '$[*]' COLUMNS(tag VARCHAR(40) PATH '$')) tag_values GROUP BY tag
        UNION ALL
        SELECT 'segments', 'NEW',
          COUNT(CASE WHEN s.\`createdAt\` >= NOW() - INTERVAL 30 DAY THEN 1 END)
        FROM searched s
        UNION ALL
        SELECT 'segments', 'REPEAT',
          COUNT(CASE WHEN s.\`paidOrderCount\` >= 2 THEN 1 END) FROM searched s
        UNION ALL
        SELECT 'segments', 'HIGH_VALUE',
          COUNT(CASE WHEN s.\`totalSpent\` >= 5000 THEN 1 END) FROM searched s
        UNION ALL
        SELECT 'segments', 'AT_RISK',
          COUNT(CASE WHEN s.\`paidOrderCount\` > 0 AND
            s.\`lastPaidOrderAt\` < NOW() - INTERVAL 90 DAY THEN 1 END) FROM searched s
        ORDER BY facet, value
      `),
    ]);
    const facets: Record<string, Array<{ value: string; count: number }>> = {
      statuses: [],
      marketing: [],
      tags: [],
      segments: [],
    };
    for (const facet of facetRows)
      facets[facet.facet]?.push({ value: facet.value, count: Number(facet.count) });
    const total = Number(countRows[0]?.count || 0);
    const summary = summaryRows[0];
    return {
      items: rows.map(persistentCustomerDto),
      pagination: pagination(input.page, input.limit, total),
      summary: {
        totalCustomers: Number(summary?.totalCustomers || 0),
        activeCustomers: Number(summary?.activeCustomers || 0),
        disabledCustomers: Number(summary?.disabledCustomers || 0),
        subscribedCustomers: Number(summary?.subscribedCustomers || 0),
        totalSpent: summary ? number(summary.totalSpent) : 0,
        currency: "INR" as const,
        spendByCurrency: jsonArray(summary?.spendByCurrency),
      },
      facets,
    };
  }

  async listAdminCustomerSegments() {
    const rows = await this.db.$queryRaw<Array<{ id: string; count: number }>>(
      Prisma.sql`
        WITH customer_metrics AS (${customerMetricsSql})
        SELECT 'NEW' AS id,
          COUNT(CASE WHEN \`createdAt\` >= NOW() - INTERVAL 30 DAY THEN 1 END) AS count
        FROM customer_metrics
        UNION ALL SELECT 'REPEAT', COUNT(CASE WHEN \`paidOrderCount\` >= 2 THEN 1 END)
          FROM customer_metrics
        UNION ALL SELECT 'HIGH_VALUE', COUNT(CASE WHEN \`totalSpent\` >= 5000 THEN 1 END)
          FROM customer_metrics
        UNION ALL SELECT 'AT_RISK', COUNT(CASE WHEN \`paidOrderCount\` > 0 AND
          \`lastPaidOrderAt\` < NOW() - INTERVAL 90 DAY THEN 1 END) FROM customer_metrics
      `,
    );
    const counts = new Map(rows.map((row) => [row.id, row.count]));
    return {
      items: customerSegmentDefinitions.map((definition) => ({
        ...definition,
        count: Number(counts.get(definition.id) || 0),
      })),
      generatedAt: new Date().toISOString(),
    };
  }

  async getAdminCustomerDetail(id: string) {
    const user = await this.db.user.findFirst({
      where: { id, role: "CUSTOMER" },
      select: {
        id: true,
        name: true,
        email: true,
        mobile: true,
        role: true,
        tags: true,
        note: true,
        marketingConsent: true,
        marketingConsentUpdatedAt: true,
        disabledAt: true,
        authVersion: true,
        createdAt: true,
        updatedAt: true,
        addresses: {
          orderBy: [{ isDefault: "desc" }, { id: "asc" }],
          take: 50,
        },
        orders: {
          select: {
            id: true,
            number: true,
            status: true,
            currency: true,
            subtotal: true,
            discount: true,
            tax: true,
            shipping: true,
            total: true,
            idempotencyKey: true,
            createdAt: true,
            items: { select: { quantity: true } },
          },
          orderBy: { createdAt: "desc" },
          take: 100,
        },
        returnRequests: {
          select: {
            id: true,
            orderId: true,
            status: true,
            reason: true,
            createdAt: true,
            order: { select: { number: true } },
          },
          orderBy: { createdAt: "desc" },
          take: 50,
        },
        supportTickets: {
          select: {
            id: true,
            number: true,
            subject: true,
            status: true,
            priority: true,
            updatedAt: true,
          },
          orderBy: { updatedAt: "desc" },
          take: 50,
        },
        _count: {
          select: {
            orders: true,
            returnRequests: true,
            supportTickets: true,
            addresses: true,
          },
        },
      },
    });
    if (!user)
      throw new AppError(404, "CUSTOMER_NOT_FOUND", "Customer not found");
    const metricRows = await this.db.$queryRaw<PersistentCustomerRow[]>(
      Prisma.sql`
        WITH customer_metrics AS (${customerMetricsSql})
        SELECT m.* FROM customer_metrics m WHERE m.\`id\` = ${id}
      `,
    );
    const profile = metricRows[0];
    if (!profile)
      throw new AppError(404, "CUSTOMER_NOT_FOUND", "Customer not found");
    return {
      ...persistentCustomerDto(profile),
      note: user.note || null,
      addresses: user.addresses,
      orders: user.orders.map((order) => ({
        id: order.id,
        number: order.number,
        status: order.status,
        total: number(order.total),
        currency: order.currency,
        itemCount: order.items.reduce((sum, item) => sum + item.quantity, 0),
        createdAt: order.createdAt.toISOString(),
        detached: false,
      })),
      returns: user.returnRequests.map((item) => ({
        id: item.id,
        orderId: item.orderId,
        orderNumber: item.order.number,
        status: item.status,
        reason: item.reason,
        createdAt: item.createdAt.toISOString(),
      })),
      supportTickets: user.supportTickets.map((ticket) => ({
        ...ticket,
        updatedAt: ticket.updatedAt.toISOString(),
      })),
      counts: {
        orders: user._count.orders,
        returns: user._count.returnRequests,
        supportTickets: user._count.supportTickets,
        addresses: user._count.addresses,
      },
      retention: {
        purchaseHistoryOwnerRetainedAfterDeletion: true,
        customerIdentityDeletedOnAccountDeletion: true,
      },
    };
  }

  async updateAdminCustomer(
    id: string,
    input: {
      tags?: string[];
      note?: string | null;
      marketingConsent?: boolean;
      accountStatus?: "ACTIVE" | "DISABLED";
    },
    actorId: string,
  ) {
    return this.db.$transaction(async (tx) => {
      const before = await tx.user.findUnique({ where: { id } });
      if (!before || before.role !== "CUSTOMER")
        throw new AppError(404, "CUSTOMER_NOT_FOUND", "Customer not found");
      const now = new Date();
      const data: Prisma.UserUpdateInput = {};
      if (input.tags !== undefined) data.tags = normalizeCustomerTags(input.tags);
      if (input.note !== undefined) data.note = input.note || null;
      if (input.marketingConsent !== undefined) {
        data.marketingConsent = input.marketingConsent;
        if (input.marketingConsent !== before.marketingConsent)
          data.marketingConsentUpdatedAt = now;
      }
      if (input.accountStatus !== undefined)
        data.disabledAt = input.accountStatus === "DISABLED" ? now : null;
      if (input.accountStatus === "DISABLED" && !before.disabledAt)
        data.authVersion = { increment: 1 };
      const updated = await tx.user.update({ where: { id }, data });
      if (input.accountStatus === "DISABLED")
        await tx.session.updateMany({
          where: { userId: id, revokedAt: null },
          data: { revokedAt: now },
        });
      await tx.auditLog.create({
        data: {
          userId: actorId,
          action: "customer.updated",
          resource: "customer",
          resourceId: id,
          before: {
            tags: before.tags,
            notePresent: Boolean(before.note),
            marketingConsent: before.marketingConsent,
            accountStatus: before.disabledAt ? "DISABLED" : "ACTIVE",
          },
          after: {
            tags: updated.tags,
            notePresent: Boolean(updated.note),
            marketingConsent: updated.marketingConsent,
            accountStatus: updated.disabledAt ? "DISABLED" : "ACTIVE",
          },
        },
      });
      return updated;
    });
  }

  async listAdminReturnsPage(input: {
    search?: string;
    status?: string;
    page: number;
    limit: number;
  }) {
    const search = input.search?.trim();
    const searchedWhere: Prisma.ReturnRequestWhereInput = search
      ? {
          OR: [
            { reason: { contains: search } },
            { order: { number: { contains: search } } },
            {
              user: {
                is: {
                  OR: [
                    { name: { contains: search } },
                    { email: { contains: search } },
                    { mobile: { contains: search } },
                  ],
                },
              },
            },
          ],
        }
      : {};
    const where: Prisma.ReturnRequestWhereInput = {
      ...searchedWhere,
      ...(input.status ? { status: input.status } : {}),
    };
    const [rows, total, statusGroups] = await this.db.$transaction([
      this.db.returnRequest.findMany({
        where,
        include: {
          order: {
            select: {
              id: true,
              number: true,
              status: true,
              total: true,
              currency: true,
            },
          },
          user: { select: { id: true, name: true, email: true, mobile: true } },
          refund: { select: { id: true, status: true, amount: true } },
          _count: { select: { items: true } },
        },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        skip: (input.page - 1) * input.limit,
        take: input.limit,
      }),
      this.db.returnRequest.count({ where }),
      this.db.returnRequest.groupBy({
        by: ["status"],
        where: searchedWhere,
        _count: { id: true },
        orderBy: { status: "asc" },
      }),
    ]);
    return {
      items: rows.map((item) => ({
        id: item.id,
        status: item.status,
        reason: item.reason,
        notes: item.notes || null,
        createdAt: item.createdAt.toISOString(),
        updatedAt: item.updatedAt.toISOString(),
        itemCount: item._count.items,
        order: {
          id: item.order.id,
          number: item.order.number,
          status: item.order.status,
          total: number(item.order.total),
          currency: item.order.currency,
        },
        customer: item.user
          ? { ...item.user, mobile: item.user.mobile || null }
          : null,
        refund: item.refund
          ? {
              id: item.refund.id,
              status: item.refund.status,
              amount: number(item.refund.amount),
              currency: item.order.currency,
            }
          : null,
      })),
      pagination: pagination(input.page, input.limit, total),
      facets: {
        statuses: statusGroups.map((group) => ({
          value: group.status,
          count: (group._count as { id: number }).id,
        })),
      },
    };
  }

  async getAdminReturnDetail(id: string) {
    const item = await this.db.returnRequest.findUnique({
      where: { id },
      include: {
        order: {
          select: {
            id: true,
            number: true,
            status: true,
            total: true,
            currency: true,
          },
        },
        user: { select: { id: true, name: true, email: true, mobile: true } },
        refund: { select: { id: true, status: true, amount: true } },
        items: {
          include: {
            orderItem: { select: { id: true, name: true, sku: true } },
          },
          orderBy: { id: "asc" },
        },
      },
    });
    if (!item)
      throw new AppError(404, "RETURN_NOT_FOUND", "Return request not found");
    return {
      id: item.id,
      status: item.status,
      reason: item.reason,
      notes: item.notes || null,
      createdAt: item.createdAt.toISOString(),
      updatedAt: item.updatedAt.toISOString(),
      itemCount: item.items.length,
      order: {
        id: item.order.id,
        number: item.order.number,
        status: item.order.status,
        total: number(item.order.total),
        currency: item.order.currency,
      },
      customer: item.user
        ? { ...item.user, mobile: item.user.mobile || null }
        : null,
      refund: item.refund
        ? {
            id: item.refund.id,
            status: item.refund.status,
            amount: number(item.refund.amount),
            currency: item.order.currency,
          }
        : null,
      items: item.items.map((entry) => ({
        id: entry.id,
        orderItemId: entry.orderItemId,
        name: entry.orderItem.name,
        sku: entry.orderItem.sku,
        quantity: entry.quantity,
        condition: entry.condition || null,
      })),
    };
  }

  async listAdminSupportPage(input: {
    search?: string;
    status?: string;
    priority?: string;
    page: number;
    limit: number;
  }) {
    const search = input.search?.trim();
    const searchedWhere: Prisma.SupportTicketWhereInput = search
      ? {
          OR: [
            { number: { contains: search } },
            { subject: { contains: search } },
            {
              user: {
                is: {
                  OR: [
                    { name: { contains: search } },
                    { email: { contains: search } },
                  ],
                },
              },
            },
          ],
        }
      : {};
    const where: Prisma.SupportTicketWhereInput = {
      ...searchedWhere,
      ...(input.status ? { status: input.status } : {}),
      ...(input.priority ? { priority: input.priority } : {}),
    };
    const [rows, total, statusGroups, priorityGroups] =
      await this.db.$transaction([
        this.db.supportTicket.findMany({
          where,
          include: {
            user: { select: { id: true, name: true, email: true, mobile: true } },
            messages: {
              select: { createdAt: true },
              orderBy: { createdAt: "desc" },
              take: 1,
            },
            _count: { select: { messages: true } },
          },
          orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
          skip: (input.page - 1) * input.limit,
          take: input.limit,
        }),
        this.db.supportTicket.count({ where }),
        this.db.supportTicket.groupBy({
          by: ["status"],
          where: searchedWhere,
          _count: { id: true },
          orderBy: { status: "asc" },
        }),
        this.db.supportTicket.groupBy({
          by: ["priority"],
          where: searchedWhere,
          _count: { id: true },
          orderBy: { priority: "asc" },
        }),
      ]);
    return {
      items: rows.map((ticket) => ({
        id: ticket.id,
        number: ticket.number,
        subject: ticket.subject,
        status: ticket.status,
        priority: ticket.priority,
        createdAt: ticket.createdAt.toISOString(),
        updatedAt: ticket.updatedAt.toISOString(),
        messageCount: ticket._count.messages,
        lastMessageAt: ticket.messages[0]?.createdAt.toISOString() ||
          ticket.createdAt.toISOString(),
        customer: ticket.user
          ? { ...ticket.user, mobile: ticket.user.mobile || null }
          : null,
      })),
      pagination: pagination(input.page, input.limit, total),
      facets: {
        statuses: statusGroups.map((group) => ({
          value: group.status,
          count: (group._count as { id: number }).id,
        })),
        priorities: priorityGroups.map((group) => ({
          value: group.priority,
          count: (group._count as { id: number }).id,
        })),
      },
    };
  }

  async getAdminSupportDetail(id: string) {
    const ticket = await this.db.supportTicket.findUnique({
      where: { id },
      include: {
        user: { select: { id: true, name: true, email: true, mobile: true } },
        _count: { select: { messages: true } },
        messages: {
          include: { author: { select: { id: true, name: true, role: true } } },
          orderBy: { createdAt: "desc" },
          take: 200,
        },
      },
    });
    if (!ticket)
      throw new AppError(404, "TICKET_NOT_FOUND", "Support ticket not found");
    return {
      id: ticket.id,
      number: ticket.number,
      subject: ticket.subject,
      status: ticket.status,
      priority: ticket.priority,
      createdAt: ticket.createdAt.toISOString(),
      updatedAt: ticket.updatedAt.toISOString(),
      messageCount: ticket._count.messages,
      lastMessageAt:
        ticket.messages[0]?.createdAt.toISOString() ||
        ticket.createdAt.toISOString(),
      customer: ticket.user
        ? { ...ticket.user, mobile: ticket.user.mobile || null }
        : null,
      messages: ticket.messages.slice().reverse().map((message) => ({
        id: message.id,
        body: message.body,
        internal: message.internal,
        createdAt: message.createdAt.toISOString(),
        author: message.author,
      })),
    };
  }

  async createSupportTicket(
    userId: string,
    input: { subject: string; message: string; priority: string },
  ) {
    const number = `SUP-${Date.now().toString(36).toUpperCase()}-${crypto
      .randomBytes(3)
      .toString("hex")
      .toUpperCase()}`;
    return this.db.supportTicket.create({
      data: {
        number,
        userId,
        subject: input.subject,
        priority: input.priority,
        messages: { create: { authorId: userId, body: input.message } },
      },
      include: { messages: true },
    });
  }
  listSupportTickets(userId?: string) {
    return this.db.supportTicket.findMany({
      where: userId ? { userId } : undefined,
      include: {
        messages: {
          where: userId ? { internal: false } : undefined,
          orderBy: { createdAt: "asc" },
          take: 100,
        },
        user: { select: { name: true, email: true } },
      },
      orderBy: { updatedAt: "desc" },
      take: userId ? 50 : 100,
    });
  }
  async replySupportTicket(
    id: string,
    actorId: string,
    message: string,
    status: string | undefined,
    customerId?: string,
    internal = false,
  ) {
    return this.db.$transaction(async (tx) => {
      const ticket = await tx.supportTicket.findFirst({
        where: { id, ...(customerId ? { userId: customerId } : {}) },
      });
      if (!ticket)
        throw new AppError(404, "TICKET_NOT_FOUND", "Support ticket not found");
      const nextStatus =
        status || (internal ? ticket.status : customerId ? "OPEN" : "WAITING_CUSTOMER");
      await tx.supportMessage.create({
        data: { ticketId: id, authorId: actorId, body: message, internal },
      });
      await tx.supportTicket.update({
        where: { id },
        data: { status: nextStatus },
      });
      if (!customerId)
        await tx.auditLog.create({
          data: {
            userId: actorId,
            action: internal ? "support.internal_note_added" : "support.replied",
            resource: "support_ticket",
            resourceId: id,
            before: { status: ticket.status },
            after: { status: nextStatus, internal },
          },
        });
      const result = await tx.supportTicket.findUnique({
        where: { id },
        include: {
          user: { select: { id: true, name: true, email: true, mobile: true } },
          messages: {
            where: customerId ? { internal: false } : undefined,
            include: { author: { select: { id: true, name: true, role: true } } },
            orderBy: { createdAt: "desc" },
            take: 200,
          },
        },
      });
      if (!result)
        throw new AppError(404, "TICKET_NOT_FOUND", "Support ticket not found");
      return result;
    });
  }

  async updateSupportTicket(
    id: string,
    input: { status?: string; priority?: string },
    actorId: string,
  ) {
    return this.db.$transaction(async (tx) => {
      const ticket = await tx.supportTicket.findUnique({ where: { id } });
      if (!ticket)
        throw new AppError(404, "TICKET_NOT_FOUND", "Support ticket not found");
      const updated = await tx.supportTicket.update({
        where: { id },
        data: { status: input.status, priority: input.priority },
      });
      await tx.auditLog.create({
        data: {
          userId: actorId,
          action: "support.updated",
          resource: "support_ticket",
          resourceId: id,
          before: { status: ticket.status, priority: ticket.priority },
          after: { status: updated.status, priority: updated.priority },
        },
      });
      return updated;
    });
  }

  async saveCartItem(key: string, variantId: string, quantity: number) {
    await this.db.$transaction(async (tx) => {
      const userId = key.startsWith("user:") ? key.slice(5) : undefined;
      const guestToken = key.startsWith("guest:") ? key.slice(6) : undefined;
      let cart = userId
        ? await tx.cart.findFirst({ where: { userId } })
        : guestToken
          ? await tx.cart.findUnique({ where: { guestToken } })
          : null;
      cart ||= await tx.cart.create({
        data: {
          userId,
          guestToken,
          expiresAt: guestToken
            ? new Date(Date.now() + 30 * 86_400_000)
            : undefined,
        },
      });
      if (quantity === 0)
        await tx.cartItem.deleteMany({ where: { cartId: cart.id, variantId } });
      else
        await tx.cartItem.upsert({
          where: { cartId_variantId: { cartId: cart.id, variantId } },
          update: { quantity },
          create: { cartId: cart.id, variantId, quantity },
        });
    });
  }

  async saveWishlist(userId: string, productId: string, saved: boolean) {
    if (saved)
      await this.db.wishlistItem.upsert({
        where: { userId_productId: { userId, productId } },
        update: {},
        create: { userId, productId },
      });
    else
      await this.db.wishlistItem.deleteMany({ where: { userId, productId } });
  }

  async saveCoupon(coupon: {
    code: string;
    type: "PERCENTAGE" | "FIXED_AMOUNT" | "FREE_SHIPPING";
    value: number;
    minimumSpend: number;
    maximumDiscount?: number;
    startsAt: number;
    endsAt: number;
    enabled: boolean;
    usageLimit?: number;
    perUserLimit: number;
    appliesTo?: "ALL_PRODUCTS" | "SELECTED_PRODUCTS";
    productIds?: string[];
  }) {
    await this.db.coupon.upsert({
      where: { code: coupon.code },
      update: {
        type: coupon.type,
        value: coupon.value,
        minimumSpend: coupon.minimumSpend,
        maximumDiscount: coupon.maximumDiscount ?? null,
        startsAt: new Date(coupon.startsAt),
        endsAt: new Date(coupon.endsAt),
        enabled: coupon.enabled,
        usageLimit: coupon.usageLimit ?? null,
        perUserLimit: coupon.perUserLimit,
        appliesTo: coupon.appliesTo || "ALL_PRODUCTS",
        productIds: coupon.appliesTo === "SELECTED_PRODUCTS" ? coupon.productIds || [] : [],
      },
      create: {
        code: coupon.code,
        type: coupon.type,
        value: coupon.value,
        minimumSpend: coupon.minimumSpend,
        maximumDiscount: coupon.maximumDiscount ?? null,
        startsAt: new Date(coupon.startsAt),
        endsAt: new Date(coupon.endsAt),
        enabled: coupon.enabled,
        usageLimit: coupon.usageLimit ?? null,
        perUserLimit: coupon.perUserLimit,
        appliesTo: coupon.appliesTo || "ALL_PRODUCTS",
        productIds: coupon.appliesTo === "SELECTED_PRODUCTS" ? coupon.productIds || [] : [],
      },
    });
  }

  async couponUsageForUser(code: string, userId: string) {
    const coupon = await this.db.coupon.findUnique({ where: { code }, select: { id: true, perUserLimit: true } });
    if (!coupon) return null;
    const used = await this.db.order.count({ where: { couponId: coupon.id, userId } });
    return { used, limit: coupon.perUserLimit };
  }

  async archiveCoupon(code: string) {
    return this.db.coupon.updateMany({ where: { code }, data: { enabled: false } });
  }

  async transitionOrder(
    orderId: string,
    from: string,
    to: string,
    actorId?: string,
    source = "ADMIN",
  ) {
    await this.db.$transaction(async (tx) => {
      const inventoryAction =
        to === "PAID"
          ? "COMMIT"
          : to === "FAILED"
            ? "RELEASE"
            : to === "CANCELLED"
              ? "CANCEL"
              : from === "FAILED" && to === "PAYMENT_PENDING"
                ? "RESERVE"
                : null;
      if (inventoryAction) {
        const items = await tx.orderItem.findMany({
          where: { orderId },
          select: { variantId: true, quantity: true, sku: true },
        });
        for (const item of items) {
          const inventory = await tx.inventory.findUnique({ where: { variantId: item.variantId } });
          if (!inventory)
            throw new AppError(409, "INVENTORY_NOT_FOUND", `Inventory is missing for ${item.sku}`);
          const wasCommitted = Boolean(await tx.inventoryMovement.findFirst({
            where: { inventoryId: inventory.id, referenceId: orderId, reason: "ORDER_COMMITTED" },
          }));
          const wasRestocked = Boolean(await tx.inventoryMovement.findFirst({
            where: { inventoryId: inventory.id, referenceId: orderId, reason: "ORDER_CANCELLED_RESTOCK" },
          }));
          let changed = 1;
          let reason = "";
          let quantity = 0;
          if (inventoryAction === "COMMIT" && !wasCommitted) {
            changed = await tx.$executeRaw`UPDATE \`Inventory\` SET \`onHand\` = \`onHand\` - ${item.quantity}, \`reserved\` = \`reserved\` - ${item.quantity}, \`version\` = \`version\` + 1 WHERE \`variantId\` = ${item.variantId} AND \`onHand\` >= ${item.quantity} AND \`reserved\` >= ${item.quantity}`;
            reason = "ORDER_COMMITTED";
            quantity = -item.quantity;
          } else if (inventoryAction === "RELEASE" && !wasCommitted) {
            changed = await tx.$executeRaw`UPDATE \`Inventory\` SET \`reserved\` = \`reserved\` - ${item.quantity}, \`version\` = \`version\` + 1 WHERE \`variantId\` = ${item.variantId} AND \`reserved\` >= ${item.quantity}`;
            reason = "ORDER_RESERVATION_RELEASED";
          } else if (inventoryAction === "CANCEL" && wasCommitted && !wasRestocked) {
            changed = await tx.$executeRaw`UPDATE \`Inventory\` SET \`onHand\` = \`onHand\` + ${item.quantity}, \`version\` = \`version\` + 1 WHERE \`variantId\` = ${item.variantId}`;
            reason = "ORDER_CANCELLED_RESTOCK";
            quantity = item.quantity;
          } else if (inventoryAction === "CANCEL" && !wasCommitted) {
            changed = await tx.$executeRaw`UPDATE \`Inventory\` SET \`reserved\` = \`reserved\` - ${item.quantity}, \`version\` = \`version\` + 1 WHERE \`variantId\` = ${item.variantId} AND \`reserved\` >= ${item.quantity}`;
            reason = "ORDER_RESERVATION_RELEASED";
          } else if (inventoryAction === "RESERVE") {
            changed = await tx.$executeRaw`UPDATE \`Inventory\` SET \`reserved\` = \`reserved\` + ${item.quantity}, \`version\` = \`version\` + 1 WHERE \`variantId\` = ${item.variantId} AND \`onHand\` - \`reserved\` >= ${item.quantity}`;
            reason = "ORDER_RETRY_RESERVED";
          }
          if (changed !== 1)
            throw new AppError(409, "INVENTORY_STATE_CONFLICT", `Inventory changed for ${item.sku}; reload and try again`);
          if (reason)
            await tx.inventoryMovement.create({
              data: { inventoryId: inventory.id, quantity, reason, referenceId: orderId },
            });
        }
      }
      const receivedReturn =
        from === "RETURN_APPROVED" && to === "RETURNED"
          ? await tx.returnRequest.findFirst({
              where: { orderId, status: "APPROVED" },
              orderBy: { updatedAt: "desc" },
              select: { id: true },
            })
          : null;
      if (from === "RETURN_APPROVED" && to === "RETURNED" && !receivedReturn)
        throw new AppError(
          409,
          "RETURN_REQUEST_MISSING",
          "An approved return request is required before receiving a return",
        );
      const changed = await tx.order.updateMany({
        where: { id: orderId, status: from as OrderStatus },
        data: { status: to as OrderStatus },
      });
      if (changed.count !== 1)
        throw new AppError(
          409,
          "STALE_ORDER_STATE",
          "Order state changed; reload and try again",
        );
      if (["SHIPPED", "OUT_FOR_DELIVERY", "DELIVERED", "CANCELLED", "RETURNED"].includes(to)) {
        const manualShipments = await tx.shipment.findMany({ where: { orderId, provider: "manual" }, select: { id: true } });
        if (manualShipments.length) {
          await tx.shipment.updateMany({ where: { orderId, provider: "manual" }, data: { status: to } });
          await tx.trackingEvent.createMany({ data: manualShipments.map(shipment => ({ shipmentId: shipment.id, providerEventId: `manual:${shipment.id}:${from}:${to}`, status: to, occurredAt: new Date() })), skipDuplicates: true });
        }
      }
      if (receivedReturn) {
        const changedReturn = await tx.returnRequest.updateMany({
          where: { id: receivedReturn.id, status: "APPROVED" },
          data: { status: "RECEIVED" },
        });
        if (changedReturn.count !== 1)
          throw new AppError(
            409,
            "STALE_RETURN_STATE",
            "Return state changed; reload and try again",
          );
      }
      await tx.orderHistory.create({
        data: {
          orderId,
          fromStatus: from as OrderStatus,
          toStatus: to as OrderStatus,
          actorId,
          source,
        },
      });
      await tx.auditLog.create({
        data: {
          userId: actorId,
          action: "order.status_changed",
          resource: "order",
          resourceId: orderId,
          before: { status: from },
          after: { status: to },
        },
      });
    });
  }

  async saveShipment(
    orderId: string,
    provider: string,
    result: { shipmentId: string; awb?: string; trackingUrl?: string; courier?: string },
  ) {
    return this.db.shipment.upsert({
      where: { idempotencyKey: `ship:${orderId}` },
      update: {
        provider,
        externalId: result.shipmentId,
        awb: result.awb,
        courier: result.courier,
        trackingUrl: result.trackingUrl,
        status: "SHIPPED",
      },
      create: {
        orderId,
        provider,
        externalId: result.shipmentId,
        awb: result.awb,
        courier: result.courier,
        trackingUrl: result.trackingUrl,
        status: "SHIPPED",
        idempotencyKey: `ship:${orderId}`,
      },
    });
  }

  async shipmentContext(orderId: string) {
    const order = await this.db.order.findUnique({
      where: { id: orderId },
      include: { items: true },
    });
    if (!order) throw new AppError(404, "ORDER_NOT_FOUND", "Order not found");
    const snapshot = order.addressSnapshot as any;
    return {
      shippingAddress: {
        ...snapshot.shipping,
        ...snapshot.contact,
        cod: String(snapshot.paymentMethod || "").toLowerCase() === "cod",
        weightGrams: 500,
      },
      orderTotal: { amount: Number(order.total), currency: "INR" },
      items: order.items.map((item) => ({
        name: item.name,
        sku: item.sku,
        quantity: item.quantity,
        price: Number(item.unitPrice),
      })),
    };
  }

  async trackingDetails(orderId: string) {
    const shipment = await this.db.shipment.findFirst({
      where: { orderId },
      orderBy: { createdAt: "desc" },
      include: { events: { orderBy: { occurredAt: "asc" } } },
    });
    return shipment
      ? {
          awb: shipment.awb,
          courier: shipment.courier || shipment.provider,
          trackingUrl: shipment.trackingUrl,
          status: shipment.status,
          events: shipment.events.map((event) => ({
            status: event.status,
            location: event.location,
            occurredAt: event.occurredAt.toISOString(),
          })),
        }
      : null;
  }

  async processWebhook(input: {
    provider: string;
    eventId: string;
    payloadHash: string;
    orderId?: string;
    from?: string;
    to?: string;
    paymentId?: string;
    paymentStatus?:
      "CAPTURED" | "FAILED" | "REFUNDED" | "AUTHORIZED" | "CANCELLED";
    externalPaymentId?: string;
    paymentAmount?: number;
    paymentErrorCode?: string;
    paymentErrorDescription?: string;
    shipmentId?: string;
    shipmentStatus?: string;
    location?: string;
    occurredAt?: Date;
    safePayload?: Prisma.InputJsonValue;
  }) {
    try {
      await this.db.$transaction(async (tx) => {
        await tx.webhookEvent.create({
          data: {
            provider: input.provider,
            externalId: input.eventId,
            signatureValid: true,
            status: "PROCESSED",
            payloadHash: input.payloadHash,
            safePayload: input.safePayload,
            processedAt: new Date(),
          },
        });
        if (input.orderId && input.from && input.to) {
          if (["PAID", "FAILED"].includes(input.to)) {
            const items = await tx.orderItem.findMany({
              where: { orderId: input.orderId },
              select: { variantId: true, quantity: true, sku: true },
            });
            for (const item of items) {
              const inventory = await tx.inventory.findUnique({ where: { variantId: item.variantId } });
              if (!inventory)
                throw new AppError(409, "INVENTORY_NOT_FOUND", `Inventory is missing for ${item.sku}`);
              const changed = input.to === "PAID"
                ? await tx.$executeRaw`UPDATE \`Inventory\` SET \`onHand\` = \`onHand\` - ${item.quantity}, \`reserved\` = \`reserved\` - ${item.quantity}, \`version\` = \`version\` + 1 WHERE \`variantId\` = ${item.variantId} AND \`onHand\` >= ${item.quantity} AND \`reserved\` >= ${item.quantity}`
                : await tx.$executeRaw`UPDATE \`Inventory\` SET \`reserved\` = \`reserved\` - ${item.quantity}, \`version\` = \`version\` + 1 WHERE \`variantId\` = ${item.variantId} AND \`reserved\` >= ${item.quantity}`;
              if (changed !== 1)
                throw new AppError(409, "INVENTORY_STATE_CONFLICT", `Inventory changed for ${item.sku}`);
              await tx.inventoryMovement.create({
                data: {
                  inventoryId: inventory.id,
                  quantity: input.to === "PAID" ? -item.quantity : 0,
                  reason: input.to === "PAID" ? "ORDER_COMMITTED" : "ORDER_RESERVATION_RELEASED",
                  referenceId: input.orderId,
                },
              });
            }
          }
          const changed = await tx.order.updateMany({
            where: { id: input.orderId, status: input.from as OrderStatus },
            data: { status: input.to as OrderStatus },
          });
          if (changed.count !== 1)
            throw new AppError(
              409,
              "STALE_ORDER_STATE",
              "Order state changed before webhook processing",
            );
          await tx.orderHistory.create({
            data: {
              orderId: input.orderId,
              fromStatus: input.from as OrderStatus,
              toStatus: input.to as OrderStatus,
              source: input.provider,
            },
          });
          if (input.to === "PAID") await queueOrderConfirmation(tx, input.orderId);
        }
        if (input.paymentId && input.paymentStatus) {
          await tx.payment.update({
            where: { id: input.paymentId },
            data: {
              status: input.paymentStatus,
              gatewayTransactionId: input.externalPaymentId,
            },
          });
          if (input.externalPaymentId)
            await tx.paymentTransaction.create({
              data: {
                paymentId: input.paymentId,
                providerEventId: `${input.provider}:${input.eventId}:${input.externalPaymentId}`,
                kind: input.paymentStatus,
                amount: input.paymentAmount || 0,
                safePayload: {
                  errorCode: input.paymentErrorCode,
                  errorDescription: input.paymentErrorDescription,
                },
              },
            });
        }
        if (input.shipmentId && input.shipmentStatus) {
          await tx.shipment.update({
            where: { id: input.shipmentId },
            data: { status: input.shipmentStatus },
          });
          await tx.trackingEvent.create({
            data: {
              shipmentId: input.shipmentId,
              providerEventId: `${input.provider}:${input.eventId}`,
              status: input.shipmentStatus,
              location: input.location,
              occurredAt: input.occurredAt || new Date(),
            },
          });
        }
      });
      return { duplicate: false };
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === "P2002"
      )
        return { duplicate: true };
      throw error;
    }
  }

  async resolvePaymentWebhook(provider: string, externalOrderId: string) {
    const payment = await this.db.payment.findFirst({
      where: {
        provider: { equals: provider },
        externalId: externalOrderId,
      },
      include: { order: true },
    });
    if (!payment)
      throw new AppError(
        404,
        "PAYMENT_NOT_FOUND",
        "Webhook payment was not found",
      );
    return {
      orderId: payment.orderId,
      status: payment.order.status,
      paymentId: payment.id,
      amount: Number(payment.amount),
      currency: payment.currency,
    };
  }

  async resolveShipmentWebhook(provider: string, awb: string) {
    const shipment = await this.db.shipment.findFirst({
      where: { provider: { equals: provider }, awb },
      include: { order: true },
    });
    if (!shipment)
      throw new AppError(
        404,
        "SHIPMENT_NOT_FOUND",
        "Webhook shipment was not found",
      );
    return {
      orderId: shipment.orderId,
      status: shipment.order.status,
      shipmentId: shipment.id,
    };
  }

  async createReturnRequest(
    userId: string,
    input: {
      orderId: string;
      reason: string;
      items?: Array<{ variantId: string; quantity: number }>;
    },
  ) {
    return this.db.$transaction(async (tx) => {
      const order = await tx.order.findFirst({
        where: { id: input.orderId, userId },
        include: { items: true },
      });
      if (!order)
        throw new AppError(404, "ORDER_NOT_FOUND", "Order not found");
      if (order.status !== "DELIVERED")
        throw new AppError(
          409,
          "RETURN_NOT_AVAILABLE",
          "Returns are available only after delivery",
        );
      const existing = await tx.returnRequest.findFirst({
        where: { orderId: order.id, status: { not: "REJECTED" } },
        select: { id: true },
      });
      if (existing)
        throw new AppError(
          409,
          "RETURN_ALREADY_EXISTS",
          "A return is already active for this order",
        );
      const requested = input.items || order.items.map((item) => ({
        variantId: item.variantId,
        quantity: item.quantity,
      }));
      const seen = new Set<string>();
      const selected = requested.map((selection) => {
        if (seen.has(selection.variantId))
          throw new AppError(
            400,
            "DUPLICATE_RETURN_ITEM",
            "Each product variant can be selected only once",
          );
        seen.add(selection.variantId);
        const orderItem = order.items.find(
          (item) => item.variantId === selection.variantId,
        );
        if (!orderItem || selection.quantity > orderItem.quantity)
          throw new AppError(
            422,
            "INVALID_RETURN_QUANTITY",
            "Return quantity exceeds the purchased quantity",
          );
        return { orderItemId: orderItem.id, quantity: selection.quantity };
      });
      const created = await tx.returnRequest.create({
        data: {
          orderId: order.id,
          userId,
          reason: input.reason,
          status: "REQUESTED",
          items: { create: selected },
        },
        include: {
          items: {
            include: {
              orderItem: { select: { variantId: true, name: true, sku: true } },
            },
          },
        },
      });
      const changed = await tx.order.updateMany({
        where: { id: order.id, status: "DELIVERED" },
        data: { status: "RETURN_REQUESTED" },
      });
      if (changed.count !== 1)
        throw new AppError(
          409,
          "STALE_ORDER_STATE",
          "Order state changed; reload and try again",
        );
      await tx.orderHistory.create({
        data: {
          orderId: order.id,
          fromStatus: "DELIVERED",
          toStatus: "RETURN_REQUESTED",
          actorId: userId,
          source: "CUSTOMER",
          metadata: { returnRequestId: created.id },
        },
      });
      await tx.auditLog.create({
        data: {
          userId,
          action: "return.requested",
          resource: "return_request",
          resourceId: created.id,
          after: {
            orderId: order.id,
            itemCount: selected.length,
            totalQuantity: selected.reduce((sum, item) => sum + item.quantity, 0),
          },
        },
      });
      return created;
    });
  }

  listCustomerReturns(userId: string) {
    return this.db.returnRequest.findMany({
      where: { userId },
      select: {
        id: true,
        orderId: true,
        reason: true,
        status: true,
        notes: true,
        createdAt: true,
        updatedAt: true,
        items: {
          select: {
            id: true,
            quantity: true,
            condition: true,
            orderItem: { select: { variantId: true, name: true, sku: true } },
          },
        },
      },
      orderBy: { createdAt: "desc" },
      take: 100,
    });
  }

  async decideReturn(
    id: string,
    status: "APPROVED" | "REJECTED" | "RECEIVED",
    notes?: string,
    actorId?: string,
  ) {
    return this.db.$transaction(async (tx) => {
      const current = await tx.returnRequest.findUnique({
        where: { id },
        include: { order: { select: { status: true } } },
      });
      if (!current)
        throw new AppError(404, "RETURN_NOT_FOUND", "Return request not found");
      const receiving = status === "RECEIVED";
      const expectedReturnStatus = receiving ? "APPROVED" : "REQUESTED";
      const expectedOrderStatus = receiving
        ? "RETURN_APPROVED"
        : "RETURN_REQUESTED";
      if (current.status !== expectedReturnStatus)
        throw new AppError(
          409,
          receiving ? "RETURN_NOT_APPROVED" : "RETURN_ALREADY_DECIDED",
          receiving
            ? "Only an approved return can be marked received"
            : "Return request is no longer pending",
        );
      if (current.order.status !== expectedOrderStatus)
        throw new AppError(
          409,
          "STALE_ORDER_STATE",
          "Order return state changed; reload and try again",
        );
      const nextOrderStatus = receiving
        ? "RETURNED"
        : status === "APPROVED"
          ? "RETURN_APPROVED"
          : "DELIVERED";
      const changed = await tx.returnRequest.updateMany({
        where: { id, status: expectedReturnStatus },
        data: { status, notes },
      });
      if (changed.count !== 1)
        throw new AppError(
          409,
          "RETURN_ALREADY_DECIDED",
          "Return request is no longer pending",
        );
      const changedOrder = await tx.order.updateMany({
        where: { id: current.orderId, status: expectedOrderStatus },
        data: { status: nextOrderStatus },
      });
      if (changedOrder.count !== 1)
        throw new AppError(
          409,
          "STALE_ORDER_STATE",
          "Order return state changed; reload and try again",
        );
      await tx.orderHistory.create({
        data: {
          orderId: current.orderId,
          fromStatus: expectedOrderStatus,
          toStatus: nextOrderStatus,
          actorId,
          source: "ADMIN",
          metadata: { returnRequestId: id, decision: status },
        },
      });
      await tx.auditLog.create({
        data: {
          userId: actorId,
          action: "return.decided",
          resource: "return_request",
          resourceId: id,
          before: { status: current.status },
          after: { status, orderStatus: nextOrderStatus, notesPresent: Boolean(notes) },
        },
      });
      return tx.returnRequest.findUnique({ where: { id } });
    });
  }

  async listCustomerPayments(userId: string) {
    const payments = await this.db.payment.findMany({
      where: { order: { userId } },
      orderBy: { createdAt: "desc" },
      select: {
        id: true,
        provider: true,
        externalId: true,
        gatewayTransactionId: true,
        status: true,
        amount: true,
        currency: true,
        verifiedAt: true,
        createdAt: true,
        order: {
          select: { id: true, number: true, status: true, createdAt: true },
        },
        transactions: {
          orderBy: { createdAt: "desc" },
          select: {
            id: true,
            kind: true,
            amount: true,
            createdAt: true,
            safePayload: true,
          },
        },
        refunds: {
          orderBy: { createdAt: "desc" },
          select: {
            id: true,
            externalId: true,
            amount: true,
            status: true,
            createdAt: true,
          },
        },
      },
    });
    return payments.map((payment) => {
      const refunds = payment.refunds.map((refund) => ({
        id: refund.id,
        reference: refund.externalId,
        amount: Number(refund.amount),
        status: refund.status,
        createdAt: refund.createdAt,
      }));
      return {
        id: payment.id,
        orderId: payment.order.id,
        orderNumber: payment.order.number,
        orderStatus: payment.order.status,
        provider: payment.provider,
        status: payment.status,
        amount: Number(payment.amount),
        currency: payment.currency,
        providerReference: payment.externalId,
        transactionId: payment.gatewayTransactionId,
        refundedAmount: refunds
          .filter((refund) => refund.status !== "FAILED")
          .reduce((sum, refund) => sum + refund.amount, 0),
        refunds,
        events: payment.transactions.map((transaction) => {
          const safe =
            transaction.safePayload &&
            typeof transaction.safePayload === "object"
              ? (transaction.safePayload as Record<string, unknown>)
              : {};
          return {
            id: transaction.id,
            type: transaction.kind,
            amount: Number(transaction.amount),
            errorCode:
              typeof safe.errorCode === "string" ? safe.errorCode : undefined,
            errorDescription:
              typeof safe.errorDescription === "string"
                ? safe.errorDescription
                : undefined,
            createdAt: transaction.createdAt,
          };
        }),
        createdAt: payment.createdAt,
        verifiedAt: payment.verifiedAt,
      };
    });
  }

  async listPayments() {
    const payments = await this.db.payment.findMany({
      orderBy: { createdAt: "desc" },
      include: {
        order: { select: { number: true, userId: true } },
        transactions: { orderBy: { createdAt: "desc" } },
        refunds: { orderBy: { createdAt: "desc" } },
      },
    });
    return payments.map((payment) => ({
      ...payment,
      amount: Number(payment.amount),
      transactions: payment.transactions.map((transaction) => ({
        ...transaction,
        amount: Number(transaction.amount),
      })),
      refunds: payment.refunds.map((refund) => ({
        ...refund,
        amount: Number(refund.amount),
      })),
    }));
  }

  async paymentForOrder(orderNumber: string, providerOrderId: string) {
    return this.db.payment.findFirst({
      where: { externalId: providerOrderId, order: { number: orderNumber } },
      include: { order: true },
    });
  }

  async recordPaymentClientEvent(input: {
    orderNumber: string;
    providerOrderId: string;
    type: "CANCELLED" | "FAILED";
    gatewayPaymentId?: string;
    errorCode?: string;
    errorDescription?: string;
    providerErrorCode?: string;
    failureAdvice?: Prisma.InputJsonValue;
  }) {
    return this.db.$transaction(async (tx) => {
      const payment = await tx.payment.findFirst({
        where: {
          externalId: input.providerOrderId,
          order: { number: input.orderNumber },
        },
      });
      if (!payment)
        throw new AppError(
          404,
          "PAYMENT_NOT_FOUND",
          "Payment attempt was not found",
        );
      const providerEventId = `client:${payment.id}:${input.type}:${input.gatewayPaymentId || crypto.randomUUID()}`;
      await tx.paymentTransaction.upsert({
        where: { providerEventId },
        update: {},
        create: {
          paymentId: payment.id,
          providerEventId,
          kind: input.type,
          amount: 0,
          safePayload: {
            errorCode: input.errorCode,
            errorDescription: input.errorDescription,
            providerErrorCode: input.providerErrorCode,
            failureAdvice: input.failureAdvice,
          },
        },
      });
      // Check status in the UPDATE itself: a webhook may capture this payment
      // between the initial read and this late browser failure/cancel event.
      await tx.payment.updateMany({
        where: { id: payment.id, status: { notIn: ["CAPTURED", "REFUNDED", "PARTIALLY_REFUNDED"] } },
        data: {
          status: input.type as never,
          gatewayTransactionId: input.gatewayPaymentId,
        },
      });
      return tx.payment.findUniqueOrThrow({ where: { id: payment.id } });
    });
  }

  async createPaymentAttempt(
    orderId: string,
    provider: string,
    externalId: string,
    amount: number,
    idempotencyKey: string,
  ) {
    return this.db.payment.create({
      data: {
        orderId,
        provider,
        externalId,
        status: "CREATED",
        amount,
        currency: "INR",
        idempotencyKey,
      },
    });
  }

  async reconcilePayment(
    paymentId: string,
    status: {
      status: string;
      gatewayPaymentId?: string;
      amount?: number;
      currency?: string;
      errorCode?: string;
      errorDescription?: string;
    },
  ) {
    return this.db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT \`id\` FROM \`Payment\` WHERE \`id\` = ${paymentId} FOR UPDATE`;
      const payment = await tx.payment.findUnique({
        where: { id: paymentId },
        include: { order: true },
      });
      if (!payment)
        throw new AppError(404, "PAYMENT_NOT_FOUND", "Payment was not found");
      if (status.status === "CAPTURED" && (!status.gatewayPaymentId || !Number.isFinite(status.amount) || Math.round(status.amount! * 100) !== Math.round(Number(payment.amount) * 100) || status.currency !== payment.currency))
        throw new AppError(422, "PAYMENT_AMOUNT_MISMATCH", "Gateway amount or currency does not match the order");
      if (["CAPTURED", "REFUNDED", "PARTIALLY_REFUNDED"].includes(payment.status))
        return { paymentId: payment.id, orderNumber: payment.order.number, status: payment.status };
      const providerEventId = `reconcile:${payment.provider}:${status.gatewayPaymentId || payment.externalId}:${status.status}`;
      await tx.paymentTransaction.upsert({
        where: { providerEventId },
        update: {
          safePayload: {
            errorCode: status.errorCode,
            errorDescription: status.errorDescription,
          },
        },
        create: {
          paymentId: payment.id,
          providerEventId,
          kind: `RECONCILE_${status.status}`,
          amount: status.amount || 0,
          safePayload: {
            errorCode: status.errorCode,
            errorDescription: status.errorDescription,
          },
        },
      });
      await tx.payment.update({
        where: { id: payment.id },
        data: {
          status: status.status as never,
          gatewayTransactionId: status.gatewayPaymentId,
          verifiedAt:
            status.status === "CAPTURED" ? new Date() : payment.verifiedAt,
        },
      });
      if (
        status.status === "CAPTURED" &&
        payment.order.status === "PAYMENT_PENDING"
      ) {
        const items = await tx.orderItem.findMany({ where: { orderId: payment.orderId } });
        const changed = await tx.order.updateMany({ where: { id: payment.orderId, status: "PAYMENT_PENDING" }, data: { status: "PAID" } });
        if (changed.count !== 1) throw new AppError(409, "STALE_ORDER_STATE", "Order changed during payment verification");
        for (const item of items) {
          const count = await tx.$executeRaw`UPDATE \`Inventory\` SET \`onHand\` = \`onHand\` - ${item.quantity}, \`reserved\` = \`reserved\` - ${item.quantity}, \`version\` = \`version\` + 1 WHERE \`variantId\` = ${item.variantId} AND \`onHand\` >= ${item.quantity} AND \`reserved\` >= ${item.quantity}`;
          if (count !== 1) throw new AppError(409, "INVENTORY_CONFLICT", "Reserved inventory could not be committed");
        }
        await tx.order.update({
          where: { id: payment.orderId },
          data: { status: "PAID" },
        });
        await tx.orderHistory.create({
          data: {
            orderId: payment.orderId,
            fromStatus: "PAYMENT_PENDING",
            toStatus: "PAID",
            source: `${payment.provider}:reconciliation`,
            metadata: { gatewayPaymentId: status.gatewayPaymentId },
          },
        });
      }
      if (status.status === "CAPTURED") await queueOrderConfirmation(tx, payment.orderId);
      return {
        paymentId: payment.id,
        orderNumber: payment.order.number,
        ...status,
      };
    });
  }

  async beginRefund(
    orderId: string,
    amount: number,
    idempotencyKey: string,
    reason: string,
    actorId?: string,
    requestedReturnId?: string,
  ) {
    if (!Number.isFinite(amount) || amount <= 0)
      throw new AppError(
        422,
        "REFUND_AMOUNT_INVALID",
        "Refund amount must be a finite positive number",
      );
    return this.db.$transaction(
      async (tx) => {
        const resolveReceivedReturn = async (preferredId?: string | null) => {
          const selectedId = preferredId || requestedReturnId;
          const request = selectedId
            ? await tx.returnRequest.findUnique({ where: { id: selectedId } })
            : await tx.returnRequest.findFirst({
                where: {
                  orderId,
                  status: { in: ["APPROVED", "RECEIVED"] },
                },
                orderBy: { updatedAt: "desc" },
              });
          if (selectedId && !request)
            throw new AppError(
              409,
              "RETURN_NOT_RECEIVED",
              "The selected return is not received and ready for refund",
            );
          if (
            request &&
            (request.orderId !== orderId || request.status !== "RECEIVED")
          )
            throw new AppError(
              409,
              "RETURN_NOT_RECEIVED",
              "The selected return is not received and ready for refund",
            );
          return request?.status === "RECEIVED" ? request.id : undefined;
        };
        const markReturnRefundPending = async (returnRequestId?: string) => {
          if (!returnRequestId) return;
          const changedOrder = await tx.order.updateMany({
            where: { id: orderId, status: "RETURNED" },
            data: { status: "REFUND_PENDING" },
          });
          if (changedOrder.count === 1) {
            await tx.orderHistory.create({
              data: {
                orderId,
                fromStatus: "RETURNED",
                toStatus: "REFUND_PENDING",
                actorId,
                source: "REFUND",
                metadata: { returnRequestId },
              },
            });
            return;
          }
          const order = await tx.order.findUnique({
            where: { id: orderId },
            select: { status: true },
          });
          if (order?.status !== "REFUND_PENDING")
            throw new AppError(
              409,
              "STALE_ORDER_STATE",
              "Returned order is not ready for refund",
            );
        };
        const existing = await tx.refund.findUnique({
          where: { idempotencyKey },
        });
        if (existing) {
          if (
            Number(existing.amount) !== amount ||
            (existing.reason !== null && existing.reason !== reason)
          )
            throw new AppError(
              409,
              "IDEMPOTENCY_CONFLICT",
              "This idempotency key was already used for a different refund request",
            );
          const existingPayment = await tx.payment.findUnique({
            where: { id: existing.paymentId },
          });
          if (!existingPayment || existingPayment.orderId !== orderId)
            throw new AppError(
              409,
              "IDEMPOTENCY_CONFLICT",
              "This idempotency key belongs to another refund operation",
            );
          if (
            requestedReturnId !== undefined &&
            existing.returnRequestId !== requestedReturnId
          )
            throw new AppError(
              409,
              "IDEMPOTENCY_CONFLICT",
              "This idempotency key was already used with another return request",
            );
          if (existing.reason === null)
            await tx.refund.update({
              where: { id: existing.id },
              data: { reason },
            });
          if (existing.status === "SUCCEEDED")
            return {
              duplicate: true,
              process: false,
              refund: { ...existing, reason: existing.reason || reason },
              provider: existingPayment.provider,
              externalId: existingPayment.externalId,
            };
          if (existing.status === "PENDING") {
            if (!existingPayment.externalId)
              throw new AppError(
                409,
                "PAYMENT_NOT_REFUNDABLE",
                "No captured provider payment is available for refund",
              );
            const returnRequestId = await resolveReceivedReturn(
              existing.returnRequestId,
            );
            if (returnRequestId && existing.returnRequestId !== returnRequestId)
              await tx.refund.update({
                where: { id: existing.id },
                data: { returnRequestId },
              });
            await markReturnRefundPending(returnRequestId);
            return {
              duplicate: true,
              process: true,
              refund: {
                ...existing,
                reason: existing.reason || reason,
                returnRequestId: returnRequestId || null,
              },
              provider: existingPayment.provider,
              externalId: existingPayment.externalId,
            };
          }
          if (
            existing.status !== "FAILED" ||
            !existingPayment.externalId ||
            !["CAPTURED", "PARTIALLY_REFUNDED"].includes(
              existingPayment.status,
            )
          )
            throw new AppError(
              409,
              "PAYMENT_NOT_REFUNDABLE",
              "No captured provider payment is available for refund",
            );
          const committed = await tx.refund.aggregate({
            where: {
              paymentId: existingPayment.id,
              status: { in: ["PENDING", "SUCCEEDED"] },
            },
            _sum: { amount: true },
          });
          if (
            amount >
            Number(existingPayment.amount) -
              Number(committed._sum.amount || 0)
          )
            throw new AppError(
              422,
              "REFUND_AMOUNT_INVALID",
              "Refund exceeds the remaining captured amount",
            );
          const returnRequestId = await resolveReceivedReturn(
            existing.returnRequestId,
          );
          const reserved = await tx.refund.updateMany({
            where: { id: existing.id, status: "FAILED" },
            data: { status: "PENDING", reason, returnRequestId },
          });
          if (reserved.count !== 1) {
            const latest = await tx.refund.findUnique({
              where: { id: existing.id },
            });
            if (latest?.status === "SUCCEEDED")
              return {
                duplicate: true,
                process: false,
                refund: latest,
                provider: existingPayment.provider,
                externalId: existingPayment.externalId,
              };
            if (latest?.status !== "PENDING")
              throw new AppError(
                409,
                "REFUND_RETRY_CONFLICT",
                "Refund retry state changed; reload and try again",
              );
          }
          await markReturnRefundPending(returnRequestId);
          return {
            duplicate: true,
            process: true,
            refund: {
              ...existing,
              status: "PENDING",
              reason,
              returnRequestId: returnRequestId || null,
            },
            provider: existingPayment.provider,
            externalId: existingPayment.externalId,
          };
        }
        const payment = await tx.payment.findFirst({
          where: {
            orderId,
            status: { in: ["CAPTURED", "PARTIALLY_REFUNDED"] },
          },
          orderBy: { createdAt: "desc" },
          include: { refunds: true },
        });
        if (!payment?.externalId)
          throw new AppError(
            409,
            "PAYMENT_NOT_REFUNDABLE",
            "No captured provider payment is available for refund",
          );
        const committed = payment.refunds
          .filter((refund) => ["PENDING", "SUCCEEDED"].includes(refund.status))
          .reduce((sum, refund) => sum + Number(refund.amount), 0);
        if (amount > Number(payment.amount) - committed)
          throw new AppError(
            422,
            "REFUND_AMOUNT_INVALID",
            "Refund exceeds the remaining captured amount",
          );
        const returnRequestId = await resolveReceivedReturn();
        const refund = await tx.refund.create({
          data: {
            paymentId: payment.id,
            returnRequestId,
            amount,
            status: "PENDING",
            idempotencyKey,
            reason,
          },
        });
        await markReturnRefundPending(returnRequestId);
        return {
          duplicate: false,
          process: true,
          refund,
          provider: payment.provider,
          externalId: payment.externalId,
        };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    );
  }

  async completeRefund(id: string, externalId: string, actorId?: string) {
    return this.db.$transaction(async (tx) => {
      const existing = await tx.refund.findUnique({ where: { id } });
      if (!existing)
        throw new AppError(404, "REFUND_NOT_FOUND", "Refund was not found");
      if (
        existing.status === "SUCCEEDED" &&
        existing.externalId &&
        existing.externalId !== externalId
      )
        throw new AppError(
          409,
          "REFUND_REFERENCE_CONFLICT",
          "Refund was already completed with another provider reference",
        );
      const changed =
        existing.status === "SUCCEEDED"
          ? { count: 0 }
          : await tx.refund.updateMany({
              where: { id, status: { in: ["PENDING", "FAILED"] } },
              data: { externalId, status: "SUCCEEDED" },
            });
      const refund = await tx.refund.findUnique({ where: { id } });
      if (!refund || refund.status !== "SUCCEEDED")
        throw new AppError(
          409,
          "REFUND_COMPLETION_CONFLICT",
          "Refund state changed before completion",
        );
      const payment = await tx.payment.findUnique({
        where: { id: refund.paymentId },
      });
      if (!payment)
        throw new AppError(404, "PAYMENT_NOT_FOUND", "Payment was not found");
      const refunded = await tx.refund.aggregate({
        where: { paymentId: payment.id, status: "SUCCEEDED" },
        _sum: { amount: true },
      });
      const refundedAmount = Number(refunded._sum.amount || 0);
      const paymentStatus =
        refundedAmount >= Number(payment.amount)
          ? "REFUNDED"
          : "PARTIALLY_REFUNDED";
      await tx.payment.update({
        where: { id: payment.id },
        data: { status: paymentStatus },
      });
      if (refund.returnRequestId) {
        const changedReturn = await tx.returnRequest.updateMany({
          where: { id: refund.returnRequestId, status: "RECEIVED" },
          data: { status: "REFUNDED" },
        });
        if (changedReturn.count === 0) {
          const request = await tx.returnRequest.findUnique({
            where: { id: refund.returnRequestId },
            select: { status: true },
          });
          if (request?.status !== "REFUNDED")
            throw new AppError(
              409,
              "STALE_RETURN_STATE",
              "Return state changed before refund completion",
            );
        }
        const nextOrderStatus =
          paymentStatus === "REFUNDED" ? "REFUNDED" : "RETURNED";
        const changedOrder = await tx.order.updateMany({
          where: { id: payment.orderId, status: "REFUND_PENDING" },
          data: { status: nextOrderStatus },
        });
        if (changedOrder.count === 1)
          await tx.orderHistory.create({
            data: {
              orderId: payment.orderId,
              fromStatus: "REFUND_PENDING",
              toStatus: nextOrderStatus,
              actorId,
              source: "REFUND",
              metadata: { returnRequestId: refund.returnRequestId, refundId: id },
            },
          });
        else {
          const order = await tx.order.findUnique({
            where: { id: payment.orderId },
            select: { status: true },
          });
          if (order?.status !== nextOrderStatus)
            throw new AppError(
              409,
              "STALE_ORDER_STATE",
              "Order state changed before refund completion",
            );
        }
      }
      if (changed.count === 1)
        await tx.auditLog.create({
          data: {
            userId: actorId,
            action: "payment.refunded",
            resource: "refund",
            resourceId: refund.id,
            after: {
              amount: Number(refund.amount),
              reason: refund.reason,
              externalId,
              paymentStatus,
              refundedAmount,
            },
          },
        });
      return { refund, paymentStatus, refundedAmount };
    });
  }

  async failRefund(id: string) {
    await this.db.$transaction(async (tx) => {
      const refund = await tx.refund.findUnique({
        where: { id },
        include: { payment: { select: { orderId: true } } },
      });
      if (!refund) return;
      const changed = await tx.refund.updateMany({
        where: { id, status: "PENDING" },
        data: { status: "FAILED" },
      });
      if (changed.count !== 1 || !refund.returnRequestId) return;
      const restored = await tx.order.updateMany({
        where: { id: refund.payment.orderId, status: "REFUND_PENDING" },
        data: { status: "RETURNED" },
      });
      if (restored.count === 1)
        await tx.orderHistory.create({
          data: {
            orderId: refund.payment.orderId,
            fromStatus: "REFUND_PENDING",
            toStatus: "RETURNED",
            source: "REFUND",
            metadata: {
              returnRequestId: refund.returnRequestId,
              refundId: refund.id,
              result: "FAILED",
            },
          },
        });
    });
  }

  async saveOrderAndReservations(
    order: StoredOrder,
    addressSnapshot: Prisma.InputJsonValue,
    provider: string,
    couponCode?: string,
    paymentExternalId?: string,
    notificationBusiness?: StorefrontConfig,
  ) {
    await this.db.$transaction(
      async (tx) => {
        const coupon = couponCode
          ? await tx.coupon.findUnique({
              where: { code: couponCode.trim().toUpperCase() },
            })
          : null;
        if (couponCode && !coupon)
          throw new AppError(422, "COUPON_NOT_APPLICABLE", "Coupon is no longer available");
        if (coupon) {
          const variants = await tx.productVariant.findMany({ where: { id: { in: order.lines.map(line => line.variantId) } }, select: { id: true, productId: true } });
          const productByVariant = new Map(variants.map(variant => [variant.id, variant.productId]));
          const benefit = couponBenefit({
            code: coupon.code, type: coupon.type, value: number(coupon.value), minimumSpend: number(coupon.minimumSpend),
            maximumDiscount: coupon.maximumDiscount === null ? undefined : number(coupon.maximumDiscount),
            startsAt: coupon.startsAt.getTime(), endsAt: coupon.endsAt.getTime(), enabled: coupon.enabled, used: 0,
            appliesTo: coupon.appliesTo === "SELECTED_PRODUCTS" ? "SELECTED_PRODUCTS" : "ALL_PRODUCTS",
            productIds: Array.isArray(coupon.productIds) ? coupon.productIds.filter((id): id is string => typeof id === "string") : [],
          }, order.lines.map(line => ({ productId: productByVariant.get(line.variantId) || "", unitPrice: line.unitPrice, quantity: line.quantity })));
          if (Math.abs(benefit.discount - (order.invoiceSnapshot?.discounts?.coupon ?? order.discount)) > 0.001 ||
              (order.invoiceSnapshot?.discounts?.couponFreeShipping !== undefined && benefit.freeShipping !== order.invoiceSnapshot.discounts.couponFreeShipping))
            throw new AppError(409, "CHECKOUT_PRICE_CHANGED", "Coupon eligibility changed. Review the updated total before placing your order.");
          const usage = await tx.order.count({
            where: { couponId: coupon.id },
          });
          if (coupon.usageLimit !== null && usage >= coupon.usageLimit)
            throw new AppError(
              422,
              "COUPON_LIMIT_REACHED",
              "Coupon usage limit has been reached",
            );
          if (order.userId) {
            const perUser = await tx.order.count({
              where: { couponId: coupon.id, userId: order.userId },
            });
            if (perUser >= coupon.perUserLimit)
              throw new AppError(
                422,
                "COUPON_USER_LIMIT_REACHED",
                "Coupon has already been used by this account",
              );
          }
        }
        for (const line of order.lines) {
          const changed =
            await tx.$executeRaw`UPDATE \`Inventory\` SET \`reserved\` = \`reserved\` + ${line.quantity}, \`version\` = \`version\` + 1 WHERE \`variantId\` = ${line.variantId} AND \`onHand\` - \`reserved\` >= ${line.quantity}`;
          if (changed !== 1)
            throw new AppError(
              409,
              "INSUFFICIENT_STOCK",
              `Insufficient stock for ${line.sku}`,
            );
          if (order.status === "CONFIRMED") {
            const committed = await tx.$executeRaw`UPDATE \`Inventory\` SET \`onHand\` = \`onHand\` - ${line.quantity}, \`reserved\` = \`reserved\` - ${line.quantity}, \`version\` = \`version\` + 1 WHERE \`variantId\` = ${line.variantId} AND \`onHand\` >= ${line.quantity} AND \`reserved\` >= ${line.quantity}`;
            if (committed !== 1)
              throw new AppError(409, "INVENTORY_STATE_CONFLICT", `Inventory changed for ${line.sku}`);
            const inventory = await tx.inventory.findUniqueOrThrow({ where: { variantId: line.variantId } });
            await tx.inventoryMovement.create({
              data: {
                inventoryId: inventory.id,
                quantity: -line.quantity,
                reason: "ORDER_COMMITTED",
                referenceId: order.id,
                idempotencyKey: `order:${order.id}:commit:${line.variantId}`,
              },
            });
          }
        }
        await tx.order.create({
          data: {
            id: order.id,
            number: order.number,
            userId: order.userId,
            couponId: coupon?.id,
            status: order.status as OrderStatus,
            subtotal: order.subtotal,
            discount: order.discount,
            tax: order.tax,
            shipping: order.shipping,
            total: order.total,
            addressSnapshot: { ...(addressSnapshot as Prisma.InputJsonObject), ...(notificationBusiness ? { notificationBusiness } : {}) },
            idempotencyKey: order.idempotencyKey,
            items: {
              create: order.lines.map((line) => ({
                variantId: line.variantId,
                name: line.name,
                sku: line.sku,
                attributes: {},
                unitPrice: line.unitPrice,
                quantity: line.quantity,
                tax: line.tax,
              })),
            },
            history: {
              create: {
                toStatus: order.status as OrderStatus,
                source: "CHECKOUT",
              },
            },
            payments:
              provider === "cod"
                ? undefined
                : {
                    create: {
                      provider,
                      status: "CREATED",
                      amount: order.total,
                      currency: "INR",
                      externalId: paymentExternalId,
                      idempotencyKey: `pay:${order.idempotencyKey}`,
                    },
                  },
          },
        });
        if (provider === "cod") await queueOrderConfirmation(tx, order.id);
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    );
  }

  async saveIntegration(
    record: StoredIntegration,
    options?: {
      actorId?: string;
      action?: string;
      before?: Record<string, unknown>;
      after?: Record<string, unknown>;
      removeIds?: string[];
    },
  ) {
    try {
      await this.db.$transaction(async (tx) => {
        const removeIds = (options?.removeIds || []).filter(
          (id) => id !== record.id,
        );
        if (removeIds.length)
          await tx.integrationConfig.deleteMany({
            where: { id: { in: removeIds } },
          });
        await tx.integrationConfig.upsert({
          where: { id: record.id },
          update: {
            kind: record.kind as never,
            provider: record.provider,
            environment: record.environment,
            enabled: record.enabled,
            priority: record.priority,
            encryptedCredentials: Buffer.from(
              record.encryptedCredentials,
              "base64",
            ),
            publicConfig: record.publicConfig as Prisma.InputJsonValue,
          },
          create: {
            id: record.id,
            kind: record.kind as never,
            provider: record.provider,
            environment: record.environment,
            enabled: record.enabled,
            priority: record.priority,
            encryptedCredentials: Buffer.from(
              record.encryptedCredentials,
              "base64",
            ),
            publicConfig: record.publicConfig as Prisma.InputJsonValue,
          },
        });
        if (options?.action)
          await tx.auditLog.create({
            data: {
              userId: options.actorId,
              action: options.action,
              resource: "integration",
              resourceId: record.id,
              before: options.before as Prisma.InputJsonValue | undefined,
              after: options.after as Prisma.InputJsonValue | undefined,
            },
          });
      });
    } catch (error) {
      if ((error as { code?: string }).code === "P2002")
        throw new AppError(
          409,
          "INTEGRATION_CONFLICT",
          "The integration was changed by another request; reload and try again",
        );
      throw error;
    }
  }
}

type PersistentCustomerRow = {
  id: string;
  name: string;
  email: string;
  mobile: string | null;
  tags: string[];
  marketingConsent: boolean;
  marketingConsentUpdatedAt: Date | null;
  disabledAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  orderCount: number;
  paidOrderCount: number;
  inrPaidOrderCount: number;
  totalSpent: Prisma.Decimal;
  lastOrderAt: Date | null;
  lastPaidOrderAt: Date | null;
  spendByCurrency: Prisma.JsonValue;
};

const customerMetricsSql = Prisma.sql`
  SELECT
    u.\`id\`,
    u.\`name\`,
    u.\`email\`,
    u.\`mobile\`,
    u.\`tags\`,
    u.\`marketingConsent\`,
    u.\`marketingConsentUpdatedAt\`,
    u.\`disabledAt\`,
    u.\`createdAt\`,
    u.\`updatedAt\`,
    COUNT(o.\`id\`) AS \`orderCount\`,
    COUNT(CASE WHEN o.\`status\` IN (
        'PAID', 'CONFIRMED', 'PROCESSING', 'PACKED', 'SHIPPED',
        'OUT_FOR_DELIVERY', 'DELIVERED', 'RETURN_REQUESTED',
        'RETURN_APPROVED', 'RETURNED', 'REFUND_PENDING'
      ) THEN o.\`id\` END) AS \`paidOrderCount\`,
    COUNT(CASE WHEN o.\`currency\` = 'INR' AND o.\`status\` IN (
        'PAID', 'CONFIRMED', 'PROCESSING', 'PACKED', 'SHIPPED',
        'OUT_FOR_DELIVERY', 'DELIVERED', 'RETURN_REQUESTED',
        'RETURN_APPROVED', 'RETURNED', 'REFUND_PENDING'
      ) THEN o.\`id\` END) AS \`inrPaidOrderCount\`,
    COALESCE(SUM(
      CASE WHEN o.\`currency\` = 'INR' AND o.\`status\` IN (
        'PAID', 'CONFIRMED', 'PROCESSING', 'PACKED', 'SHIPPED',
        'OUT_FOR_DELIVERY', 'DELIVERED', 'RETURN_REQUESTED',
        'RETURN_APPROVED', 'RETURNED', 'REFUND_PENDING'
      ) THEN GREATEST(
        o.\`total\` - COALESCE((
          SELECT SUM(r.\`amount\`)
          FROM \`Refund\` r
          INNER JOIN \`Payment\` p ON p.\`id\` = r.\`paymentId\`
          WHERE p.\`orderId\` = o.\`id\` AND r.\`status\` = 'SUCCEEDED'
        ), 0),
        0
      ) ELSE 0 END
    ), 0) AS \`totalSpent\`,
    MAX(o.\`createdAt\`) AS \`lastOrderAt\`,
    MAX(CASE WHEN o.\`status\` IN (
        'PAID', 'CONFIRMED', 'PROCESSING', 'PACKED', 'SHIPPED',
        'OUT_FOR_DELIVERY', 'DELIVERED', 'RETURN_REQUESTED',
        'RETURN_APPROVED', 'RETURNED', 'REFUND_PENDING'
      ) THEN o.\`createdAt\` END) AS \`lastPaidOrderAt\`
    ,COALESCE(MAX(currency_metrics.\`spendByCurrency\`), '[]') AS \`spendByCurrency\`
  FROM \`User\` u
  LEFT JOIN \`Order\` o ON o.\`userId\` = u.\`id\`
  -- Aggregate before joining: a derived table cannot reference outer u.id on
  -- MariaDB, even though newer MySQL releases permit that correlated query.
  LEFT JOIN (
    SELECT spend.\`userId\`, JSON_ARRAYAGG(JSON_OBJECT(
      'currency', spend.currency,
      'totalSpent', spend.\`totalSpent\`,
      'paidOrderCount', spend.\`paidOrderCount\`,
      'averageOrderValue', CASE WHEN spend.\`paidOrderCount\` > 0
        THEN ROUND(spend.\`totalSpent\` / spend.\`paidOrderCount\`, 2) ELSE 0 END
    )) AS \`spendByCurrency\`
    FROM (
      SELECT o2.\`userId\`, o2.\`currency\` AS currency,
        SUM(GREATEST(o2.\`total\` - COALESCE((
          SELECT SUM(r2.\`amount\`) FROM \`Refund\` r2
          INNER JOIN \`Payment\` p2 ON p2.\`id\` = r2.\`paymentId\`
          WHERE p2.\`orderId\` = o2.\`id\` AND r2.\`status\` = 'SUCCEEDED'
        ), 0), 0)) AS \`totalSpent\`, COUNT(*) AS \`paidOrderCount\`
      FROM \`Order\` o2
      WHERE o2.\`userId\` IS NOT NULL AND o2.\`status\` IN (
        'PAID', 'CONFIRMED', 'PROCESSING', 'PACKED', 'SHIPPED',
        'OUT_FOR_DELIVERY', 'DELIVERED', 'RETURN_REQUESTED',
        'RETURN_APPROVED', 'RETURNED', 'REFUND_PENDING'
      )
      GROUP BY o2.\`userId\`, o2.\`currency\`
    ) spend GROUP BY spend.\`userId\`
  ) currency_metrics ON currency_metrics.\`userId\` = u.\`id\`
  WHERE u.\`role\` = 'CUSTOMER'
  GROUP BY u.\`id\`
`;

function persistentCustomerDto(row: PersistentCustomerRow) {
  const totalSpent = number(row.totalSpent);
  const spendByCurrency = jsonArray(row.spendByCurrency);
  const segments = [] as Array<"NEW" | "REPEAT" | "HIGH_VALUE" | "AT_RISK">;
  if (row.createdAt.getTime() >= Date.now() - 30 * 86_400_000)
    segments.push("NEW");
  if (row.paidOrderCount >= 2) segments.push("REPEAT");
  if (totalSpent >= 5000) segments.push("HIGH_VALUE");
  if (
    row.paidOrderCount > 0 &&
    row.lastPaidOrderAt &&
    row.lastPaidOrderAt.getTime() < Date.now() - 90 * 86_400_000
  )
    segments.push("AT_RISK");
  return {
    id: row.id,
    name: row.name,
    email: row.email,
    mobile: row.mobile,
    accountStatus: row.disabledAt ? ("DISABLED" as const) : ("ACTIVE" as const),
    marketingConsent: Boolean(row.marketingConsent),
    marketingConsentUpdatedAt: row.marketingConsentUpdatedAt?.toISOString() || null,
    tags: normalizeCustomerTags(jsonArray(row.tags)),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    metrics: {
      orderCount: Number(row.orderCount),
      totalSpent,
      averageOrderValue: row.inrPaidOrderCount
        ? Math.round((totalSpent / Number(row.inrPaidOrderCount)) * 100) / 100
        : 0,
      lastOrderAt: row.lastOrderAt?.toISOString() || null,
      currency: "INR" as const,
      spendByCurrency,
    },
    segments,
  };
}
