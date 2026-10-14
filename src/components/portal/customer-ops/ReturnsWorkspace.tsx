import { useMemo, useState } from "react";
import {
  CheckCircle2,
  ChevronRight,
  Clock3,
  PackageCheck,
  RefreshCw,
  RotateCcw,
  Search,
  XCircle,
} from "lucide-react";
import { toast } from "sonner";
import { commerceApi } from "@/lib/commerce-api";
import {
  DetailDrawer,
  MetricStrip,
  PaginationControls,
  StatusBadge,
  WorkspaceState,
  facetCount,
  formatCurrency,
  formatDate,
  toQuery,
  useClampedPage,
  useDebouncedValue,
  useLiveResource,
  useMountedRef,
} from "./shared";
import type {
  ReturnDetail,
  ReturnListItem,
  ReturnListResponse,
  ReturnStatus,
} from "./types";

const LIMIT = 20;

export function ReturnsWorkspace() {
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState<"" | ReturnStatus>("REQUESTED");
  const [page, setPage] = useState(1);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const debouncedSearch = useDebouncedValue(search);
  const url = useMemo(
    () =>
      `/api/v1/admin/returns${toQuery({
        search: debouncedSearch,
        status,
        page,
        limit: LIMIT,
      })}`,
    [debouncedSearch, status, page],
  );
  const resource = useLiveResource<ReturnListResponse>(url);
  const data = resource.data;
  useClampedPage({
    page,
    pagination: data?.pagination,
    itemCount: data?.items.length || 0,
    ready: resource.resolvedUrl === url,
    onPage: setPage,
  });
  const filtersApplied = Boolean(search || status);
  const metrics = [
    data?.pagination.total !== undefined
      ? {
          label: status ? `${status.toLowerCase()} returns` : "All returns",
          value: data.pagination.total,
          icon: RotateCcw,
        }
      : null,
    facetCount(data?.facets, "statuses", "REQUESTED") !== undefined
      ? {
          label: "Awaiting decision",
          value: facetCount(data?.facets, "statuses", "REQUESTED"),
          icon: Clock3,
        }
      : null,
    facetCount(data?.facets, "statuses", "APPROVED") !== undefined
      ? {
          label: "Approved",
          value: facetCount(data?.facets, "statuses", "APPROVED"),
          icon: PackageCheck,
        }
      : null,
    facetCount(data?.facets, "statuses", "REJECTED") !== undefined
      ? {
          label: "Rejected",
          value: facetCount(data?.facets, "statuses", "REJECTED"),
          icon: XCircle,
        }
      : null,
  ].filter((item): item is NonNullable<typeof item> => Boolean(item));

  return (
    <div className="ops-workspace">
      <div className="ops-heading">
        <div>
          <p className="portal-eyebrow">After-sales care</p>
          <h2>Returns</h2>
          <span>Review customer requests and record a clear decision.</span>
        </div>
        <button
          className="secondary"
          type="button"
          onClick={resource.reload}
          disabled={resource.loading || resource.refreshing}
        >
          <RefreshCw
            className={resource.loading || resource.refreshing ? "spin" : ""}
          />{" "}
          {resource.refreshing ? "Updating…" : "Refresh"}
        </button>
      </div>

      <MetricStrip items={metrics} />

      <section className="ops-panel">
        <div className="ops-toolbar">
          <label className="ops-search">
            <Search />
            <span className="sr-only">Search returns</span>
            <input
              type="search"
              value={search}
              onChange={(event) => {
                setSearch(event.target.value);
                setPage(1);
              }}
              placeholder="Search order, customer or reason"
            />
          </label>
          <label>
            <span>Status</span>
            <select
              value={status}
              onChange={(event) => {
                setStatus(event.target.value as "" | ReturnStatus);
                setPage(1);
              }}
            >
              <option value="">All statuses</option>
              <option value="REQUESTED">Awaiting decision</option>
              <option value="APPROVED">Approved</option>
              <option value="REJECTED">Rejected</option>
              <option value="RECEIVED">Received</option>
              <option value="REFUNDED">Refunded</option>
            </select>
          </label>
        </div>

        <WorkspaceState
          loading={resource.loading && !data}
          error={resource.error}
          empty={!data?.items.length}
          emptyTitle={
            filtersApplied ? "No matching returns" : "No return requests"
          }
          emptyBody={
            filtersApplied
              ? "Try another search or status."
              : "Customer return requests will appear here automatically."
          }
          onRetry={resource.reload}
        >
          <div className="ops-table-wrap">
            <table className="ops-table">
              <thead>
                <tr>
                  <th>Request</th>
                  <th>Customer</th>
                  <th>Reason</th>
                  <th>Requested</th>
                  <th>Status</th>
                  <th>
                    <span className="sr-only">Open</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {data?.items.map((item) => (
                  <ReturnRow
                    item={item}
                    onOpen={() => setSelectedId(item.id)}
                    key={item.id}
                  />
                ))}
              </tbody>
            </table>
          </div>
          <PaginationControls pagination={data?.pagination} onPage={setPage} />
        </WorkspaceState>
      </section>

      <DetailDrawer
        open={Boolean(selectedId)}
        title="Return request"
        subtitle="Review the request before making a decision"
        onClose={() => setSelectedId(null)}
      >
        {selectedId && (
          <ReturnDetailContent
            returnId={selectedId}
            onChanged={resource.reload}
          />
        )}
      </DetailDrawer>
    </div>
  );
}

