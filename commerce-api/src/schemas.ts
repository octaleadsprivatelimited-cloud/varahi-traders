import { z } from "zod";

export const mobileNumber = z.string({ required_error: "Mobile number is required" }).trim().transform(value => /^\d{10}$/.test(value) ? `+91${value}` : value).pipe(z.string().regex(/^\+91[6-9]\d{9}$/, "Enter a valid 10-digit Indian mobile number"));
export const mobileOtpRequestSchema = z.object({ mobile: mobileNumber });
export const mobileOtpVerifySchema = mobileOtpRequestSchema.extend({
  code: z.string({ required_error: "Verification code is required" }).trim().regex(/^\d{6}$/, "Verification code must contain 6 digits"),
  name: z.string().trim().min(2, "Name must be at least 2 characters").max(100, "Name must be 100 characters or fewer").optional(),
});
export const googleLoginSchema = z.object({
  credential: z.string().min(100).max(10000),
}).strict();
const variant = z
  .object({
    id: z.string().uuid().optional(),
    sku: z.string().trim().min(3).max(80),
    title: z.string().trim().min(1).max(120),
    active: z.boolean().default(true),
    price: z.number().positive().max(100000000),
    mrp: z.number().positive().max(100000000),
    stock: z.number().int().min(0).max(1000000),
    reserved: z.number().int().min(0).default(0),
    attributes: z.record(z.string().max(100)),
    weightGrams: z.number().int().positive().max(100000),
  })
  .refine((x) => x.mrp >= x.price, {
    message: "MRP must be greater than or equal to price",
    path: ["mrp"],
  });
export const productSchema = z.object({
  name: z.string().trim().min(2).max(200),
  slug: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
  description: z.string().min(10).max(20000),
  category: z.string().min(2).max(100),
  brand: z.string().max(100).optional(),
  status: z.enum(["DRAFT", "ACTIVE", "ARCHIVED"]).default("DRAFT"),
  taxRate: z.number().min(0).max(100),
  hsnCode: z
    .string()
    .regex(/^\d{4,8}$/)
    .optional(),
  specifications: z.record(z.string().max(500)).default({}),
  seoTitle: z.string().trim().max(70).optional(),
  seoDescription: z.string().trim().max(170).optional(),
  media: z.array(z.object({
    id: z.string().uuid().optional(),
    url: z.string().url().max(2000),
    alt: z.string().trim().min(1).max(200),
    type: z.enum(["IMAGE", "VIDEO"]).default("IMAGE"),
    position: z.number().int().min(0).max(1000).default(0),
    variantId: z.string().uuid().optional(),
  })).max(30).optional(),
  variants: z.array(variant).min(1).max(200),
});
export const productMediaOrderSchema = z.object({
  mediaIds: z.array(z.string().uuid()).max(30),
});
export const productMediaUpdateSchema = z
  .object({
    alt: z.string().trim().min(1).max(200).optional(),
    variantId: z.string().uuid().nullable().optional(),
  })
  .refine((value) => value.alt !== undefined || value.variantId !== undefined, {
    message: "Provide an alt value or variant assignment",
  });
const checkoutLinesSchema = z
  .array(
    z.object({
      variantId: z.string().uuid(),
      quantity: z.number().int().min(1).max(20),
    }),
  )
  .min(1)
  .max(100);
