import { Link } from "@tanstack/react-router";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  AlertCircle,
  CheckCircle2,
  ChevronDown,
  Clock3,
  PackageCheck,
  Plus,
  RefreshCw,
  RotateCcw,
  X,
  XCircle,
} from "lucide-react";
import { toast } from "sonner";
import { commerceApi } from "@/lib/commerce-api";
import {
  CustomerServiceState,
  CustomerStatus,
  formatAccountDate,
  toCustomerServiceError,
  type CustomerServiceError,
} from "./shared";
import type {
  CustomerOrder,
  CustomerReturn,
  CustomerReturnStatus,
} from "./types";

const activeReturnStatuses = new Set<CustomerReturnStatus>([
  "REQUESTED",
  "APPROVED",
  "RECEIVED",
  "REFUNDED",
]);

const returnGuidance: Record<CustomerReturnStatus, string> = {
  REQUESTED: "Your request is waiting for the store team to review it.",
  APPROVED: "Your return is approved. Follow the store’s return instructions.",
  REJECTED: "The store could not approve this request. See the note below, if provided.",
  RECEIVED: "The returned items have reached the store and are being checked.",
  REFUNDED: "The store has completed the refund for this return.",
};

export function CustomerReturnsWorkspace() {
  const [orders, setOrders] = useState<CustomerOrder[]>([]);
  const [returns, setReturns] = useState<CustomerReturn[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<CustomerServiceError | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [selectedOrderId, setSelectedOrderId] = useState("");
  const [reason, setReason] = useState("");
  const [wholeOrder, setWholeOrder] = useState(true);
  const [quantities, setQuantities] = useState<Record<string, number>>({});
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState("");
  const requestVersion = useRef(0);
  const orderSelectRef = useRef<HTMLSelectElement>(null);

  const load = useCallback(async (initial = false) => {
    const version = ++requestVersion.current;
    if (initial) setLoading(true);
    else setRefreshing(true);
    setError(null);
    try {
      const [orderData, returnData] = await Promise.all([
        commerceApi<CustomerOrder[]>("/api/v1/account/orders"),
        commerceApi<CustomerReturn[]>("/api/v1/account/returns"),
      ]);
      if (version !== requestVersion.current) return;
      setOrders(
        [...orderData].sort((left, right) =>
          right.createdAt.localeCompare(left.createdAt),
        ),
      );
      setReturns(
        [...returnData].sort((left, right) =>
          right.createdAt.localeCompare(left.createdAt),
        ),
      );
    } catch (value) {
      if (version === requestVersion.current)
        setError(
          toCustomerServiceError(value, "Your returns could not be loaded."),
        );
    } finally {
      if (version === requestVersion.current) {
        setLoading(false);
        setRefreshing(false);
      }
    }
  }, []);

  useEffect(() => {
    void load(true);
    return () => {
      requestVersion.current += 1;
    };
  }, [load]);

  const activeOrderIds = useMemo(
    () =>
      new Set(
        returns
          .filter((item) => activeReturnStatuses.has(item.status))
          .map((item) => item.orderId),
      ),
    [returns],
  );
  const eligibleOrders = useMemo(
    () =>
      orders.filter(
        (order) =>
          order.status === "DELIVERED" && !activeOrderIds.has(order.id),
      ),
    [activeOrderIds, orders],
  );
  const selectedOrder = eligibleOrders.find(
    (order) => order.id === selectedOrderId,
  );
  const activeCount = returns.filter((item) =>
    ["REQUESTED", "APPROVED", "RECEIVED"].includes(item.status),
  ).length;
  const completedCount = returns.filter(
    (item) => item.status === "REFUNDED",
  ).length;

  useEffect(() => {
    if (!eligibleOrders.length) {
      setSelectedOrderId("");
      return;
    }
    if (!eligibleOrders.some((order) => order.id === selectedOrderId))
      setSelectedOrderId(eligibleOrders[0].id);
  }, [eligibleOrders, selectedOrderId]);

  const openCreate = () => {
    setSubmitError("");
    setShowCreate(true);
    window.setTimeout(() => orderSelectRef.current?.focus(), 0);
  };

  const resetCreate = () => {
    setShowCreate(false);
    setReason("");
    setWholeOrder(true);
    setQuantities({});
    setSubmitError("");
  };

  const submitReturn = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!selectedOrder) {
      setSubmitError("Choose an eligible delivered order.");
      return;
    }
    const cleanReason = reason.trim();
    if (cleanReason.length < 5) {
      setSubmitError("Please tell us the reason in at least 5 characters.");
      return;
    }
    const selectedItems = selectedOrder.lines
      .map((line) => ({
        variantId: line.variantId,
        quantity: Math.min(
          line.quantity,
          Math.max(0, Math.floor(quantities[line.variantId] || 0)),
        ),
      }))
      .filter((line) => line.quantity > 0);
    if (!wholeOrder && !selectedItems.length) {
      setSubmitError("Choose at least one item and quantity to return.");
      return;
    }

    setSubmitting(true);
    setSubmitError("");
    try {
      const created = await commerceApi<CustomerReturn>(
        "/api/v1/account/returns",
        {
          method: "POST",
          body: JSON.stringify({
            orderId: selectedOrder.id,
            reason: cleanReason,
            ...(!wholeOrder ? { items: selectedItems } : {}),
          }),
        },
      );
      setReturns((current) => [
        created,
        ...current.filter((item) => item.id !== created.id),
      ]);
      resetCreate();
      toast.success(`Return requested for order #${selectedOrder.number}`);
      void load(false);
    } catch (value) {
      const nextError = toCustomerServiceError(
        value,
        "Your return request could not be submitted.",
      );
      setSubmitError(nextError.message);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="customer-service-workspace">
      <div className="customer-service-heading">
        <div>
          <p className="portal-eyebrow">After delivery</p>
          <h2>Returns</h2>
          <span>Report a product issue and follow the review from your account.</span>
        </div>
        <div className="customer-service-heading-actions">
          <button
            className="secondary"
            type="button"
            onClick={() => void load(false)}
            disabled={loading || refreshing}
          >
            <RefreshCw className={refreshing ? "spin" : ""} />
            {refreshing ? "Updating…" : "Refresh"}
          </button>
          <button
            className="primary"
            type="button"
            onClick={openCreate}
            disabled={!eligibleOrders.length || showCreate}
            aria-expanded={showCreate}
            aria-controls="customer-return-form"
          >
            <Plus /> Start a return
          </button>
        </div>
      </div>

      {!loading && !error && (
        <div className="customer-service-metrics" aria-label="Return summary">
          <article className="panel">
            <Clock3 />
            <span>
              <small>In progress</small>
              <b>{activeCount}</b>
            </span>
          </article>
          <article className="panel">
            <CheckCircle2 />
            <span>
              <small>Refunded</small>
              <b>{completedCount}</b>
            </span>
          </article>
          <article className="panel">
            <PackageCheck />
            <span>
              <small>Delivered orders</small>
              <b>{eligibleOrders.length}</b>
            </span>
          </article>
        </div>
      )}

      <p className="customer-service-note">For an undelivered order, contact <Link to="/account" search={{ tab: "Support" }}>order support</Link>. See our <Link to="/shipping-returns">returns and refund policy</Link> for review criteria and available remedies.</p>

      {error && (orders.length > 0 || returns.length > 0) && (
        <div className="customer-service-inline-alert" role="alert">
          <AlertCircle />
          <span>{error.message}</span>
          <button type="button" onClick={() => void load(false)}>
            Try again
          </button>
        </div>
      )}

      {showCreate && selectedOrder && (
        <form
          id="customer-return-form"
          className="panel customer-service-create"
          onSubmit={(event) => void submitReturn(event)}
        >
          <header>
            <div>
              <p className="portal-eyebrow">New request</p>
              <h3>Start a return</h3>
              <span>Select the affected items and describe the problem.</span>
            </div>
            <button
              type="button"
              className="customer-service-icon-button"
              onClick={resetCreate}
              aria-label="Close return form"
              disabled={submitting}
            >
              <X />
            </button>
          </header>
          <p className="customer-service-note">
            Change-of-mind returns, exchanges and refunds are not offered. Requests for damaged, defective, wrong or missing goods are reviewed under our <Link to="/shipping-returns">returns and refund policy</Link>; submitting a request does not guarantee a refund. Statutory remedies remain available.
          </p>
          <div className="customer-return-form-grid">
            <label>
              Delivered order
              <span className="customer-service-select">
                <select
                  ref={orderSelectRef}
                  value={selectedOrderId}
                  onChange={(event) => {
                    setSelectedOrderId(event.target.value);
                    setQuantities({});
                  }}
                  disabled={submitting}
                >
                  {eligibleOrders.map((order) => (
                    <option value={order.id} key={order.id}>
                      #{order.number} · {formatAccountDate(order.createdAt)}
                    </option>
                  ))}
                </select>
                <ChevronDown aria-hidden="true" />
              </span>
            </label>
            <label className="customer-return-reason">
              Reason for return
              <textarea
                value={reason}
                onChange={(event) => setReason(event.target.value)}
                minLength={5}
                maxLength={1000}
                rows={4}
                placeholder="Describe the damage, defect, wrong item or missing contents"
                required
                disabled={submitting}
              />
              <small>{reason.length}/1000 characters</small>
            </label>
          </div>

          <fieldset className="customer-return-items">
            <legend>Items to return</legend>
            <label className="customer-service-check">
              <input
                type="checkbox"
                checked={wholeOrder}
                onChange={(event) => setWholeOrder(event.target.checked)}
                disabled={submitting}
              />
              <span>
                <b>Return the entire order</b>
                <small>All purchased quantities will be included.</small>
              </span>
            </label>
            {!wholeOrder && (
              <div className="customer-return-lines">
                {selectedOrder.lines.map((line) => (
                  <label key={line.variantId}>
                    <span>
                      <b>{line.name}</b>
                      <small>{line.sku || "SKU unavailable"}</small>
                    </span>
                    <span>
                      Quantity
                      <input
                        type="number"
                        inputMode="numeric"
                        min={0}
                        max={line.quantity}
                        step={1}
                        value={quantities[line.variantId] || 0}
                        onChange={(event) =>
                          setQuantities((current) => ({
                            ...current,
                            [line.variantId]: Math.min(
                              line.quantity,
                              Math.max(0, Number(event.target.value) || 0),
                            ),
                          }))
                        }
                        aria-label={`Quantity of ${line.name} to return, maximum ${line.quantity}`}
                        disabled={submitting}
                      />
                      <small>of {line.quantity}</small>
                    </span>
                  </label>
                ))}
              </div>
            )}
          </fieldset>

          {submitError && (
            <p className="customer-service-form-error" role="alert">
              <AlertCircle /> {submitError}
            </p>
          )}
          <footer>
            <button
              className="secondary"
              type="button"
              onClick={resetCreate}
              disabled={submitting}
            >
              Cancel
            </button>
            <button className="primary" type="submit" disabled={submitting}>
              {submitting ? <RefreshCw className="spin" /> : <RotateCcw />}
              {submitting ? "Sending request…" : "Submit return request"}
            </button>
          </footer>
        </form>
      )}

      {!loading && !error && !eligibleOrders.length && !showCreate && (
        <div className="customer-service-note">
          <PackageCheck />
          <span>
            <b>No delivered order is currently eligible</b>
            <p>
              Product issues can be submitted here after delivery for review. Orders with an active return
              are already shown in the history below.
            </p>
          </span>
        </div>
      )}

      <section className="panel customer-service-list-panel">
        <header>
          <div>
            <h3>Return history</h3>
            <p>Live updates from the store team.</p>
          </div>
          {returns.length > 0 && (
            <span aria-live="polite">
              {returns.length} {returns.length === 1 ? "request" : "requests"}
            </span>
          )}
        </header>
        <CustomerServiceState
          loading={loading}
          error={error && orders.length === 0 && returns.length === 0 ? error : null}
          empty={!returns.length}
          emptyTitle="No return requests yet"
          emptyBody="Your submitted returns and their live status will appear here."
          onRetry={() => void load(true)}
        >
          <div className="customer-return-history">
            {returns.map((item) => (
              <ReturnCard
                item={item}
                order={orders.find((order) => order.id === item.orderId)}
                key={item.id}
              />
            ))}
          </div>
        </CustomerServiceState>
      </section>
    </div>
  );
}