function ReturnRow({
  item,
  onOpen,
}: {
  item: ReturnListItem;
  onOpen: () => void;
}) {
  return (
    <tr>
      <td>
        <button className="ops-record-title" type="button" onClick={onOpen}>
          <b>{item.order ? `#${item.order.number}` : "Order unavailable"}</b>
          <small>
            {item.itemCount} {item.itemCount === 1 ? "item" : "items"}
          </small>
        </button>
      </td>
      <td>
        <b>{item.customer?.name || "Deleted customer"}</b>
        <small className="ops-cell-subtitle">
          {item.customer?.email || "Identity removed"}
        </small>
      </td>
      <td>
        <span className="ops-clamp">{item.reason}</span>
      </td>
      <td>{formatDate(item.createdAt)}</td>
      <td>
        <StatusBadge value={item.status} />
      </td>
      <td>
        <button
          className="ops-open"
          type="button"
          onClick={onOpen}
          aria-label={`Open return ${item.order ? `for order ${item.order.number}` : item.id}`}
        >
          <ChevronRight />
        </button>
      </td>
    </tr>
  );
}

function ReturnDetailContent({
  returnId,
  onChanged,
}: {
  returnId: string;
  onChanged: () => void;
}) {
  const resource = useLiveResource<ReturnDetail>(
    `/api/v1/admin/returns/${encodeURIComponent(returnId)}`,
  );
  const item = resource.data;
  const [decision, setDecision] = useState<"APPROVED" | "REJECTED" | null>(
    null,
  );
  const [notes, setNotes] = useState("");
  const [receiptConfirmed, setReceiptConfirmed] = useState(false);
  const [saving, setSaving] = useState(false);
  const mounted = useMountedRef();

  const decide = async () => {
    if (!decision) return;
    setSaving(true);
    try {
      const updated = await commerceApi<ReturnDetail>(
        `/api/v1/admin/returns/${encodeURIComponent(returnId)}`,
        {
          method: "PATCH",
          body: JSON.stringify({
            status: decision,
            notes: notes.trim() || undefined,
          }),
        },
      );
      if (!mounted.current) {
        onChanged();
        return;
      }
      resource.setData(updated);
      setDecision(null);
      setNotes("");
      onChanged();
      toast.success(
        decision === "APPROVED" ? "Return approved" : "Return rejected",
      );
    } catch (error) {
      if (mounted.current)
        toast.error(
          error instanceof Error
            ? error.message
            : "The return decision could not be saved",
        );
    } finally {
      if (mounted.current) setSaving(false);
    }
  };

  const markReceived = async () => {
    if (!receiptConfirmed) return;
    setSaving(true);
    try {
      const updated = await commerceApi<ReturnDetail>(
        `/api/v1/admin/returns/${encodeURIComponent(returnId)}`,
        {
          method: "PATCH",
          body: JSON.stringify({
            status: "RECEIVED",
            notes: notes.trim() || undefined,
          }),
        },
      );
      if (!mounted.current) {
        onChanged();
        return;
      }
      resource.setData(updated);
      setNotes("");
      setReceiptConfirmed(false);
      onChanged();
      toast.success("Return marked as received");
    } catch (error) {
      if (mounted.current)
        toast.error(
          error instanceof Error
            ? error.message
            : "The return receipt could not be recorded",
        );
    } finally {
      if (mounted.current) setSaving(false);
    }
  };

  return (
    <WorkspaceState
      loading={resource.loading && !item}
      error={resource.error}
      empty={!item}
      emptyTitle="Return not found"
      emptyBody="This request may no longer be available."
      onRetry={resource.reload}
    >
      {item && (
        <div className="ops-detail-stack">
          <section className="ops-detail-card ops-return-summary">
            <div className="ops-section-head">
              <div>
                <RotateCcw />
                <span>
                  <h3>
                    {item.order
                      ? `Order #${item.order.number}`
                      : "Order record unavailable"}
                  </h3>
                  <p>Requested {formatDate(item.createdAt, true)}</p>
                </span>
              </div>
              <StatusBadge value={item.status} />
            </div>
            <dl className="ops-detail-list">
              <div>
                <dt>Customer</dt>
                <dd>{item.customer?.name || "Deleted customer"}</dd>
              </div>
              <div>
                <dt>Email</dt>
                <dd>{item.customer?.email || "Identity removed"}</dd>
              </div>
              {item.order && (
                <div>
                  <dt>Order total</dt>
                  <dd>
                    {formatCurrency(item.order.total, item.order.currency)}
                  </dd>
                </div>
              )}
              {item.refund && (
                <div>
                  <dt>Refund</dt>
                  <dd>
                    {formatCurrency(item.refund.amount, item.refund.currency)} ·{" "}
                    {item.refund.status.toLowerCase()}
                  </dd>
                </div>
              )}
            </dl>
          </section>

          <section className="ops-detail-card">
            <div className="ops-section-head">
              <div>
                <PackageCheck />
                <span>
                  <h3>Customer’s reason</h3>
                  <p>Submitted with the return request.</p>
                </span>
              </div>
            </div>
            <blockquote className="ops-customer-message">
              {item.reason}
            </blockquote>
            {item.notes && (
              <p className="ops-existing-note">
                <b>Decision note</b>
                {item.notes}
              </p>
            )}
          </section>

          {item.items.length ? (
            <section className="ops-detail-card">
              <div className="ops-section-head">
                <div>
                  <PackageCheck />
                  <span>
                    <h3>Order items</h3>
                    <p>Items recorded against this order.</p>
                  </span>
                </div>
              </div>
              <div className="ops-compact-list">
                {item.items.map((line, index) => (
                  <article key={`${line.sku || line.name}-${index}`}>
                    <span>
                      <b>{line.name}</b>
                      <small>
                        {line.sku || "SKU not recorded"}
                        {line.condition ? ` · ${line.condition}` : ""}
                      </small>
                    </span>
                    <span>
                      <b>× {line.quantity}</b>
                    </span>
                  </article>
                ))}
              </div>
            </section>
          ) : null}

          {item.status === "REQUESTED" ? (
            <section className="ops-detail-card ops-decision-card">
              <div className="ops-section-head">
                <div>
                  <Clock3 />
                  <span>
                    <h3>Make a decision</h3>
                    <p>The customer will see the updated status.</p>
                  </span>
                </div>
              </div>
              <div
                className="ops-decision-options"
                role="group"
                aria-label="Return decision"
              >
                <button
                  type="button"
                  className={decision === "APPROVED" ? "active approve" : ""}
                  aria-pressed={decision === "APPROVED"}
                  onClick={() => setDecision("APPROVED")}
                >
                  <CheckCircle2 /> Approve return
                </button>
                <button
                  type="button"
                  className={decision === "REJECTED" ? "active reject" : ""}
                  aria-pressed={decision === "REJECTED"}
                  onClick={() => setDecision("REJECTED")}
                >
                  <XCircle /> Reject return
                </button>
              </div>
              {decision && (
                <div className="ops-decision-confirm">
                  <label>
                    Decision note <small>(optional)</small>
                    <textarea
                      value={notes}
                      onChange={(event) => setNotes(event.target.value)}
                      placeholder="Add a clear reason or next step"
                    />
                  </label>
                  <p>
                    You are about to mark this return as{" "}
                    <b>{decision.toLowerCase()}</b>.
                  </p>
                  <button
                    className={
                      decision === "REJECTED" ? "primary danger" : "primary"
                    }
                    type="button"
                    onClick={() => void decide()}
                    disabled={saving}
                  >
                    {saving ? (
                      <RefreshCw className="spin" />
                    ) : decision === "APPROVED" ? (
                      <CheckCircle2 />
                    ) : (
                      <XCircle />
                    )}
                    {saving
                      ? "Saving decision…"
                      : `Confirm ${decision.toLowerCase()}`}
                  </button>
                </div>
              )}
            </section>
          ) : item.status === "APPROVED" ? (
            <section className="ops-detail-card ops-decision-card">
              <div className="ops-section-head">
                <div>
                  <PackageCheck />
                  <span>
                    <h3>Record warehouse receipt</h3>
                    <p>
                      Use this only after the returned items physically reach
                      the store.
                    </p>
                  </span>
                </div>
              </div>
              <label>
                Receipt note <small>(optional)</small>
                <textarea
                  value={notes}
                  onChange={(event) => setNotes(event.target.value)}
                  placeholder="Condition, package details or warehouse note"
                  disabled={saving}
                />
              </label>
              <label className="ops-receipt-confirmation">
                <input
                  type="checkbox"
                  checked={receiptConfirmed}
                  onChange={(event) =>
                    setReceiptConfirmed(event.target.checked)
                  }
                  disabled={saving}
                />
                <span>
                  I confirm the selected items have been physically received.
                </span>
              </label>
              <button
                className="primary"
                type="button"
                onClick={() => void markReceived()}
                disabled={saving || !receiptConfirmed}
              >
                {saving ? (
                  <RefreshCw className="spin" />
                ) : (
                  <PackageCheck />
                )}
                {saving ? "Recording receipt…" : "Mark return received"}
              </button>
            </section>
          ) : (
            <section className="ops-resolved-callout">
              <CheckCircle2 />
              <span>
                <b>Decision recorded</b>
                <p>
                  This request has already been {item.status.toLowerCase()}.
                </p>
              </span>
            </section>
          )}
        </div>
      )}
    </WorkspaceState>
  );
}