export const checkoutSchema = z.object({
  lines: checkoutLinesSchema,
  postalCode: z.string().regex(/^[1-9]\d{5}$/),
  contact: z.object({
    name: z.string().trim().min(2).max(100),
    email: z.string().email().max(254),
    phone: mobileNumber,
  }).strict(),
  shippingAddress: z.object({
    line1: z.string().trim().min(3).max(200),
    line2: z.string().trim().max(200).optional(),
    city: z.string().trim().min(2).max(100),
    state: z.string().trim().min(2).max(100),
    country: z.string().trim().length(2).default("IN"),
  }),
  billingAddress: z.object({
    line1: z.string().trim().min(3).max(200),
    line2: z.string().trim().max(200).optional(),
    city: z.string().trim().min(2).max(100),
    state: z.string().trim().min(2).max(100),
    postalCode: z.string().regex(/^[1-9]\d{5}$/),
    country: z.string().trim().length(2).default("IN"),
  }).optional(),
  gstin: z.string().trim().regex(/^\d{2}[A-Z]{5}\d{4}[A-Z][A-Z\d]Z[A-Z\d]$/).optional(),
  deliveryInstructions: z.string().trim().max(500).optional(),
  couponCode: z.string().max(40).optional(),
  paymentProvider: z.string().min(2).max(40),
  shippingService: z.string().trim().min(1).max(120).optional(),
  expectedTotal: z.number().finite().min(0).max(100000000).optional(),
}).strict();
export const manualShipmentSchema = z.object({
  courier: z.string().trim().min(2).max(100),
  awb: z.string().trim().regex(/^[a-zA-Z0-9_-]{3,80}$/).optional(),
  trackingUrl: z.string().url().max(1000).refine(value => value.startsWith("https://"), "Use an HTTPS courier tracking URL").optional(),
  service: z.string().max(120).optional(),
}).strict();
export const trackingSchema = z.object({ orderNumber: z.string().trim().min(3).max(40), contact: z.string().trim().min(3).max(254) }).strict();
export const checkoutQuoteSchema = checkoutSchema.pick({
  lines: true,
  postalCode: true,
  couponCode: true,
  paymentProvider: true,
  shippingService: true,
});
export const integrationSchema = z.object({
  kind: z.enum([
    "PAYMENT",
    "SHIPPING",
    "EMAIL",
    "SMS",
    "WHATSAPP",
    "STORAGE",
    "ANALYTICS",
    "AUTH",
  ]),
  provider: z.string().trim().min(2).max(80),
  enabled: z.boolean(),
  priority: z.number().int().min(1).max(1000),
  environment: z.enum(["TEST", "LIVE"]),
  credentials: z
    .record(z.string().max(2000))
    .refine((value) => Object.keys(value).length <= 20, {
      message: "Too many credential fields",
    })
    .optional(),
  publicConfig: z
    .record(z.unknown())
    .refine((value) => Object.keys(value).length <= 50, {
      message: "Too many public configuration fields",
    })
    .optional(),
});
export const integrationDisconnectSchema = z.object({
  confirmation: z.literal("DISCONNECT"),
});
export const orderStatusSchema = z.object({
  status: z.enum([
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
  ]),
});
export const cartItemSchema = z.object({
  variantId: z.string().uuid(),
  quantity: z.number().int().min(0).max(20),
});
export const couponSchema = z
  .object({
    code: z
      .string()
      .trim()
      .toUpperCase()
      .regex(/^[A-Z0-9_-]{3,40}$/),
    type: z.enum(["PERCENTAGE", "FIXED_AMOUNT", "FREE_SHIPPING"]),
    value: z.number().min(0).max(10000000),
    minimumSpend: z.number().min(0).default(0),
    maximumDiscount: z.number().positive().optional(),
    startsAt: z.coerce.date(),
    endsAt: z.coerce.date(),
    enabled: z.boolean().default(true),
    usageLimit: z.number().int().positive().optional(),
    perUserLimit: z.number().int().positive().max(100).default(1),
    appliesTo: z.enum(["ALL_PRODUCTS", "SELECTED_PRODUCTS"]).default("ALL_PRODUCTS"),
    productIds: z.array(z.string().uuid()).max(500).default([]).transform(ids => [...new Set(ids)]),
  })
  .refine((value) => value.endsAt > value.startsAt, {
    message: "Coupon end date must be after start date",
    path: ["endsAt"],
  })
  .refine((value) => value.type !== "PERCENTAGE" || value.value <= 100, {
    message: "Percentage cannot exceed 100",
    path: ["value"],
  })
  .refine((value) => value.appliesTo !== "SELECTED_PRODUCTS" || value.productIds.length > 0, {
    message: "Select at least one product",
    path: ["productIds"],
  });
