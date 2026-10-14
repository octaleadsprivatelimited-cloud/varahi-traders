import { useMemo, useRef, useState } from "react";
import {
  CheckCircle2,
  ChevronRight,
  Clock3,
  Inbox,
  LifeBuoy,
  MessageSquareReply,
  NotebookPen,
  RefreshCw,
  Search,
  Send,
  ShieldAlert,
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
  formatDate,
  initials,
  toQuery,
  useDebouncedValue,
  useClampedPage,
  useLiveResource,
  useMountedRef,
} from "./shared";
import type {
  TicketDetail,
  TicketListItem,
  TicketListResponse,
  TicketPriority,
  TicketStatus,
} from "./types";

const LIMIT = 20;

export function SupportWorkspace() {
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState<"" | TicketStatus>("");
  const [priority, setPriority] = useState<"" | TicketPriority>("");
  const [page, setPage] = useState(1);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const debouncedSearch = useDebouncedValue(search);
  const url = useMemo(
    () =>
      `/api/v1/admin/support${toQuery({
        search: debouncedSearch,
        status,
        priority,
        page,
        limit: LIMIT,
      })}`,
    [debouncedSearch, status, priority, page],
  );
  const resource = useLiveResource<TicketListResponse>(url);
  const data = resource.data;
  useClampedPage({
    page,
    pagination: data?.pagination,
    itemCount: data?.items.length || 0,
    ready: resource.resolvedUrl === url,
    onPage: setPage,
  });
  const filtersApplied = Boolean(search || status || priority);
  const metrics = [
    data?.pagination.total !== undefined
      ? {
          label: filtersApplied ? "Matching tickets" : "All tickets",
          value: data.pagination.total,
          icon: LifeBuoy,
        }
      : null,
    facetCount(data?.facets, "statuses", "OPEN") !== undefined
      ? {
          label: "Open",
          value: facetCount(data?.facets, "statuses", "OPEN"),
          icon: Inbox,
        }
      : null,
    facetCount(data?.facets, "statuses", "WAITING_CUSTOMER") !== undefined
      ? {
          label: "Waiting for customer",
          value: facetCount(data?.facets, "statuses", "WAITING_CUSTOMER"),
          icon: Clock3,
        }
      : null,
    facetCount(data?.facets, "priorities", "HIGH") !== undefined
      ? {
          label: "High priority",
          value: facetCount(data?.facets, "priorities", "HIGH"),
          icon: ShieldAlert,
        }
      : null,
  ].filter((item): item is NonNullable<typeof item> => Boolean(item));

  return (
    <div className="ops-workspace">
      <div className="ops-heading">
        <div>
          <p className="portal-eyebrow">Customer care</p>
          <h2>Support inbox</h2>
          <span>
            Keep customer conversations, ownership and next steps together.
          </span>
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
            <span className="sr-only">Search support tickets</span>
            <input
              type="search"
              value={search}
              onChange={(event) => {
                setSearch(event.target.value);
                setPage(1);
              }}
              placeholder="Search ticket, customer or subject"
            />
          </label>
          <label>
            <span>Status</span>
            <select
              value={status}
              onChange={(event) => {
                setStatus(event.target.value as "" | TicketStatus);
                setPage(1);
              }}
            >
              <option value="">All statuses</option>
              <option value="OPEN">Open</option>
              <option value="WAITING_CUSTOMER">Waiting for customer</option>
              <option value="RESOLVED">Resolved</option>
              <option value="CLOSED">Closed</option>
            </select>
          </label>
          <label>
            <span>Priority</span>
            <select
              value={priority}
              onChange={(event) => {
                setPriority(event.target.value as "" | TicketPriority);
                setPage(1);
              }}
            >
              <option value="">All priorities</option>
              <option value="HIGH">High</option>
              <option value="NORMAL">Normal</option>
              <option value="LOW">Low</option>
            </select>
          </label>
        </div>

        <WorkspaceState
          loading={resource.loading && !data}
          error={resource.error}
          empty={!data?.items.length}
          emptyTitle={
            filtersApplied ? "No matching tickets" : "The inbox is clear"
          }
          emptyBody={
            filtersApplied
              ? "Try another search or filter."
              : "New customer support requests will appear here."
          }
          onRetry={resource.reload}
        >
          <div className="ops-ticket-list">
            {data?.items.map((ticket) => (
              <TicketRow
                ticket={ticket}
                onOpen={() => setSelectedId(ticket.id)}
                key={ticket.id}
              />
            ))}
          </div>
          <PaginationControls pagination={data?.pagination} onPage={setPage} />
        </WorkspaceState>
      </section>

      <DetailDrawer
        open={Boolean(selectedId)}
        title="Support conversation"
        subtitle="Reply, add a private note or update the ticket"
        onClose={() => setSelectedId(null)}
      >
        {selectedId && (
          <TicketDetailContent
            ticketId={selectedId}
            onChanged={resource.reload}
          />
        )}
      </DetailDrawer>
    </div>
  );
}

