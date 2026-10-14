import { CashfreePaymentProvider, verifyCashfreeSignature } from "./cashfree.js";
import crypto from "node:crypto";
import express from "express";
import cors from "cors";
import helmet from "helmet";
import jwt from "jsonwebtoken";
import { pinoHttp } from "pino-http";
import type { DestinationStream } from "pino";
import { privateErrorLog, privateRequestLog, privateResponseLog } from "./http-security.js";
import { checkoutOrderDto, customerOrderHistory, paymentAttemptDto, trackingContactMatches } from "./customer-safe-dto.js";
import { createPostalLookup } from "./postal-lookup.js";
import { freeDeliveryQualifies } from "./delivery-policy.js";
import { onlinePaymentDiscount } from "./payment-policy.js";
import { couponBenefit } from "./coupon-policy.js";
import { loadConfig, type AppConfig } from "./config.js";
import { googleAccountRole, isStoreAdminEmail } from "./auth-policy.js";
import { AppError, errorHandler, notFound } from "./errors.js";
import {
  authenticate,
  authorize,
  SecretVault,
  signAccessToken,
  verifyHmac,
  type Principal,
} from "./security.js";
import {
  checkoutSchema,
  checkoutQuoteSchema,
  trackingSchema,
  manualShipmentSchema,
  addressSchema,
  cartItemSchema,
  couponSchema,
  couponValidationSchema,
  integrationSchema,
  integrationDisconnectSchema,
  inventoryAdjustmentSchema,
  orderStatusSchema,
  productMediaOrderSchema,
  productMediaUpdateSchema,
  productSchema,
  refundSchema,
  returnSchema,
  returnDecisionSchema,
  supportReplySchema,
  customerSupportReplySchema,
  supportTicketSchema,
  storefrontConfigSchema,
  promotionConfigSchema,
  recommendationRequestSchema,
  googleLoginSchema,
  paymentClientEventSchema,
  paymentRetrySchema,
  paymentReconcileSchema,
  accountDeletionSchema,
  adminCustomerQuerySchema,
  adminCustomerUpdateSchema,
  adminReturnQuerySchema,
  adminSupportQuerySchema,
  supportInternalNoteSchema,
  supportUpdateSchema,
} from "./schemas.js";
import { validate } from "./validate.js";
import {
  CommerceStore,
  seedStore,
  type StoredIntegration,
  type StoredUser,
} from "./store.js";
import {
  DevelopmentPaymentProvider,
  DevelopmentShippingProvider,
  ManualShippingProvider,
  RazorpayPaymentProvider,
  ShiprocketShippingProvider,
} from "./providers.js";
import { PrismaPersistence } from "./persistence.js";
import type { ShippingProvider } from "./contracts.js";
import { assertOrderTransition } from "./order-state.js";
import { classifyGatewayFailure } from "./payment-lifecycle.js";
import { buildMerchantFeed } from "./catalog-discovery.js";
import {
  defaultStorefrontConfig,
  normalizeHostname,
  storefrontSettingKey,
  type StorefrontConfig,
} from "./storefront-config.js";
import {
  defaultPromotionConfig,
  publicPromotionConfig,
  type PromotionConfig,
} from "./promotions.js";
import { verifyFirebaseGoogleToken } from "./firebase-auth.js";
import {
  convertProductImage,
  productImageUpload,
  removeConvertedProductImage,
} from "./image-upload.js";
import { generateInvoicePdf } from "./invoice.js";
import { assertBrandingAssetsExist, brandingFields, brandingFileName, convertBrandingAsset, removeBrandingAsset, unusedBrandingAssets, type BrandingKind } from "./branding-assets.js";
import { adminOrderDto, adminRefundDto } from "./admin-orders.js";
import {
  adminProductDetailDto,
  listAdminInventory,
  listAdminProducts,
  paginatedMovements,
  queryInteger,
  storefrontProductDto,
} from "./admin-products.js";

import {
  integrationDefinitions,
  integrationDefinition,
  integrationConfigured,
  integrationDto,
  publicAnalyticsConfig,
  normalizeProvider,
  parsePublicConfig,
  providerPublicConfig,
  runtimeEnvironment,
  selectRuntimeIntegration,
  testIntegrationConnection,
  type IntegrationOutcome,
} from "./integrations.js";
import {
  adminCustomerDetail,
  adminReturnDetail,
  adminSupportDetail,
  listAdminCustomers,
  listAdminReturns,
  listAdminSupportTickets,
  listCustomerSegments,
  normalizeCustomerTags,
} from "./admin-customer-operations.js";

