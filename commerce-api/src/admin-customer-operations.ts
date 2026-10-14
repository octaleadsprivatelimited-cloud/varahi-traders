import { AppError } from "./errors.js";
import type { CommerceStore, StoredOrder, StoredUser } from "./store.js";

export const customerSegmentIds = [
  "NEW",
  "REPEAT",
  "HIGH_VALUE",
  "AT_RISK",
] as const;
export type CustomerSegmentId = (typeof customerSegmentIds)[number];

export type AdminCustomerQuery = {
  search?: string;
  status?: "ACTIVE" | "DISABLED";
  marketing?: "SUBSCRIBED" | "NOT_SUBSCRIBED";
  segment?: CustomerSegmentId;
  tag?: string;
  sortBy?: "createdAt" | "name" | "orders" | "spent" | "lastOrderAt";
  sortOrder?: "asc" | "desc";
  page: number;
  limit: number;
};

type PageQuery = { page: number; limit: number };

export const customerSegmentDefinitions: Array<{
  id: CustomerSegmentId;
  name: string;
  description: string;
}> = [
  {
    id: "NEW",
    name: "New customers",
    description: "Customers who joined within the last 30 days.",
  },
  {
    id: "REPEAT",
    name: "Repeat customers",
    description: "Customers who have placed at least two paid orders.",
  },
  {
    id: "HIGH_VALUE",
    name: "High-value customers",
    description: "Customers with at least ₹5,000 in net lifetime spend.",
  },
  {
    id: "AT_RISK",
    name: "At-risk customers",
    description: "Past purchasers whose latest order was over 90 days ago.",
  },
];

const validDate = (value?: string) => {
  const parsed = value ? Date.parse(value) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : 0;
};

const roundMoney = (value: number) => Math.round(value * 100) / 100;

export function pagination(page: number, limit: number, total: number) {
  const totalPages = Math.max(1, Math.ceil(total / limit));
  return {
    page,
    limit,
    total,
    totalPages,
    hasNextPage: page < totalPages,
    hasPreviousPage: page > 1,
  };
}

export function normalizeCustomerTags(input: unknown) {
  const tags = Array.isArray(input) ? input.filter((tag): tag is string => typeof tag === "string") : [];
  const unique = new Map<string, string>();
  for (const tag of tags) {
    const clean = tag.trim().replace(/\s+/g, " ");
    const key = clean.toLowerCase();
    if (clean && !unique.has(key)) unique.set(key, clean);
  }
  return [...unique.values()].sort((a, b) => a.localeCompare(b));
}

function customerOrders(userId: string, orders: StoredOrder[]) {
  return orders.filter((order) => order.userId === userId);
}

export function customerMetrics(userId: string, orders: StoredOrder[]) {
  const owned = customerOrders(userId, orders);
  const paidStatuses = new Set([
    "PAID",
    "CONFIRMED",
    "PROCESSING",
    "PACKED",
    "SHIPPED",
    "OUT_FOR_DELIVERY",
    "DELIVERED",
    "RETURN_REQUESTED",
    "RETURN_APPROVED",
    "RETURNED",
    "REFUND_PENDING",
  ]);
  const revenueOrders = owned.filter(
    (order) => paidStatuses.has(order.status),
  );
  const spend = new Map<
    string,
    { currency: string; totalSpent: number; paidOrderCount: number }
  >();
  for (const order of revenueOrders) {
      const refunded = (order.payment?.refunds || [])
        .filter((refund) => refund.status === "SUCCEEDED")
        .reduce((value, refund) => value + refund.amount, 0);
      const currency = order.payment?.currency || "INR";
      const current = spend.get(currency) || {
        currency,
        totalSpent: 0,
        paidOrderCount: 0,
      };
      current.totalSpent = roundMoney(
        current.totalSpent + Math.max(0, order.total - refunded),
      );
      current.paidOrderCount += 1;
      spend.set(currency, current);
  }
  const spendByCurrency = [...spend.values()]
    .sort((a, b) => a.currency.localeCompare(b.currency))
    .map((entry) => ({
      ...entry,
      averageOrderValue: entry.paidOrderCount
        ? roundMoney(entry.totalSpent / entry.paidOrderCount)
        : 0,
    }));
  const inr = spendByCurrency.find((entry) => entry.currency === "INR");
  const ordered = owned
    .slice()
    .sort((a, b) => validDate(b.createdAt) - validDate(a.createdAt));
  return {
    orderCount: owned.length,
    totalSpent: inr?.totalSpent || 0,
    averageOrderValue: inr?.averageOrderValue || 0,
    lastOrderAt: ordered[0]?.createdAt || null,
    currency: "INR" as const,
    spendByCurrency,
  };
}