function ReturnCard({
  item,
  order,
}: {
  item: CustomerReturn;
  order?: CustomerOrder;
}) {
  return (
    <article className="customer-return-card">
      <header>
        <span className="customer-service-record-icon">
          {item.status === "REJECTED" ? <XCircle /> : <RotateCcw />}
        </span>
        <span>
          <small>Order</small>
          <b>{order ? `#${order.number}` : item.orderId}</b>
          <time dateTime={item.createdAt}>
            Requested {formatAccountDate(item.createdAt)}
          </time>
        </span>
        <CustomerStatus value={item.status} />
      </header>
      <p className="customer-return-guidance">{returnGuidance[item.status]}</p>
      <blockquote>{item.reason}</blockquote>
      {item.items.length > 0 && (
        <div className="customer-return-card-lines">
          {item.items.map((line) => (
            <span key={line.id}>
              <span>
                <b>{line.name}</b>
                <small>
                  {line.sku || "SKU unavailable"}
                  {line.condition ? ` · ${line.condition}` : ""}
                </small>
              </span>
              <b>× {line.quantity}</b>
            </span>
          ))}
        </div>
      )}
      {item.notes && (
        <div className="customer-service-team-note">
          <b>Store note</b>
          <p>{item.notes}</p>
        </div>
      )}
      <footer>
        <span>
          Last updated {formatAccountDate(item.updatedAt, true)}
        </span>
      </footer>
    </article>
  );
}