function TicketRow({
  ticket,
  onOpen,
}: {
  ticket: TicketListItem;
  onOpen: () => void;
}) {
  return (
    <button className="ops-ticket-row" type="button" onClick={onOpen}>
      <i className="ops-avatar">{initials(ticket.customer?.name)}</i>
      <span className="ops-ticket-person">
        <b>{ticket.customer?.name || "Deleted customer"}</b>
        <small>{ticket.customer?.email || "Identity removed"}</small>
      </span>
      <span className="ops-ticket-subject">
        <b>{ticket.subject}</b>
        <small>
          #{ticket.number} · {ticket.messageCount}{" "}
          {ticket.messageCount === 1 ? "message" : "messages"}
        </small>
      </span>
      <StatusBadge value={ticket.priority} />
      <StatusBadge value={ticket.status} />
      <time dateTime={ticket.lastMessageAt}>
        {formatDate(ticket.lastMessageAt, true)}
      </time>
      <ChevronRight />
    </button>
  );
}

function TicketDetailContent({
  ticketId,
  onChanged,
}: {
  ticketId: string;
  onChanged: () => void;
}) {
  const resource = useLiveResource<TicketDetail>(
    `/api/v1/admin/support/${encodeURIComponent(ticketId)}`,
  );
  const ticket = resource.data;
  const [mode, setMode] = useState<"reply" | "note">("reply");
  const [message, setMessage] = useState("");
  const [replyStatus, setReplyStatus] =
    useState<TicketStatus>("WAITING_CUSTOMER");
  const [savingMessage, setSavingMessage] = useState(false);
  const [savingDetails, setSavingDetails] = useState(false);
  const mutationLock = useRef(false);
  const mounted = useMountedRef();
  const mutationBusy = savingMessage || savingDetails;

  const updateDetails = async (patch: {
    status?: TicketStatus;
    priority?: TicketPriority;
  }) => {
    if (mutationLock.current) return;
    mutationLock.current = true;
    const previous = ticket;
    setSavingDetails(true);
    if (ticket) resource.setData({ ...ticket, ...patch });
    try {
      const updated = await commerceApi<TicketDetail>(
        `/api/v1/admin/support/${encodeURIComponent(ticketId)}`,
        { method: "PATCH", body: JSON.stringify(patch) },
      );
      if (!mounted.current) {
        onChanged();
        return;
      }
      resource.setData(updated);
      onChanged();
      toast.success("Ticket updated");
    } catch (error) {
      if (mounted.current && previous) resource.setData(previous);
      if (mounted.current)
        toast.error(
          error instanceof Error
            ? error.message
            : "Ticket details could not be updated",
        );
    } finally {
      mutationLock.current = false;
      if (mounted.current) setSavingDetails(false);
    }
  };

  const sendMessage = async () => {
    const submittedDraft = message;
    const body = submittedDraft.trim();
    if (!body || mutationLock.current) return;
    mutationLock.current = true;
    setSavingMessage(true);
    try {
      const path = mode === "note" ? "internal-notes" : "replies";
      const updated = await commerceApi<TicketDetail>(
        `/api/v1/admin/support/${encodeURIComponent(ticketId)}/${path}`,
        {
          method: "POST",
          body: JSON.stringify(
            mode === "note"
              ? { message: body }
              : { message: body, status: replyStatus },
          ),
        },
      );
      if (!mounted.current) {
        onChanged();
        return;
      }
      resource.setData(updated);
      setMessage((current) => (current === submittedDraft ? "" : current));
      onChanged();
      toast.success(mode === "note" ? "Internal note added" : "Reply sent");
    } catch (error) {
      if (mounted.current)
        toast.error(
          error instanceof Error
            ? error.message
            : "The message could not be saved",
        );
    } finally {
      mutationLock.current = false;
      if (mounted.current) setSavingMessage(false);
    }
  };

  return (
    <WorkspaceState
      loading={resource.loading && !ticket}
      error={resource.error}
      empty={!ticket}
      emptyTitle="Ticket not found"
      emptyBody="This conversation may no longer be available."
      onRetry={resource.reload}
    >
      {ticket && (
        <div className="ops-detail-stack ops-ticket-detail">
          <section className="ops-ticket-header">
            <div>
              <p>#{ticket.number}</p>
              <h3>{ticket.subject}</h3>
              <span>Opened {formatDate(ticket.createdAt, true)}</span>
            </div>
            <div className="ops-ticket-controls">
              <label>
                Priority
                <select
                  aria-label="Ticket priority"
                  value={ticket.priority}
                  disabled={mutationBusy}
                  onChange={(event) =>
                    void updateDetails({
                      priority: event.target.value as TicketPriority,
                    })
                  }
                >
                  <option value="LOW">Low priority</option>
                  <option value="NORMAL">Normal priority</option>
                  <option value="HIGH">High priority</option>
                </select>
              </label>
              <label>
                Status
                <select
                  aria-label="Ticket status"
                  value={ticket.status}
                  disabled={mutationBusy}
                  onChange={(event) =>
                    void updateDetails({
                      status: event.target.value as TicketStatus,
                    })
                  }
                >
                  <option value="OPEN">Open</option>
                  <option value="WAITING_CUSTOMER">Waiting for customer</option>
                  <option value="RESOLVED">Resolved</option>
                  <option value="CLOSED">Closed</option>
                </select>
              </label>
            </div>
          </section>

          <section className="ops-ticket-customer">
            <i>{initials(ticket.customer?.name)}</i>
            <span>
              <b>{ticket.customer?.name || "Deleted customer"}</b>
              <small>
                {ticket.customer?.email || "Customer identity removed"}
              </small>
              {ticket.customer?.mobile && (
                <small>{ticket.customer.mobile}</small>
              )}
            </span>
          </section>

          <section className="ops-thread" aria-label="Conversation history">
            {ticket.messages.length ? (
              ticket.messages.map((entry) => (
                <article
                  className={
                    entry.internal
                      ? "internal"
                      : entry.author?.role === "CUSTOMER"
                        ? "customer"
                        : "staff"
                  }
                  key={entry.id}
                >
                  <div>
                    <i>
                      {entry.internal ? (
                        <NotebookPen />
                      ) : (
                        initials(entry.author?.name)
                      )}
                    </i>
                    <span>
                      <b>
                        {entry.internal
                          ? "Internal note"
                          : entry.author?.name || "System"}
                      </b>
                      <small>
                        {entry.internal
                          ? "Only staff can see this"
                          : entry.author?.role?.toLowerCase() || "Update"}
                      </small>
                    </span>
                    <time dateTime={entry.createdAt}>
                      {formatDate(entry.createdAt, true)}
                    </time>
                  </div>
                  <p>{entry.body}</p>
                </article>
              ))
            ) : (
              <p className="ops-muted">No messages recorded.</p>
            )}
          </section>

          <section className="ops-composer">
            <div
              className="ops-compose-tabs"
              role="group"
              aria-label="Message type"
            >
              <button
                type="button"
                aria-pressed={mode === "reply"}
                className={mode === "reply" ? "active" : ""}
                disabled={mutationBusy}
                onClick={() => setMode("reply")}
              >
                <MessageSquareReply /> Reply to customer
              </button>
              <button
                type="button"
                aria-pressed={mode === "note"}
                className={mode === "note" ? "active" : ""}
                disabled={mutationBusy}
                onClick={() => setMode("note")}
              >
                <NotebookPen /> Internal note
              </button>
            </div>
            <label>
              <span className="sr-only">
                {mode === "reply" ? "Reply" : "Internal note"}
              </span>
              <textarea
                value={message}
                disabled={mutationBusy}
                onChange={(event) => setMessage(event.target.value)}
                placeholder={
                  mode === "reply"
                    ? "Write a clear, helpful reply…"
                    : "Leave context for another staff member…"
                }
              />
            </label>
            <div className="ops-compose-actions">
              {mode === "reply" && (
                <label>
                  After sending
                  <select
                    value={replyStatus}
                    disabled={mutationBusy}
                    onChange={(event) =>
                      setReplyStatus(event.target.value as TicketStatus)
                    }
                  >
                    <option value="WAITING_CUSTOMER">Wait for customer</option>
                    <option value="OPEN">Keep open</option>
                    <option value="RESOLVED">Mark resolved</option>
                    <option value="CLOSED">Close ticket</option>
                  </select>
                </label>
              )}
              <button
                className="primary"
                type="button"
                onClick={() => void sendMessage()}
                disabled={mutationBusy || !message.trim()}
              >
                {savingMessage ? (
                  <RefreshCw className="spin" />
                ) : mode === "reply" ? (
                  <Send />
                ) : (
                  <NotebookPen />
                )}
                {savingMessage
                  ? "Saving…"
                  : mode === "reply"
                    ? "Send reply"
                    : "Add note"}
              </button>
            </div>
          </section>

          {ticket.status === "RESOLVED" && (
            <section className="ops-resolved-callout">
              <CheckCircle2 />
              <span>
                <b>Marked as resolved</b>
                <p>Reopen the ticket if the customer needs more help.</p>
              </span>
            </section>
          )}
        </div>
      )}
    </WorkspaceState>
  );
}