export function customerSegments(
  user: StoredUser,
  orders: StoredOrder[],
  now = new Date(),
) {
  const metrics = customerMetrics(user.id, orders);
  const paidStatuses = new Set([
    "PAID",
    "CONFIRMED",
    "PROCESSING",
    "PACKED",
    "SHIPPED",
    "OUT_FOR_DELIVERY",
    "DELIVERED",
    "RETURN_REQUESTED",
    "RETURN_APPROVED",
    "RETURNED",
    "REFUND_PENDING",
  ]);
  const paidOrders = customerOrders(user.id, orders)
    .filter((order) => paidStatuses.has(order.status))
    .sort((a, b) => validDate(b.createdAt) - validDate(a.createdAt));
  const createdAt = validDate(user.createdAt);
  const lastPaidOrderAt = validDate(paidOrders[0]?.createdAt);
  const thirtyDaysAgo = now.getTime() - 30 * 86_400_000;
  const ninetyDaysAgo = now.getTime() - 90 * 86_400_000;
  return customerSegmentIds.filter((segment) => {
    if (segment === "NEW") return createdAt >= thirtyDaysAgo;
    if (segment === "REPEAT") return paidOrders.length >= 2;
    if (segment === "HIGH_VALUE") return metrics.totalSpent >= 5000;
    return paidOrders.length > 0 &&
      lastPaidOrderAt > 0 && lastPaidOrderAt < ninetyDaysAgo;
  });
}

export function adminCustomerDto(
  user: StoredUser,
  orders: StoredOrder[],
  now = new Date(),
) {
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    mobile: user.mobile || null,
    accountStatus: user.disabledAt ? ("DISABLED" as const) : ("ACTIVE" as const),
    marketingConsent: Boolean(user.marketingConsent),
    marketingConsentUpdatedAt: user.marketingConsentUpdatedAt || null,
    tags: normalizeCustomerTags(user.tags || []),
    createdAt: user.createdAt || null,
    updatedAt: user.updatedAt || user.createdAt || null,
    metrics: customerMetrics(user.id, orders),
    segments: customerSegments(user, orders, now),
  };
}

function count<T extends string>(values: T[]) {
  return [...new Set(values)].sort().map((value) => ({
    value,
    count: values.filter((candidate) => candidate === value).length,
  }));
}

export function listAdminCustomers(
  users: StoredUser[],
  orders: StoredOrder[],
  query: AdminCustomerQuery,
  now = new Date(),
) {
  const customers = users.filter((user) => user.role === "CUSTOMER");
  const allItems = customers.map((user) => adminCustomerDto(user, orders, now));
  const search = query.search?.toLowerCase() || "";
  const searched = allItems.filter((item) =>
    !search ||
    [item.name, item.email, item.mobile || "", ...item.tags]
      .join(" ")
      .toLowerCase()
      .includes(search),
  );
  const tag = query.tag?.toLowerCase();
  const filtered = searched.filter(
    (item) =>
      (!query.status || item.accountStatus === query.status) &&
      (!query.marketing ||
        item.marketingConsent === (query.marketing === "SUBSCRIBED")) &&
      (!query.segment || item.segments.includes(query.segment)) &&
      (!tag || item.tags.some((value) => value.toLowerCase() === tag)),
  );
  const direction = query.sortOrder === "asc" ? 1 : -1;
  const sortBy = query.sortBy || "createdAt";
  filtered.sort((a, b) => {
    if (sortBy === "name")
      return a.name.localeCompare(b.name) * direction || a.id.localeCompare(b.id);
    if (sortBy === "orders")
      return (a.metrics.orderCount - b.metrics.orderCount) * direction ||
        a.id.localeCompare(b.id);
    if (sortBy === "spent")
      return (a.metrics.totalSpent - b.metrics.totalSpent) * direction ||
        a.id.localeCompare(b.id);
    if (sortBy === "lastOrderAt")
      return (validDate(a.metrics.lastOrderAt || undefined) -
        validDate(b.metrics.lastOrderAt || undefined)) * direction ||
        a.id.localeCompare(b.id);
    return (validDate(a.createdAt || undefined) - validDate(b.createdAt || undefined)) *
      direction || a.id.localeCompare(b.id);
  });
  const spend = new Map<string, number>();
  for (const item of allItems)
    for (const entry of item.metrics.spendByCurrency)
      spend.set(
        entry.currency,
        roundMoney((spend.get(entry.currency) || 0) + entry.totalSpent),
      );
  const spendByCurrency = [...spend]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([currency, totalSpent]) => ({ currency, totalSpent }));
  const inrSpend = spend.get("INR") || 0;
  return {
    items: filtered.slice((query.page - 1) * query.limit, query.page * query.limit),
    pagination: pagination(query.page, query.limit, filtered.length),
    summary: {
      totalCustomers: allItems.length,
      activeCustomers: allItems.filter((item) => item.accountStatus === "ACTIVE").length,
      disabledCustomers: allItems.filter((item) => item.accountStatus === "DISABLED").length,
      subscribedCustomers: allItems.filter((item) => item.marketingConsent).length,
      totalSpent: roundMoney(inrSpend),
      currency: "INR" as const,
      spendByCurrency,
    },
    facets: {
      statuses: count(searched.map((item) => item.accountStatus)),
      marketing: count(
        searched.map((item) =>
          item.marketingConsent ? "SUBSCRIBED" : "NOT_SUBSCRIBED",
        ),
      ),
      tags: count(searched.flatMap((item) => item.tags)),
      segments: count(searched.flatMap((item) => item.segments)),
    },
  };
}

