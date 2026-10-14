import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import {
  AlertTriangle,
  ChevronLeft,
  ChevronRight,
  Inbox,
  LockKeyhole,
  RefreshCw,
  X,
  type LucideIcon,
} from "lucide-react";
import { CommerceApiError, commerceApi } from "@/lib/commerce-api";

export function useDebouncedValue<T>(value: T, delay = 300) {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = window.setTimeout(() => setDebounced(value), delay);
    return () => window.clearTimeout(timer);
  }, [value, delay]);
  return debounced;
}

export function useMountedRef() {
  const mounted = useRef(true);
  useEffect(
    () => () => {
      mounted.current = false;
    },
    [],
  );
  return mounted;
}

export function useLiveResource<T>(url: string) {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const [resolvedUrl, setResolvedUrl] = useState("");
  const [revision, setRevision] = useState(0);
  const requestId = useRef(0);
  const hasData = useRef(false);

  useEffect(() => {
    const currentRequest = ++requestId.current;
    let active = true;
    if (hasData.current) setRefreshing(true);
    else setLoading(true);
    setError(null);
    commerceApi<T>(url)
      .then((next) => {
        if (active && requestId.current === currentRequest) {
          hasData.current = true;
          setData(next);
          setResolvedUrl(url);
        }
      })
      .catch((reason: unknown) => {
        if (active && requestId.current === currentRequest)
          setError(
            reason instanceof Error
              ? reason
              : new Error("This workspace could not be loaded"),
          );
      })
      .finally(() => {
        if (active && requestId.current === currentRequest) {
          setLoading(false);
          setRefreshing(false);
        }
      });
    return () => {
      active = false;
    };
  }, [url, revision]);

  return {
    data,
    setData,
    loading,
    refreshing,
    error,
    resolvedUrl,
    reload: () => setRevision((value) => value + 1),
  };
}

export function toQuery(
  values: Record<string, string | number | boolean | undefined>,
) {
  const query = new URLSearchParams();
  Object.entries(values).forEach(([key, value]) => {
    if (value !== undefined && value !== "") query.set(key, String(value));
  });
  const serialized = query.toString();
  return serialized ? `?${serialized}` : "";
}

export function formatDate(value?: string | null, includeTime = false) {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleString("en-IN", {
    day: "numeric",
    month: "short",
    year: "numeric",
    ...(includeTime ? { hour: "numeric", minute: "2-digit" } : {}),
  });
}

export function formatCurrency(
  value: number | null | undefined,
  currency: string,
) {
  if (value === null || value === undefined) return "—";
  try {
    return new Intl.NumberFormat("en-IN", {
      style: "currency",
      currency,
    }).format(value);
  } catch {
    return `${currency} ${value.toLocaleString("en-IN")}`;
  }
}

export function CurrencyAmounts({
  amounts,
}: {
  amounts: Array<{ currency: string; totalSpent: number }>;
}) {
  if (!amounts.length) return <>—</>;
  return (
    <span className="ops-currency-amounts">
      {amounts.map((item) => (
        <span key={item.currency}>
          {formatCurrency(item.totalSpent, item.currency)}
        </span>
      ))}
    </span>
  );
}

export function useClampedPage({
  page,
  pagination,
  itemCount,
  ready,
  onPage,
}: {
  page: number;
  pagination?: {
    page: number;
    totalPages: number;
  };
  itemCount: number;
  ready: boolean;
  onPage: (page: number) => void;
}) {
  useEffect(() => {
    if (!ready || !pagination) return;
    const totalPages = Math.max(1, pagination.totalPages);
    if (page > totalPages) {
      onPage(totalPages);
      return;
    }
    if (pagination.page === page && page > 1 && itemCount === 0)
      onPage(page - 1);
  }, [itemCount, onPage, page, pagination, ready]);
}

export const sentenceCase = (value: string) =>
  value
    .replaceAll("_", " ")
    .toLowerCase()
    .replace(/^./, (letter) => letter.toUpperCase());

export const initials = (name?: string | null) =>
  (name || "Customer")
    .split(/\s+/)
    .filter(Boolean)
    .map((part) => part[0])
    .join("")
    .slice(0, 2)
    .toUpperCase();

export function facetCount(
  facets: Record<string, Array<{ value: string; count: number }>> | undefined,
  name: string,
  value?: string,
) {
  const facet = facets?.[name];
  if (!facet) return undefined;
  if (!value) return facet.reduce((sum, item) => sum + item.count, 0);
  return facet.find((item) => item.value === value)?.count;
}

export function StatusBadge({ value }: { value: string }) {
  const normalized = value.toLowerCase().replaceAll("_", "-");
  return (
    <span className={`ops-status ops-status-${normalized}`}>
      <i aria-hidden="true" />
      {sentenceCase(value)}
    </span>
  );
}

export function MetricStrip({
  items,
}: {
  items: Array<{
    label: string;
    value: ReactNode;
    note?: string;
    icon: LucideIcon;
  }>;
}) {
  if (!items.length) return null;
  return (
    <div className="ops-metrics" aria-label="Workspace summary">
      {items.map(({ label, value, note, icon: Icon }) => (
        <article key={label}>
          <Icon aria-hidden="true" />
          <span>
            <small>{label}</small>
            <b>{value}</b>
            {note && <em>{note}</em>}
          </span>
        </article>
      ))}
    </div>
  );
}