const refreshCookieName = "varahi_refresh_token";
const ok = (
  res: express.Response,
  data: unknown,
  message = "Success",
  status = 200,
) => res.status(status).json({ success: true, data, message });
function limiter(
  limit: number,
  windowMs: number,
  keySelector?: (req: express.Request) => string | undefined,
): express.RequestHandler {
  const buckets = new Map<string, { count: number; reset: number }>();
  return (req, res, next) => {
    const key = keySelector?.(req) || req.ip || "unknown",
      now = Date.now(),
      old = buckets.get(key),
      bucket =
        !old || old.reset < now ? { count: 0, reset: now + windowMs } : old;
    bucket.count++;
    if (buckets.size >= 10_000 && !buckets.has(key)) {
      for (const [candidate, value] of buckets) {
        if (value.reset <= now) buckets.delete(candidate);
      }
      while (buckets.size >= 10_000)
        buckets.delete(buckets.keys().next().value!);
    }
    buckets.set(key, bucket);
    if (bucket.count > limit) {
      const retryAfterSeconds = Math.max(1, Math.ceil((bucket.reset - now) / 1000));
      res.setHeader("Retry-After", String(retryAfterSeconds));
      return next(
        new AppError(429, "RATE_LIMITED", "Too many requests; try again later", { retryAfterSeconds }),
      );
    }
    next();
  };
}
export async function createApp(overrides?: {
  config?: AppConfig;
  store?: CommerceStore;
  persistence?: PrismaPersistence | null;
  googleVerifier?: typeof verifyFirebaseGoogleToken;
  providerRequest?: typeof fetch;
  logDestination?: DestinationStream;
}) {
  const config = overrides?.config || loadConfig(),
    store = overrides?.store || new CommerceStore(),
    persistence =
      overrides?.persistence === undefined
        ? config.NODE_ENV === "production" || config.USE_DATABASE
          ? new PrismaPersistence(undefined, config.DATABASE_URL)
          : null
        : overrides.persistence,
    vault = new SecretVault(config.INTEGRATION_ENCRYPTION_KEY),
    developmentPayments = new DevelopmentPaymentProvider(),
    developmentShipping = new DevelopmentShippingProvider();
  const googleVerifier = overrides?.googleVerifier || verifyFirebaseGoogleToken,
    providerRequest = overrides?.providerRequest || fetch,
    googleIdentities = new Map<
      string,
      { userId: string; audience: string; email: string }
    >();
  const developmentStorefronts = new Map<string, StorefrontConfig>();
  const developmentPromotions = new Map<string, PromotionConfig>();
  const issuePaymentAttemptToken = (
    orderId: string,
    orderNumber: string,
    providerOrderId?: string,
  ) =>
    jwt.sign(
      { purpose: "payment_attempt", orderId, orderNumber, providerOrderId },
      config.JWT_SECRET,
      {
        algorithm: "HS256",
        issuer: "sri-varahi-traders-commerce-api",
        audience: "payment-attempt",
        expiresIn: "30m",
      },
    );
  const verifyPaymentAttemptToken = (
    token: string,
    expected: { orderId: string; orderNumber: string; providerOrderId?: string },
  ) => {
    try {
      const claims = jwt.verify(token, config.JWT_SECRET, {
        algorithms: ["HS256"],
        issuer: "sri-varahi-traders-commerce-api",
        audience: "payment-attempt",
      }) as jwt.JwtPayload;
      if (
        claims.purpose !== "payment_attempt" ||
        claims.orderId !== expected.orderId ||
        claims.orderNumber !== expected.orderNumber ||
        (expected.providerOrderId &&
          claims.providerOrderId !== expected.providerOrderId)
      )
        throw new Error("Payment attempt mismatch");
      return claims;
    } catch {
      throw new AppError(
        401,
        "INVALID_PAYMENT_ATTEMPT",
        "This payment attempt has expired or is invalid. Start a new secure payment attempt.",
      );
    }
  };
  if (persistence) {
    await persistence.connect();
    await persistence.hydrate(store);
  } else seedStore(store);
  const resolvePaymentProvider = (requested: string) => {
    const integration = selectRuntimeIntegration(
      store.integrations.values(),
      "PAYMENT",
      requested,
      config.NODE_ENV,
    );
    if (normalizeProvider(requested) === "cashfree") {
      const configured = [...store.integrations.values()].find(entry => entry.kind === "PAYMENT" && entry.provider === "cashfree" && entry.environment === runtimeEnvironment(config.NODE_ENV));
      if ((configured && !configured.enabled) || (!integration && config.NODE_ENV === "production" && process.env.CASHFREE_ENVIRONMENT !== "LIVE"))
        throw new AppError(503, "PAYMENT_NOT_CONFIGURED", "Cashfree is not enabled for this environment");
      const secrets = integration ? vault.decrypt<Record<string, string>>(integration.encryptedCredentials) : {};
      return new CashfreePaymentProvider({ clientId: secrets.clientId || process.env.CASHFREE_CLIENT_ID || "", clientSecret: secrets.clientSecret || process.env.CASHFREE_CLIENT_SECRET || "", environment: integration?.environment === "LIVE" || (!integration && process.env.CASHFREE_ENVIRONMENT === "LIVE") ? "LIVE" : "TEST" }, providerRequest);
    }
    if (integration && normalizeProvider(integration.provider) === "razorpay") {
      const secrets = vault.decrypt<Record<string, string>>(
        integration.encryptedCredentials,
      );
      return new RazorpayPaymentProvider({
        keyId: secrets.keyId || secrets.key_id || "",
        keySecret: secrets.keySecret || secrets.key_secret || "",
      }, providerRequest);
    }
    if (config.NODE_ENV === "production")
      throw new AppError(
        503,
        "PAYMENT_NOT_CONFIGURED",
        `Payment provider ${requested} is not enabled`,
      );
    return developmentPayments;
  };
  const resolveShippingProvider = (requested?: string, settings?: StorefrontConfig): { name: string; origin: string; provider: ShippingProvider } => {
    if (settings?.manualDeliveryEnabled && (!requested || requested === "manual"))
      return { name: "manual", origin: "", provider: new ManualShippingProvider(settings) };
    const requestedProvider = requested
      ? normalizeProvider(requested)
      : undefined;
    const integration = selectRuntimeIntegration(
      store.integrations.values(),
      "SHIPPING",
      requestedProvider,
      config.NODE_ENV,
    );
    if (integration && normalizeProvider(integration.provider) === "shiprocket") {
      const secrets = vault.decrypt<Record<string, string>>(
        integration.encryptedCredentials,
      );
      const pickupPostcode = String(
        integration.publicConfig.pickupPostcode || "500001",
      );
      return {
        name: "shiprocket",
        origin: pickupPostcode,
        provider: new ShiprocketShippingProvider({
          token: secrets.token || secrets.apiKey || "",
          pickupPostcode,
          pickupLocation: String(
            integration.publicConfig.pickupLocation || "Primary",
          ),
        }, providerRequest),
      };
    }
    if (
      config.NODE_ENV === "production" ||
      (requestedProvider && requestedProvider !== "development")
    )
      throw new AppError(
        503,
        "SHIPPING_NOT_CONFIGURED",
        requestedProvider
          ? `Shipping provider ${requestedProvider} is not enabled`
          : "No live shipping provider is enabled",
      );
    return {
      name: "development",
      origin: "500001",
      provider: developmentShipping,
    };
  };
  const googleAuthConfiguration = () => {
    const projectId = config.FIREBASE_PROJECT_ID?.trim() || "";
    const apiKey = config.FIREBASE_API_KEY?.trim() || "";
    const authDomain = config.FIREBASE_AUTH_DOMAIN?.trim() || "";
    const appId = config.FIREBASE_APP_ID?.trim() || "";
    const enabled = /^[a-z][a-z0-9-]{4,28}[a-z0-9]$/.test(projectId) && /^AIza[\w-]{20,}$/.test(apiKey) && /^[a-zA-Z0-9.-]+$/.test(authDomain) && authDomain.includes(".");
    return { enabled, projectId, apiKey, authDomain, ...(appId ? { appId } : {}) };
  };
  const googleIdentityForUser = async (userId: string) => {
    if (persistence)
      return persistence.getUserAuthIdentity(userId, "google");
    for (const [subject, identity] of googleIdentities)
      if (identity.userId === userId)
        return {
          userId,
          provider: "google",
          subject,
          audience: identity.audience,
          email: identity.email,
        };
    return null;
  };
  const googleAuthMethods = async (userId: string) => {
    const identity = await googleIdentityForUser(userId),
      configuration = googleAuthConfiguration();
    return {
      google: {
        linked: Boolean(identity),
        enabled: configuration.enabled,
      },
    };
  };
  const accountAuthMethods = async (user: StoredUser) => ({
    ...(await googleAuthMethods(user.id)),
    mobileOtp: { available: false },
  });
  const app = express();
  app.disable("x-powered-by");
  app.set(
    "trust proxy",
    /^\d+$/.test(config.TRUST_PROXY)
      ? Number(config.TRUST_PROXY)
      : config.TRUST_PROXY
      ? config.TRUST_PROXY.split(",")
          .map((entry) => entry.trim())
          .filter(Boolean)
      : false,
  );
  app.use(
    pinoHttp({
      level: config.NODE_ENV === "test" ? "silent" : "info",
      serializers: {
        req: privateRequestLog,
        res: privateResponseLog,
        err: privateErrorLog,
      },
      customSuccessObject: (req, _res, value) => ({ ...value, route: typeof (req as express.Request).route?.path === "string" ? (req as express.Request).route.path : "unmatched" }),
      customErrorObject: (req, _res, _error, value) => ({ ...value, route: typeof (req as express.Request).route?.path === "string" ? (req as express.Request).route.path : "unmatched" }),
      redact: [
        "req.headers.authorization",
        "req.headers.cookie",
        "req.body.password",
        "req.body.currentPassword",
        "req.body.code",
        "req.body.otp",
        "req.body.credential",
        "req.body.mobileOtp",
        "req.body.googleCredential",
        "req.body.credentials",
        "res.headers.set-cookie",
      ],
    }, overrides?.logDestination),
  );
  app.use(helmet());
  app.use("/api", (_req, res, next) => {
    // Account, cart and checkout responses must never be reused for another
    // request or customer, including cached authentication failures.
    res.setHeader("Cache-Control", "private, no-store");
    res.vary("Authorization");
    res.vary("Cookie");
    next();
  });
  app.use(
    cors({
      origin: (origin, cb) => {
        const allowed = config.CORS_ORIGINS.split(",").map((x) => x.trim());
        cb(
          origin && !allowed.includes(origin)
            ? new AppError(403, "CORS_DENIED", "Origin is not allowed")
            : null,
          true,
        );
      },
      credentials: true,
      methods: ["GET", "POST", "PUT", "PATCH", "DELETE"],
    }),
  );
  app.post(
    "/webhooks/:provider",
    express.raw({ type: "application/json", limit: "1mb" }),
    async (req, res, next) => {
      try {
        const provider = String(req.params.provider),
          raw = req.body as Buffer,
          integration =
            selectRuntimeIntegration(
              store.integrations.values(),
              "PAYMENT",
              provider,
              config.NODE_ENV,
            ) ||
            selectRuntimeIntegration(
              store.integrations.values(),
              "SHIPPING",
              provider,
              config.NODE_ENV,
            ),
          integrationSecrets = integration
            ? vault.decrypt<Record<string, string>>(
                integration.encryptedCredentials,
              )
            : undefined,
          signature = String(
            req.headers["x-webhook-signature"] ||
              req.headers["x-razorpay-signature"] ||
              "",
          ),
          secret =
            integrationSecrets?.webhookSecret ||
            integrationSecrets?.webhook_secret ||
            process.env[`${provider.toUpperCase()}_WEBHOOK_SECRET`];
        if (provider === "cashfree"
          ? !verifyCashfreeSignature(raw, signature, String(req.headers["x-webhook-timestamp"] || ""), integrationSecrets?.clientSecret || process.env.CASHFREE_CLIENT_SECRET || "")
          : !secret || !verifyHmac(req.body as Buffer, signature, secret))
          throw new AppError(
            401,
            "INVALID_WEBHOOK_SIGNATURE",
            "Webhook signature is invalid",
          );
        let payload: any;
        try {
          payload = JSON.parse(raw.toString("utf8"));
        } catch {
          throw new AppError(
            400,
            "INVALID_WEBHOOK_BODY",
            "Webhook body must be valid JSON",
          );
        }
        if (provider === "cashfree") {
          if (payload.type === "REFUND_STATUS_WEBHOOK") {
            const refundData = payload.data?.refund;
            const reference = String(refundData?.refund_id || "");
            const externalOrder = String(refundData?.order_id || "");
            const status = String(refundData?.refund_status || "");
            const persistedRefund = persistence ? await persistence.db.refund.findUnique({ where: { externalId: reference }, include: { payment: true } }) : null;
            const order = persistedRefund ? store.orders.get(persistedRefund.payment.orderId) : [...store.orders.values()].find(o => o.payment?.externalId === externalOrder && o.payment.refunds?.some(r => r.externalId === reference));
            const refund = persistedRefund || order?.payment?.refunds?.find(r => r.externalId === reference);
            if (!order || !refund || (persistedRefund ? persistedRefund.payment.externalId : order.payment?.externalId) !== externalOrder || (persistedRefund ? persistedRefund.payment.provider : order.payment?.provider) !== "cashfree") throw new AppError(404, "REFUND_NOT_FOUND", "Refund reference was not found");
            if (Number(refund.amount) !== Number(refundData.refund_amount)) throw new AppError(422, "REFUND_VALUE_MISMATCH", "Refund amount does not match");
            if (status === "SUCCESS") {
              if (persistence) { await persistence.completeRefund(refund.id, reference); await persistence.refreshOrder(store, order.id); }
              else store.completeRefund(order.id, refund.id, reference);
            } else if (["FAILED", "CANCELLED"].includes(status) && refund.status === "PENDING") {
              if (persistence) { await persistence.failRefund(refund.id); await persistence.refreshOrder(store, order.id); }
              else store.failRefund(order.id, refund.id);
            }
            return ok(res, { received: true });
          }
          // Failed attempts do not fail an entire Cashfree order: customers can retry.
          if (["PAYMENT_FAILED_WEBHOOK", "PAYMENT_USER_DROPPED_WEBHOOK"].includes(payload.type)) return ok(res, { received: true });
          if (payload.type !== "PAYMENT_SUCCESS_WEBHOOK" || payload.data?.payment?.payment_status !== "SUCCESS") throw new AppError(422, "WEBHOOK_EVENT_NOT_SUPPORTED", "Unsupported Cashfree event");
          payload = { event: "payment.captured", payload: { payment: { entity: { id: String(payload.data.payment.cf_payment_id || ""), order_id: payload.data.order?.order_id, amount: Math.round(Number(payload.data.payment.payment_amount) * 100), currency: payload.data.payment.payment_currency } } } };
        }
        const eventType = String(payload.type || payload.event || ""),
          integrationKind =
            integration?.kind ||
            (["razorpay", "cashfree"].includes(provider.toLowerCase())
              ? "PAYMENT"
              : provider.toLowerCase() === "shiprocket"
                ? "SHIPPING"
                : undefined),
          paymentEvent = eventType.startsWith("payment."),
          shippingEvent = eventType.startsWith("shipment."),
          suppliedOrderId = String(
            payload.orderId ||
              payload.payload?.payment?.entity?.notes?.internalOrderId ||
              payload.payload?.order?.entity?.notes?.internalOrderId ||
              "",
          ),
          externalOrderId = String(
            payload.payload?.payment?.entity?.order_id ||
              payload.payload?.order?.entity?.id ||
              "",
          ),
          externalPaymentId = String(
            payload.payload?.payment?.entity?.id || "",
          ),
          // Only use identifiers covered by the verified raw-body signature.
          // Caller-controlled headers must never alter replay identity.
          explicitEventId = String(payload.id || ""),
          eventId =
            explicitEventId ||
            crypto
              .createHash("sha256")
              .update(
                `${eventType}:${externalOrderId}:${externalPaymentId}:${String(
                  payload.created_at || payload.payload?.payment?.entity?.created_at || "",
                )}`,
              )
              .digest("hex");
        if (!externalPaymentId && paymentEvent)
          throw new AppError(
            400,
            "PAYMENT_REFERENCE_REQUIRED",
            "Provider payment reference is required",
          );
        if (
          (paymentEvent && integrationKind !== "PAYMENT") ||
          (shippingEvent && integrationKind !== "SHIPPING") ||
          (!paymentEvent && !shippingEvent)
        )
          throw new AppError(
            422,
            "WEBHOOK_EVENT_NOT_ALLOWED",
            "This provider is not authorized for the event type",
          );
        if (store.webhookIds.has(`${provider}:${eventId}`))
          return ok(res, { duplicate: true }, "Already processed");
        let orderId = suppliedOrderId,
          paymentId: string | undefined,
          shipmentId: string | undefined;
        if (persistence && paymentEvent) {
          if (!externalOrderId)
            throw new AppError(
              400,
              "PAYMENT_REFERENCE_REQUIRED",
              "Provider payment order reference is required",
            );
          const bound = await persistence.resolvePaymentWebhook(
            provider,
            externalOrderId,
          );
          if (suppliedOrderId && suppliedOrderId !== bound.orderId)
            throw new AppError(
              422,
              "WEBHOOK_RESOURCE_MISMATCH",
              "Payment does not belong to the supplied order",
            );
          orderId = bound.orderId;
          paymentId = bound.paymentId;
          if (eventType === "payment.captured") {
            const amountMinor = Number(
                payload.payload?.payment?.entity?.amount,
              ),
              currency = String(
                payload.payload?.payment?.entity?.currency || "",
              ).toUpperCase();
            if (
              !Number.isSafeInteger(amountMinor) ||
              amountMinor !== Math.round(bound.amount * 100) ||
              currency !== bound.currency.toUpperCase()
            )
              throw new AppError(
                422,
                "PAYMENT_VALUE_MISMATCH",
                "Captured payment amount or currency does not match the order",
              );
          }
        }
        if (!persistence && paymentEvent) {
          if (!externalOrderId)
            throw new AppError(
              400,
              "PAYMENT_REFERENCE_REQUIRED",
              "Provider payment order reference is required",
            );
          const boundOrder = [...store.orders.values()].find(
            (candidate) =>
              candidate.payment?.externalId === externalOrderId &&
              normalizeProvider(candidate.payment.provider || "") ===
                normalizeProvider(provider),
          );
          if (!boundOrder?.payment)
            throw new AppError(
              404,
              "PAYMENT_NOT_FOUND",
              "Webhook payment was not found",
            );
          if (suppliedOrderId && suppliedOrderId !== boundOrder.id)
            throw new AppError(
              422,
              "WEBHOOK_RESOURCE_MISMATCH",
              "Payment does not belong to the supplied order",
            );
          orderId = boundOrder.id;
          if (eventType === "payment.captured") {
            const amountMinor = Number(payload.payload?.payment?.entity?.amount),
              currency = String(
                payload.payload?.payment?.entity?.currency || "",
              ).toUpperCase();
            if (
              !Number.isSafeInteger(amountMinor) ||
              amountMinor !== Math.round((boundOrder.payment.amount || boundOrder.total) * 100) ||
              currency !== (boundOrder.payment.currency || "INR").toUpperCase()
            )
              throw new AppError(
                422,
                "PAYMENT_VALUE_MISMATCH",
                "Captured payment amount or currency does not match the order",
              );
          }
        }
        if (persistence && shippingEvent) {
          const awb = String(payload.awb || payload.awb_code || "");
          if (!awb)
            throw new AppError(
              400,
              "SHIPMENT_REFERENCE_REQUIRED",
              "Shipment AWB is required",
            );
          const bound = await persistence.resolveShipmentWebhook(provider, awb);
          if (suppliedOrderId && suppliedOrderId !== bound.orderId)
            throw new AppError(
              422,
              "WEBHOOK_RESOURCE_MISMATCH",
              "Shipment does not belong to the supplied order",
            );
          orderId = bound.orderId;
          shipmentId = bound.shipmentId;
        }
        const target =
            eventType === "payment.captured"
              ? "PAID"
              : eventType === "payment.failed"
                ? "FAILED"
                : eventType === "payment.refunded"
                  ? "REFUNDED"
                  : eventType === "shipment.out_for_delivery"
                    ? "OUT_FOR_DELIVERY"
                    : eventType === "shipment.delivered"
                      ? "DELIVERED"
                      : undefined,
          order = orderId ? store.orders.get(orderId) : undefined;
        if (!target)
          throw new AppError(
            422,
            "WEBHOOK_EVENT_NOT_SUPPORTED",
            "Webhook event type is not supported",
          );
        if (target && !order)
          throw new AppError(
            404,
            "ORDER_NOT_FOUND",
            "Webhook order was not found",
          );
        if (target && order?.status === target) {
          store.webhookIds.add(`${provider}:${eventId}`);
          return ok(res, { duplicate: true }, "Already processed");
        }
        if (target && order) assertOrderTransition(order.status, target);
        const persisted = await persistence?.processWebhook({
          provider,
          eventId,
          payloadHash: crypto.createHash("sha256").update(raw).digest("hex"),
          orderId: order?.id,
          from: order?.status,
          to: target,
          paymentId,
          paymentStatus: paymentId
            ? target === "PAID"
              ? "CAPTURED"
              : target === "REFUNDED"
                ? "REFUNDED"
                : "FAILED"
            : undefined,
          paymentAmount:
            Number(payload.payload?.payment?.entity?.amount || 0) / 100,
          paymentErrorCode:
            String(payload.payload?.payment?.entity?.error_code || "") ||
            undefined,
          paymentErrorDescription:
            String(payload.payload?.payment?.entity?.error_description || "") ||
            undefined,
          externalPaymentId:
            externalPaymentId || undefined,
          shipmentId,
          shipmentStatus: shipmentId ? target : undefined,
          location:
            typeof payload.location === "string" ? payload.location : undefined,
          occurredAt: payload.current_timestamp
            ? new Date(payload.current_timestamp)
            : undefined,
          safePayload: { type: eventType, orderId: orderId || undefined },
        });
        if (persisted?.duplicate)
          return ok(res, { duplicate: true }, "Already processed");
        if (target && order) {
          if (paymentEvent && order.payment) {
            order.payment.status =
              target === "PAID"
                ? "CAPTURED"
                : target === "REFUNDED"
                  ? "REFUNDED"
                  : "FAILED";
            order.payment.gatewayTransactionId =
              externalPaymentId ||
              order.payment.gatewayTransactionId;
            if (target === "FAILED")
              order.payment.lastError = {
                code:
                  String(payload.payload?.payment?.entity?.error_code || "") ||
                  undefined,
                description:
                  String(
                    payload.payload?.payment?.entity?.error_description || "",
                  ) || undefined,
              };
          }
          store.transitionOrder(order.id, target, undefined, provider);
        }
        store.webhookIds.add(`${provider}:${eventId}`);
        return ok(res, { accepted: true }, "Accepted", 202);
      } catch (e) {
        next(e);
      }
    },
  );
  // Mobile numbers are contact details only; SMS authentication is disabled.
  app.use(["/api/v1/auth/mobile", "/api/v1/account/auth/mobile"], (_req, _res, next) => {
    next(new AppError(404, "MOBILE_OTP_DISABLED", "Use Google to sign in"));
  });
  app.use(express.json({ limit: "1mb" }));
  app.use(
    "/uploads",
    express.static(config.UPLOAD_DIR, {
      fallthrough: false,
      immutable: true,
      maxAge: "1y",
      dotfiles: "deny",
      index: false,
      // Catalog and branding uploads are sanitized public images, also used by
      // the separate localhost storefront during development.
      setHeaders: res => res.setHeader("Cross-Origin-Resource-Policy", "cross-origin"),
    }),
  );
  // Express only uses X-Forwarded-Host when the direct peer matches the
  // explicitly configured trusted proxy list. This prevents callers from
  // selecting another tenant's pricing rules with a forged header.
  const allowedOrigins = new Set(
    config.CORS_ORIGINS.split(",").map((origin) => origin.trim()).filter(Boolean),
  );
  const requestHostname = (req: express.Request) => {
    const origin = req.get("origin");
    if (origin && allowedOrigins.has(origin)) {
      try {
        return normalizeHostname(new URL(origin).hostname);
      } catch {
        // The CORS middleware rejects malformed/unapproved origins. Retaining
        // the direct host here keeps non-browser and same-origin clients safe.
      }
    }
    return normalizeHostname(req.hostname);
  };
  const readStorefront = async (hostname: string) => {
    const exactKey = storefrontSettingKey(hostname);
    const stored = persistence
      ? await persistence.getSetting<StorefrontConfig>(exactKey)
      : developmentStorefronts.get(exactKey);
    const fallback = persistence
      ? await persistence.getSetting<StorefrontConfig>(
          storefrontSettingKey("localhost"),
        )
      : developmentStorefronts.get(storefrontSettingKey("localhost"));
    return storefrontConfigSchema.parse(
      stored || fallback || defaultStorefrontConfig,
    );
  };
  app.get("/api/v1/storefront/config", async (req, res) =>
    ok(res, await readStorefront(requestHostname(req))),
  );
  const lookupPostalCode = createPostalLookup(overrides?.providerRequest || fetch);
  app.get("/api/v1/postal-codes/:postalCode", limiter(30, 60_000), async (req, res) =>
    ok(res, await lookupPostalCode(String(req.params.postalCode))));
  app.get("/api/v1/storefront/favicon", async (req, res) => {
    const settings = await readStorefront(requestHostname(req));
    res.setHeader("Cache-Control", "no-store");
    return res.redirect(302, settings.faviconUrl || "/favicon.svg");
  });
  app.get("/api/v1/storefront/manifest", async (req, res) => {
    const settings = await readStorefront(requestHostname(req));
    res.setHeader("Cache-Control", "no-store");
    return res.type("application/manifest+json").json({
      name: settings.storeName, short_name: settings.storeName.slice(0, 24),
      description: settings.seoDescription, start_url: "/", scope: "/", display: "standalone",
      lang: settings.locale, background_color: settings.backgroundColor, theme_color: settings.primaryColor,
      icons: [{ src: settings.faviconUrl || "/favicon.svg", sizes: "any", purpose: "any" }],
    });
  });
  app.get("/api/v1/storefront/analytics", (_req, res) => {
    res.setHeader("Cache-Control", "no-store");
    return ok(res, publicAnalyticsConfig(store.integrations.values(), config.NODE_ENV));
  });
  const promotionKey = (hostname: string) =>
    `promotions:${normalizeHostname(hostname)}`;
  const readPromotions = async (hostname: string) =>
    persistence
      ? (await persistence.getSetting<PromotionConfig>(
          promotionKey(hostname),
        )) ||
        (await persistence.getSetting<PromotionConfig>(
          promotionKey("localhost"),
        )) ||
        defaultPromotionConfig
      : developmentPromotions.get(promotionKey(hostname)) ||
        developmentPromotions.get(promotionKey("localhost")) ||
        defaultPromotionConfig;
  app.get("/api/v1/storefront/promotions", async (req, res) => {
    const returning = req.query.returning === "true",
      settings = promotionConfigSchema.parse(
        await readPromotions(requestHostname(req)),
      );
    res.setHeader("Cache-Control", "no-store");
    return ok(res, publicPromotionConfig(settings, returning));
  });
  app.post(
    "/api/v1/storefront/recommendations",
    validate(recommendationRequestSchema),
    async (req, res) => {
      const { viewedProductIds, cartProductIds, categories, limit } = req.body,
        products = store
          .listProducts()
          .filter((product) => product.status === "ACTIVE"),
        affinity = new Map<string, number>();
      for (const id of [...viewedProductIds, ...cartProductIds]) {
        const product = products.find((candidate) => candidate.id === id || candidate.slug === id);
        if (product)
          affinity.set(
            product.category,
            (affinity.get(product.category) || 0) +
              (cartProductIds.includes(id) ? 4 : 2),
          );
      }
      for (const category of categories)
        affinity.set(category, (affinity.get(category) || 0) + 1);
      const excluded = new Set(cartProductIds),
        ranked = products
          .filter((product) => !excluded.has(product.id) && !excluded.has(product.slug))
          .map((product) => ({
            product: storefrontProductDto(product),
            score:
              (affinity.get(product.category) || 0) * 10 +
              product.variants.filter((variant) => variant.active).reduce(
                (sum, variant) => sum + variant.stock - variant.reserved,
                0,
              ) /
                1000,
            reason: affinity.has(product.category)
              ? `Because you explored ${product.category}`
              : "Popular in the store",
          }))
          .sort((a, b) => b.score - a.score)
          .slice(0, limit);
      return ok(res, ranked);
    },
  );
  app.get("/health", (_req, res) =>
    ok(res, { status: "healthy", time: new Date().toISOString() }),
  );
  app.get("/ready", async (_req, res) => {
    if (!persistence)
      return config.NODE_ENV === "production"
        ? res.status(503).json({ success: false, error: { code: "PERSISTENCE_UNAVAILABLE", message: "Durable persistence is unavailable" } })
        : ok(res, { status: "ready", persistence: "memory" });
    try {
      await persistence.db.$queryRaw`SELECT 1`;
      return ok(res, { status: "ready", persistence: "mysql" });
    } catch {
      return res.status(503).json({ success: false, error: { code: "DATABASE_UNAVAILABLE", message: "Database readiness check failed" } });
    }
  });
  const assertAccountActive = async (
    user: StoredUser,
    tokenAuthVersion?: number,
  ) => {
    if (user.role !== "CUSTOMER") {
      const current = persistence ? await persistence.findAuthUser({ id: user.id }) : user;
      if (!current || current.disabledAt || current.role !== "ADMIN" || !isStoreAdminEmail(current.email) ||
          (tokenAuthVersion !== undefined && tokenAuthVersion !== (current.authVersion || 0)))
        throw new AppError(401, "INVALID_TOKEN", "Session is invalid or expired");
      user.permissions = current.permissions;
      user.authVersion = current.authVersion;
      return current.authVersion || 0;
    }
    const persisted = persistence
      ? await persistence.getCustomerAccountState(user.id)
      : null;
    const disabled = persisted
      ? !persisted.exists || !persisted.customer || persisted.disabled
      : Boolean(user.disabledAt);
    const authoritativeVersion = persisted?.authVersion ?? user.authVersion ?? 0;
    if (
      tokenAuthVersion !== undefined &&
      tokenAuthVersion !== authoritativeVersion
    )
      throw new AppError(401, "INVALID_TOKEN", "Session is invalid or expired");
    if (disabled)
      throw new AppError(
        403,
        "ACCOUNT_DISABLED",
        "This account is disabled. Contact store support for assistance",
      );
    user.permissions = [];
    user.authVersion = authoritativeVersion;
    if (persisted) {
      user.disabledAt = persisted.disabledAt?.toISOString();
      if (persisted.user) {
        user.name = persisted.user.name;
        user.email = persisted.user.email;
        user.mobile = persisted.user.mobile || undefined;
      }
    }
    return authoritativeVersion;
  };
  const loadCustomerForAuth = async (userId: string) => {
    let user = store.users.get(userId);
    if (persistence) {
      const state = await persistence.getCustomerAccountState(userId);
      if (!state.exists || !state.customer || !state.user)
        throw new AppError(
          401,
          "INVALID_TOKEN",
          "Session is invalid or expired",
        );
      if (!user) {
        user = {
          id: state.user.id,
          name: state.user.name,
          email: state.user.email,
          mobile: state.user.mobile || undefined,
          role: state.user.role,
          permissions: [],
        };
        store.users.set(user.id, user);
      }
      user.name = state.user.name;
      user.email = state.user.email;
      user.mobile = state.user.mobile || undefined;
      user.disabledAt = state.user.disabledAt?.toISOString();
      user.authVersion = state.user.authVersion;
    }
    if (!user || user.role !== "CUSTOMER")
      throw new AppError(
        401,
        "INVALID_TOKEN",
        "Session is invalid or expired",
      );
    user.permissions = [];
    return user;
  };
  const cachePersistedAuthUser = async (input: {
    email?: string;
    mobile?: string;
  }) => {
    if (!persistence) return undefined;
    const persistedUser = await persistence.findAuthUser(input);
    if (persistedUser) store.users.set(persistedUser.id, persistedUser);
    return persistedUser || undefined;
  };
  const assertAccountActiveBeforeGoogle = async (user: StoredUser) => {
    if (user.disabledAt) throw new AppError(403, "ACCOUNT_DISABLED", "This account is disabled. Contact store support for assistance");
  };
  const reconcileGoogleRole = async (user: StoredUser, verifiedEmail: string) => {
    const role = googleAccountRole(verifiedEmail);
    if (role === "ADMIN" && !isStoreAdminEmail(user.email))
      throw new AppError(409, "GOOGLE_ACCOUNT_LINK_REQUIRED", "The administrator Google account must match its store account.");
    if (persistence) {
      const current = await persistence.reconcileGoogleRole(user.id, verifiedEmail);
      store.users.set(current.id, current);
      return current;
    }
    if (user.role !== role) {
      user.authVersion = (user.authVersion || 0) + 1;
      for (const [id, session] of store.sessions) if (session.userId === user.id) store.sessions.delete(id);
    }
    user.role = role;
    user.permissions = role === "ADMIN" ? ["*"] : [];
    user.totpEnabled = false;
    user.totpSecretEncrypted = undefined;
    return user;
  };
  const issueCustomerSession = async (
    user: StoredUser,
    res: express.Response,
  ) => {
    const authVersion = await assertAccountActive(user);
      const principal: Principal = {
        sub: user.id,
        role: user.role,
        permissions: user.permissions,
        authVersion,
      },
      accessToken = signAccessToken(principal, config.JWT_SECRET),
      sessionId = crypto.randomUUID(),
      refreshToken = jwt.sign(
        { ...principal, jti: sessionId },
        config.JWT_REFRESH_SECRET,
        {
          algorithm: "HS256",
          expiresIn: "7d",
          issuer: "sri-varahi-traders-commerce",
          audience: "store-refresh",
        },
      );
    store.sessions.set(sessionId, {
      userId: user.id,
      expiresAt: Date.now() + 604800000,
    });
    await persistence?.saveSession(sessionId, user.id, Date.now() + 604800000);
    res.cookie(refreshCookieName, refreshToken, {
      httpOnly: true,
      secure: config.NODE_ENV === "production",
      sameSite: "strict",
      path: "/api/v1/auth",
      maxAge: 604800000,
    });
    return {
      accessToken,
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        mobile: user.mobile,
        role: user.role,
      },
    };
  };
  app.get("/api/v1/auth/providers", (_req, res) => {
    const google = googleAuthConfiguration();
    return ok(res, {
      mobileOtp: { enabled: false },
      google: {
        enabled: google.enabled,
      },
      firebase: { enabled: google.enabled, projectId: google.projectId, apiKey: google.apiKey, authDomain: google.authDomain, ...(google.appId ? { appId: google.appId } : {}) },
    });
  });
  app.post(
    "/api/v1/auth/google",
    limiter(10, 60000),
    validate(googleLoginSchema),
    async (req, res) => {
      const google = googleAuthConfiguration();
      if (!google.enabled)
        throw new AppError(
          503,
          "GOOGLE_AUTH_NOT_CONFIGURED",
          "Google sign-in is not configured",
        );
      const claims = await googleVerifier(
        req.body.credential,
        google.projectId,
      );
      const subject = claims.sub.trim(),
        email = claims.email.trim().toLowerCase();
      if (!subject || !email)
        throw new AppError(
          401,
          "INVALID_GOOGLE_TOKEN",
          "Google credential could not be verified",
        );
      let user: StoredUser | undefined;
      if (persistence)
        user =
          (await persistence.findAuthUserByIdentity(
            "google",
            subject,
            email,
            google.projectId,
          )) || undefined;
      else {
        const identity = googleIdentities.get(subject);
        user = identity ? store.users.get(identity.userId) : undefined;
        if (identity && user) {
          identity.audience = google.projectId;
          identity.email = email;
        } else if (identity) googleIdentities.delete(subject);
      }
      if (persistence && user) store.users.set(user.id, user);
      if (!user) {
        const emailOwner =
          store.findUser(email) ||
          (await cachePersistedAuthUser({ email }));
        if (emailOwner) {
          // Google must be authoritative for an existing email before migration.
          // Verified third-party addresses alone can outlive their ownership.
          const emailDomain = email.split("@")[1];
          const authoritative = claims.email_verified === true &&
            emailDomain === "gmail.com";
          const existingIdentity = await googleIdentityForUser(emailOwner.id);
          if (!authoritative || (existingIdentity && existingIdentity.subject !== subject))
            throw new AppError(409, "GOOGLE_ACCOUNT_LINK_REQUIRED", "Contact the store administrator to connect this existing account to Google.");
          await assertAccountActiveBeforeGoogle(emailOwner);
          if (persistence) await persistence.linkAuthIdentity({ userId: emailOwner.id, provider: "google", subject, audience: google.projectId, email });
          else googleIdentities.set(subject, { userId: emailOwner.id, audience: google.projectId, email });
          return ok(res, await issueCustomerSession(await reconcileGoogleRole(emailOwner, email), res), "Google account connected");
        }
        let candidate: StoredUser;
        try {
          candidate = store.createUser({
            name: claims.name || email.split("@")[0] || "Google customer",
            email,
            role: "CUSTOMER",
            permissions: [],
          });
        } catch (error) {
          if (error instanceof AppError && error.code === "EMAIL_EXISTS")
            throw new AppError(
              409,
              "GOOGLE_ACCOUNT_LINK_REQUIRED",
              "Contact the store administrator to connect this existing account to Google.",
            );
          throw error;
        }
        try {
          if (persistence) {
            user = await persistence.saveGoogleUser(
              candidate,
              subject,
              email,
              google.projectId,
            );
            if (user.id !== candidate.id) {
              store.users.delete(candidate.id);
              store.users.set(user.id, user);
            }
          } else {
            user = candidate;
            googleIdentities.set(subject, {
              userId: user.id,
              audience: google.projectId,
              email,
            });
          }
        } catch (error) {
          store.users.delete(candidate.id);
          throw error;
        }
      }
      await assertAccountActiveBeforeGoogle(user);
      user = await reconcileGoogleRole(user, email);
      return ok(
        res,
        await issueCustomerSession(user, res),
        "Google account verified",
      );
    },
  );
  const readRefreshToken = (req: express.Request) =>
    req.headers.cookie
      ?.split(";")
      .map((part) => part.trim().split("="))
      .find(([name]) => name === refreshCookieName)?.[1];
  app.post(
    "/api/v1/auth/refresh",
    limiter(30, 60_000),
    async (req, res, next) => {
      try {
        const token = readRefreshToken(req);
        if (!token)
          throw new AppError(
            401,
            "REFRESH_REQUIRED",
            "Refresh session required",
          );
        const decoded = jwt.verify(token, config.JWT_REFRESH_SECRET, {
          algorithms: ["HS256"],
          issuer: "sri-varahi-traders-commerce",
          audience: "store-refresh",
        }) as Principal & { jti?: string };
        const session = decoded.jti
          ? persistence
            ? await persistence.getSession(decoded.jti)
            : store.sessions.get(decoded.jti)
          : undefined;
        if (
          !decoded.jti ||
          !session ||
          new Date(session.expiresAt).getTime() <= Date.now()
        )
          throw new AppError(
            401,
            "INVALID_REFRESH_TOKEN",
            "Session is invalid or expired",
          );
        const user =
          decoded.role === "CUSTOMER"
            ? await loadCustomerForAuth(session.userId)
            : persistence ? await persistence.findAuthUser({ id: session.userId }) : store.users.get(session.userId);
        if (!user)
          throw new AppError(
            401,
            "INVALID_REFRESH_TOKEN",
            "Session is invalid",
          );
        await assertAccountActive(user, decoded.authVersion || 0);
        if (persistence) {
          if (!(await persistence.consumeSession(decoded.jti)))
            throw new AppError(
              401,
              "INVALID_REFRESH_TOKEN",
              "Session has already been rotated",
            );
        } else {
          if (!store.sessions.delete(decoded.jti))
            throw new AppError(
              401,
              "INVALID_REFRESH_TOKEN",
              "Session has already been rotated",
            );
        }
        const principal: Principal = {
          sub: user.id,
          role: user.role,
          permissions: user.permissions,
          authVersion: user.authVersion || 0,
        };
        const nextSessionId = crypto.randomUUID();
        store.sessions.set(nextSessionId, {
          userId: user.id,
          expiresAt: Date.now() + 604800000,
        });
        await persistence?.saveSession(
          nextSessionId,
          user.id,
          Date.now() + 604800000,
        );
        const refreshToken = jwt.sign(
          { ...principal, jti: nextSessionId },
          config.JWT_REFRESH_SECRET,
          {
            algorithm: "HS256",
            expiresIn: "7d",
            issuer: "sri-varahi-traders-commerce",
            audience: "store-refresh",
          },
        );
        res.cookie(refreshCookieName, refreshToken, {
          httpOnly: true,
          secure: config.NODE_ENV === "production",
          sameSite: "strict",
          path: "/api/v1/auth",
          maxAge: 604800000,
        });
        return ok(res, {
          accessToken: signAccessToken(principal, config.JWT_SECRET),
        });
      } catch (error) {
        next(
          error instanceof AppError
            ? error
            : new AppError(
                401,
                "INVALID_REFRESH_TOKEN",
                "Session is invalid or expired",
              ),
        );
      }
    },
  );
  app.post("/api/v1/auth/logout", async (req, res) => {
    const token = readRefreshToken(req);
    if (token) {
      try {
        const decoded = jwt.verify(token, config.JWT_REFRESH_SECRET, {
          algorithms: ["HS256"],
            issuer: "sri-varahi-traders-commerce",
          audience: "store-refresh",
        }) as { jti?: string };
        if (decoded.jti) {
          store.sessions.delete(decoded.jti);
          await persistence?.revokeSession(decoded.jti);
        }
      } catch {
        // Logout remains idempotent for expired or malformed cookies.
      }
    }
    res.clearCookie(refreshCookieName, { path: "/api/v1/auth" });
    return ok(res, { loggedOut: true }, "Logged out");
  });
  const tokenAuth = authenticate(config.JWT_SECRET);
  const auth: express.RequestHandler = (req, res, next) =>
    tokenAuth(req, res, (error) => {
      if (error) return next(error);
      const check = async () => {
        if (req.principal?.role !== "CUSTOMER") {
          const user = persistence
            ? await persistence.findAuthUser({ id: req.principal!.sub })
            : store.users.get(req.principal!.sub);
          if (!user || user.role !== "ADMIN" || !isStoreAdminEmail(user.email) || user.role !== req.principal!.role)
            throw new AppError(401, "INVALID_TOKEN", "Session is invalid or expired");
          await assertAccountActive(user, req.principal!.authVersion || 0);
          req.principal!.permissions = user.permissions;
          store.users.set(user.id, user);
          return;
        }
        const user = await loadCustomerForAuth(req.principal!.sub);
        await assertAccountActive(user, req.principal!.authVersion || 0);
        req.principal!.permissions = [];
      };
      void check().then(() => next(), next);
    });
  const accountRateLimitKey = (req: express.Request) =>
    req.principal?.sub ? `account:${req.principal.sub}` : undefined;
  const optionalAuth: express.RequestHandler = (req, res, next) =>
    req.headers.authorization ? auth(req, res, next) : next();
  // Settings aliases publish together. Serialize replacements so an overlapping
  // upload cannot delete an asset another save has just made active.
  let brandingWrite: Promise<unknown> = Promise.resolve();
  const withBrandingWrite = <T,>(operation: () => Promise<T>): Promise<T> => {
    const result = brandingWrite.then(operation, operation);
    brandingWrite = result.catch(() => undefined);
    return result;
  };
  const cleanupKey = "branding:pending-cleanup";
  let developmentCleanup: string[] = [];
  const saveStorefront = async (value: StorefrontConfig, req: express.Request) => {
    await assertBrandingAssetsExist(value, config.UPLOAD_DIR, config.PUBLIC_UPLOAD_BASE_URL);
    const hostname = value.primaryDomain || requestHostname(req);
    const keys = new Set([storefrontSettingKey(hostname), storefrontSettingKey("localhost")]);
    const before = persistence
      ? await persistence.listSettings<StorefrontConfig>("storefront:")
      : [...developmentStorefronts].map(([key, setting]) => ({ key, value: setting }));
    const after = [...before.filter(entry => !keys.has(entry.key)).map(entry => entry.value), value];
    const pending = persistence ? await persistence.getSetting<string[]>(cleanupKey) || [] : developmentCleanup;
    const retired = unusedBrandingAssets([...before.map(entry => entry.value), ...pending.map(url => ({ ...value, logoUrl: url }))], after, config.PUBLIC_UPLOAD_BASE_URL);
    // Product and campaign references also keep a shared branding upload alive.
    const references = new Set(store.listProducts().flatMap(product => product.media.map(media => brandingFileName(media.url, config.PUBLIC_UPLOAD_BASE_URL))).filter(Boolean));
    const campaigns = persistence ? await persistence.listSettings<PromotionConfig>("promotions:")
      : [...developmentPromotions].map(([key, setting]) => ({ key, value: setting }));
    campaigns.forEach(entry => entry.value.banners.forEach(banner => {
      const name = brandingFileName(banner.imageUrl, config.PUBLIC_UPLOAD_BASE_URL);
      if (name) references.add(name);
    }));
    const cleanup = retired;
    if (persistence) await persistence.saveSettings([
      ...[...keys].map(key => ({ key, value })), { key: cleanupKey, value: cleanup },
    ]);
    else {
      keys.forEach(key => developmentStorefronts.set(key, value));
      developmentCleanup = cleanup;
    }
    const remaining: string[] = [];
    let cleanupFailures = 0;
    for (const url of cleanup) {
      if (references.has(brandingFileName(url, config.PUBLIC_UPLOAD_BASE_URL))) { remaining.push(url); continue; }
      try { await removeBrandingAsset(url, config.UPLOAD_DIR, config.PUBLIC_UPLOAD_BASE_URL); }
      catch (error) {
        cleanupFailures++;
        remaining.push(url);
        req.log.warn({ err: error }, "Branding cleanup will retry on the next settings save");
      }
    }
    if (persistence) await persistence.saveSetting(cleanupKey, remaining).catch(error =>
      req.log.warn({ err: error }, "Could not acknowledge branding cleanup"));
    else developmentCleanup = remaining;
    store.auditLogs.unshift({ id: crypto.randomUUID(), action: "storefront.settings.updated",
      resource: "Setting", resourceId: hostname, actorId: req.principal!.sub, createdAt: new Date().toISOString() });
    return { ...value, assetCleanupPending: cleanupFailures > 0 };
  };
  app.get(
    "/api/v1/admin/storefront-config",
    auth,
    authorize("settings:read"),
    async (req, res) => ok(res, await readStorefront(requestHostname(req))),
  );
  app.put(
    "/api/v1/admin/storefront-config",
    auth,
    authorize("settings:update"),
    validate(storefrontConfigSchema),
    async (req, res) => {
      return ok(res, await withBrandingWrite(() => saveStorefront(req.body as StorefrontConfig, req)), "Storefront configuration saved");
    },
  );
  app.post("/api/v1/admin/storefront-config/assets/:kind", auth, authorize("settings:update"), productImageUpload, async (req, res) => {
    const kind = String(req.params.kind) as BrandingKind;
    if (!Object.hasOwn(brandingFields, kind)) throw new AppError(400, "BRANDING_KIND_INVALID", "Choose a header logo, footer logo or favicon");
    if (!req.file) throw new AppError(400, "IMAGE_REQUIRED", "Choose a logo image to upload");
    const value = await withBrandingWrite(async () => {
      const settings = await readStorefront(requestHostname(req));
      const url = await convertBrandingAsset(req.file!.buffer, kind, config.UPLOAD_DIR, config.PUBLIC_UPLOAD_BASE_URL);
      try { return await saveStorefront({ ...settings, [brandingFields[kind]]: url }, req); }
      catch (error) {
        await removeBrandingAsset(url, config.UPLOAD_DIR, config.PUBLIC_UPLOAD_BASE_URL).catch(() => undefined);
        throw error;
      }
    });
    return ok(res, value, "Branding updated and unused previous uploads removed", 201);
  });
  app.get(
    "/api/v1/admin/promotions",
    auth,
    authorize("marketing:update"),
    async (req, res) =>
      ok(
        res,
        promotionConfigSchema.parse(await readPromotions(requestHostname(req))),
      ),
  );
  app.put(
    "/api/v1/admin/promotions",
    auth,
    authorize("marketing:update"),
    validate(promotionConfigSchema),
    async (req, res) => {
      const hostname = requestHostname(req),
        value = req.body as PromotionConfig;
      persistence
        ? await persistence.saveSetting(promotionKey(hostname), value)
        : developmentPromotions.set(promotionKey(hostname), value);
      store.auditLogs.unshift({
        id: crypto.randomUUID(),
        action: "promotions.updated",
        resource: "Setting",
        resourceId: hostname,
        actorId: req.principal!.sub,
        createdAt: new Date().toISOString(),
      });
      return ok(res, value, "Promotions published");
    },
  );
  app.get(
    "/api/v1/admin/coupons",
    auth,
    authorize("marketing:update"),
    (_req, res) => ok(res, [...store.coupons.values()]),
  );
  app.get("/api/v1/auth/me", auth, (req, res) => {
    const user = store.users.get(req.principal!.sub);
    if (!user) throw new AppError(404, "USER_NOT_FOUND", "User not found");
    return ok(res, {
      id: user.id,
      name: user.name,
      email: user.email,
      mobile: user.mobile || null,
      role: user.role,
      permissions: user.permissions,
    });
  });
  app.get("/api/v1/account/auth-methods", auth, async (req, res) => {
    const user = store.users.get(req.principal!.sub);
    if (!user || user.role !== "CUSTOMER")
      throw new AppError(
        403,
        "CUSTOMER_ACCOUNT_REQUIRED",
        "Customer account required",
      );
    return ok(res, await accountAuthMethods(user));
  });
  app.delete(
    "/api/v1/account",
    auth,
    limiter(8, 60_000, accountRateLimitKey),
    validate(accountDeletionSchema),
    async (req, res) => {
      const userId = req.principal!.sub,
        user = store.users.get(userId);
      if (!user)
        throw new AppError(404, "ACCOUNT_NOT_FOUND", "Account not found");
      if (user.role !== "CUSTOMER")
        throw new AppError(
          403,
          "CUSTOMER_ACCOUNT_REQUIRED",
          "Staff accounts cannot be deleted here",
        );
      let reauthenticated = false;
      if (req.body.googleCredential) {
        const identity = await googleIdentityForUser(user.id);
        if (!identity)
          throw new AppError(
            409,
            "GOOGLE_ACCOUNT_NOT_LINKED",
            "Connect a Google account before using Google to confirm deletion",
          );
        const claims = await googleVerifier(
          req.body.googleCredential,
          googleAuthConfiguration().projectId,
        );
        reauthenticated = claims.sub.trim() === identity.subject;
      }
      if (!reauthenticated)
        throw new AppError(
          401,
          "REAUTHENTICATION_REQUIRED",
          "Confirm your identity again before deleting the account",
        );
      const retainedOrders = persistence
        ? (await persistence.deleteCustomerAccount(userId)).retainedOrders
        : [...store.orders.values()].filter((order) => order.userId === userId)
            .length;
      for (const order of store.orders.values())
        if (order.userId === userId) {
          order.userId = undefined;
          order.invoiceSnapshot = {};
        }
      for (const [id, session] of store.sessions)
        if (session.userId === userId) store.sessions.delete(id);
      for (const request of store.returns.values())
        if (request.userId === userId) {
          request.userId = undefined;
          request.reason = "Personal details removed";
          request.notes = undefined;
        }
      for (const [id, ticket] of store.supportTickets)
        if (ticket.userId === userId) store.supportTickets.delete(id);
      store.addresses.delete(userId);
      store.wishlists.delete(userId);
      store.carts.delete(`user:${userId}`);
      for (const [subject, identity] of googleIdentities)
        if (identity.userId === userId) googleIdentities.delete(subject);
      store.users.delete(userId);
      store.auditLogs.unshift({
        id: crypto.randomUUID(),
        action: "customer.account_deleted",
        resource: "user",
        resourceId: userId,
        retainedOrders,
        personalDataRedacted: true,
        createdAt: new Date().toISOString(),
      });
      res.clearCookie(refreshCookieName, { path: "/api/v1/auth" });
      return ok(
        res,
        { deleted: true, retainedOrders },
        "Your account and personal data were deleted. Anonymized transaction records remain with the store owner.",
      );
    },
  );
  app.get("/api/v1/account/addresses", auth, async (req, res) =>
    ok(
      res,
      persistence
        ? await persistence.listAddresses(req.principal!.sub)
        : store.addresses.get(req.principal!.sub) || [],
    ),
  );
  app.post(
    "/api/v1/account/addresses",
    auth,
    validate(addressSchema),
    async (req, res) => {
      if (persistence)
        return ok(
          res,
          await persistence.saveAddress(req.principal!.sub, req.body),
          "Address saved",
          201,
        );
      const addresses = store.addresses.get(req.principal!.sub) || [];
      if (req.body.isDefault)
        addresses.forEach((address) => {
          address.isDefault = false;
        });
      const address = {
        id: crypto.randomUUID(),
        userId: req.principal!.sub,
        ...req.body,
        createdAt: new Date().toISOString(),
      };
      addresses.push(address);
      store.addresses.set(req.principal!.sub, addresses);
      return ok(res, address, "Address saved", 201);
    },
  );
  app.delete("/api/v1/account/addresses/:id", auth, async (req, res) => {
    if (persistence)
      await persistence.deleteAddress(
        req.principal!.sub,
        String(req.params.id),
      );
    else {
      const addresses = store.addresses.get(req.principal!.sub) || [],
        next = addresses.filter((address) => address.id !== req.params.id);
      if (next.length === addresses.length)
        throw new AppError(404, "ADDRESS_NOT_FOUND", "Address not found");
      store.addresses.set(req.principal!.sub, next);
    }
    return ok(res, { deleted: true }, "Address removed");
  });
  app.get("/api/v1/products", (req, res) => {
    const q = String(req.query.q || "").toLowerCase(),
      category = String(req.query.category || "");
    const data = store
      .listProducts()
      .filter(
        (x) =>
          x.status === "ACTIVE" &&
          (!q ||
            `${x.name} ${x.description} ${x.category}`
              .toLowerCase()
              .includes(q)) &&
          (!category || x.category === category),
      )
      .map(storefrontProductDto);
    return ok(res, data);
  });
  app.get("/api/v1/search/suggestions", (req, res) => {
    const query = String(req.query.q || "").trim().toLowerCase();
    if (query.length > 80)
      throw new AppError(400, "INVALID_SEARCH", "Search must be 80 characters or fewer");
    if (query.length < 2) return ok(res, []);

    const data = store
      .listProducts()
      .filter((product) => product.status === "ACTIVE")
      .map((product) => {
        const name = String(product.name || "").toLowerCase();
        const category = String(product.category || "").toLowerCase();
        const description = String(product.description || "").toLowerCase();
        const brand = String(product.brand || "").toLowerCase();
        const score = name.startsWith(query)
          ? 4
          : name.includes(query)
            ? 3
            : category.includes(query)
              ? 2
              : `${brand} ${description}`.includes(query)
                ? 1
                : 0;
        return { product, score };
      })
      .filter(({ score }) => score > 0)
      .sort((a, b) => b.score - a.score || a.product.name.localeCompare(b.product.name))
      .slice(0, 6)
      .map(({ product }) => {
        const detail = storefrontProductDto(product);
        return {
          id: detail.id,
          slug: detail.slug,
          name: detail.name,
          category: detail.category,
          image: detail.media.find((item) => item.type === "IMAGE")?.url || null,
          taxRate: detail.taxRate,
          price: detail.variants.length
            ? detail.variants.reduce(
                (lowest, variant) => Math.min(lowest, variant.price),
                Number.POSITIVE_INFINITY,
              )
            : 0,
        };
      });
    return ok(res, data);
  });
  app.get("/api/v1/products/:id", (req, res) => {
    const key = String(req.params.id);
    const product = store.products.get(key) || store.listProducts().find((candidate) => candidate.slug === key);
    if (!product || product.status !== "ACTIVE")
      throw new AppError(404, "PRODUCT_NOT_FOUND", "Product not found");
    return ok(res, storefrontProductDto(product));
  });
  app.get(
    "/api/v1/admin/products",
    auth,
    authorize("products:read"),
    (req, res) => {
      const status = String(req.query.status || "ALL").toUpperCase();
      if (!["ALL", "DRAFT", "ACTIVE", "ARCHIVED"].includes(status))
        throw new AppError(400, "INVALID_QUERY", "Unknown product status");
      const sortBy = String(req.query.sortBy || "updatedAt");
      if (!["updatedAt", "name", "inventory"].includes(sortBy))
        throw new AppError(400, "INVALID_QUERY", "Unknown product sort field");
      const sortOrder = String(req.query.sortOrder || "desc").toLowerCase();
      if (!["asc", "desc"].includes(sortOrder))
        throw new AppError(400, "INVALID_QUERY", "Unknown product sort order");
      return ok(
        res,
        listAdminProducts(store.listProducts(), {
          search: String(req.query.search || "").slice(0, 200),
          status: status as "ALL" | "DRAFT" | "ACTIVE" | "ARCHIVED",
          category: String(req.query.category || "").slice(0, 100),
          sortBy: sortBy as "updatedAt" | "name" | "inventory",
          sortOrder: sortOrder as "asc" | "desc",
          page: queryInteger(req.query.page, 1, 1, 1000),
          limit: queryInteger(req.query.limit, 25, 1, 100),
        }),
      );
    },
  );
  app.get(
    "/api/v1/admin/categories",
    auth,
    authorize("products:read"),
    (req, res) => {
      const search = String(req.query.search || "").trim().toLowerCase();
      const categories = new Map<
        string,
        { name: string; slug: string; productCount: number; activeProductCount: number }
      >();
      for (const product of store.listProducts()) {
        const key = product.category.toLowerCase();
        const current = categories.get(key) || {
          name: product.category,
          slug: product.category
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, "-")
            .replace(/^-|-$/g, ""),
          productCount: 0,
          activeProductCount: 0,
        };
        current.productCount++;
        if (product.status === "ACTIVE") current.activeProductCount++;
        categories.set(key, current);
      }
      return ok(res, {
        items: [...categories.values()]
          .filter(
            (category) =>
              !search ||
              `${category.name} ${category.slug}`.toLowerCase().includes(search),
          )
          .sort((left, right) => left.name.localeCompare(right.name)),
      });
    },
  );
  app.get(
    "/api/v1/admin/products/:id",
    auth,
    authorize("products:read"),
    (req, res) =>
      ok(
        res,
        adminProductDetailDto(store.getProduct(String(req.params.id))),
      ),
  );
  const customerReturnDto = (item: {
    id: string;
    orderId: string;
    reason: string;
    notes?: string | null;
    status: string;
    createdAt: string | Date;
    updatedAt?: string | Date;
    items?: Array<{
      id: string;
      variantId: string;
      name: string;
      sku: string;
      quantity: number;
      condition?: string | null;
    }>;
  }) => ({
    id: item.id,
    orderId: item.orderId,
    reason: item.reason,
    notes: item.notes || null,
    status: item.status,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt || item.createdAt,
    items: (item.items || []).map((entry) => ({
      id: entry.id,
      variantId: entry.variantId,
      name: entry.name,
      sku: entry.sku,
      quantity: entry.quantity,
      condition: entry.condition || null,
    })),
  });
  app.post(
    "/api/v1/admin/products",
    auth,
    authorize("products:create"),
    validate(productSchema),
    async (req, res) => {
      const variants = req.body.variants.map(
        (entry: Record<string, unknown>) => ({
          ...entry,
          id: String(entry.id || crypto.randomUUID()),
          active: entry.active !== false,
          reserved: 0,
        }),
      );
      if (
        req.body.status === "ACTIVE" &&
        !variants.some((variant: { active: boolean }) => variant.active)
      )
        throw new AppError(
          409,
          "ACTIVE_VARIANT_REQUIRED",
          "An active product must have at least one active variant",
        );
      const variantIds = new Set(variants.map((variant: { id: string }) => variant.id));
      const media = (req.body.media || [])
        .slice()
        .sort(
          (left: { position: number }, right: { position: number }) =>
            left.position - right.position,
        )
        .map((entry: Record<string, unknown>, position: number) => {
          if (entry.variantId && !variantIds.has(String(entry.variantId)))
            throw new AppError(
              400,
              "MEDIA_VARIANT_INVALID",
              "Product media can only be assigned to a variant in this product",
            );
          return {
            ...entry,
            id: String(entry.id || crypto.randomUUID()),
            position,
          };
        });
      const product = store.saveProduct({ ...req.body, media, variants });
      try {
        await persistence?.saveProduct(product);
      } catch (error) {
        store.products.delete(product.id);
        throw error;
      }
      return ok(res, adminProductDetailDto(product), "Product created", 201);
    },
  );
  app.post(
    "/api/v1/admin/products/:id/media/upload",
    auth,
    authorize("products:update"),
    productImageUpload,
    async (req, res) => {
      const product = store.getProduct(String(req.params.id));
      if (!req.file)
        throw new AppError(400, "IMAGE_REQUIRED", "Choose an image to upload");
      const variantId = String(req.body.variantId || "");
      if (
        variantId &&
        !product.variants.some((variant) => variant.id === variantId)
      )
        throw new AppError(
          400,
          "MEDIA_VARIANT_INVALID",
          "Product media can only be assigned to a variant in this product",
        );
      const converted = await convertProductImage(
          req.file.buffer,
          config.UPLOAD_DIR,
          config.PUBLIC_UPLOAD_BASE_URL,
        ),
        media = {
          id: crypto.randomUUID(),
          url: converted.url,
          alt:
            String(req.body.alt || product.name)
              .trim()
              .slice(0, 200) || product.name,
          type: "IMAGE" as const,
          position: Number.isFinite(Number(req.body.position))
            ? Math.max(
                0,
                Math.min(product.media.length, Math.trunc(Number(req.body.position))),
              )
            : product.media.length,
          ...(variantId ? { variantId } : {}),
        };
      const orderedIds = product.media.map((item) => item.id);
      orderedIds.splice(media.position, 0, media.id);
      try {
        await persistence?.addProductMedia({
          id: media.id,
          productId: product.id,
          url: media.url,
          alt: media.alt,
          position: media.position,
          variantId: media.variantId,
        }, orderedIds);
      } catch (error) {
        await removeConvertedProductImage(
          media.url,
          config.UPLOAD_DIR,
          config.PUBLIC_UPLOAD_BASE_URL,
        ).catch(() => undefined);
        throw error;
      }
      product.media.splice(media.position, 0, media);
      product.media.forEach((item, position) => (item.position = position));
      product.updatedAt = new Date().toISOString();
      return ok(
        res,
        { media, ...converted },
        "Image converted to WebP and attached",
        201,
      );
    },
  );
  app.put(
    "/api/v1/admin/products/:id/media/order",
    auth,
    authorize("products:update"),
    validate(productMediaOrderSchema),
    async (req, res) => {
      const product = store.getProduct(String(req.params.id));
      const requested = req.body.mediaIds as string[];
      if (
        new Set(requested).size !== requested.length ||
        requested.length !== product.media.length ||
        requested.some(
          (id) => !product.media.some((candidate) => candidate.id === id),
        )
      )
        throw new AppError(
          400,
          "MEDIA_ORDER_INVALID",
          "Media ordering must contain every current media id exactly once",
        );
      await persistence?.reorderProductMedia(product.id, requested);
      const positions = new Map(requested.map((id, position) => [id, position]));
      product.media.sort(
        (left, right) => positions.get(left.id)! - positions.get(right.id)!,
      );
      product.media.forEach((item, position) => (item.position = position));
      product.updatedAt = new Date().toISOString();
      return ok(res, adminProductDetailDto(product).media, "Media reordered");
    },
  );
  app.patch(
    "/api/v1/admin/products/:id/media/:mediaId",
    auth,
    authorize("products:update"),
    validate(productMediaUpdateSchema),
    async (req, res) => {
      const product = store.getProduct(String(req.params.id));
      const media = product.media.find(
        (candidate) => candidate.id === String(req.params.mediaId),
      );
      if (!media)
        throw new AppError(404, "MEDIA_NOT_FOUND", "Product media not found");
      if (
        req.body.variantId &&
        !product.variants.some(
          (variant) => variant.id === String(req.body.variantId),
        )
      )
        throw new AppError(
          400,
          "MEDIA_VARIANT_INVALID",
          "Product media can only be assigned to a variant in this product",
        );
      await persistence?.updateProductMedia(product.id, media.id, req.body);
      if (req.body.alt !== undefined) media.alt = req.body.alt;
      if (req.body.variantId === null) delete media.variantId;
      else if (req.body.variantId !== undefined)
        media.variantId = req.body.variantId;
      product.updatedAt = new Date().toISOString();
      return ok(res, media, "Media updated");
    },
  );
  app.delete(
    "/api/v1/admin/products/:id/media/:mediaId",
    auth,
    authorize("products:update"),
    async (req, res) => {
      const product = store.getProduct(String(req.params.id));
      const index = product.media.findIndex(
        (candidate) => candidate.id === String(req.params.mediaId),
      );
      if (index < 0)
        throw new AppError(404, "MEDIA_NOT_FOUND", "Product media not found");
      const media = product.media[index]!;
      await persistence?.deleteProductMedia(product.id, media.id);
      product.media.splice(index, 1);
      product.media.forEach((item, position) => (item.position = position));
      product.updatedAt = new Date().toISOString();
      await persistence?.reorderProductMedia(
        product.id,
        product.media.map((item) => item.id),
      );
      try {
        await removeConvertedProductImage(
          media.url,
          config.UPLOAD_DIR,
          config.PUBLIC_UPLOAD_BASE_URL,
        );
      } catch (error) {
        req.log.warn(
          { err: error, mediaId: media.id },
          "Could not remove generated product image files",
        );
      }
      return ok(res, { id: media.id, deleted: true }, "Media removed");
    },
  );
  app.put(
    "/api/v1/admin/products/:id",
    auth,
    authorize("products:update"),
    validate(productSchema),
    async (req, res) => {
      const existing = store.getProduct(String(req.params.id));
      const usedVariantIds = new Set<string>();
      const variants = req.body.variants.map(
        (entry: Record<string, unknown>) => {
          const requestedId = entry.id ? String(entry.id) : undefined;
          const current = requestedId
            ? existing.variants.find((variant) => variant.id === requestedId)
            : existing.variants.find(
                (variant) =>
                  !usedVariantIds.has(variant.id) &&
                  variant.sku.toLowerCase() === String(entry.sku).toLowerCase(),
              );
          if (requestedId && !current)
            throw new AppError(
              400,
              "VARIANT_ID_INVALID",
              "A submitted variant id does not belong to this product",
            );
          const id = current?.id || crypto.randomUUID();
          if (usedVariantIds.has(id))
            throw new AppError(
              409,
              "DUPLICATE_VARIANT",
              "Each product variant can only be submitted once",
            );
          usedVariantIds.add(id);
          return {
            ...entry,
            id,
            active: entry.active !== false,
            stock: current?.stock ?? Number(entry.stock),
            reserved: current?.reserved ?? 0,
          };
        },
      );
      for (const variant of existing.variants) {
        if (!usedVariantIds.has(variant.id))
          variants.push({ ...variant, active: false });
      }
      if (
        req.body.status === "ACTIVE" &&
        !variants.some((variant: { active: boolean }) => variant.active)
      )
        throw new AppError(
          409,
          "ACTIVE_VARIANT_REQUIRED",
          "An active product must have at least one active variant",
        );
      const variantIds = new Set(
        variants.map((variant: { id: string }) => variant.id),
      );
      const media =
        req.body.media === undefined
          ? existing.media
          : req.body.media
              .slice()
              .sort(
                (left: { position: number }, right: { position: number }) =>
                  left.position - right.position,
              )
              .map((entry: Record<string, unknown>, position: number) => {
                if (
                  entry.id &&
                  !existing.media.some((candidate) => candidate.id === entry.id)
                )
                  throw new AppError(
                    400,
                    "MEDIA_ID_INVALID",
                    "A submitted media id does not belong to this product",
                  );
                if (entry.variantId && !variantIds.has(String(entry.variantId)))
                  throw new AppError(
                    400,
                    "MEDIA_VARIANT_INVALID",
                    "Product media can only be assigned to a variant in this product",
                  );
                return {
                  ...entry,
                  id: String(entry.id || crypto.randomUUID()),
                  position,
                };
              });
      const product = store.saveProduct(
        { ...req.body, media, variants },
        String(req.params.id),
      );
      try {
        await persistence?.saveProduct(product);
      } catch (error) {
        store.products.set(existing.id, existing);
        throw error;
      }
      return ok(res, adminProductDetailDto(product), "Product updated");
    },
  );
  app.delete(
    "/api/v1/admin/products/:id",
    auth,
    authorize("products:delete"),
    async (req, res) => {
      const existing = store.getProduct(String(req.params.id));
      const product = store.deleteProduct(existing.id);
      try {
        await persistence?.archiveProduct(product.id);
      } catch (error) {
        store.products.set(existing.id, existing);
        throw error;
      }
      return ok(res, adminProductDetailDto(product), "Product archived");
    },
  );
  const cartKey = (req: express.Request, res: express.Response) => {
    if (req.principal) return `user:${req.principal.sub}`;
    const supplied = String(req.headers["x-cart-token"] || "");
    const token = /^[a-f0-9-]{36}$/.test(supplied)
      ? supplied
      : crypto.randomUUID();
    res.setHeader("x-cart-token", token);
    return `guest:${token}`;
  };
  app.get(
    "/api/v1/cart",
    optionalAuth,
    async (req, res) => {
      const key = cartKey(req, res),
        items = store.carts.get(key) || new Map<string, number>();
      return ok(
        res,
        [...items].flatMap(([variantId, quantity]) => {
          const product = store.listProducts().find(candidate => candidate.status === "ACTIVE" && candidate.variants.some(variant => variant.id === variantId && variant.active));
          if (!product) return [];
          const visible = storefrontProductDto(product);
          return [{
            product: visible,
            variant: visible.variants.find(variant => variant.id === variantId),
            variantId,
            quantity,
          }];
        }),
      );
    },
  );
  app.put(
    "/api/v1/cart/items",
    optionalAuth,
    validate(cartItemSchema),
    async (req, res) => {
      const key = cartKey(req, res),
        items = store.carts.get(key) || new Map<string, number>();
      if (req.body.quantity === 0) {
        await persistence?.saveCartItem(key, req.body.variantId, 0);
        items.delete(req.body.variantId); store.carts.set(key, items);
        return ok(res, { variantId: req.body.variantId, quantity: 0 }, "Cart updated");
      }
      const { product, variant } = store.getVariant(req.body.variantId);
      if (
        req.body.quantity > 0 &&
        (product.status !== "ACTIVE" || !variant.active)
      )
        throw new AppError(
          409,
          "PRODUCT_UNAVAILABLE",
          `${product.name} is no longer available`,
        );
      if (req.body.quantity > variant.stock - variant.reserved)
        throw new AppError(
          409,
          "INSUFFICIENT_STOCK",
          `Insufficient stock for ${variant.sku}`,
        );
      if (req.body.quantity === 0) items.delete(req.body.variantId);
      else items.set(req.body.variantId, req.body.quantity);
      store.carts.set(key, items);
      await persistence?.saveCartItem(
        key,
        req.body.variantId,
        req.body.quantity,
      );
      return ok(
        res,
        { variantId: req.body.variantId, quantity: req.body.quantity },
        "Cart updated",
      );
    },
  );
  app.get("/api/v1/wishlist", auth, (req, res) =>
    ok(
      res,
      [...(store.wishlists.get(req.principal!.sub) || new Set())].flatMap(id => {
        const product = store.products.get(id);
        return product?.status === "ACTIVE" && product.variants.some(variant => variant.active) ? [storefrontProductDto(product)] : [];
      }),
    ),
  );
  app.put("/api/v1/wishlist/:productId", auth, async (req, res) => {
    const id = String(req.params.productId);
    const product = store.getProduct(id);
    if (product.status !== "ACTIVE" || !product.variants.some(variant => variant.active)) throw new AppError(404, "PRODUCT_NOT_FOUND", "Product not found");
    const list = store.wishlists.get(req.principal!.sub) || new Set<string>();
    list.add(id);
    store.wishlists.set(req.principal!.sub, list);
    await persistence?.saveWishlist(req.principal!.sub, id, true);
    return ok(res, { productId: id, saved: true }, "Saved to wishlist");
  });
  app.delete("/api/v1/wishlist/:productId", auth, async (req, res) => {
    const id = String(req.params.productId),
      list = store.wishlists.get(req.principal!.sub) || new Set<string>();
    list.delete(id);
    await persistence?.saveWishlist(req.principal!.sub, id, false);
    return ok(res, { productId: id, saved: false }, "Removed from wishlist");
  });
  const couponCartLines = (input: Array<{ variantId: string; quantity: number }>) => {
    const quantities = new Map<string, number>();
    for (const line of input) quantities.set(line.variantId, (quantities.get(line.variantId) || 0) + line.quantity);
    if ([...quantities.values()].some(quantity => quantity > 20))
      throw new AppError(422, "VARIANT_QUANTITY_LIMIT", "A single product option cannot exceed 20 units");
    return input.map(line => {
      const { product, variant } = store.getVariant(line.variantId);
      if (product.status !== "ACTIVE" || !variant.active)
        throw new AppError(409, "PRODUCT_UNAVAILABLE", `${product.name} is no longer available`);
      if (variant.stock - variant.reserved < quantities.get(variant.id)!)
        throw new AppError(409, "INSUFFICIENT_STOCK", `Insufficient stock for ${variant.sku}`);
      return { productId: product.id, unitPrice: variant.price, quantity: line.quantity };
    });
  };
  app.post("/api/v1/coupons/validate", optionalAuth, validate(couponValidationSchema), async (req, res) => {
    const code = String(req.body?.code || "").toUpperCase(),
      coupon = store.coupons.get(code);
    const benefit = couponBenefit(coupon, couponCartLines(req.body.lines));
    if (req.principal && persistence) {
      const usage = await persistence.couponUsageForUser(code, req.principal.sub);
      if (usage && usage.used >= usage.limit)
        throw new AppError(422, "COUPON_USER_LIMIT_REACHED", "You have already used this coupon");
    }
    return ok(
      res,
      { code, ...benefit },
      "Coupon applied",
    );
  });
  app.put(
    "/api/v1/admin/coupons",
    auth,
    authorize("marketing:update"),
    validate(couponSchema),
    async (req, res) => {
      const coupon = {
        ...req.body,
        productIds: req.body.appliesTo === "SELECTED_PRODUCTS" ? req.body.productIds : [],
        startsAt: req.body.startsAt.getTime(),
        endsAt: req.body.endsAt.getTime(),
        used: store.coupons.get(req.body.code)?.used || 0,
      };
      if (coupon.productIds.some((id: string) => !store.products.has(id)))
        throw new AppError(400, "COUPON_PRODUCT_NOT_FOUND", "One or more selected products no longer exist");
      await persistence?.saveCoupon(coupon);
      store.coupons.set(coupon.code, coupon);
      store.auditLogs.unshift({ id: crypto.randomUUID(), action: "coupon.saved", resource: "Coupon", resourceId: coupon.code, actorId: req.principal!.sub, createdAt: new Date().toISOString() });
      return ok(res, coupon, "Coupon saved");
    },
  );
  app.delete(
    "/api/v1/admin/coupons/:code",
    auth,
    authorize("marketing:update"),
    async (req, res) => {
      const code = String(req.params.code || "").trim().toUpperCase();
      const coupon = store.coupons.get(code);
      if (!coupon) throw new AppError(404, "COUPON_NOT_FOUND", "Coupon not found");
      coupon.enabled = false;
      await persistence?.archiveCoupon(code);
      store.auditLogs.unshift({ id: crypto.randomUUID(), action: "coupon.archived", resource: "Coupon", resourceId: code, actorId: req.principal!.sub, createdAt: new Date().toISOString() });
      return ok(res, coupon, "Coupon archived");
    },
  );
  const calculateCheckoutQuote = async (
    input: {
      lines: Array<{ variantId: string; quantity: number }>;
      postalCode: string;
      couponCode?: string;
      paymentProvider: string;
      shippingService?: string;
    },
    deliverySettings: StorefrontConfig,
  ) => {
    const isCod = input.paymentProvider.toLowerCase() === "cod";
    if (isCod && !deliverySettings.codEnabled)
      throw new AppError(409, "COD_DISABLED", "Cash on delivery is currently unavailable. Choose an available online payment method.");
    const paymentProvider = isCod ? null : resolvePaymentProvider(input.paymentProvider);
    const onlineOfferEligible = paymentProvider instanceof CashfreePaymentProvider || paymentProvider instanceof RazorpayPaymentProvider;
    const quantities = new Map<string, number>();
    for (const line of input.lines)
      quantities.set(
        line.variantId,
        (quantities.get(line.variantId) || 0) + line.quantity,
      );
    if ([...quantities.values()].some((quantity) => quantity > 20))
      throw new AppError(
        422,
        "VARIANT_QUANTITY_LIMIT",
        "A single product option cannot exceed 20 units",
      );

    let subtotal = 0,
      tax = 0,
      weight = 0;
    const lines = input.lines.map((line) => {
      const { product, variant } = store.getVariant(line.variantId);
      if (product.status !== "ACTIVE" || !variant.active)
        throw new AppError(
          409,
          "PRODUCT_UNAVAILABLE",
          `${product.name} is no longer available`,
        );
      if (
        variant.stock - variant.reserved <
        (quantities.get(variant.id) || line.quantity)
      )
        throw new AppError(
          409,
          "INSUFFICIENT_STOCK",
          `Insufficient stock for ${variant.sku}`,
        );
      const lineTax =
        (variant.price * line.quantity * product.taxRate) / 100;
      subtotal += variant.price * line.quantity;
      tax += lineTax;
      weight += variant.weightGrams * line.quantity;
      return {
        variantId: variant.id,
        name: product.name,
        sku: variant.sku,
        quantity: line.quantity,
        unitPrice: variant.price,
        tax: lineTax,
      };
    });

    const shippingProvider = resolveShippingProvider(undefined, deliverySettings);
    const providerRates = await shippingProvider.provider.rates({
      origin: shippingProvider.origin,
      destination: input.postalCode,
      weightGrams: weight,
      cod: input.paymentProvider.toLowerCase() === "cod",
    });
    if (!providerRates.length)
      throw new AppError(
        422,
        "PINCODE_NOT_SERVICEABLE",
        "No delivery service is available for this PIN code",
      );
    const selectedRate = input.shippingService
      ? providerRates.find((rate) => rate.service === input.shippingService)
      : providerRates[0];
    if (!selectedRate)
      throw new AppError(
        422,
        "SHIPPING_SERVICE_UNAVAILABLE",
        "The selected delivery service is no longer available",
      );

    const coupon = input.couponCode
        ? store.coupons.get(input.couponCode.trim().toUpperCase())
        : undefined;
    const benefit = input.couponCode ? couponBenefit(coupon, couponCartLines(input.lines)) : undefined;
    const couponDiscount = benefit?.discount || 0,
      freeShipping =
        benefit?.freeShipping ||
        freeDeliveryQualifies(deliverySettings, subtotal),
      shippingAmount = freeShipping ? 0 : selectedRate.amount.amount,
      roundedTax = Math.round(tax * 100) / 100,
      onlineDiscount = onlinePaymentDiscount(deliverySettings, onlineOfferEligible, subtotal, couponDiscount, shippingAmount + roundedTax),
      discount = Math.round((couponDiscount + onlineDiscount) * 100) / 100,
      total =
        Math.round(
          (subtotal + roundedTax + shippingAmount - discount) * 100,
        ) / 100,
      rates = providerRates.map((rate) => {
        const shipping = freeShipping ? 0 : rate.amount.amount;
        const rateDiscount = couponDiscount + onlinePaymentDiscount(deliverySettings, onlineOfferEligible, subtotal, couponDiscount, shipping + roundedTax);
        return {
          service: rate.service,
          label: rate.label,
          etaDays: rate.etaDays,
          etaMinDays: rate.etaMinDays,
          baseAmount: rate.amount.amount,
          shipping,
          currency: rate.amount.currency,
          total:
            Math.round((subtotal + roundedTax + shipping - rateDiscount) * 100) /
            100,
        };
      });
    if (paymentProvider instanceof CashfreePaymentProvider && total < 1)
      throw new AppError(422, "ORDER_TOTAL_TOO_LOW", "Online payment requires at least ₹1 payable. Remove the coupon or contact the store.");
    return {
      lines,
      coupon,
      provider: shippingProvider.name,
      rates,
      selectedShipping: {
        service: selectedRate.service,
        label: selectedRate.label,
        etaDays: selectedRate.etaDays,
        etaMinDays: selectedRate.etaMinDays,
        quotedAmount: selectedRate.amount.amount,
        chargedAmount: shippingAmount,
        currency: selectedRate.amount.currency,
      },
      subtotal,
      tax: roundedTax,
      discount,
      couponDiscount,
      onlinePaymentDiscount: onlineDiscount,
      onlinePaymentOffer: onlineDiscount > 0 ? { type: deliverySettings.onlinePaymentDiscountType, value: deliverySettings.onlinePaymentDiscountValue } : null,
      shipping: shippingAmount,
      total,
      currency: selectedRate.amount.currency,
      freeShipping,
    };
  };
  app.get("/api/v1/payments/providers", async (req, res) => {
    const settings = await readStorefront(requestHostname(req));
    let enabled = false;
    try { resolvePaymentProvider("cashfree"); enabled = true; } catch { /* Configuration is optional until enabled by the merchant. */ }
    let shippingEnabled = false;
    try { resolveShippingProvider(undefined, settings); shippingEnabled = true; } catch { /* Checkout stays closed until delivery is configured. */ }
    return ok(res, {
      cashfree: { enabled: enabled && shippingEnabled },
      cod: { enabled: shippingEnabled && settings.codEnabled },
      checkout: { enabled: shippingEnabled && (settings.codEnabled || enabled) },
    });
  });
  app.post(
    "/api/v1/checkout/quote",
    limiter(30, 60_000),
    validate(checkoutQuoteSchema),
    async (req, res) => {
      const storefront = await readStorefront(requestHostname(req));
      const { lines: _lines, coupon: _coupon, ...quote } =
        await calculateCheckoutQuote(
          req.body,
          storefront,
        );
      return ok(res, quote, "Checkout quote calculated");
    },
  );
  app.post(
    "/api/v1/checkout",
    limiter(20, 60_000),
    optionalAuth,
    validate(checkoutSchema),
    async (req, res, next) => {
      let reserved = false,
        accepted = false,
        createdOrderId: string | undefined;
      try {
        const key = String(req.headers["idempotency-key"] || "");
        if (key.length < 8 || key.length > 100)
          throw new AppError(
            400,
            "IDEMPOTENCY_KEY_REQUIRED",
            "A valid Idempotency-Key header is required",
          );
        const checkoutScope =
          req.principal?.sub ||
          `guest:${req.ip}:${String(
            req.body.contact.email || req.body.contact.phone,
          )
            .trim()
            .toLowerCase()}`;
        const keyPrefix = crypto
          .createHash("sha256")
          .update(`${checkoutScope}:${key}`)
          .digest("hex");
        const requestHash = crypto
          .createHash("sha256")
          .update(JSON.stringify(req.body))
          .digest("hex");
        const duplicate = store.findOrderByKey(keyPrefix);
        if (duplicate) {
          if (duplicate.idempotencyKey !== `${keyPrefix}.${requestHash}`)
            throw new AppError(
              409,
              "IDEMPOTENCY_CONFLICT",
              "This idempotency key was already used for a different checkout request",
            );
          return ok(
            res,
            {
              order: checkoutOrderDto(duplicate),
              payment: paymentAttemptDto(duplicate.payment),
              paymentAttemptToken: duplicate.payment
                ? issuePaymentAttemptToken(
                    duplicate.id,
                    duplicate.number,
                    duplicate.payment.externalId,
                  )
                : null,
            },
            "Existing order returned",
          );
        }
        const storefront = await readStorefront(requestHostname(req));
        const quote = await calculateCheckoutQuote(
          req.body,
          storefront,
        );
        if (quote.provider === "manual" && req.body.shippingAddress.country !== "IN")
          throw new AppError(422, "DELIVERY_COUNTRY_NOT_SUPPORTED", "Delivery is available within India");
        if (req.body.expectedTotal !== undefined && Math.abs(req.body.expectedTotal - quote.total) > 0.001)
          throw new AppError(409, "CHECKOUT_PRICE_CHANGED", "Order pricing has changed. Review the updated total before placing your order.");
        const {
          lines,
          coupon,
          provider: shippingProviderName,
          rates,
          selectedShipping,
          subtotal,
          tax,
          discount,
          shipping: shippingAmount,
          total,
        } = quote;
        const shippingSelection = {
          provider: shippingProviderName,
          ...selectedShipping,
          quotedAt: new Date().toISOString(),
        };
        store.reserveMany(req.body.lines);
        reserved = true;
        const isCod = req.body.paymentProvider.toLowerCase() === "cod";
        const order = store.createOrder({
          userId: req.principal?.sub,
          status: isCod ? "CONFIRMED" : "PAYMENT_PENDING",
          inventoryState: "RESERVED",
          lines,
          subtotal,
          tax,
          shipping: shippingAmount,
          discount,
          total,
          idempotencyKey: `${keyPrefix}.${requestHash}`,
          shippingSelection,
          trackingVerificationHash: crypto
            .createHash("sha256")
            .update(
              String(req.body.contact.email || req.body.contact.phone)
                .trim()
                .toLowerCase(),
            )
            .digest("hex"),
          invoiceSnapshot: {
            contact: req.body.contact,
            shipping: {
              ...req.body.shippingAddress,
              postalCode: req.body.postalCode,
            },
            gstin: req.body.gstin,
            paymentMethod: req.body.paymentProvider.toLowerCase(),
            discounts: { coupon: quote.couponDiscount, couponFreeShipping: quote.coupon?.type === "FREE_SHIPPING", onlinePayment: quote.onlinePaymentDiscount, onlineOffer: quote.onlinePaymentOffer || undefined },
            shippingSelection,
          },
        });
        createdOrderId = order.id;
        if (isCod) store.commitOrderInventory(order);
        let payment: null | { externalId: string; clientToken?: string } = null,
          paymentFailure:
            | {
                code: string;
                message: string;
                retryable: boolean;
              fallbackOptions: string[];
              recommendedAction?: string;
              retryAfterSeconds?: number;
              }
            | undefined;
        if (!isCod)
          try {
            payment = await resolvePaymentProvider(
              req.body.paymentProvider,
            ).createOrder({
              orderId: order.id,
              customer: req.body.contact,
              amount: { amount: total, currency: "INR" },
              idempotencyKey: `pay:${keyPrefix}`,
            });
          } catch (error) {
            if (
              !(error instanceof AppError) ||
              error.code !== "PAYMENT_PROVIDER_ERROR"
            )
              throw error;
            const details = (error.details || {}) as Record<string, unknown>;
            paymentFailure = {
              code: String(details.category || error.code),
              message: String(
                details.customerMessage ||
                  "The selected payment gateway is unavailable. Your order is saved safely.",
              ),
              retryable: Boolean(details.retryable),
              recommendedAction: String(
                details.recommendedAction || "CHANGE_METHOD",
              ),
              retryAfterSeconds:
                typeof details.retryAfterSeconds === "number"
                  ? details.retryAfterSeconds
                  : undefined,
              fallbackOptions: Boolean(details.retryable)
                ? ["retry", "change_method"]
                : ["change_method"],
            };
            order.payment = {
              externalId: `unavailable:${order.id}`,
              provider: req.body.paymentProvider,
              status: "FAILED",
              amount: order.total,
              currency: "INR",
              refundedAmount: 0,
              refunds: [],
              lastError: {
                code: paymentFailure.code,
                description: paymentFailure.message,
              },
            };
          }
        if (payment)
          order.payment = {
            ...payment,
            provider: req.body.paymentProvider,
            status: "CREATED",
            amount: order.total,
            currency: "INR",
            refundedAmount: 0,
            refunds: [],
          };
        else if (isCod) order.payment = null;
        await persistence?.saveOrderAndReservations(
          order,
          {
            contact: req.body.contact,
            shipping: {
              ...req.body.shippingAddress,
              postalCode: req.body.postalCode,
            },
            billing: req.body.billingAddress || {
              ...req.body.shippingAddress,
              postalCode: req.body.postalCode,
            },
            gstin: req.body.gstin,
            deliveryInstructions: req.body.deliveryInstructions,
            paymentMethod: req.body.paymentProvider.toLowerCase(),
            discounts: order.invoiceSnapshot?.discounts,
            shippingSelection: order.shippingSelection,
          },
          req.body.paymentProvider,
          req.body.couponCode,
          payment?.externalId,
          await readStorefront(requestHostname(req)),
        );
        accepted = true;
        if (coupon) coupon.used++;
        return ok(
          res,
          {
            order: checkoutOrderDto(order),
            payment,
            paymentAttemptToken: !isCod
              ? issuePaymentAttemptToken(
                  order.id,
                  order.number,
                  order.payment?.externalId,
                )
              : null,
            paymentFailure,
            fallbackOptions: paymentFailure?.fallbackOptions || [],
            shipping: selectedShipping,
            rates,
            price: {
              subtotal,
              tax,
              discount,
              shipping: shippingAmount,
              total,
              currency: quote.currency,
              freeShipping: quote.freeShipping,
            },
          },
          paymentFailure
            ? "Order saved; payment requires another attempt"
            : "Checkout created",
          paymentFailure ? 202 : 201,
        );
      } catch (e) {
        if (!accepted) {
          const failedOrder = createdOrderId ? store.orders.get(createdOrderId) : undefined;
          // COD has already committed its reservation in memory. Restore those
          // units only when checkout failed before durable acceptance.
          if (failedOrder) store.cancelOrderInventory(failedOrder);
          else if (reserved) store.releaseMany(req.body.lines);
          if (createdOrderId) store.orders.delete(createdOrderId);
        }
        next(e);
      }
    },
  );
  app.post(
    "/api/v1/payments/client-events",
    limiter(20, 60000),
    validate(paymentClientEventSchema),
    async (req, res) => {
      const order = [...store.orders.values()].find(
        (item) =>
          item.number === req.body.orderNumber &&
          item.payment?.externalId === req.body.providerOrderId,
      );
      if (!order || !order.payment)
        throw new AppError(
          404,
          "PAYMENT_NOT_FOUND",
          "Payment attempt was not found",
        );
      verifyPaymentAttemptToken(req.body.attemptToken, {
        orderId: order.id,
        orderNumber: order.number,
        providerOrderId: order.payment.externalId,
      });
      const failureAdvice = classifyGatewayFailure(
        req.body.type === "CANCELLED" ? 400 : 402,
        req.body.errorCode,
        req.body.type === "CANCELLED"
          ? "customer_cancelled"
          : req.body.errorDescription,
      );
      const eventInput = {
        ...req.body,
        providerErrorCode: req.body.errorCode,
        errorCode: failureAdvice.category,
        errorDescription: failureAdvice.customerMessage,
        failureAdvice,
      };
      if (persistence) {
        await persistence.recordPaymentClientEvent(eventInput);
        const refreshed = await persistence.refreshOrder(store, order.id);
        return ok(
          res,
          {
            ...paymentAttemptDto(refreshed?.payment),
            failureAdvice,
          },
          "Payment attempt recorded",
        );
      }
      // The popup can report cancellation after a signed payment capture has
      // arrived. A browser event must never undo a verified gateway result.
      if (["CAPTURED", "REFUNDED", "PARTIALLY_REFUNDED"].includes(order.payment.status || ""))
        return ok(res, paymentAttemptDto(order.payment), "Verified payment status retained");
      order.payment.status = req.body.type;
      order.payment.gatewayTransactionId = req.body.gatewayPaymentId;
      order.payment.lastError = {
        code: failureAdvice.category,
        description: failureAdvice.customerMessage,
      };
      store.auditLogs.unshift({
        id: crypto.randomUUID(),
        action: `payment.${req.body.type.toLowerCase()}`,
        resource: "payment",
        resourceId: order.payment.externalId,
        after: {
          gatewayTransactionId: req.body.gatewayPaymentId,
          errorCode: failureAdvice.category,
          providerErrorCode: req.body.errorCode,
          failureAdvice,
        },
        createdAt: new Date().toISOString(),
      });
      return ok(
        res,
        { ...paymentAttemptDto(order.payment), failureAdvice },
        "Payment attempt recorded",
      );
    },
  );
  app.post("/api/v1/payments/verify", limiter(20, 60000), validate(paymentRetrySchema), async (req, res) => {
    const order = [...store.orders.values()].find(item => item.number === req.body.orderNumber);
    if (!order?.payment?.externalId) throw new AppError(404, "PAYMENT_NOT_FOUND", "Payment was not found");
    verifyPaymentAttemptToken(req.body.attemptToken, { orderId: order.id, orderNumber: order.number });
    const payment = order.payment;
    if (!["PAYMENT_PENDING", "FAILED"].includes(order.status)) return ok(res, { status: payment.status, orderStatus: order.status });
    const status = await resolvePaymentProvider(payment.provider || "cashfree").lookup(payment.externalId!);
    if (status.status === "CAPTURED") {
      if (!status.gatewayPaymentId || !Number.isFinite(status.amount) || Math.round(status.amount! * 100) !== Math.round(order.total * 100) || status.currency !== (payment.currency || "INR")) throw new AppError(422, "PAYMENT_VALUE_MISMATCH", "Payment amount or currency does not match");
      if (persistence) {
        const bound = await persistence.resolvePaymentWebhook(payment.provider || "cashfree", payment.externalId!);
        await persistence.reconcilePayment(bound.paymentId, status);
        // Commit the running catalog's reservation before replacing the order
        // with its persisted PAID snapshot, which is already marked committed.
        if (store.orders.get(order.id)?.status === "PAYMENT_PENDING")
          store.transitionOrder(order.id, "PAID", undefined, "GATEWAY_VERIFICATION");
        await persistence.refreshOrder(store, order.id);
      } else {
        payment.status = "CAPTURED";
        payment.gatewayTransactionId = status.gatewayPaymentId;
        store.transitionOrder(order.id, "PAID", undefined, "GATEWAY_VERIFICATION");
      }
    }
    return ok(res, { status: store.orders.get(order.id)?.payment?.status || status.status, orderStatus: store.orders.get(order.id)?.status });
  });
  app.post(
    "/api/v1/payments/retry",
    limiter(5, 60000),
    validate(paymentRetrySchema),
    async (req, res) => {
      const order = [...store.orders.values()].find(
          (item) => item.number === req.body.orderNumber,
        ),
        currentPayment = order?.payment;
      if (
        !order ||
        !["PAYMENT_PENDING", "FAILED"].includes(order.status) ||
        !currentPayment
      )
        throw new AppError(
          404,
          "ORDER_NOT_FOUND",
          "Pending order was not found",
        );
      verifyPaymentAttemptToken(req.body.attemptToken, {
        orderId: order.id,
        orderNumber: order.number,
      });
      if (req.body.provider.toLowerCase() === "cod")
        throw new AppError(400, "INVALID_PAYMENT_METHOD", "A pending online order must be paid using an online payment method");
      const releasedFailure = order.status === "FAILED";
      if (releasedFailure) {
        await persistence?.transitionOrder(order.id, "FAILED", "PAYMENT_PENDING", undefined, "PAYMENT_RETRY");
        store.transitionOrder(order.id, "PAYMENT_PENDING", undefined, "PAYMENT_RETRY");
      }
      const provider = resolvePaymentProvider(req.body.provider),
        missingGatewayOrder = !currentPayment.externalId || currentPayment.externalId.startsWith("unavailable:"),
        // A timeout may have created the gateway order without returning its
        // session. Reuse the original create key to recover that same order.
        attemptKey = provider instanceof CashfreePaymentProvider && currentPayment.provider === "cashfree" && missingGatewayOrder
          ? `pay:${order.idempotencyKey.split(".")[0]}`
          : `retry:${order.id}:${crypto.randomUUID()}`;
      if (provider instanceof CashfreePaymentProvider && currentPayment.provider === "cashfree" && currentPayment.externalId && !missingGatewayOrder) {
        const resumed = await provider.resumeOrder(currentPayment.externalId);
        if (resumed) {
          Object.assign(currentPayment, resumed);
          return ok(res, { order: { number: order.number, status: order.status }, payment: paymentAttemptDto(currentPayment), paymentAttemptToken: issuePaymentAttemptToken(order.id, order.number, resumed.externalId) }, "Existing payment session resumed");
        }
      }
      let payment: Awaited<ReturnType<typeof provider.createOrder>>;
      try {
        payment = await provider.createOrder({
          orderId: order.id,
          customer: order.invoiceSnapshot?.contact as { name: string; email: string; phone: string },
          amount: { amount: order.total, currency: "INR" },
          idempotencyKey: attemptKey,
        });
      } catch (error) {
        if (releasedFailure) {
          await persistence?.transitionOrder(order.id, "PAYMENT_PENDING", "FAILED", undefined, "PAYMENT_RETRY_FAILED");
          store.transitionOrder(order.id, "FAILED", undefined, "PAYMENT_RETRY_FAILED");
        }
        throw error;
      }
      const
        attempt = {
          ...payment,
          provider: req.body.provider,
          status: "CREATED",
          amount: order.total,
          currency: "INR",
          refundedAmount: order.payment?.refundedAmount || 0,
          refunds: order.payment?.refunds || [],
        };
      order.payment = attempt;
      await persistence?.createPaymentAttempt(
        order.id,
        req.body.provider,
        payment.externalId,
        order.total,
        attemptKey,
      );
      return ok(
        res,
        {
          order: { number: order.number, status: order.status },
          payment: paymentAttemptDto(attempt),
          paymentAttemptToken: issuePaymentAttemptToken(
            order.id,
            order.number,
            attempt.externalId,
          ),
        },
        "New payment attempt created",
        201,
      );
    },
  );
  app.get("/api/v1/orders/:number/track", (_req, _res, next) =>
    next(new AppError(410, "TRACKING_FORM_UPDATED", "Refresh the tracking page to use the secure tracking form")));
  app.post(
    "/api/v1/orders/track",
    limiter(30, 60_000),
    validate(trackingSchema),
    async (req, res) => {
      const order = [...store.orders.values()].find(
        (x) => x.number === req.body.orderNumber,
      );
      if (!order || !trackingContactMatches(order, req.body.contact))
        throw new AppError(
          404,
          "ORDER_NOT_FOUND",
          "Order not found or contact details do not match",
        );
      const shipment = persistence
        ? await persistence.trackingDetails(order.id)
        : order.shipment || null;
      return ok(res, {
        number: order.number,
        status: order.status,
        history: customerOrderHistory(order),
        shipment: shipment ? { courier: shipment.courier, status: shipment.status,
          events: shipment.events.map(event => ({ status: event.status, occurredAt: event.occurredAt })) } : null,
        estimatedDelivery: null,
      });
    },
  );
  app.get("/api/v1/account/orders", auth, (req, res) =>
    ok(
      res,
      [...store.orders.values()]
        .filter((order) => order.userId === req.principal!.sub)
        .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
        .map((order) => ({
          id: order.id,
          number: order.number,
          status: order.status,
          lines: order.lines,
          subtotal: order.subtotal,
          tax: order.tax,
          shipping: order.shipping,
          discount: order.discount,
          couponDiscount: order.invoiceSnapshot?.discounts?.coupon ?? order.discount,
          onlinePaymentDiscount: order.invoiceSnapshot?.discounts?.onlinePayment ?? 0,
          total: order.total,
          currency: order.payment?.currency || "INR",
          payment: order.payment
            ? {
                provider: order.payment.provider || "Payment provider",
                status: order.payment.status || "PENDING",
                refundedAmount: order.payment.refundedAmount || 0,
              }
            : null,
          shippingSelection: order.shippingSelection || null,
          shipment: order.shipment
            ? {
                courier: order.shipment.courier || null,
                status: order.shipment.status,
                awb: order.shipment.awb || null,
                trackingUrl: order.shipment.trackingUrl || null,
                events: order.shipment.events,
              }
            : null,
          history: customerOrderHistory(order),
          createdAt: order.createdAt,
        })),
    ),
  );
  app.get("/api/v1/account/payments", auth, async (req, res) => {
    if (persistence)
      return ok(
        res,
        await persistence.listCustomerPayments(req.principal!.sub),
      );
    const payments = [...store.orders.values()]
      .filter(
        (order) =>
          order.userId === req.principal!.sub && Boolean(order.payment),
      )
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
      .map((order) => {
        const payment = order.payment!;
        const refundedAmount =
          payment.refundedAmount ||
          (payment.status === "REFUNDED" ? order.total : 0);
        return {
          id: `payment:${order.id}`,
          orderId: order.id,
          orderNumber: order.number,
          orderStatus: order.status,
          provider: payment.provider || "Payment provider",
          status: payment.status || "CREATED",
          amount: order.total,
          currency: "INR",
          providerReference: payment.externalId,
          transactionId: payment.gatewayTransactionId || null,
          refundedAmount,
          refunds: (payment.refunds || []).map(adminRefundDto),
          events: payment.lastError
            ? [
                {
                  id: `event:${order.id}`,
                  type: payment.status || "FAILED",
                  amount: 0,
                  errorCode: payment.lastError.code,
                  errorDescription: payment.lastError.description,
                  createdAt: order.createdAt,
                },
              ]
            : [],
          createdAt: order.createdAt,
          verifiedAt: null,
        };
      });
    return ok(res, payments);
  });
  app.get("/api/v1/orders/:id/invoice", auth, async (req, res) => {
    const order = store.orders.get(String(req.params.id));
    if (
      !order ||
      (order.userId !== req.principal!.sub &&
        !req.principal!.permissions.includes("orders:read"))
    )
      throw new AppError(404, "ORDER_NOT_FOUND", "Order not found");
    const storefront = await readStorefront(requestHostname(req)),
      pdf = await generateInvoicePdf({
        store: {
          name: storefront.storeName,
          legalName: storefront.legalName,
          gstin: storefront.businessGstin,
          address: storefront.businessAddress,
          email: storefront.supportEmail,
          phone: storefront.supportPhone,
        },
        order: {
          number: order.number,
          createdAt: order.createdAt,
          status: order.status,
          subtotal: order.subtotal,
          tax: order.tax,
          shipping: order.shipping,
          discount: order.discount,
          total: order.total,
          paymentStatus:
            order.payment?.status ||
            (order.payment ? "PENDING" : "CASH_ON_DELIVERY"),
          lines: order.lines,
          snapshot: order.invoiceSnapshot,
        },
      });
    res.setHeader("content-type", "application/pdf");
    res.setHeader(
      "content-disposition",
      `attachment; filename="invoice-${order.number.replace(/[^A-Za-z0-9_-]/g, "")}.pdf"`,
    );
    res.setHeader("cache-control", "private, no-store");
    return res.status(200).send(pdf);
  });
  app.post(
    "/api/v1/account/returns",
    auth,
    validate(returnSchema),
    async (req, res) => {
      if (persistence) {
        const created = await persistence.createReturnRequest(
          req.principal!.sub,
          req.body,
        );
        await persistence.refreshOrder(store, req.body.orderId);
        const request = {
          id: created.id,
          orderId: created.orderId,
          userId: created.userId || undefined,
          reason: created.reason,
          notes: created.notes || undefined,
          status: created.status,
          createdAt: created.createdAt.toISOString(),
          updatedAt: created.updatedAt.toISOString(),
          items: created.items.map((item) => ({
            id: item.id,
            orderItemId: item.orderItemId,
            variantId: item.orderItem.variantId,
            name: item.orderItem.name,
            sku: item.orderItem.sku,
            quantity: item.quantity,
            condition: item.condition || undefined,
          })),
        };
        store.returns.set(request.id, request);
        return ok(res, customerReturnDto(request), "Return requested", 201);
      }
      const order = store.orders.get(req.body.orderId);
      if (!order || order.userId !== req.principal!.sub)
        throw new AppError(404, "ORDER_NOT_FOUND", "Order not found");
      if (order.status !== "DELIVERED")
        throw new AppError(
          409,
          "RETURN_NOT_AVAILABLE",
          "Returns are available only after delivery",
        );
      const selections = req.body.items || order.lines.map((line) => ({
        variantId: line.variantId,
        quantity: line.quantity,
      }));
      const seen = new Set<string>();
      const items = selections.map(
        (selection: { variantId: string; quantity: number }) => {
          if (seen.has(selection.variantId))
            throw new AppError(
              400,
              "DUPLICATE_RETURN_ITEM",
              "Each product variant can be selected only once",
            );
          seen.add(selection.variantId);
          const line = order.lines.find(
            (candidate) => candidate.variantId === selection.variantId,
          );
          if (!line || selection.quantity > line.quantity)
            throw new AppError(
              422,
              "INVALID_RETURN_QUANTITY",
              "Return quantity exceeds the purchased quantity",
            );
          return {
            id: crypto.randomUUID(),
            orderItemId: selection.variantId,
            variantId: selection.variantId,
            name: line.name,
            sku: line.sku,
            quantity: selection.quantity,
          };
        },
      );
      if (
        [...store.returns.values()].some(
          (item) => item.orderId === order.id && item.status !== "REJECTED",
        )
      )
        throw new AppError(
          409,
          "RETURN_ALREADY_EXISTS",
          "A return is already active for this order",
        );
      const createdAt = new Date().toISOString();
      const request = {
        id: crypto.randomUUID(),
        orderId: order.id,
        userId: req.principal!.sub,
        reason: req.body.reason,
        status: "REQUESTED",
        createdAt,
        updatedAt: createdAt,
        items,
      };
      store.transitionOrder(
        order.id,
        "RETURN_REQUESTED",
        req.principal!.sub,
        "CUSTOMER",
      );
      store.returns.set(request.id, request);
      return ok(res, customerReturnDto(request), "Return requested", 201);
    },
  );
  app.get("/api/v1/account/returns", auth, async (req, res) => {
    if (persistence) {
      const items = await persistence.listCustomerReturns(req.principal!.sub);
      return ok(
        res,
        items.map((item) => customerReturnDto({
          id: item.id,
          orderId: item.orderId,
          reason: item.reason,
          notes: item.notes || null,
          status: item.status,
          createdAt: item.createdAt,
          updatedAt: item.updatedAt,
          items: item.items.map((entry) => ({
            id: entry.id,
            variantId: entry.orderItem.variantId,
            name: entry.orderItem.name,
            sku: entry.orderItem.sku,
            quantity: entry.quantity,
            condition: entry.condition || null,
          })),
        })),
      );
    }
    return ok(
      res,
      [...store.returns.values()]
        .filter((item) => item.userId === req.principal!.sub)
        .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
        .slice(0, 100)
        .map(customerReturnDto),
    );
  });
  const customerSupportDto = (ticket: {
    id: string;
    number: string;
    subject: string;
    priority: string;
    status: string;
    createdAt: string | Date;
    updatedAt?: string | Date;
    messages: Array<{
      id: string;
      body: string;
      internal: boolean;
      createdAt: string | Date;
    }>;
  }) => ({
    id: ticket.id,
    number: ticket.number,
    subject: ticket.subject,
    priority: ticket.priority,
    status: ticket.status,
    createdAt: ticket.createdAt,
    updatedAt: ticket.updatedAt || ticket.createdAt,
    messages: ticket.messages
      .filter((message) => !message.internal)
      .slice(-200)
      .sort(
        (left, right) =>
          new Date(left.createdAt).getTime() - new Date(right.createdAt).getTime(),
      )
      .map((message) => ({
        id: message.id,
        body: message.body,
        createdAt: message.createdAt,
      })),
  });
  app.post(
    "/api/v1/account/support",
    auth,
    validate(supportTicketSchema),
    async (req, res) => {
      if (persistence)
        return ok(
          res,
          customerSupportDto(
            await persistence.createSupportTicket(req.principal!.sub, req.body),
          ),
          "Support ticket created",
          201,
        );
      const createdAt = new Date().toISOString(),
        ticket = {
          id: crypto.randomUUID(),
          number: `SUP-${Date.now().toString(36).toUpperCase()}-${crypto
            .randomBytes(3)
            .toString("hex")
            .toUpperCase()}`,
          userId: req.principal!.sub,
          subject: req.body.subject,
          priority: req.body.priority,
          status: "OPEN",
          createdAt,
          messages: [
            {
              id: crypto.randomUUID(),
              authorId: req.principal!.sub,
              body: req.body.message,
              internal: false,
              createdAt,
            },
          ],
        };
      store.supportTickets.set(ticket.id, ticket);
      return ok(res, customerSupportDto(ticket), "Support ticket created", 201);
    },
  );
  app.get("/api/v1/account/support", auth, async (req, res) =>
    ok(
      res,
      persistence
        ? (await persistence.listSupportTickets(req.principal!.sub)).map(
            customerSupportDto,
          )
        : [...store.supportTickets.values()]
            .filter((ticket) => ticket.userId === req.principal!.sub)
            .sort((left, right) =>
              String(right.updatedAt || right.createdAt).localeCompare(
                String(left.updatedAt || left.createdAt),
              ),
            )
            .slice(0, 50)
            .map(customerSupportDto),
    ),
  );
  app.post(
    "/api/v1/account/support/:id/replies",
    auth,
    validate(customerSupportReplySchema),
    async (req, res) => {
      if (persistence)
        return ok(
          res,
          customerSupportDto(
            await persistence.replySupportTicket(
              String(req.params.id),
              req.principal!.sub,
              req.body.message,
              undefined,
              req.principal!.sub,
            ),
          ),
          "Reply added",
          201,
        );
      const ticket = store.supportTickets.get(String(req.params.id));
      if (!ticket || ticket.userId !== req.principal!.sub)
        throw new AppError(404, "TICKET_NOT_FOUND", "Support ticket not found");
      const repliedAt = new Date().toISOString();
      ticket.messages.push({
        id: crypto.randomUUID(),
        authorId: req.principal!.sub,
        body: req.body.message,
        internal: false,
        createdAt: repliedAt,
      });
      ticket.status = "OPEN";
      ticket.updatedAt = repliedAt;
      return ok(res, customerSupportDto(ticket), "Reply added", 201);
    },
  );
  app.get(
    "/api/v1/admin/orders",
    auth,
    authorize("orders:read"),
    async (req, res) => {
      const parsePositiveInteger = (
        value: unknown,
        fallback: number,
        maximum: number,
        name: string,
      ) => {
        if (value === undefined) return fallback;
        const raw = String(value);
        if (!/^\d+$/.test(raw))
          throw new AppError(400, "INVALID_PAGINATION", `${name} must be a positive integer`);
        const parsed = Number(raw);
        if (parsed < 1 || parsed > maximum)
          throw new AppError(400, "INVALID_PAGINATION", `${name} must be between 1 and ${maximum}`);
        return parsed;
      };
      const page = parsePositiveInteger(req.query.page, 1, 1_000, "page");
      const pageSize = parsePositiveInteger(req.query.pageSize, 20, 100, "pageSize");
      const search = String(req.query.search || "").trim();
      if (search.length > 120)
        throw new AppError(400, "INVALID_SEARCH", "Order search cannot exceed 120 characters");
      const requestedStatus = String(req.query.status || "").trim().toUpperCase();
      const allowedStatuses = new Set([
        "PENDING",
        "PAYMENT_PENDING",
        "PAID",
        "CONFIRMED",
        "PROCESSING",
        "PACKED",
        "SHIPPED",
        "OUT_FOR_DELIVERY",
        "DELIVERED",
        "CANCELLED",
        "RETURN_REQUESTED",
        "RETURN_APPROVED",
        "RETURNED",
        "REFUND_PENDING",
        "REFUNDED",
        "FAILED",
      ]);
      if (requestedStatus && !allowedStatuses.has(requestedStatus))
        throw new AppError(400, "INVALID_ORDER_STATUS", "Unknown order status filter");

      const allOrders = persistence ? [] : [...store.orders.values()];
      const matches = (order: (typeof allOrders)[number]) => {
        if (requestedStatus && order.status !== requestedStatus) return false;
        if (!search) return true;
        const query = search.toLowerCase();
        const customer = order.userId ? store.users.get(order.userId) : undefined;
        const contact = order.invoiceSnapshot?.contact;
        return [
          order.number,
          customer?.name,
          customer?.email,
          customer?.mobile,
          contact?.name,
          contact?.email,
          contact?.phone,
          ...order.lines.flatMap((line) => [line.name, line.sku]),
        ].some((value) => String(value || "").toLowerCase().includes(query));
      };
      const memoryFiltered = persistence
        ? []
        : allOrders
            .filter(matches)
            .sort(
              (left, right) =>
                right.createdAt.localeCompare(left.createdAt) ||
                right.id.localeCompare(left.id),
            );
      const persisted = persistence
        ? await persistence.listAdminOrdersPage({
            page,
            pageSize,
            search: search || undefined,
            status: requestedStatus
              ? (requestedStatus as Parameters<PrismaPersistence["listAdminOrdersPage"]>[0]["status"])
              : undefined,
          })
        : null;
      const selectedOrders = persisted
        ? persisted.orders
        : memoryFiltered.slice((page - 1) * pageSize, page * pageSize);
      for (const order of selectedOrders) store.orders.set(order.id, order);
      const filteredTotal = persisted?.filteredTotal ?? memoryFiltered.length;
      const terminalStatuses = new Set(["CANCELLED", "FAILED", "REFUNDED"]);
      const summary =
        persisted?.summary ||
        {
          totalOrders: allOrders.length,
          activeCount: allOrders.filter((order) => !terminalStatuses.has(order.status)).length,
          readyToShip: allOrders.filter((order) => order.status === "PACKED").length,
          orderValue: allOrders
            .filter((order) => !["CANCELLED", "FAILED"].includes(order.status))
            .reduce((total, order) => total + order.total, 0),
          currency: "INR",
        };
      return ok(
        res,
        {
          items: selectedOrders.map((order) =>
            adminOrderDto(
              order,
              order.userId ? store.users.get(order.userId) : undefined,
            ),
          ),
          pagination: {
            page,
            pageSize,
            total: filteredTotal,
            totalPages: Math.max(1, Math.ceil(filteredTotal / pageSize)),
          },
          summary,
        },
      );
    },
  );
  app.get(
    "/api/v1/admin/payments",
    auth,
    authorize("payments:read"),
    async (_req, res) =>
      ok(
        res,
        persistence
          ? await persistence.listPayments()
          : [...store.orders.values()]
              .filter((order) => order.payment)
              .map((order) => ({
                orderNumber: order.number,
                amount: order.total,
                currency: "INR",
                ...order.payment,
              })),
      ),
  );
  app.post("/api/v1/admin/refunds/:id/reconcile", auth, authorize("orders:refund"), limiter(10, 60000), async (req, res) => {
    if (!persistence) throw new AppError(503, "DATABASE_REQUIRED", "Refund reconciliation requires the database");
    const refund = await persistence.db.refund.findUnique({ where: { id: String(req.params.id) }, include: { payment: true } });
    if (!refund?.externalId || !refund.payment.externalId) throw new AppError(404, "REFUND_NOT_FOUND", "Submitted refund was not found");
    const provider = resolvePaymentProvider(refund.payment.provider);
    if (!(provider instanceof CashfreePaymentProvider)) throw new AppError(422, "PROVIDER_NOT_SUPPORTED", "Use the provider's refund dashboard");
    const result = await provider.lookupRefund(refund.payment.externalId, refund.externalId);
    if (Math.round(result.amount * 100) !== Math.round(Number(refund.amount) * 100)) throw new AppError(422, "REFUND_VALUE_MISMATCH", "Refund amount does not match");
    if (result.status === "SUCCESS") await persistence.completeRefund(refund.id, refund.externalId, req.principal!.sub);
    else if (["FAILED", "CANCELLED"].includes(result.status) && refund.status === "PENDING") await persistence.failRefund(refund.id);
    await persistence.refreshOrder(store, refund.payment.orderId);
    return ok(res, { status: result.status }, "Refund status checked");
  });
  app.post(
    "/api/v1/admin/payments/reconcile",
    auth,
    authorize("payments:read"),
    validate(paymentReconcileSchema),
    async (req, res) => {
      if (!persistence)
        throw new AppError(
          503,
          "DATABASE_REQUIRED",
          "Payment reconciliation requires persistent payment records",
        );
      const payments = await persistence.listPayments(),
        payment = payments.find((item) => item.id === req.body.paymentId);
      if (!payment?.externalId)
        throw new AppError(404, "PAYMENT_NOT_FOUND", "Payment was not found");
      const gateway = await resolvePaymentProvider(payment.provider),
        status = await gateway.lookup(payment.externalId),
        result = await persistence.reconcilePayment(payment.id, status);
      const order = [...store.orders.values()].find(
        (item) => item.number === result.orderNumber,
      );
      if (
        order &&
        status.status === "CAPTURED" &&
        order.status === "PAYMENT_PENDING"
      )
        store.transitionOrder(
          order.id,
          "PAID",
          req.principal!.sub,
          "RECONCILIATION",
        );
      return ok(res, result, "Payment reconciled");
    },
  );
  app.get(
    "/api/v1/admin/customers",
    auth,
    authorize("customers:read"),
    validate(adminCustomerQuerySchema, "query"),
    async (req, res) =>
      ok(
        res,
        persistence
          ? await persistence.listAdminCustomersPage(req.query as never)
          : listAdminCustomers(
              [...store.users.values()],
              [...store.orders.values()],
              req.query as never,
            ),
      ),
  );
  app.get(
    "/api/v1/admin/customer-segments",
    auth,
    authorize("customers:read"),
    async (_req, res) =>
      ok(
        res,
        persistence
          ? await persistence.listAdminCustomerSegments()
          : listCustomerSegments(
              [...store.users.values()],
              [...store.orders.values()],
            ),
      ),
  );
  app.get(
    "/api/v1/admin/customers/:id",
    auth,
    authorize("customers:read"),
    async (req, res) =>
      ok(
        res,
        persistence
          ? await persistence.getAdminCustomerDetail(String(req.params.id))
          : adminCustomerDetail(store, String(req.params.id)),
      ),
  );
  app.patch(
    "/api/v1/admin/customers/:id",
    auth,
    authorize("customers:update"),
    validate(adminCustomerUpdateSchema),
    async (req, res) => {
      const id = String(req.params.id);
      if (persistence) {
        const updated = await persistence.updateAdminCustomer(
          id,
          req.body,
          req.principal!.sub,
        );
        const mirror = store.users.get(id);
        if (mirror?.role === "CUSTOMER") {
          mirror.tags = Array.isArray(updated.tags) ? updated.tags.filter((tag): tag is string => typeof tag === "string") : [];
          mirror.note = updated.note || undefined;
          mirror.marketingConsent = updated.marketingConsent;
          mirror.marketingConsentUpdatedAt =
            updated.marketingConsentUpdatedAt?.toISOString();
          mirror.disabledAt = updated.disabledAt?.toISOString();
          mirror.authVersion = updated.authVersion;
          mirror.updatedAt = updated.updatedAt.toISOString();
        }
        if (req.body.accountStatus === "DISABLED")
          for (const [sessionId, session] of store.sessions)
            if (session.userId === id) store.sessions.delete(sessionId);
        return ok(
          res,
          await persistence.getAdminCustomerDetail(id),
          "Customer updated",
        );
      }
      const user = store.users.get(id);
      if (!user || user.role !== "CUSTOMER")
        throw new AppError(404, "CUSTOMER_NOT_FOUND", "Customer not found");
      const before = {
        tags: [...(user.tags || [])],
        notePresent: Boolean(user.note),
        marketingConsent: Boolean(user.marketingConsent),
        accountStatus: user.disabledAt ? "DISABLED" : "ACTIVE",
      };
      const now = new Date().toISOString();
      if (req.body.tags !== undefined)
        user.tags = normalizeCustomerTags(req.body.tags);
      if (req.body.note !== undefined)
        user.note = req.body.note || undefined;
      if (req.body.marketingConsent !== undefined) {
        const changed = user.marketingConsent !== req.body.marketingConsent;
        user.marketingConsent = req.body.marketingConsent;
        if (changed)
          user.marketingConsentUpdatedAt =
            now;
      }
      if (req.body.accountStatus !== undefined)
        user.disabledAt = req.body.accountStatus === "DISABLED" ? now : undefined;
      if (
        req.body.accountStatus === "DISABLED" &&
        before.accountStatus === "ACTIVE"
      )
        user.authVersion = (user.authVersion || 0) + 1;
      user.updatedAt = now;
      if (req.body.accountStatus === "DISABLED")
        for (const [sessionId, session] of store.sessions)
          if (session.userId === id) store.sessions.delete(sessionId);
      store.auditLogs.push({
          id: crypto.randomUUID(),
          actor: req.principal!.sub,
          action: "customer.updated",
          resource: "customer",
          resourceId: id,
          before,
          after: {
            tags: user.tags || [],
            notePresent: Boolean(user.note),
            marketingConsent: Boolean(user.marketingConsent),
            accountStatus: user.disabledAt ? "DISABLED" : "ACTIVE",
          },
          createdAt: now,
        });
      return ok(
        res,
        adminCustomerDetail(store, id),
        "Customer updated",
      );
    },
  );
  app.get(
    "/api/v1/admin/inventory",
    auth,
    authorize("inventory:read"),
    (req, res) => {
      const lowStockValue = String(req.query.lowStock || "").toLowerCase();
      if (lowStockValue && !["true", "false"].includes(lowStockValue))
        throw new AppError(400, "INVALID_QUERY", "lowStock must be true or false");
      return ok(
        res,
        listAdminInventory(store.listProducts(), {
          search: String(req.query.search || "").slice(0, 200),
          productId: String(req.query.productId || "").slice(0, 100),
          lowStock: lowStockValue === "true",
          page: queryInteger(req.query.page, 1, 1, 1000),
          limit: queryInteger(req.query.limit, 25, 1, 100),
        }),
      );
    },
  );
  app.get(
    "/api/v1/admin/inventory/:variantId/movements",
    auth,
    authorize("inventory:read"),
    async (req, res) => {
      const variantId = String(req.params.variantId);
      store.getVariant(variantId);
      const page = queryInteger(req.query.page, 1, 1, 1000);
      const limit = queryInteger(req.query.limit, 25, 1, 100);
      const movements = persistence
        ? (await persistence.listInventoryMovements(variantId)).map(
            (movement) => ({
              id: movement.id,
              quantity: movement.quantity,
              reason: movement.reason,
              referenceId: movement.referenceId || undefined,
              createdAt: movement.createdAt.toISOString(),
            }),
          )
        : (store.inventoryMovements.get(variantId) || []).map((movement) => ({
            id: movement.id,
            quantity: movement.quantity,
            reason: movement.reason,
            referenceId: movement.referenceId,
            createdAt: movement.createdAt,
          }));
      return ok(res, {
        variantId,
        ...paginatedMovements(movements, page, limit),
      });
    },
  );
  app.patch(
    "/api/v1/admin/inventory/:variantId",
    auth,
    authorize("inventory:update"),
    validate(inventoryAdjustmentSchema),
    async (req, res) => {
      const variantId = String(req.params.variantId);
      const { variant } = store.getVariant(variantId);
      const key = String(req.headers["idempotency-key"] || "");
      if (key.length < 8 || key.length > 100)
        throw new AppError(
          400,
          "IDEMPOTENCY_KEY_REQUIRED",
          "A valid Idempotency-Key header is required",
        );
      const operationKey = `inventory:${key}`;
      let movement:
        | {
            id: string;
            quantity: number;
            reason: string;
            referenceId?: string | null;
            createdAt: Date | string;
          }
        | undefined;
      let replayed = false;
      if (persistence) {
        const result = await persistence.adjustInventory(
            variant.id,
            req.body.quantity,
            req.body.reason,
            req.principal!.sub,
            operationKey,
          );
        variant.stock = result.inventory.onHand;
        movement = result.movement;
        replayed = result.replayed;
      } else {
        const result = store.adjustInventory(
            variant.id,
            req.body.quantity,
            req.body.reason,
            operationKey,
            req.principal!.sub,
          );
        movement = result.movement;
        replayed = result.replayed;
      }
      return ok(
        res,
        {
          inventory: {
            variantId: variant.id,
            onHand: variant.stock,
            reserved: variant.reserved,
            available: variant.stock - variant.reserved,
            lowStockAt: 5,
            lowStock: variant.stock - variant.reserved <= 5,
          },
          movement: {
            id: movement.id,
            quantity: movement.quantity,
            reason: movement.reason,
            referenceId: movement.referenceId || undefined,
            createdAt:
              movement.createdAt instanceof Date
                ? movement.createdAt.toISOString()
                : movement.createdAt,
          },
          replayed,
        },
        replayed ? "Inventory adjustment replayed" : "Inventory adjusted",
      );
    },
  );
  app.get(
    "/api/v1/admin/analytics/marketing",
    auth,
    authorize("analytics:read"),
    async (req, res) => {
      const storefront = await readStorefront(requestHostname(req));
      const origin = new URL(process.env.APP_URL || (storefront.primaryDomain ? `https://${storefront.primaryDomain}` : "http://localhost:5180")).origin;
      const { report } = buildMerchantFeed(store.products.values(), origin, storefront.storeName);
      const businessMissing = [
        !storefront.legalName && "legal business name",
        !storefront.businessAddress && "business postal address",
        !storefront.supportPhone && "customer support phone",
        !storefront.supportEmail && "customer support email",
      ].filter((value): value is string => Boolean(value));
      res.setHeader("Cache-Control", "private, no-store");
      return ok(res, {
        analytics: publicAnalyticsConfig(store.integrations.values(), config.NODE_ENV),
        feed: report,
        businessMissing,
      });
    },
  );
  app.get(
    "/api/v1/admin/analytics",
    auth,
    authorize("analytics:read"),
    (_req, res) => {
      const orders = [...store.orders.values()],
        completed = orders.filter(
          (order) => !["CANCELLED", "FAILED"].includes(order.status),
        );
      const revenue = completed.reduce((sum, order) => sum + order.total, 0);
      return ok(res, {
        revenue,
        orders: orders.length,
        averageOrderValue: completed.length
          ? Math.round((revenue / completed.length) * 100) / 100
          : 0,
        customers: [...store.users.values()].filter(
          (user) => user.role === "CUSTOMER",
        ).length,
        failedOrders: orders.filter((order) => order.status === "FAILED")
          .length,
        refunds: orders.filter((order) => order.status === "REFUNDED").length,
      });
    },
  );
  app.get(
    "/api/v1/admin/returns",
    auth,
    authorize("returns:read"),
    validate(adminReturnQuerySchema, "query"),
    async (req, res) =>
      ok(
        res,
        persistence
          ? await persistence.listAdminReturnsPage(req.query as never)
          : listAdminReturns(store, req.query as never),
      ),
  );
  app.get(
    "/api/v1/admin/returns/:id",
    auth,
    authorize("returns:read"),
    async (req, res) =>
      ok(
        res,
        persistence
          ? await persistence.getAdminReturnDetail(String(req.params.id))
          : adminReturnDetail(store, String(req.params.id)),
      ),
  );
  app.patch(
    "/api/v1/admin/returns/:id",
    auth,
    authorize("returns:update"),
    validate(returnDecisionSchema),
    async (req, res) => {
      const id = String(req.params.id);
      if (persistence) {
        const decided = await persistence.decideReturn(
          id,
          req.body.status,
          req.body.notes,
          req.principal!.sub,
        );
        if (decided) {
          await persistence.refreshOrder(store, decided.orderId);
          const mirror = store.returns.get(id);
          if (mirror) {
            mirror.status = decided.status;
            mirror.notes = decided.notes || undefined;
            mirror.updatedAt = decided.updatedAt.toISOString();
          }
        }
        return ok(
          res,
          await persistence.getAdminReturnDetail(id),
          `Return ${req.body.status.toLowerCase()}`,
        );
      }
      const item = store.returns.get(id);
      if (!item)
        throw new AppError(404, "RETURN_NOT_FOUND", "Return request not found");
      const receiving = req.body.status === "RECEIVED";
      const expectedReturnStatus = receiving ? "APPROVED" : "REQUESTED";
      if (item.status !== expectedReturnStatus)
        throw new AppError(
          409,
          receiving ? "RETURN_NOT_APPROVED" : "RETURN_ALREADY_DECIDED",
          receiving
            ? "Only an approved return can be marked received"
            : "Return request is no longer pending",
        );
      const before = item.status;
      const order = store.orders.get(item.orderId);
      if (!order)
        throw new AppError(404, "ORDER_NOT_FOUND", "Order not found");
      store.transitionOrder(
        order.id,
        receiving
          ? "RETURNED"
          : req.body.status === "APPROVED"
            ? "RETURN_APPROVED"
            : "DELIVERED",
        req.principal!.sub,
        "ADMIN",
      );
      item.status = req.body.status;
      item.notes = req.body.notes;
      item.updatedAt = new Date().toISOString();
      store.auditLogs.push({
          id: crypto.randomUUID(),
          actor: req.principal!.sub,
          action: "return.decided",
          resource: "return_request",
          resourceId: id,
          before: { status: before },
          after: { status: item.status, notesPresent: Boolean(item.notes) },
          createdAt: item.updatedAt,
        });
      return ok(
        res,
        adminReturnDetail(store, id),
        `Return ${req.body.status.toLowerCase()}`,
      );
    },
  );
  app.get(
    "/api/v1/admin/support",
    auth,
    authorize("support:read"),
    validate(adminSupportQuerySchema, "query"),
    async (req, res) =>
      ok(
        res,
        persistence
          ? await persistence.listAdminSupportPage(req.query as never)
          : listAdminSupportTickets(store, req.query as never),
      ),
  );
  app.get(
    "/api/v1/admin/support/:id",
    auth,
    authorize("support:read"),
    async (req, res) =>
      ok(
        res,
        persistence
          ? await persistence.getAdminSupportDetail(String(req.params.id))
          : adminSupportDetail(store, String(req.params.id)),
      ),
  );
  app.post(
    "/api/v1/admin/support/:id/replies",
    auth,
    authorize("support:update"),
    validate(supportReplySchema),
    async (req, res) => {
      const id = String(req.params.id);
      if (persistence) {
        await persistence.replySupportTicket(
          id,
          req.principal!.sub,
          req.body.message,
          req.body.status,
        );
        return ok(
          res,
          await persistence.getAdminSupportDetail(id),
          "Reply added",
          201,
        );
      }
      const ticket = store.supportTickets.get(id);
      if (!ticket)
        throw new AppError(404, "TICKET_NOT_FOUND", "Support ticket not found");
      const now = new Date().toISOString();
      ticket.messages.push({
        id: crypto.randomUUID(),
        authorId: req.principal!.sub,
        body: req.body.message,
        internal: false,
        createdAt: now,
      });
      ticket.status = req.body.status || "WAITING_CUSTOMER";
      ticket.updatedAt = now;
      store.auditLogs.push({
        id: crypto.randomUUID(),
        actor: req.principal!.sub,
        action: "support.replied",
        resource: "support_ticket",
        resourceId: id,
        after: { status: ticket.status, internal: false },
        createdAt: now,
      });
      return ok(res, adminSupportDetail(store, id), "Reply added", 201);
    },
  );
  app.post(
    "/api/v1/admin/support/:id/internal-notes",
    auth,
    authorize("support:update"),
    validate(supportInternalNoteSchema),
    async (req, res) => {
      const id = String(req.params.id);
      if (persistence) {
        await persistence.replySupportTicket(
          id,
          req.principal!.sub,
          req.body.message,
          undefined,
          undefined,
          true,
        );
        return ok(
          res,
          await persistence.getAdminSupportDetail(id),
          "Internal note added",
          201,
        );
      }
      const ticket = store.supportTickets.get(id);
      if (!ticket)
        throw new AppError(404, "TICKET_NOT_FOUND", "Support ticket not found");
      const now = new Date().toISOString();
      ticket.messages.push({
        id: crypto.randomUUID(),
        authorId: req.principal!.sub,
        body: req.body.message,
        internal: true,
        createdAt: now,
      });
      ticket.updatedAt = now;
      store.auditLogs.push({
        id: crypto.randomUUID(),
        actor: req.principal!.sub,
        action: "support.internal_note_added",
        resource: "support_ticket",
        resourceId: id,
        after: { status: ticket.status, internal: true },
        createdAt: now,
      });
      return ok(res, adminSupportDetail(store, id), "Internal note added", 201);
    },
  );
  app.patch(
    "/api/v1/admin/support/:id",
    auth,
    authorize("support:update"),
    validate(supportUpdateSchema),
    async (req, res) => {
      const id = String(req.params.id);
      if (persistence) {
        await persistence.updateSupportTicket(id, req.body, req.principal!.sub);
        return ok(
          res,
          await persistence.getAdminSupportDetail(id),
          "Support ticket updated",
        );
      }
      const ticket = store.supportTickets.get(id);
      if (!ticket)
        throw new AppError(404, "TICKET_NOT_FOUND", "Support ticket not found");
      const before = { status: ticket.status, priority: ticket.priority };
      if (req.body.status) ticket.status = req.body.status;
      if (req.body.priority) ticket.priority = req.body.priority;
      ticket.updatedAt = new Date().toISOString();
      store.auditLogs.push({
        id: crypto.randomUUID(),
        actor: req.principal!.sub,
        action: "support.updated",
        resource: "support_ticket",
        resourceId: id,
        before,
        after: { status: ticket.status, priority: ticket.priority },
        createdAt: ticket.updatedAt,
      });
      return ok(res, adminSupportDetail(store, id), "Support ticket updated");
    },
  );
  app.post(
    "/api/v1/admin/orders/:id/refunds",
    auth,
    authorize("orders:refund"),
    validate(refundSchema),
    async (req, res) => {
      const orderId = String(req.params.id);
      const order = store.orders.get(orderId);
      if (!order) throw new AppError(404, "ORDER_NOT_FOUND", "Order not found");
      const key = String(req.headers["idempotency-key"] || "");
      if (key.length < 8 || key.length > 100)
        throw new AppError(
          400,
          "IDEMPOTENCY_KEY_REQUIRED",
          "A valid Idempotency-Key header is required",
        );
      const operationKey = `refund:${order.id}:${key}`;
      const reservation = persistence
          ? await persistence.beginRefund(
            order.id,
            req.body.amount,
            operationKey,
            req.body.reason,
            req.principal!.sub,
            req.body.returnRequestId,
          )
        : store.beginRefund(
            order.id,
            req.body.amount,
            operationKey,
            req.body.reason,
            req.principal!.sub,
            req.body.returnRequestId,
          );
      const operationResponse = async () => {
        await persistence?.refreshOrder(store, orderId);
        const current = store.orders.get(orderId);
        if (!current)
          throw new AppError(404, "ORDER_NOT_FOUND", "Order not found");
        const dto = adminOrderDto(
          current,
          current.userId ? store.users.get(current.userId) : undefined,
        );
        const refund = dto.payment.refunds.find(
          (item) => item.id === reservation.refund.id,
        );
        if (!refund)
          throw new AppError(404, "REFUND_NOT_FOUND", "Refund was not found");
        return {
          refund,
          payment: {
            status: dto.payment.status,
            refundedAmount: dto.payment.refundedAmount,
            refundableAmount: dto.payment.refundableAmount,
          },
        };
      };
      if (!reservation.process)
        return ok(res, await operationResponse(), "Existing refund returned");
      let result: { refundId: string; status?: "PENDING" | "SUCCEEDED" | "FAILED" };
      try {
        result = await resolvePaymentProvider(
          reservation.provider!,
        ).refund({
          paymentId: reservation.externalId!,
          externalOrderId: order.payment?.externalId,
          amount: {
            amount: req.body.amount,
            currency: order.payment?.currency || "INR",
          },
          idempotencyKey: operationKey,
        });
      } catch (error) {
        const details =
          error instanceof AppError && error.details
            ? (error.details as Record<string, unknown>)
            : {};
        const definitiveRejection =
          error instanceof AppError &&
          (error.code === "PAYMENT_NOT_CONFIGURED" ||
            (error.code === "PAYMENT_PROVIDER_ERROR" &&
              details.retryable === false));
        if (definitiveRejection) {
          try {
            if (persistence) await persistence.failRefund(reservation.refund.id);
            else store.failRefund(order.id, reservation.refund.id);
          } catch {
            // Leaving the refund PENDING is safer than releasing its reserved
            // capacity when failure-state persistence is unavailable.
          }
        }
        // Timeouts, 5xx responses and malformed success responses are
        // ambiguous: the provider may already have accepted the refund. Keep
        // the reservation PENDING and retry only with this same operation key.
        throw error;
      }
      if (result.status === "PENDING" || result.status === "FAILED") {
        if (persistence) await persistence.db.refund.update({ where: { id: reservation.refund.id }, data: { externalId: result.refundId } });
        else reservation.refund.externalId = result.refundId;
        if (result.status === "FAILED") {
          if (persistence) await persistence.failRefund(reservation.refund.id);
          else store.failRefund(order.id, reservation.refund.id);
        }
        return ok(res, await operationResponse(), result.status === "PENDING" ? "Refund submitted; awaiting Cashfree confirmation" : "Cashfree rejected the refund", 202);
      }
      if (persistence)
        await persistence.completeRefund(
          reservation.refund.id,
          result.refundId,
          req.principal!.sub,
        );
      else
        store.completeRefund(
          order.id,
          reservation.refund.id,
          result.refundId,
          req.principal!.sub,
        );
      return ok(
        res,
        await operationResponse(),
        reservation.duplicate ? "Refund retry processed" : "Refund processed",
        reservation.duplicate ? 200 : 201,
      );
    },
  );
  app.patch(
    "/api/v1/admin/orders/:id/status",
    auth,
    authorize("orders:update"),
    validate(orderStatusSchema),
    async (req, res) => {
      const id = String(req.params.id),
        order = store.orders.get(id);
      if (!order) throw new AppError(404, "ORDER_NOT_FOUND", "Order not found");
      if (["PAID", "REFUND_PENDING", "REFUNDED"].includes(req.body.status))
        throw new AppError(
          409,
          "PAYMENT_STATE_MANAGED_EXTERNALLY",
          "Payment and refund states can only be changed by verified payment workflows",
        );
      assertOrderTransition(order.status, req.body.status);
      await persistence?.transitionOrder(
        id,
        order.status,
        req.body.status,
        req.principal!.sub,
      );
      const updated = store.transitionOrder(
        id,
        req.body.status,
        req.principal!.sub,
      );
      return ok(
        res,
        adminOrderDto(
          updated,
          updated.userId ? store.users.get(updated.userId) : undefined,
        ),
        "Order status updated",
      );
    },
  );
  app.post(
    "/api/v1/admin/orders/:id/shipment",
    auth,
    authorize("shipping:create"),
    async (req, res, next) => {
      try {
        const order = store.orders.get(String(req.params.id));
        if (!order)
          throw new AppError(404, "ORDER_NOT_FOUND", "Order not found");
        if (order.status !== "PACKED")
          throw new AppError(
            409,
            "ORDER_NOT_PACKED",
            "Only packed orders can be shipped",
          );
        let providerName: string;
        let result: { shipmentId: string; awb?: string; trackingUrl?: string; courier?: string };
        if (order.shippingSelection?.provider === "manual") {
          const parsed = manualShipmentSchema.safeParse(req.body);
          if (!parsed.success) throw new AppError(422, "MANUAL_SHIPMENT_DETAILS_REQUIRED", "Enter the courier name and valid optional tracking details", parsed.error.flatten());
          providerName = "manual";
          result = { shipmentId: `manual:${order.id}`, courier: parsed.data.courier, awb: parsed.data.awb, trackingUrl: parsed.data.trackingUrl };
        } else {
          const selectedShipping = resolveShippingProvider(order.shippingSelection?.provider);
          providerName = selectedShipping.name;
          const shipmentContext = persistence ? await persistence.shipmentContext(order.id) : {};
          result = await selectedShipping.provider.createShipment({
            orderId: order.id,
            service: order.shippingSelection?.service || String(req.body?.service || "STANDARD"),
            idempotencyKey: `ship:${order.id}`,
            ...shipmentContext,
          });
        }
        const persistedShipment = await persistence?.saveShipment(
          order.id,
          providerName,
          result,
        );
        await persistence?.transitionOrder(
          order.id,
          order.status,
          "SHIPPED",
          req.principal!.sub,
          "SHIPPING",
        );
        order.shipment = {
          id: persistedShipment?.id || result.shipmentId,
          provider: providerName,
          externalId: result.shipmentId,
          awb: result.awb,
          courier: result.courier,
          trackingUrl:
            "trackingUrl" in result &&
            typeof result.trackingUrl === "string"
              ? result.trackingUrl
              : undefined,
          status: "SHIPPED",
          createdAt:
            persistedShipment?.createdAt.toISOString() ||
            new Date().toISOString(),
          events: [],
        };
        const updated = store.transitionOrder(
          order.id,
          "SHIPPED",
          req.principal!.sub,
          "SHIPPING",
        );
        const dto = adminOrderDto(
          updated,
          updated.userId ? store.users.get(updated.userId) : undefined,
        );
        return ok(
          res,
          { shipment: dto.shipping.shipment, order: dto },
          "Shipment created",
          201,
        );
      } catch (error) {
        next(error);
      }
    },
  );
  app.get(
    "/api/v1/admin/audit-logs",
    auth,
    authorize("audit:read"),
    (_req, res) => ok(res, store.auditLogs),
  );
  const integrationMatches = (
    kind: string,
    provider: string,
    environment: "TEST" | "LIVE",
  ) => {
    const normalized = normalizeProvider(provider);
    return [...store.integrations.values()]
      .filter(
        (entry) =>
          entry.kind === kind &&
          entry.environment === environment &&
          normalizeProvider(entry.provider) === normalized,
      )
      .sort(
        (left, right) =>
          Number(right.provider === normalized) -
            Number(left.provider === normalized) ||
          right.updatedAt.localeCompare(left.updatedAt) ||
          left.id.localeCompare(right.id),
      );
  };
  const decryptIntegration = (record?: StoredIntegration) => {
    if (!record) return { credentials: {} as Record<string, string> };
    try {
      const value = vault.decrypt<unknown>(record.encryptedCredentials);
      if (!value || typeof value !== "object" || Array.isArray(value))
        throw new Error("Credentials are not an object");
      return {
        credentials: Object.fromEntries(
          Object.entries(value as Record<string, unknown>)
            .filter(([, secret]) => typeof secret === "string")
            .map(([key, secret]) => [key, secret as string]),
        ),
      };
    } catch {
      return {
        credentials: {} as Record<string, string>,
        unreadable: true,
      };
    }
  };
  const integrationAuditSnapshot = (
    record: StoredIntegration,
    credentialKeys: string[],
  ) => {
    const definition = integrationDefinition(record.kind, record.provider);
    return {
      kind: record.kind,
      provider: record.provider,
      enabled: record.enabled,
      priority: record.priority,
      environment: record.environment,
      publicConfig: definition
        ? providerPublicConfig(definition, record.publicConfig)
        : {},
      configuredCredentialKeys: credentialKeys.sort(),
    };
  };
  const pushIntegrationAudit = (
    action: string,
    record: StoredIntegration,
    actorId: string,
    before: Record<string, unknown> | undefined,
    after: Record<string, unknown>,
  ) =>
    store.auditLogs.unshift({
      id: crypto.randomUUID(),
      action,
      resource: "integration",
      resourceId: record.id,
      actorId,
      before,
      after,
      createdAt: new Date().toISOString(),
    });
  app.get(
    "/api/v1/admin/integrations",
    auth,
    authorize("settings:read"),
    (req, res) => {
      const requestedEnvironment = String(
        req.query.environment || runtimeEnvironment(config.NODE_ENV),
      ).toUpperCase();
      if (!(["TEST", "LIVE"] as const).includes(requestedEnvironment as never))
        throw new AppError(
          400,
          "INTEGRATION_ENVIRONMENT_INVALID",
          "Integration environment must be TEST or LIVE",
        );
      const environment = requestedEnvironment as "TEST" | "LIVE";
      const requestedKind = req.query.kind
        ? String(req.query.kind).toUpperCase()
        : undefined;
      if (
        requestedKind &&
        !integrationDefinitions.some(
          (definition) => definition.kind === requestedKind,
        )
      )
        throw new AppError(
          400,
          "INTEGRATION_KIND_INVALID",
          "Unknown integration kind",
        );
      const items = integrationDefinitions
        .filter(
          (definition) => !requestedKind || definition.kind === requestedKind,
        )
        .map((definition) => {
          const record = integrationMatches(
            definition.kind,
            definition.provider,
            environment,
          )[0];
          const { credentials } = decryptIntegration(record);
          return integrationDto({
            definition,
            environment,
            record,
            credentials,
            mask: (value) => vault.mask(value),
          });
        });
      return ok(res, { items, environment });
    },
  );
  app.put(
    "/api/v1/admin/integrations",
    auth,
    authorize("settings:update"),
    validate(integrationSchema),
    async (req, res) => {
      const provider = normalizeProvider(req.body.provider);
      const definition = integrationDefinition(req.body.kind, provider);
      if (!definition)
        throw new AppError(
          422,
          "INTEGRATION_PROVIDER_UNSUPPORTED",
          "This provider is not supported for the selected integration kind",
        );
      const environment = req.body.environment as "TEST" | "LIVE";
      const matches = integrationMatches(
        definition.kind,
        provider,
        environment,
      );
      const existing = matches[0];
      const existingState = decryptIntegration(existing);
      const suppliedCredentials = (req.body.credentials || {}) as Record<
        string,
        string
      >;
      const allowedCredentialKeys = new Set(
        definition.credentialFields.map((field) => field.key),
      );
      const unknownCredentialKeys = Object.keys(suppliedCredentials).filter(
        (key) => !allowedCredentialKeys.has(key),
      );
      if (unknownCredentialKeys.length)
        throw new AppError(
          400,
          "INTEGRATION_CREDENTIAL_FIELD_INVALID",
          "Unknown credential fields were supplied",
          { fields: unknownCredentialKeys.sort() },
        );
      const usableSuppliedCredentials = Object.fromEntries(
        Object.entries(suppliedCredentials).filter(([, value]) =>
          Boolean(value.trim()),
        ),
      );
      const suppliedRequiredCredentials = definition.credentialFields
        .filter((field) => field.required)
        .every((field) => Boolean(usableSuppliedCredentials[field.key]));
      if (
        existingState.unreadable &&
        !suppliedRequiredCredentials
      )
        throw new AppError(
          409,
          "INTEGRATION_CREDENTIALS_UNREADABLE",
          "Stored credentials cannot be preserved; disconnect or replace all required credentials",
        );
      const credentials = {
        ...(existingState.unreadable ? {} : existingState.credentials),
        ...usableSuppliedCredentials,
      };
      const suppliedPublicConfig = (req.body.publicConfig || {}) as Record<
        string,
        unknown
      >;
      const publicFields = new Map(
        definition.publicFields.map((field) => [field.key, field]),
      );
      const unknownPublicFields = Object.keys(suppliedPublicConfig).filter(
        (key) => !publicFields.has(key),
      );
      if (unknownPublicFields.length)
        throw new AppError(
          400,
          "INTEGRATION_PUBLIC_FIELD_INVALID",
          "Unknown public configuration fields were supplied",
          { fields: unknownPublicFields.sort() },
        );
      const publicConfigCandidate: Record<string, unknown> = {
        ...(definition.defaults || {}),
        ...providerPublicConfig(definition, existing?.publicConfig || {}),
      };
      for (const [key, value] of Object.entries(suppliedPublicConfig)) {
        if (typeof value === "string" && !value.trim())
          delete publicConfigCandidate[key];
        else publicConfigCandidate[key] = value;
      }
      let publicConfig: Record<string, unknown>;
      try {
        publicConfig = parsePublicConfig(definition, publicConfigCandidate);
      } catch (error) {
        throw new AppError(
          400,
          "INTEGRATION_CONFIG_INVALID",
          "Provider configuration is invalid",
          typeof (error as { flatten?: unknown }).flatten === "function"
            ? (error as { flatten: () => unknown }).flatten()
            : undefined,
        );
      }
      if (req.body.enabled && !definition.liveOperations)
        throw new AppError(
          422,
          "INTEGRATION_PROVIDER_UNAVAILABLE",
          "This provider does not have a live server adapter yet",
        );
      if (
        req.body.enabled &&
        !integrationConfigured(definition, credentials, publicConfig)
      )
        throw new AppError(
          422,
          "INTEGRATION_CONFIGURATION_INCOMPLETE",
          "All required credentials and public settings are needed before enabling",
        );
      const credentialsChanged = Object.entries(
        usableSuppliedCredentials,
      ).some(([key, value]) => existingState.credentials[key] !== value);
      const publicConfigChanged =
        JSON.stringify(
          providerPublicConfig(definition, existing?.publicConfig || {}),
        ) !==
        JSON.stringify(publicConfig);
      const connection =
        existing && !credentialsChanged && !publicConfigChanged
          ? existing.publicConfig._connection
          : {
              outcome: "UNTESTED" satisfies IntegrationOutcome,
              message: "Connection has not been tested with this configuration.",
            };
      const record: StoredIntegration = {
        id: `${definition.kind}:${provider}:${environment}`,
        kind: definition.kind,
        provider,
        enabled: req.body.enabled,
        priority: req.body.priority,
        environment,
        encryptedCredentials: vault.encrypt(credentials),
        publicConfig: {
          ...publicConfig,
          ...(connection ? { _connection: connection } : {}),
        },
        updatedAt: new Date().toISOString(),
      };
      const before = existing
        ? integrationAuditSnapshot(
            existing,
            Object.keys(existingState.credentials),
          )
        : undefined;
      const after = integrationAuditSnapshot(record, Object.keys(credentials));
      await persistence?.saveIntegration(record, {
        actorId: req.principal!.sub,
        action: "integration.saved",
        before,
        after,
        removeIds: matches.map((entry) => entry.id),
      });
      for (const item of matches) store.integrations.delete(item.id);
      store.integrations.set(record.id, record);
      pushIntegrationAudit(
        "integration.saved",
        record,
        req.principal!.sub,
        before,
        after,
      );
      return ok(
        res,
        integrationDto({
          definition,
          environment,
          record,
          credentials,
          mask: (value) => vault.mask(value),
        }),
        "Integration saved",
      );
    },
  );
  app.post(
    "/api/v1/admin/integrations/:id/test",
    auth,
    authorize("settings:update"),
    limiter(10, 60_000),
    async (req, res) => {
      const existing = store.integrations.get(String(req.params.id));
      if (!existing)
        throw new AppError(
          404,
          "INTEGRATION_NOT_FOUND",
          "Integration configuration was not found",
        );
      const definition = integrationDefinition(
        existing.kind,
        existing.provider,
      );
      if (!definition)
        throw new AppError(
          422,
          "INTEGRATION_PROVIDER_UNSUPPORTED",
          "This provider is not supported for a connection test",
        );
      const { credentials } = decryptIntegration(existing);
      const result = await testIntegrationConnection({
        definition,
        credentials,
        publicConfig: providerPublicConfig(
          definition,
          existing.publicConfig,
        ),
        request: providerRequest,
      });
      const record: StoredIntegration = {
        ...existing,
        publicConfig: {
          ...providerPublicConfig(definition, existing.publicConfig),
          _connection: result,
        },
        updatedAt: new Date().toISOString(),
      };
      const before = integrationAuditSnapshot(
        existing,
        Object.keys(credentials),
      );
      const after = {
        ...integrationAuditSnapshot(record, Object.keys(credentials)),
        testOutcome: result.outcome,
      };
      await persistence?.saveIntegration(record, {
        actorId: req.principal!.sub,
        action: "integration.connection_tested",
        before,
        after,
      });
      store.integrations.set(record.id, record);
      pushIntegrationAudit(
        "integration.connection_tested",
        record,
        req.principal!.sub,
        before,
        after,
      );
      return ok(
        res,
        {
          ...integrationDto({
            definition,
            environment: record.environment as "TEST" | "LIVE",
            record,
            credentials,
            mask: (value) => vault.mask(value),
          }),
          test: result,
        },
        "Connection test completed",
      );
    },
  );
  app.post(
    "/api/v1/admin/integrations/:id/disconnect",
    auth,
    authorize("settings:update"),
    validate(integrationDisconnectSchema),
    async (req, res) => {
      const existing = store.integrations.get(String(req.params.id));
      if (!existing)
        throw new AppError(
          404,
          "INTEGRATION_NOT_FOUND",
          "Integration configuration was not found",
        );
      const definition = integrationDefinition(
        existing.kind,
        existing.provider,
      );
      if (!definition)
        throw new AppError(
          422,
          "INTEGRATION_PROVIDER_UNSUPPORTED",
          "This provider is not supported",
        );
      const testedAt = new Date().toISOString();
      const record: StoredIntegration = {
        ...existing,
        enabled: false,
        encryptedCredentials: vault.encrypt({}),
        publicConfig: {
          ...providerPublicConfig(definition, existing.publicConfig),
          _connection: {
            outcome: "DISCONNECTED" satisfies IntegrationOutcome,
            testedAt,
            message: "Credentials were deliberately removed.",
          },
        },
        updatedAt: testedAt,
      };
      const previousState = decryptIntegration(existing);
      const before = integrationAuditSnapshot(
        existing,
        Object.keys(previousState.credentials),
      );
      const after = integrationAuditSnapshot(record, []);
      await persistence?.saveIntegration(record, {
        actorId: req.principal!.sub,
        action: "integration.disconnected",
        before,
        after,
      });
      store.integrations.set(record.id, record);
      pushIntegrationAudit(
        "integration.disconnected",
        record,
        req.principal!.sub,
        before,
        after,
      );
      return ok(
        res,
        integrationDto({
          definition,
          environment: record.environment as "TEST" | "LIVE",
          record,
          credentials: {},
          mask: (value) => vault.mask(value),
        }),
        "Integration disconnected",
      );
    },
  );
  app.use(notFound);
  app.use(errorHandler);
  return { app, store, config, persistence, readStorefront };
}
