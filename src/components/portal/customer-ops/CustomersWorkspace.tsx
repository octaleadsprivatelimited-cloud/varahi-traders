import { useEffect, useMemo, useRef, useState } from "react";
import {
  CalendarPlus,
  ChevronRight,
  CircleDollarSign,
  Mail,
  Megaphone,
  NotebookPen,
  RefreshCw,
  Save,
  Search,
  ShieldCheck,
  ShoppingBag,
  Tag,
  UserCheck,
  Users,
} from "lucide-react";
import { toast } from "sonner";
import { commerceApi } from "@/lib/commerce-api";
import {
  CurrencyAmounts,
  DetailDrawer,
  MetricStrip,
  PaginationControls,
  StatusBadge,
  WorkspaceState,
  formatCurrency,
  formatDate,
  initials,
  toQuery,
  useClampedPage,
  useDebouncedValue,
  useLiveResource,
  useMountedRef,
} from "./shared";
import type {
  CustomerDetail,
  CustomerListItem,
  CustomerListResponse,
  CustomerSegment,
  CustomerSegmentsResponse,
  CustomerStatus,
} from "./types";

const LIMIT = 20;

export function CustomersWorkspace() {
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState<"" | CustomerStatus>("");
  const [marketing, setMarketing] = useState<
    "" | "SUBSCRIBED" | "NOT_SUBSCRIBED"
  >("");
  const [segment, setSegment] = useState<"" | CustomerSegment>("");
  const [tag, setTag] = useState("");
  const [sort, setSort] = useState("lastOrderAt:desc");
  const [page, setPage] = useState(1);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const debouncedSearch = useDebouncedValue(search);
  const [sortBy, sortOrder] = sort.split(":");
  const url = useMemo(
    () =>
      `/api/v1/admin/customers${toQuery({
        search: debouncedSearch,
        status,
        marketing,
        segment,
        tag,
        sortBy,
        sortOrder,
        page,
        limit: LIMIT,
      })}`,
    [debouncedSearch, status, marketing, segment, tag, sortBy, sortOrder, page],
  );
  const customers = useLiveResource<CustomerListResponse>(url);
  const segments = useLiveResource<CustomerSegmentsResponse>(
    "/api/v1/admin/customer-segments",
  );
  const data = customers.data;
  const tags = data?.facets.tags || [];
  useClampedPage({
    page,
    pagination: data?.pagination,
    itemCount: data?.items.length || 0,
    ready: customers.resolvedUrl === url,
    onPage: setPage,
  });

  const total = data?.summary.totalCustomers;
  const activeCustomers = data?.summary.activeCustomers;
  const subscribed = data?.summary.subscribedCustomers;
  const summarySpending = data
    ? data.summary.spendByCurrency?.length
      ? data.summary.spendByCurrency
      : [
          {
            currency: data.summary.currency,
            totalSpent: data.summary.totalSpent,
          },
        ]
    : [];
  const metrics = [
    total !== undefined
      ? {
          label: "Customers",
          value: total.toLocaleString("en-IN"),
          icon: Users,
        }
      : null,
    activeCustomers !== undefined
      ? {
          label: "Active accounts",
          value: activeCustomers.toLocaleString("en-IN"),
          icon: UserCheck,
        }
      : null,
    subscribed !== undefined
      ? {
          label: "Marketing subscribers",
          value: subscribed.toLocaleString("en-IN"),
          icon: Megaphone,
        }
      : null,
    summarySpending.length
      ? {
          label: "Customer lifetime sales",
          value: <CurrencyAmounts amounts={summarySpending} />,
          icon: CircleDollarSign,
        }
      : null,
  ].filter((item): item is NonNullable<typeof item> => Boolean(item));

  const resetPage = () => setPage(1);
  const filtersApplied = Boolean(
    status || marketing || segment || tag || search,
  );
  const clearFilters = () => {
    setSearch("");
    setStatus("");
    setMarketing("");
    setSegment("");
    setTag("");
    setPage(1);
  };

  return (
    <div className="ops-workspace">
      <div className="ops-heading">
        <div>
          <p className="portal-eyebrow">Customer relationships</p>
          <h2>Customers</h2>
          <span>Understand each customer and keep service personal.</span>
        </div>
        <button
          className="secondary"
          type="button"
          onClick={customers.reload}
          disabled={customers.loading || customers.refreshing}
        >
          <RefreshCw
            className={customers.loading || customers.refreshing ? "spin" : ""}
          />
          {customers.refreshing ? "Updating…" : "Refresh"}
        </button>
      </div>

      <MetricStrip items={metrics} />

      {!segments.error && segments.data?.items.length ? (
        <div
          className="ops-segments"
          role="group"
          aria-label="Customer segments"
        >
          <button
            type="button"
            className={!segment ? "active" : ""}
            aria-pressed={!segment}
            onClick={() => {
              setSegment("");
              resetPage();
            }}
          >
            <span>All customers</span>
            {total !== undefined && <b>{total}</b>}
          </button>
          {segments.data.items.map((item) => (
            <button
              type="button"
              className={segment === item.id ? "active" : ""}
              aria-pressed={segment === item.id}
              onClick={() => {
                setSegment(item.id as CustomerSegment);
                resetPage();
              }}
              title={item.description}
              key={item.id}
            >
              <span>{item.name}</span>
              <b>{item.count}</b>
            </button>
          ))}
        </div>
      ) : null}

      <section className="ops-panel">
        <div className="ops-toolbar">
          <label className="ops-search">
            <Search />
            <span className="sr-only">Search customers</span>
            <input
              value={search}
              onChange={(event) => {
                setSearch(event.target.value);
                resetPage();
              }}
              placeholder="Search name, email or mobile"
              type="search"
            />
          </label>
          <label>
            <span>Account</span>
            <select
              value={status}
              onChange={(event) => {
                setStatus(event.target.value as "" | CustomerStatus);
                resetPage();
              }}
            >
              <option value="">All accounts</option>
              <option value="ACTIVE">Active</option>
              <option value="DISABLED">Disabled</option>
            </select>
          </label>
          <label>
            <span>Marketing</span>
            <select
              value={marketing}
              onChange={(event) => {
                setMarketing(
                  event.target.value as "" | "SUBSCRIBED" | "NOT_SUBSCRIBED",
                );
                resetPage();
              }}
            >
              <option value="">Any preference</option>
              <option value="SUBSCRIBED">Subscribed</option>
              <option value="NOT_SUBSCRIBED">Not subscribed</option>
            </select>
          </label>
          {tags.length > 0 && (
            <label>
              <span>Tag</span>
              <select
                value={tag}
                onChange={(event) => {
                  setTag(event.target.value);
                  resetPage();
                }}
              >
                <option value="">All tags</option>
                {tags.map((item) => (
                  <option value={item.value} key={item.value}>
                    {item.value} ({item.count})
                  </option>
                ))}
              </select>
            </label>
          )}
          <label>
            <span>Sort</span>
            <select
              value={sort}
              onChange={(event) => {
                setSort(event.target.value);
                resetPage();
              }}
            >
              <option value="lastOrderAt:desc">Recent orders</option>
              <option value="createdAt:desc">Newest customers</option>
              <option value="spent:desc">Highest spend</option>
              <option value="orders:desc">Most orders</option>
              <option value="name:asc">Name A–Z</option>
            </select>
          </label>
          {filtersApplied && (
            <button className="ops-clear" type="button" onClick={clearFilters}>
              Clear filters
            </button>
          )}
        </div>

        <WorkspaceState
          loading={customers.loading && !data}
          error={customers.error}
          empty={!data?.items.length}
          emptyTitle={
            filtersApplied ? "No matching customers" : "No customers yet"
          }
          emptyBody={
            filtersApplied
              ? "Try removing a filter or searching with fewer details."
              : "Customers will appear here after they create an account or place an order."
          }
          onRetry={customers.reload}
        >
          <div className="ops-table-wrap">
            <table className="ops-table">
              <thead>
                <tr>
                  <th>Customer</th>
                  <th>Account</th>
                  <th>Orders</th>
                  <th>Total spent</th>
                  <th>Last order</th>
                  <th>Tags</th>
                  <th>
                    <span className="sr-only">Open</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {data?.items.map((customer) => (
                  <CustomerRow
                    customer={customer}
                    onOpen={() => setSelectedId(customer.id)}
                    key={customer.id}
                  />
                ))}
              </tbody>
            </table>
          </div>
          <PaginationControls pagination={data?.pagination} onPage={setPage} />
        </WorkspaceState>
      </section>

      <CustomerDrawer
        customerId={selectedId}
        onClose={() => setSelectedId(null)}
        onSaved={customers.reload}
      />
    </div>
  );
}