export function listCustomerSegments(
  users: StoredUser[],
  orders: StoredOrder[],
  now = new Date(),
) {
  const customers = users.filter((user) => user.role === "CUSTOMER");
  return {
    items: customerSegmentDefinitions.map((definition) => ({
      ...definition,
      count: customers.filter((user) =>
        customerSegments(user, orders, now).includes(definition.id),
      ).length,
    })),
    generatedAt: now.toISOString(),
  };
}

export function adminCustomerDetail(store: CommerceStore, id: string) {
  const user = store.users.get(id);
  if (!user || user.role !== "CUSTOMER")
    throw new AppError(404, "CUSTOMER_NOT_FOUND", "Customer not found");
  const orders = [...store.orders.values()]
    .filter((order) => order.userId === id)
    .sort((a, b) => validDate(b.createdAt) - validDate(a.createdAt));
  const returns = [...store.returns.values()]
    .filter((item) => item.userId === id)
    .sort((a, b) => validDate(b.createdAt) - validDate(a.createdAt));
  const tickets = [...store.supportTickets.values()]
    .filter((ticket) => ticket.userId === id)
    .sort((a, b) =>
      validDate(b.updatedAt || b.createdAt) - validDate(a.updatedAt || a.createdAt),
    );
  return {
    ...adminCustomerDto(user, [...store.orders.values()]),
    note: user.note || null,
    addresses: (store.addresses.get(id) || []).map((address) => ({ ...address })),
    orders: orders.slice(0, 100).map((order) => ({
      id: order.id,
      number: order.number,
      status: order.status,
      total: order.total,
      currency: order.payment?.currency || "INR",
      itemCount: order.lines.reduce((sum, line) => sum + line.quantity, 0),
      createdAt: order.createdAt,
      detached: false,
    })),
    returns: returns.slice(0, 50).map((item) => ({
      id: item.id,
      orderId: item.orderId,
      orderNumber: store.orders.get(item.orderId)?.number || null,
      status: item.status,
      reason: item.reason,
      createdAt: item.createdAt,
    })),
    supportTickets: tickets.slice(0, 50).map((ticket) => ({
      id: ticket.id,
      number: ticket.number,
      subject: ticket.subject,
      status: ticket.status,
      priority: ticket.priority,
      updatedAt: ticket.updatedAt || ticket.createdAt,
    })),
    counts: {
      orders: orders.length,
      returns: returns.length,
      supportTickets: tickets.length,
    },
    retention: {
      purchaseHistoryOwnerRetainedAfterDeletion: true,
      customerIdentityDeletedOnAccountDeletion: true,
    },
  };
}

function includes(value: string, search: string) {
  return !search || value.toLowerCase().includes(search);
}