export const couponValidationSchema = z.object({
  code: z.string().trim().toUpperCase().regex(/^[A-Z0-9_-]{3,40}$/),
  lines: checkoutLinesSchema,
}).strict();
export const returnSchema = z.object({
  orderId: z.string().uuid(),
  reason: z.string().trim().min(5).max(1000),
  items: z.array(z.object({
    variantId: z.string().uuid(),
    quantity: z.number().int().min(1).max(1000),
  }).strict()).min(1).max(100).optional(),
});
export const returnDecisionSchema = z.object({
  status: z.enum(["APPROVED", "REJECTED", "RECEIVED"]),
  notes: z.string().trim().max(1000).optional(),
});
export const refundSchema = z.object({
  amount: z.number().positive().max(100000000).multipleOf(0.01),
  reason: z.string().trim().min(3).max(500),
  returnRequestId: z.string().uuid().optional(),
});
export const inventoryAdjustmentSchema = z.object({
  quantity: z.number().int().min(-1000000).max(1000000).refine(value => value !== 0),
  reason: z.string().trim().min(3).max(200),
});
export const addressSchema = z.object({
  phone: mobileNumber.optional(),
  label: z.string().trim().min(2).max(40), line1: z.string().trim().min(3).max(200), line2: z.string().trim().max(200).optional(), city: z.string().trim().min(2).max(100), state: z.string().trim().min(2).max(100), postalCode: z.string().regex(/^[1-9]\d{5}$/), country: z.string().length(2).default("IN"), isDefault: z.boolean().default(false),
});
export const supportTicketSchema = z.object({ subject: z.string().trim().min(3).max(160), message: z.string().trim().min(5).max(5000), priority: z.enum(["LOW", "NORMAL", "HIGH"]).default("NORMAL") });
export const supportReplySchema = z.object({ message: z.string().trim().min(1).max(5000), status: z.enum(["OPEN", "WAITING_CUSTOMER", "RESOLVED", "CLOSED"]).optional() });
export const customerSupportReplySchema = z.object({
  message: z.string().trim().min(1).max(5000),
}).strict();
const pageQuery = {
  page: z.coerce.number().int().min(1).max(1000).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(25),
};
export const adminCustomerQuerySchema = z.object({
  search: z.string().trim().max(200).optional(),
  status: z.enum(["ACTIVE", "DISABLED"]).optional(),
  marketing: z.enum(["SUBSCRIBED", "NOT_SUBSCRIBED"]).optional(),
  segment: z.enum(["NEW", "REPEAT", "HIGH_VALUE", "AT_RISK"]).optional(),
  tag: z.string().trim().min(1).max(40).optional(),
  sortBy: z.enum(["createdAt", "name", "orders", "spent", "lastOrderAt"]).default("createdAt"),
  sortOrder: z.enum(["asc", "desc"]).default("desc"),
  ...pageQuery,
}).strict();
export const adminCustomerUpdateSchema = z.object({
  tags: z.array(z.string().trim().min(1).max(40)).max(20).optional(),
  note: z.string().trim().max(2000).nullable().optional(),
  marketingConsent: z.boolean().optional(),
  accountStatus: z.enum(["ACTIVE", "DISABLED"]).optional(),
}).strict().refine((value) => Object.keys(value).length > 0, {
  message: "Provide at least one customer field to update",
});
export const adminReturnQuerySchema = z.object({
  search: z.string().trim().max(200).optional(),
  status: z.enum(["REQUESTED", "APPROVED", "REJECTED", "RECEIVED", "REFUNDED"]).optional(),
  ...pageQuery,
}).strict();
export const adminSupportQuerySchema = z.object({
  search: z.string().trim().max(200).optional(),
  status: z.enum(["OPEN", "WAITING_CUSTOMER", "RESOLVED", "CLOSED"]).optional(),
  priority: z.enum(["LOW", "NORMAL", "HIGH"]).optional(),
  ...pageQuery,
}).strict();
export const supportInternalNoteSchema = z.object({
  message: z.string().trim().min(1).max(5000),
}).strict();
export const supportUpdateSchema = z.object({
  status: z.enum(["OPEN", "WAITING_CUSTOMER", "RESOLVED", "CLOSED"]).optional(),
  priority: z.enum(["LOW", "NORMAL", "HIGH"]).optional(),
}).strict().refine((value) => Object.keys(value).length > 0, {
  message: "Provide a status or priority",
});
export const accountDeletionSchema = z.object({
  confirmation: z.literal("DELETE"),
  googleCredential: z.string().min(100).max(10000),
}).strict();
export { storefrontConfigSchema } from "./storefront-config.js";
export { promotionConfigSchema, recommendationRequestSchema } from "./promotions.js";
export { paymentClientEventSchema, paymentRetrySchema, paymentReconcileSchema } from "./payment-lifecycle.js";