function CustomerRow({
  customer,
  onOpen,
}: {
  customer: CustomerListItem;
  onOpen: () => void;
}) {
  return (
    <tr>
      <td>
        <button className="ops-person" type="button" onClick={onOpen}>
          <i>{initials(customer.name)}</i>
          <span>
            <b>{customer.name}</b>
            <small>{customer.email}</small>
          </span>
        </button>
      </td>
      <td>
        <StatusBadge value={customer.accountStatus} />
      </td>
      <td>{customer.metrics.orderCount.toLocaleString("en-IN")}</td>
      <td>
        <b>
          <CurrencyAmounts
            amounts={
              customer.metrics.spendByCurrency?.length
                ? customer.metrics.spendByCurrency
                : [
                    {
                      currency: customer.metrics.currency,
                      totalSpent: customer.metrics.totalSpent,
                    },
                  ]
            }
          />
        </b>
      </td>
      <td>{formatDate(customer.metrics.lastOrderAt)}</td>
      <td>
        <div className="ops-tag-list">
          {customer.tags.slice(0, 2).map((item) => (
            <span key={item}>{item}</span>
          ))}
          {customer.tags.length > 2 && (
            <small>+{customer.tags.length - 2}</small>
          )}
          {!customer.tags.length && <small>—</small>}
        </div>
      </td>
      <td>
        <button
          className="ops-open"
          type="button"
          onClick={onOpen}
          aria-label={`Open ${customer.name}`}
        >
          <ChevronRight />
        </button>
      </td>
    </tr>
  );
}

