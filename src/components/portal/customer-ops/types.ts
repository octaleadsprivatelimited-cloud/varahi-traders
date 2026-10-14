export type Pagination = {
  page: number;
  limit: number;
  total: number;
  totalPages: number;
  hasNextPage?: boolean;
  hasPreviousPage?: boolean;
};

export type Facet = { value: string; count: number };
export type Facets = Record<string, Facet[]>;
export type CurrencySpend = {
  currency: string;
  totalSpent: number;
  averageOrderValue?: number;
  paidOrderCount?: number;
};

export type CustomerStatus = "ACTIVE" | "DISABLED";
export type CustomerSegment = "NEW" | "REPEAT" | "HIGH_VALUE" | "AT_RISK";

export type CustomerListItem = {
  id: string;
  name: string;
  email: string;
  mobile: string | null;
  accountStatus: CustomerStatus;
  marketingConsent: boolean;
  marketingConsentUpdatedAt: string | null;
  tags: string[];
  createdAt: string | null;
  updatedAt: string | null;
  metrics: {
    orderCount: number;
    totalSpent: number;
    averageOrderValue: number;
    lastOrderAt: string | null;
    currency: string;
    spendByCurrency?: CurrencySpend[];
  };
  segments: string[];
};

export type CustomerListResponse = {
  items: CustomerListItem[];
  pagination: Pagination;
  summary: {
    totalCustomers: number;
    activeCustomers: number;
    disabledCustomers: number;
    subscribedCustomers: number;
    totalSpent: number;
    currency: string;
    spendByCurrency?: Array<{ currency: string; totalSpent: number }>;
  };
  facets: Facets;
};

export type CustomerSegmentItem = {
  id: CustomerSegment | string;
  name: string;
  description: string;
  count: number;
};

export type CustomerSegmentsResponse = {
  items: CustomerSegmentItem[];
  generatedAt: string;
};

export type CustomerAddress = {
  id?: string;
  label?: string | null;
  name?: string | null;
  phone?: string | null;
  line1?: string | null;
  line2?: string | null;
  city?: string | null;
  state?: string | null;
  postalCode?: string | null;
  country?: string | null;
  gstin?: string | null;
  isDefault?: boolean;
};

export type CustomerOrder = {
  id: string;
  number: string;
  status: string;
  total: number;
  currency: string;
  createdAt: string;
  itemCount: number;
  detached: false;
};

export type CustomerDetail = CustomerListItem & {
  note: string | null;
  addresses: CustomerAddress[];
  orders: CustomerOrder[];
  returns: Array<{
    id: string;
    orderId: string;
    orderNumber: string | null;
    status: string;
    reason: string;
    createdAt: string;
  }>;
  supportTickets: Array<{
    id: string;
    number: string;
    subject: string;
    status: string;
    priority: string;
    updatedAt: string;
  }>;
  retention: {
    purchaseHistoryOwnerRetainedAfterDeletion: true;
    customerIdentityDeletedOnAccountDeletion: true;
  };
};

export type ReturnStatus =
  "REQUESTED" | "APPROVED" | "REJECTED" | "RECEIVED" | "REFUNDED";
export type ReturnListItem = {
  id: string;
  status: ReturnStatus;
  reason: string;
  notes: string | null;
  createdAt: string;
  updatedAt: string;
  itemCount: number;
  order: {
    id: string;
    number: string;
    status: string;
    total: number;
    currency: string;
  } | null;
  customer: {
    id: string;
    name: string;
    email: string;
    mobile: string | null;
  } | null;
  refund: {
    id: string;
    status: string;
    amount: number;
    currency: string;
  } | null;
};

export type ReturnListResponse = {
  items: ReturnListItem[];
  pagination: Pagination;
  facets: Facets;
};

export type ReturnDetail = ReturnListItem & {
  items: Array<{
    id: string;
    orderItemId: string;
    name: string;
    sku: string;
    quantity: number;
    condition: string | null;
  }>;
};

export type TicketStatus = "OPEN" | "WAITING_CUSTOMER" | "RESOLVED" | "CLOSED";
export type TicketPriority = "LOW" | "NORMAL" | "HIGH";
export type TicketMessage = {
  id: string;
  body: string;
  internal: boolean;
  createdAt: string;
  author: { id: string; name: string; role: string } | null;
};

export type TicketListItem = {
  id: string;
  number: string;
  subject: string;
  priority: TicketPriority;
  status: TicketStatus;
  createdAt: string;
  updatedAt: string;
  lastMessageAt: string;
  messageCount: number;
  customer: {
    id: string;
    name: string;
    email: string;
    mobile: string | null;
  } | null;
};

export type TicketListResponse = {
  items: TicketListItem[];
  pagination: Pagination;
  facets: Facets;
};

export type TicketDetail = TicketListItem & {
  messages: TicketMessage[];
};
