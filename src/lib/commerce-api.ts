const API_URL = (
  import.meta.env.VITE_COMMERCE_API_URL ?? (import.meta.env.DEV ? "http://localhost:4010" : "")
).replace(/\/$/, "");

type ApiEnvelope<T> = { success: true; data: T; message: string };

let refreshInFlight: Promise<string | null> | null = null;
let sessionRevision = 0;
let guestSessionChecked = false;
export const sessionExpiredEvent = "varahi-commerce-session-expired";

export class CommerceApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
  }
}

function accessToken() {
  return typeof window !== "undefined"
    ? sessionStorage.getItem("varahi_commerce_access_token")
    : null;
}

async function withSessionCookieLock<T>(operation: () => Promise<T>): Promise<T> {
  return typeof navigator !== "undefined" && navigator.locks
    ? await navigator.locks.request(`varahi-commerce-session:${API_URL}`, operation)
    : await operation();
}

async function refreshAccessToken() {
  if (typeof window === "undefined") return null;
  if (!refreshInFlight) {
    const revision = sessionRevision;
    const refresh = async () => {
      // A sign-in or sign-out that happened while waiting takes precedence.
      if (revision !== sessionRevision) return accessToken();
      try {
        const response = await fetch(`${API_URL}/api/v1/auth/refresh`, {
          method: "POST",
          credentials: "include",
          cache: "no-store",
          signal: AbortSignal.timeout(15_000),
          headers: { "content-type": "application/json" },
        });
        if (revision !== sessionRevision) return accessToken();
        if (response.status === 401 || response.status === 403) {
          const hadSession = Boolean(accessToken());
          clearAccessToken();
          if (hadSession) window.dispatchEvent(new Event(sessionExpiredEvent));
          return null;
        }
        if (!response.ok) throw new Error("Session refresh unavailable");
        const body = (await response.json()) as ApiEnvelope<{ accessToken: string }>;
        if (!body?.data?.accessToken || typeof body.data.accessToken !== "string")
          throw new Error("Invalid session refresh response");
        if (revision !== sessionRevision) return accessToken();
        sessionRevision++;
        guestSessionChecked = false;
        sessionStorage.setItem("varahi_commerce_access_token", body.data.accessToken);
        return body.data.accessToken;
      } catch {
        if (revision !== sessionRevision) return accessToken();
        // Connectivity or service failures must not erase a signed-in session
        // or silently turn an authenticated checkout into a guest order.
        throw new CommerceApiError(503, "SESSION_REFRESH_UNAVAILABLE", "Your session could not be refreshed. Please try again.");
      }
    };
    // Refresh cookies are shared across tabs and rotate after every use. Keep
    // their requests sequential when the browser supports Web Locks.
    const pending = withSessionCookieLock(refresh).finally(() => {
        if (refreshInFlight === pending) refreshInFlight = null;
      });
    refreshInFlight = pending;
  }
  return refreshInFlight;
}

async function commerceFetch(
  path: string,
  init: RequestInit = {},
  retryAfterRefresh = true,
) {
  const pathname = path.split("?", 1)[0];
  const optionalSessionRequest = /^\/api\/v1\/(?:cart(?:\/|$)|checkout$|coupons\/validate$)/.test(pathname);
  // sessionStorage is empty in a newly opened tab, even while the secure
  // refresh cookie still represents a signed-in customer.
  if (optionalSessionRequest && !accessToken() && !guestSessionChecked)
    await refreshAccessToken();
  const changesSessionCookie = pathname === "/api/v1/auth/google" || pathname === "/api/v1/auth/logout";
  // Finish an older renewal before login/logout can replace its cookie. The
  // browser lock also covers other tabs; waiting here supports older browsers.
  if (changesSessionCookie && refreshInFlight)
    await refreshInFlight.catch(() => null);
  const token = accessToken();
  const cartToken =
    typeof window !== "undefined" && path.startsWith("/api/v1/cart")
      ? localStorage.getItem("varahi_commerce_cart_token")
      : null;
  const request = () => fetch(`${API_URL}${path}`, {
    ...init,
    credentials: "include",
    cache: "no-store",
    headers: {
      ...(!(typeof FormData !== "undefined" && init.body instanceof FormData)
        ? { "content-type": "application/json" }
        : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(cartToken ? { "x-cart-token": cartToken } : {}),
      ...init.headers,
    },
  });
  const response = changesSessionCookie
    ? await withSessionCookieLock(request)
    : await request();
  const nextCartToken = response.headers.get("x-cart-token");
  if (typeof window !== "undefined" && nextCartToken)
    localStorage.setItem("varahi_commerce_cart_token", nextCartToken);
  const publicAuthRequest = [
    "/api/v1/auth/refresh",
    "/api/v1/auth/google",
  ].includes(pathname);
  const sessionFailure = response.status === 401 && !publicAuthRequest &&
    ["AUTHENTICATION_REQUIRED", "INVALID_TOKEN"].includes(
      (await response.clone().json().catch(() => null))?.error?.code,
    );
  if (
    sessionFailure &&
    retryAfterRefresh
  ) {
    // A slower request may fail after another one has already renewed the
    // session. Retry with that token instead of rotating its cookie again.
    const currentToken = accessToken();
    if ((currentToken && currentToken !== token) || await refreshAccessToken())
      return commerceFetch(path, init, false);
  }
  if (sessionFailure && token && accessToken() === token) {
    clearAccessToken();
    window.dispatchEvent(new Event(sessionExpiredEvent));
  }
  return response;
}

export async function commerceApi<T>(path: string, init: RequestInit = {}) {
  const response = await commerceFetch(path, init);
  const body = await response.json().catch(() => null);
  if (!response.ok)
    throw new CommerceApiError(
      response.status,
      body?.error?.code || "REQUEST_FAILED",
      body?.error?.message || "The request could not be completed",
    );
  return (body as ApiEnvelope<T>).data;
}

export async function commerceDownload(path: string) {
  const response = await commerceFetch(path);
  if (!response.ok) {
    const body = await response.json().catch(() => null);
    throw new CommerceApiError(
      response.status,
      body?.error?.code || "DOWNLOAD_FAILED",
      body?.error?.message || "The file could not be downloaded",
    );
  }
  return response.blob();
}

export type ApiProduct = {
  id: string;
  name: string;
  variants: Array<{
    id: string;
    title: string;
    attributes: Record<string, string>;
  }>;
};

export type ApiSearchSuggestion = {
  slug: string;
  id: string;
  name: string;
  category: string;
  image: string | null;
  price: number;
  taxRate?: number;
};

export function saveAccessToken(token: string) {
  sessionRevision++;
  guestSessionChecked = false;
  sessionStorage.setItem("varahi_commerce_access_token", token);
  window.dispatchEvent(new Event("varahi-commerce-auth"));
}

export function clearAccessToken() {
  sessionRevision++;
  guestSessionChecked = true;
  sessionStorage.removeItem("varahi_commerce_access_token");
}
