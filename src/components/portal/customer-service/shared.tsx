import type { ReactNode } from "react";
import { AlertCircle, Inbox, LoaderCircle, RefreshCw } from "lucide-react";
import { CommerceApiError } from "@/lib/commerce-api";

export type CustomerServiceError = { message: string; status?: number };

export function toCustomerServiceError(
  value: unknown,
  fallback: string,
): CustomerServiceError {
  return {
    message: value instanceof Error ? value.message : fallback,
    status: value instanceof CommerceApiError ? value.status : undefined,
  };
}

export function CustomerServiceState({
  loading,
  error,
  empty,
  emptyTitle,
  emptyBody,
  onRetry,
  children,
}: {
  loading: boolean;
  error: CustomerServiceError | null;
  empty: boolean;
  emptyTitle: string;
  emptyBody: string;
  onRetry: () => void;
  children: ReactNode;
}) {
  if (loading)
    return (
      <div className="customer-service-state" role="status">
        <LoaderCircle className="spin" />
        <h3>Loading your account…</h3>
        <p>Your latest information will appear in a moment.</p>
      </div>
    );
  if (error) {
    const signedOut = error.status === 401;
    const forbidden = error.status === 403;
    return (
      <div className="customer-service-state customer-service-error" role="alert">
        <AlertCircle />
        <h3>
          {signedOut
            ? "Sign in to continue"
            : forbidden
              ? "This section isn’t available"
              : "We couldn’t load this section"}
        </h3>
        <p>{error.message}</p>
        {signedOut ? (
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
      <div className="customer-service-state">
        <Inbox />
        <h3>{emptyTitle}</h3>
        <p>{emptyBody}</p>
      </div>
    );
  return <>{children}</>;
}

export function CustomerStatus({ value }: { value: string }) {
  const normalized = value.toLowerCase().replaceAll("_", "-");
  return (
    <span className={`customer-service-status ${normalized}`}>
      {humanize(value)}
    </span>
  );
}

export function humanize(value: string) {
  return value
    .toLowerCase()
    .replaceAll("_", " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

export function formatAccountDate(value: string, includeTime = false) {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return "Date unavailable";
  return new Intl.DateTimeFormat("en-IN", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    ...(includeTime ? { hour: "2-digit", minute: "2-digit" } : {}),
  }).format(parsed);
}