export function listAdminReturns(
  store: CommerceStore,
  query: PageQuery & { search?: string; status?: string },
) {
  const search = query.search?.toLowerCase() || "";
  const all = [...store.returns.values()].map((item) => {
    const order = store.orders.get(item.orderId);
    const customer = item.userId ? store.users.get(item.userId) : undefined;
    const refund = order?.payment?.refunds?.find(
      (candidate) => candidate.returnRequestId === item.id,
    );
    return {
      id: item.id,
      status: item.status,
      reason: item.reason,
      notes: item.notes || null,
      createdAt: item.createdAt,
      updatedAt: item.updatedAt || item.createdAt,
      itemCount: item.items?.length || 0,
      order: order
        ? {
            id: order.id,
            number: order.number,
            status: order.status,
            total: order.total,
            currency: order.payment?.currency || "INR",
          }
        : null,
      customer: customer
        ? {
            id: customer.id,
            name: customer.name,
            email: customer.email,
            mobile: customer.mobile || null,
          }
        : null,
      refund: refund
        ? {
            id: refund.id,
            status: refund.status,
            amount: refund.amount,
            currency: order?.payment?.currency || "INR",
          }
        : null,
    };
  });
  const searched = all.filter((item) =>
    includes(
      [
        item.id,
        item.reason,
        item.order?.number || "",
        item.customer?.name || "",
        item.customer?.email || "",
      ].join(" "),
      search,
    ),
  );
  const filtered = searched
    .filter((item) => !query.status || item.status === query.status)
    .sort((a, b) => validDate(b.createdAt) - validDate(a.createdAt));
  return {
    items: filtered.slice((query.page - 1) * query.limit, query.page * query.limit),
    pagination: pagination(query.page, query.limit, filtered.length),
    facets: { statuses: count(searched.map((item) => item.status)) },
  };
}

export function adminReturnDetail(store: CommerceStore, id: string) {
  const stored = store.returns.get(id);
  if (!stored)
    throw new AppError(404, "RETURN_NOT_FOUND", "Return request not found");
  const item = listAdminReturns(store, {
    page: 1,
    limit: Math.max(1, store.returns.size),
  }).items.find(
    (candidate) => candidate.id === id,
  );
  if (!item) throw new AppError(404, "RETURN_NOT_FOUND", "Return request not found");
  return {
    ...item,
    items: (stored.items || []).map((entry) => ({
      id: entry.id,
      orderItemId: entry.orderItemId || entry.variantId,
      name: entry.name,
      sku: entry.sku,
      quantity: entry.quantity,
      condition: entry.condition || null,
    })),
  };
}

export function listAdminSupportTickets(
  store: CommerceStore,
  query: PageQuery & { search?: string; status?: string; priority?: string },
) {
  const search = query.search?.toLowerCase() || "";
  const all = [...store.supportTickets.values()].map((ticket) => {
    const customer = ticket.userId ? store.users.get(ticket.userId) : undefined;
    const lastMessage = ticket.messages
      .slice()
      .sort((a, b) => validDate(b.createdAt) - validDate(a.createdAt))[0];
    return {
      id: ticket.id,
      number: ticket.number,
      subject: ticket.subject,
      status: ticket.status,
      priority: ticket.priority,
      createdAt: ticket.createdAt,
      updatedAt: ticket.updatedAt || ticket.createdAt,
      messageCount: ticket.messages.length,
      lastMessageAt: lastMessage?.createdAt || ticket.createdAt,
      customer: customer
        ? {
            id: customer.id,
            name: customer.name,
            email: customer.email,
            mobile: customer.mobile || null,
          }
        : null,
    };
  });
  const searched = all.filter((item) =>
    includes(
      [
        item.number,
        item.subject,
        item.customer?.name || "",
        item.customer?.email || "",
      ].join(" "),
      search,
    ),
  );
  const filtered = searched
    .filter(
      (item) =>
        (!query.status || item.status === query.status) &&
        (!query.priority || item.priority === query.priority),
    )
    .sort((a, b) => validDate(b.updatedAt) - validDate(a.updatedAt));
  return {
    items: filtered.slice((query.page - 1) * query.limit, query.page * query.limit),
    pagination: pagination(query.page, query.limit, filtered.length),
    facets: {
      statuses: count(searched.map((item) => item.status)),
      priorities: count(searched.map((item) => item.priority)),
    },
  };
}

export function adminSupportDetail(store: CommerceStore, id: string) {
  const summary = listAdminSupportTickets(store, {
    page: 1,
    limit: Math.max(1, store.supportTickets.size),
  }).items.find(
    (candidate) => candidate.id === id,
  );
  const ticket = store.supportTickets.get(id);
  if (!summary || !ticket)
    throw new AppError(404, "TICKET_NOT_FOUND", "Support ticket not found");
  return {
    ...summary,
    messages: ticket.messages
      .slice()
      .sort((a, b) => validDate(a.createdAt) - validDate(b.createdAt))
      .slice(-200)
      .map((message) => {
        const author = message.authorId ? store.users.get(message.authorId) : undefined;
        return {
          id: message.id,
          body: message.body,
          internal: message.internal,
          createdAt: message.createdAt,
          author: author
            ? { id: author.id, name: author.name, role: author.role }
            : null,
        };
      }),
  };
}