function CustomerDrawer({
  customerId,
  onClose,
  onSaved,
}: {
  customerId: string | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  return (
    <DetailDrawer
      open={Boolean(customerId)}
      title="Customer details"
      subtitle="Profile, relationship and order history"
      onClose={onClose}
    >
      {customerId && (
        <CustomerDetailContent customerId={customerId} onSaved={onSaved} />
      )}
    </DetailDrawer>
  );
}

function CustomerDetailContent({
  customerId,
  onSaved,
}: {
  customerId: string;
  onSaved: () => void;
}) {
  const resource = useLiveResource<CustomerDetail>(
    `/api/v1/admin/customers/${encodeURIComponent(customerId)}`,
  );
  const customer = resource.data;
  const [tags, setTags] = useState("");
  const [note, setNote] = useState("");
  const [marketingConsent, setMarketingConsent] = useState(false);
  const [accountStatus, setAccountStatus] = useState<CustomerStatus>("ACTIVE");
  const [confirmDisable, setConfirmDisable] = useState(false);
  const [savingProfile, setSavingProfile] = useState(false);
  const [savingStatus, setSavingStatus] = useState(false);
  const initializedCustomer = useRef<string | null>(null);
  const mounted = useMountedRef();

  useEffect(() => {
    if (!customer || initializedCustomer.current === customer.id) return;
    initializedCustomer.current = customer.id;
    setTags(customer.tags.join(", "));
    setNote(customer.note || "");
    setMarketingConsent(customer.marketingConsent);
    setAccountStatus(customer.accountStatus);
    setConfirmDisable(false);
  }, [customer]);

  const saveProfile = async () => {
    setSavingProfile(true);
    try {
      const updated = await commerceApi<CustomerDetail>(
        `/api/v1/admin/customers/${encodeURIComponent(customerId)}`,
        {
          method: "PATCH",
          body: JSON.stringify({
            tags: tags
              .split(",")
              .map((value) => value.trim())
              .filter(Boolean),
            note: note.trim() || null,
            marketingConsent,
          }),
        },
      );
      if (!mounted.current) {
        onSaved();
        return;
      }
      resource.setData(updated);
      setTags(updated.tags.join(", "));
      setNote(updated.note || "");
      setMarketingConsent(updated.marketingConsent);
      onSaved();
      toast.success("Customer profile saved");
    } catch (error) {
      if (mounted.current)
        toast.error(
          error instanceof Error
            ? error.message
            : "Customer changes could not be saved",
        );
    } finally {
      if (mounted.current) setSavingProfile(false);
    }
  };

  const saveAccountStatus = async () => {
    if (!customer || accountStatus === customer.accountStatus) return;
    if (accountStatus === "DISABLED" && !confirmDisable) return;
    setSavingStatus(true);
    try {
      const updated = await commerceApi<CustomerDetail>(
        `/api/v1/admin/customers/${encodeURIComponent(customerId)}`,
        {
          method: "PATCH",
          body: JSON.stringify({ accountStatus }),
        },
      );
      if (!mounted.current) {
        onSaved();
        return;
      }
      resource.setData(updated);
      setAccountStatus(updated.accountStatus);
      setConfirmDisable(false);
      onSaved();
      toast.success(
        accountStatus === "DISABLED"
          ? "Customer account disabled"
          : "Customer account re-enabled",
      );
    } catch (error) {
      if (mounted.current)
        toast.error(
          error instanceof Error
            ? error.message
            : "Account access could not be updated",
        );
    } finally {
      if (mounted.current) setSavingStatus(false);
    }
  };

  return (
    <WorkspaceState
      loading={resource.loading && !customer}
      error={resource.error}
      empty={!customer}
      emptyTitle="Customer not found"
      emptyBody="This customer may have been deleted or is no longer available."
      onRetry={resource.reload}
    >
      {customer && (
        <div className="ops-detail-stack">
          <section className="ops-customer-identity">
            <i>{initials(customer.name)}</i>
            <div>
              <h3>{customer.name}</h3>
              <a href={`mailto:${customer.email}`}>
                <Mail /> {customer.email}
              </a>
              {customer.mobile && (
                <a href={`tel:${customer.mobile}`}>{customer.mobile}</a>
              )}
              <span>Customer since {formatDate(customer.createdAt)}</span>
            </div>
            <StatusBadge value={customer.accountStatus} />
          </section>

          <section className="ops-detail-metrics">
            <span>
              <small>Orders</small>
              <b>{customer.metrics.orderCount}</b>
            </span>
            <span>
              <small>Total spent</small>
              <b>
                <CurrencyAmounts
                  amounts={
                    customer.metrics.spendByCurrency?.length
                      ? customer.metrics.spendByCurrency
                      : [
                          {
                            currency: customer.metrics.currency,
                            totalSpent: customer.metrics.totalSpent,
                          },
                        ]
                  }
                />
              </b>
            </span>
            <span>
              <small>Last order</small>
              <b>{formatDate(customer.metrics.lastOrderAt)}</b>
            </span>
          </section>

          <section className="ops-detail-card ops-customer-editor">
            <div className="ops-section-head">
              <div>
                <NotebookPen />
                <span>
                  <h3>Relationship notes</h3>
                  <p>Visible only to store staff.</p>
                </span>
              </div>
            </div>
            <label>
              Tags
              <span className="ops-input-icon">
                <Tag />
                <input
                  value={tags}
                  onChange={(event) => setTags(event.target.value)}
                  placeholder="VIP, wholesale, gift buyer"
                />
              </span>
              <small>Separate tags with commas.</small>
            </label>
            <label>
              Private note
              <textarea
                value={note}
                onChange={(event) => setNote(event.target.value)}
                placeholder="Add helpful context for the next conversation"
              />
            </label>
            <div className="ops-form-grid">
              <label className="ops-switch-row">
                <input
                  type="checkbox"
                  checked={marketingConsent}
                  onChange={(event) =>
                    setMarketingConsent(event.target.checked)
                  }
                />
                <span>
                  <b>Marketing subscription</b>
                  <small>Only enable when consent is recorded.</small>
                </span>
              </label>
            </div>
            <button
              className="primary"
              type="button"
              onClick={() => void saveProfile()}
              disabled={savingProfile}
            >
              {savingProfile ? <RefreshCw className="spin" /> : <Save />}
              {savingProfile ? "Saving…" : "Save notes and preferences"}
            </button>
          </section>

          <section className="ops-detail-card ops-account-access">
            <div className="ops-section-head">
              <div>
                <UserCheck />
                <span>
                  <h3>Account access</h3>
                  <p>
                    Managed separately from notes and marketing preferences.
                  </p>
                </span>
              </div>
            </div>
            <label>
              Customer account
              <select
                value={accountStatus}
                onChange={(event) => {
                  setAccountStatus(event.target.value as CustomerStatus);
                  setConfirmDisable(false);
                }}
              >
                <option value="ACTIVE">Active — customer can sign in</option>
                <option value="DISABLED">
                  Disabled — customer cannot sign in
                </option>
              </select>
            </label>
            {customer.accountStatus === "ACTIVE" &&
              accountStatus === "DISABLED" && (
                <div className="ops-disable-warning" role="alert">
                  <p>
                    <b>Disabling immediately signs this customer out.</b> They
                    will not be able to log in until the account is re-enabled.
                    Store-owned order history is retained.
                  </p>
                  <label>
                    <input
                      type="checkbox"
                      checked={confirmDisable}
                      onChange={(event) =>
                        setConfirmDisable(event.target.checked)
                      }
                    />{" "}
                    I understand and want to disable this account.
                  </label>
                </div>
              )}
            <button
              className={
                accountStatus === "DISABLED" ? "secondary danger" : "secondary"
              }
              type="button"
              onClick={() => void saveAccountStatus()}
              disabled={
                savingStatus ||
                accountStatus === customer.accountStatus ||
                (accountStatus === "DISABLED" && !confirmDisable)
              }
            >
              {savingStatus ? <RefreshCw className="spin" /> : <UserCheck />}
              {savingStatus
                ? "Updating access…"
                : accountStatus === "DISABLED"
                  ? "Disable customer account"
                  : "Re-enable customer account"}
            </button>
          </section>

          <section className="ops-detail-card">
            <div className="ops-section-head">
              <div>
                <ShoppingBag />
                <span>
                  <h3>Order history</h3>
                  <p>Transaction records retained by the store.</p>
                </span>
              </div>
            </div>
            {customer.orders?.length ? (
              <div className="ops-compact-list">
                {customer.orders.map((order) => (
                  <article key={order.id}>
                    <span>
                      <b>#{order.number}</b>
                      <small>
                        {formatDate(order.createdAt)} · {order.itemCount}{" "}
                        {order.itemCount === 1 ? "item" : "items"}
                      </small>
                    </span>
                    <span>
                      <StatusBadge value={order.status} />
                      <b>{formatCurrency(order.total, order.currency)}</b>
                    </span>
                  </article>
                ))}
              </div>
            ) : (
              <p className="ops-muted">No orders recorded for this customer.</p>
            )}
          </section>

          <section className="ops-detail-card">
            <div className="ops-section-head">
              <div>
                <CalendarPlus />
                <span>
                  <h3>Saved addresses</h3>
                  <p>Customer-provided delivery details.</p>
                </span>
              </div>
            </div>
            {customer.addresses?.length ? (
              <div className="ops-address-grid">
                {customer.addresses.map((address, index) => (
                  <address key={address.id || index}>
                    <b>
                      {address.label ||
                        (address.isDefault
                          ? "Default address"
                          : `Address ${index + 1}`)}
                    </b>
                    <span>
                      {[
                        address.line1,
                        address.line2,
                        address.city,
                        address.state,
                        address.postalCode,
                        address.country,
                      ]
                        .filter(Boolean)
                        .join(", ")}
                    </span>
                    {address.phone && <small>{address.phone}</small>}
                    {address.gstin && <small>GSTIN {address.gstin}</small>}
                  </address>
                ))}
              </div>
            ) : (
              <p className="ops-muted">No saved addresses.</p>
            )}
          </section>

          <section className="ops-detail-card">
            <div className="ops-section-head">
              <div>
                <Megaphone />
                <span>
                  <h3>Service history</h3>
                  <p>Returns and support conversations.</p>
                </span>
              </div>
            </div>
            <dl className="ops-service-counts">
              <div>
                <dt>Returns</dt>
                <dd>{customer.returns?.length || 0}</dd>
              </div>
              <div>
                <dt>Support tickets</dt>
                <dd>{customer.supportTickets?.length || 0}</dd>
              </div>
            </dl>
          </section>

          {customer.retention?.customerIdentityDeletedOnAccountDeletion &&
            customer.retention?.purchaseHistoryOwnerRetainedAfterDeletion && (
              <section className="ops-retention-note">
                <ShieldCheck />
                <span>
                  <b>Privacy-safe purchase records</b>
                  <p>
                    If this customer deletes their account, their identity is
                    removed while the store’s transaction history remains for
                    accounting and order support.
                  </p>
                </span>
              </section>
            )}
        </div>
      )}
    </WorkspaceState>
  );
}