export function WorkspaceState({
  loading,
  error,
  empty,
  emptyTitle,
  emptyBody,
  onRetry,
  children,
}: {
  loading: boolean;
  error: Error | null;
  empty: boolean;
  emptyTitle: string;
  emptyBody: string;
  onRetry: () => void;
  children: ReactNode;
}) {
  if (loading)
    return (
      <div className="ops-state" role="status" aria-live="polite">
        <RefreshCw className="spin" />
        <h3>Loading live records…</h3>
        <p>Getting the latest information from your store.</p>
      </div>
    );

  if (error) {
    const unauthorized =
      error instanceof CommerceApiError && error.status === 401;
    const forbidden = error instanceof CommerceApiError && error.status === 403;
    return (
      <div className="ops-state" role="alert">
        {unauthorized || forbidden ? <LockKeyhole /> : <AlertTriangle />}
        <h3>
          {unauthorized
            ? "Sign in to continue"
            : forbidden
              ? "This role needs access"
              : "This workspace did not load"}
        </h3>
        <p>
          {forbidden
            ? "Ask a store owner to grant the required permission for this workspace."
            : error.message}
        </p>
        {unauthorized ? (
          <a className="primary" href="/login">
            Sign in
          </a>
        ) : (
          <button className="secondary" type="button" onClick={onRetry}>
            <RefreshCw /> Try again
          </button>
        )}
      </div>
    );
  }

  if (empty)
    return (
      <div className="ops-state">
        <Inbox />
        <h3>{emptyTitle}</h3>
        <p>{emptyBody}</p>
      </div>
    );

  return <>{children}</>;
}

export function PaginationControls({
  pagination,
  onPage,
}: {
  pagination?: {
    page: number;
    limit: number;
    total: number;
    totalPages: number;
    hasNextPage?: boolean;
    hasPreviousPage?: boolean;
  };
  onPage: (page: number) => void;
}) {
  if (!pagination || pagination.total === 0) return null;
  const start = (pagination.page - 1) * pagination.limit + 1;
  const end = Math.min(pagination.page * pagination.limit, pagination.total);
  const previous = pagination.hasPreviousPage ?? pagination.page > 1;
  const next =
    pagination.hasNextPage ?? pagination.page < pagination.totalPages;
  return (
    <nav className="ops-pagination" aria-label="Results pages">
      <span>
        Showing{" "}
        <b>
          {start}–{end}
        </b>{" "}
        of <b>{pagination.total}</b>
      </span>
      <div>
        <button
          type="button"
          onClick={() => onPage(pagination.page - 1)}
          disabled={!previous}
          aria-label="Previous page"
        >
          <ChevronLeft />
        </button>
        <span>
          Page {pagination.page} of {Math.max(1, pagination.totalPages)}
        </span>
        <button
          type="button"
          onClick={() => onPage(pagination.page + 1)}
          disabled={!next}
          aria-label="Next page"
        >
          <ChevronRight />
        </button>
      </div>
    </nav>
  );
}

export function DetailDrawer({
  open,
  title,
  subtitle,
  onClose,
  children,
}: {
  open: boolean;
  title: string;
  subtitle?: string;
  onClose: () => void;
  children: ReactNode;
}) {
  const titleId = useId();
  const drawer = useRef<HTMLElement>(null);
  const previousFocus = useRef<HTMLElement | null>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  useEffect(() => {
    if (!open) return;
    previousFocus.current = document.activeElement as HTMLElement | null;
    const originalOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const focusableControls = () =>
      Array.from(
        drawer.current?.querySelectorAll<HTMLElement>(
          'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
        ) || [],
      );
    const focusFrame = window.requestAnimationFrame(() => {
      const controls = focusableControls();
      (controls[0] || drawer.current)?.focus();
    });
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        closeRef.current();
        return;
      }
      if (event.key !== "Tab" || !drawer.current) return;
      const controls = focusableControls();
      if (!controls.length) {
        event.preventDefault();
        drawer.current.focus();
        return;
      }
      const first = controls[0]!;
      const last = controls[controls.length - 1]!;
      if (
        event.shiftKey &&
        (document.activeElement === first ||
          document.activeElement === drawer.current)
      ) {
        event.preventDefault();
        last.focus();
      } else if (
        !event.shiftKey &&
        (document.activeElement === last ||
          document.activeElement === drawer.current)
      ) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => {
      window.cancelAnimationFrame(focusFrame);
      document.body.style.overflow = originalOverflow;
      document.removeEventListener("keydown", onKeyDown);
      previousFocus.current?.focus();
    };
  }, [open]);

  if (!open) return null;
  return (
    <div className="ops-drawer-layer">
      <button
        className="ops-drawer-backdrop"
        type="button"
        tabIndex={-1}
        aria-label="Close details"
        onClick={onClose}
      />
      <aside
        className="ops-drawer"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        ref={drawer}
        tabIndex={-1}
      >
        <header>
          <div>
            <h2 id={titleId}>{title}</h2>
            {subtitle && <p>{subtitle}</p>}
          </div>
          <button type="button" aria-label="Close details" onClick={onClose}>
            <X />
          </button>
        </header>
        <div className="ops-drawer-content">{children}</div>
      </aside>
    </div>
  );
}
