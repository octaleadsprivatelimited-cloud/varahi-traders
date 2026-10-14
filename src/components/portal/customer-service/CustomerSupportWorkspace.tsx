import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  AlertCircle,
  ArrowLeft,
  ChevronRight,
  Clock3,
  LifeBuoy,
  MessageCircle,
  Plus,
  RefreshCw,
  Search,
  Send,
  X,
} from "lucide-react";
import { toast } from "sonner";
import { commerceApi } from "@/lib/commerce-api";
import {
  CustomerServiceState,
  CustomerStatus,
  formatAccountDate,
  humanize,
  toCustomerServiceError,
  type CustomerServiceError,
} from "./shared";
import type {
  CustomerSupportTicket,
  SupportPriority,
} from "./types";

export function CustomerSupportWorkspace() {
  const [tickets, setTickets] = useState<CustomerSupportTicket[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<CustomerServiceError | null>(null);
  const [search, setSearch] = useState("");
  const [showCreate, setShowCreate] = useState(false);
  const [subject, setSubject] = useState("");
  const [priority, setPriority] = useState<SupportPriority>("NORMAL");
  const [message, setMessage] = useState("");
  const [reply, setReply] = useState("");
  const [mutation, setMutation] = useState<"create" | "reply" | null>(null);
  const [formError, setFormError] = useState("");
  const [replyError, setReplyError] = useState("");
  const requestVersion = useRef(0);
  const subjectRef = useRef<HTMLInputElement>(null);

  const load = useCallback(async (initial = false) => {
    const version = ++requestVersion.current;
    if (initial) setLoading(true);
    else setRefreshing(true);
    setError(null);
    try {
      const data = await commerceApi<CustomerSupportTicket[]>(
        "/api/v1/account/support",
      );
      if (version !== requestVersion.current) return;
      const sorted = [...data].sort((left, right) =>
        right.updatedAt.localeCompare(left.updatedAt),
      );
      setTickets(sorted);
      setSelectedId((current) =>
        current && sorted.some((ticket) => ticket.id === current)
          ? current
          : sorted[0]?.id || null,
      );
    } catch (value) {
      if (version === requestVersion.current)
        setError(
          toCustomerServiceError(value, "Your support tickets could not be loaded."),
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

  const selected = tickets.find((ticket) => ticket.id === selectedId) || null;
  const filteredTickets = useMemo(() => {
    const query = search.trim().toLowerCase();
    if (!query) return tickets;
    return tickets.filter(
      (ticket) =>
        ticket.subject.toLowerCase().includes(query) ||
        ticket.number.toLowerCase().includes(query),
    );
  }, [search, tickets]);
  const openCount = tickets.filter((ticket) => ticket.status === "OPEN").length;
  const waitingCount = tickets.filter(
    (ticket) => ticket.status === "WAITING_CUSTOMER",
  ).length;
  const resolvedCount = tickets.filter((ticket) =>
    ["RESOLVED", "CLOSED"].includes(ticket.status),
  ).length;

  const openCreate = () => {
    setFormError("");
    setShowCreate(true);
    window.setTimeout(() => subjectRef.current?.focus(), 0);
  };

  const resetCreate = () => {
    setShowCreate(false);
    setSubject("");
    setPriority("NORMAL");
    setMessage("");
    setFormError("");
  };

  const createTicket = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const cleanSubject = subject.trim();
    const cleanMessage = message.trim();
    if (cleanSubject.length < 3 || cleanMessage.length < 5) {
      setFormError(
        "Add a subject of at least 3 characters and a message of at least 5 characters.",
      );
      return;
    }
    if (mutation) return;
    setMutation("create");
    setFormError("");
    try {
      const created = await commerceApi<CustomerSupportTicket>(
        "/api/v1/account/support",
        {
          method: "POST",
          body: JSON.stringify({
            subject: cleanSubject,
            message: cleanMessage,
            priority,
          }),
        },
      );
      setTickets((current) => [
        created,
        ...current.filter((ticket) => ticket.id !== created.id),
      ]);
      setSelectedId(created.id);
      resetCreate();
      toast.success(`Support ticket ${created.number} created`);
    } catch (value) {
      setFormError(
        toCustomerServiceError(value, "Your ticket could not be created.").message,
      );
    } finally {
      setMutation(null);
    }
  };

  const sendReply = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!selected || mutation) return;
    const submitted = reply.trim();
    if (!submitted) {
      setReplyError("Write a message before sending your reply.");
      return;
    }
    setMutation("reply");
    setReplyError("");
    try {
      const updated = await commerceApi<CustomerSupportTicket>(
        `/api/v1/account/support/${encodeURIComponent(selected.id)}/replies`,
        {
          method: "POST",
          body: JSON.stringify({ message: submitted }),
        },
      );
      setTickets((current) =>
        [updated, ...current.filter((ticket) => ticket.id !== updated.id)].sort(
          (left, right) => right.updatedAt.localeCompare(left.updatedAt),
        ),
      );
      setReply((current) => (current.trim() === submitted ? "" : current));
      toast.success("Reply sent");
    } catch (value) {
      setReplyError(
        toCustomerServiceError(value, "Your reply could not be sent.").message,
      );
    } finally {
      setMutation(null);
    }
  };

  return (
    <div className="customer-service-workspace">
      <div className="customer-service-heading">
        <div>
          <p className="portal-eyebrow">Customer care</p>
          <h2>Support</h2>
          <span>Start a conversation and keep every update in one place.</span>
        </div>
        <div className="customer-service-heading-actions">
          <button
            className="secondary"
            type="button"
            onClick={() => void load(false)}
            disabled={loading || refreshing || Boolean(mutation)}
          >
            <RefreshCw className={refreshing ? "spin" : ""} />
            {refreshing ? "Updating…" : "Refresh"}
          </button>
          <button
            className="primary"
            type="button"
            onClick={openCreate}
            disabled={showCreate || Boolean(mutation)}
            aria-expanded={showCreate}
            aria-controls="customer-ticket-form"
          >
            <Plus /> New ticket
          </button>
        </div>
      </div>

      {!loading && !error && (
        <div className="customer-service-metrics" aria-label="Support summary">
          <article className="panel">
            <LifeBuoy />
            <span>
              <small>Open</small>
              <b>{openCount}</b>
            </span>
          </article>
          <article className="panel">
            <Clock3 />
            <span>
              <small>Waiting for you</small>
              <b>{waitingCount}</b>
            </span>
          </article>
          <article className="panel">
            <MessageCircle />
            <span>
              <small>Resolved</small>
              <b>{resolvedCount}</b>
            </span>
          </article>
        </div>
      )}

      {error && tickets.length > 0 && (
        <div className="customer-service-inline-alert" role="alert">
          <AlertCircle />
          <span>{error.message}</span>
          <button type="button" onClick={() => void load(false)}>
            Try again
          </button>
        </div>
      )}

      {showCreate && (
        <form
          id="customer-ticket-form"
          className="panel customer-service-create"
          onSubmit={(event) => void createTicket(event)}
        >
          <header>
            <div>
              <p className="portal-eyebrow">New conversation</p>
              <h3>How can we help?</h3>
              <span>Share enough detail for the care team to get started.</span>
            </div>
            <button
              type="button"
              className="customer-service-icon-button"
              onClick={resetCreate}
              aria-label="Close new ticket form"
              disabled={mutation === "create"}
            >
              <X />
            </button>
          </header>
          <div className="customer-ticket-form-grid">
            <label>
              Subject
              <input
                ref={subjectRef}
                value={subject}
                onChange={(event) => setSubject(event.target.value)}
                minLength={3}
                maxLength={160}
                placeholder="For example, help with my delivery"
                required
                disabled={mutation === "create"}
              />
              <small>{subject.length}/160 characters</small>
            </label>
            <label>
              Priority
              <select
                value={priority}
                onChange={(event) =>
                  setPriority(event.target.value as SupportPriority)
                }
                disabled={mutation === "create"}
              >
                <option value="LOW">Low — general question</option>
                <option value="NORMAL">Normal — help needed</option>
                <option value="HIGH">High — urgent issue</option>
              </select>
            </label>
            <label className="customer-ticket-message">
              Message
              <textarea
                value={message}
                onChange={(event) => setMessage(event.target.value)}
                minLength={5}
                maxLength={5000}
                rows={5}
                placeholder="Tell us what happened and what you need help with"
                required
                disabled={mutation === "create"}
              />
              <small>{message.length}/5000 characters</small>
            </label>
          </div>
          {formError && (
            <p className="customer-service-form-error" role="alert">
              <AlertCircle /> {formError}
            </p>
          )}
          <footer>
            <button
              className="secondary"
              type="button"
              onClick={resetCreate}
              disabled={mutation === "create"}
            >
              Cancel
            </button>
            <button
              className="primary"
              type="submit"
              disabled={mutation === "create"}
            >
              {mutation === "create" ? (
                <RefreshCw className="spin" />
              ) : (
                <Send />
              )}
              {mutation === "create" ? "Creating ticket…" : "Create ticket"}
            </button>
          </footer>
        </form>
      )}

      <CustomerServiceState
        loading={loading}
        error={error && !tickets.length ? error : null}
        empty={!tickets.length}
        emptyTitle="No support conversations yet"
        emptyBody="Create a ticket whenever you need help from the store team."
        onRetry={() => void load(true)}
      >
        <section
          className={`panel customer-support-layout${selected ? " has-selection" : ""}`}
        >
          <aside className="customer-support-list" aria-label="Support tickets">
            <header>
              <div>
                <h3>Your tickets</h3>
                <p>{tickets.length} total</p>
              </div>
              <label>
                <Search />
                <span className="sr-only">Search tickets</span>
                <input
                  type="search"
                  value={search}
                  onChange={(event) => setSearch(event.target.value)}
                  placeholder="Search"
                />
              </label>
            </header>
            {filteredTickets.length ? (
              <div className="customer-support-ticket-buttons">
                {filteredTickets.map((ticket) => (
                  <button
                    type="button"
                    className={ticket.id === selectedId ? "active" : ""}
                    aria-current={ticket.id === selectedId ? "true" : undefined}
                    onClick={() => {
                      setSelectedId(ticket.id);
                      setReplyError("");
                    }}
                    key={ticket.id}
                  >
                    <span>
                      <small>{ticket.number}</small>
                      <b>{ticket.subject}</b>
                      <time dateTime={ticket.updatedAt}>
                        Updated {formatAccountDate(ticket.updatedAt)}
                      </time>
                    </span>
                    <span>
                      <CustomerStatus value={ticket.status} />
                      <ChevronRight />
                    </span>
                  </button>
                ))}
              </div>
            ) : (
              <div className="customer-support-search-empty">
                <Search />
                <b>No matching tickets</b>
                <p>Try another ticket number or subject.</p>
              </div>
            )}
          </aside>

          {selected ? (
            <article className="customer-support-conversation">
              <header>
                <button
                  className="customer-support-mobile-back"
                  type="button"
                  onClick={() => setSelectedId(null)}
                  aria-label="Back to support tickets"
                >
                  <ArrowLeft />
                </button>
                <div>
                  <small>{selected.number}</small>
                  <h3>{selected.subject}</h3>
                  <p>
                    {humanize(selected.priority)} priority · Opened {" "}
                    {formatAccountDate(selected.createdAt)}
                  </p>
                </div>
                <CustomerStatus value={selected.status} />
              </header>
              <div
                className="customer-support-messages"
                aria-label="Conversation history"
              >
                {selected.messages.map((entry) => (
                  <article key={entry.id}>
                    <span>
                      <MessageCircle /> Conversation update
                    </span>
                    <p>{entry.body}</p>
                    <time dateTime={entry.createdAt}>
                      {formatAccountDate(entry.createdAt, true)}
                    </time>
                  </article>
                ))}
              </div>
              <form
                className="customer-support-reply"
                onSubmit={(event) => void sendReply(event)}
              >
                {["RESOLVED", "CLOSED"].includes(selected.status) && (
                  <p className="customer-support-reopen-note">
                    Sending a reply will reopen this conversation.
                  </p>
                )}
                <label>
                  Reply to the care team
                  <textarea
                    value={reply}
                    onChange={(event) => setReply(event.target.value)}
                    maxLength={5000}
                    rows={4}
                    placeholder="Write your message"
                    disabled={mutation === "reply"}
                  />
                  <small>{reply.length}/5000 characters</small>
                </label>
                {replyError && (
                  <p className="customer-service-form-error" role="alert">
                    <AlertCircle /> {replyError}
                  </p>
                )}
                <button
                  className="primary"
                  type="submit"
                  disabled={!reply.trim() || mutation === "reply"}
                >
                  {mutation === "reply" ? (
                    <RefreshCw className="spin" />
                  ) : (
                    <Send />
                  )}
                  {mutation === "reply" ? "Sending…" : "Send reply"}
                </button>
              </form>
            </article>
          ) : (
            <div className="customer-support-no-selection">
              <LifeBuoy />
              <h3>Choose a conversation</h3>
              <p>Select a support ticket to read its messages and reply.</p>
            </div>
          )}
        </section>
      </CustomerServiceState>
    </div>
  );
}
