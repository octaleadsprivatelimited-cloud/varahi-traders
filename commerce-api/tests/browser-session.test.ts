import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Exercise the production browser request client with real Response objects.
// These browser helpers are transformed by Vitest rather than compiled by API tsc.
const clientSource = "../../src/lib/commerce-api.ts";
const tokenKey = "varahi_commerce_access_token";
const response = (data: unknown, status = 200) => new Response(JSON.stringify(
  status < 400 ? { success: true, data } : { success: false, error: { code: "AUTHENTICATION_REQUIRED", message: "Authentication required" } },
), { status, headers: { "content-type": "application/json" } });

function storage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
  };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
const urlPath = (input: string) => new URL(input, "https://shop.example").pathname;
const bearer = (init?: RequestInit) => new Headers(init?.headers).get("authorization");

beforeEach(() => {
  vi.resetModules();
  vi.stubGlobal("window", new EventTarget());
  vi.stubGlobal("sessionStorage", storage());
  vi.stubGlobal("localStorage", storage());
  vi.stubGlobal("navigator", {});
});
afterEach(() => vi.unstubAllGlobals());

describe("browser customer session recovery", () => {
  it.each(["/api/v1/cart", "/api/v1/cart/items", "/api/v1/checkout", "/api/v1/coupons/validate"])(
    "restores a new-tab cookie before optional-auth %s so customer activity stays linked",
    async (path) => {
      const requests: Array<{ path: string; token: string | null }> = [];
      vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => {
        requests.push({ path: urlPath(url), token: bearer(init) });
        expect(init.credentials).toBe("include");
        expect(init.cache).toBe("no-store");
        return response(urlPath(url).endsWith("/refresh") ? { accessToken: "restored-customer" } : { customer: true });
      }));
      const { commerceApi } = await import(clientSource);
      await commerceApi(path, path === "/api/v1/cart" ? {} : { method: "POST", body: "{}" });
      expect(requests).toEqual([
        { path: "/api/v1/auth/refresh", token: null },
        { path, token: "Bearer restored-customer" },
      ]);
    },
  );

  it("keeps guest checkout available after confirming there is no refresh session", async () => {
    const fetcher = vi.fn(async (url: string, init: RequestInit) => {
      if (urlPath(url).endsWith("/refresh")) return response(null, 401);
      expect(bearer(init)).toBeNull();
      return response([]);
    });
    vi.stubGlobal("fetch", fetcher);
    const { commerceApi } = await import(clientSource);
    await commerceApi("/api/v1/cart");
    await commerceApi("/api/v1/checkout", { method: "POST", body: "{}" });
    expect(fetcher.mock.calls.filter(([url]) => urlPath(url).endsWith("/refresh"))).toHaveLength(1);
  });

  it("shares one renewal when orders and another account panel expire together", async () => {
    sessionStorage.setItem(tokenKey, "expired");
    const pending = deferred<Response>();
    const fetcher = vi.fn(async (url: string, init: RequestInit) => {
      if (urlPath(url).endsWith("/refresh")) return pending.promise;
      return bearer(init) === "Bearer fresh" ? response([]) : response(null, 401);
    });
    vi.stubGlobal("fetch", fetcher);
    const { commerceApi } = await import(clientSource);
    const requests = Promise.all([commerceApi("/api/v1/account/orders"), commerceApi("/api/v1/account/payments")]);
    await vi.waitFor(() => expect(fetcher.mock.calls.filter(([url]) => urlPath(url).endsWith("/refresh"))).toHaveLength(1));
    pending.resolve(response({ accessToken: "fresh" }));
    expect(await requests).toEqual([[], []]);
    expect(fetcher.mock.calls.filter(([url]) => urlPath(url).endsWith("/refresh"))).toHaveLength(1);
  });

  it("reuses an already renewed token when a slower request returns an old 401", async () => {
    sessionStorage.setItem(tokenKey, "expired");
    const slow = deferred<Response>();
    const fetcher = vi.fn(async (url: string, init: RequestInit) => {
      if (urlPath(url).endsWith("/refresh")) return response({ accessToken: "fresh" });
      if (bearer(init) === "Bearer fresh") return response([]);
      if (urlPath(url).endsWith("/payments")) return slow.promise;
      return response(null, 401);
    });
    vi.stubGlobal("fetch", fetcher);
    const { commerceApi } = await import(clientSource);
    const slowRequest = commerceApi("/api/v1/account/payments");
    await commerceApi("/api/v1/account/orders");
    slow.resolve(response(null, 401));
    expect(await slowRequest).toEqual([]);
    expect(fetcher.mock.calls.filter(([url]) => urlPath(url).endsWith("/refresh"))).toHaveLength(1);
  });

  it.each([401, 200])("never lets stale refresh status %s overwrite a new Google sign-in", async (status) => {
    sessionStorage.setItem(tokenKey, "expired");
    const pending = deferred<Response>();
    const fetcher = vi.fn(async (url: string, init: RequestInit) => {
      if (urlPath(url).endsWith("/refresh")) return pending.promise;
      return bearer(init) === "Bearer google-new-session" ? response([]) : response(null, 401);
    });
    vi.stubGlobal("fetch", fetcher);
    const { commerceApi, saveAccessToken, sessionExpiredEvent } = await import(clientSource);
    const expired = vi.fn();
    window.addEventListener(sessionExpiredEvent, expired);
    const orders = commerceApi("/api/v1/account/orders");
    await vi.waitFor(() => expect(fetcher.mock.calls).toHaveLength(2));
    saveAccessToken("google-new-session");
    pending.resolve(response({ accessToken: "stale-session" }, status));
    expect(await orders).toEqual([]);
    expect(sessionStorage.getItem(tokenKey)).toBe("google-new-session");
    expect(expired).not.toHaveBeenCalled();
  });

  it.each(["network", "server"])("retains the session after a temporary %s refresh failure", async (failure) => {
    sessionStorage.setItem(tokenKey, "expired");
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      if (!urlPath(url).endsWith("/refresh")) return response(null, 401);
      if (failure === "network") throw new TypeError("Connection lost");
      return response(null, 503);
    }));
    const { commerceApi, sessionExpiredEvent } = await import(clientSource);
    const expired = vi.fn();
    window.addEventListener(sessionExpiredEvent, expired);
    await expect(commerceApi("/api/v1/account/orders")).rejects.toMatchObject({ status: 503, code: "SESSION_REFRESH_UNAVAILABLE" });
    expect(sessionStorage.getItem(tokenKey)).toBe("expired");
    expect(expired).not.toHaveBeenCalled();
  });

  it("blocks optional-auth checkout during a session outage instead of placing a guest order", async () => {
    const fetcher = vi.fn(async () => response(null, 503));
    vi.stubGlobal("fetch", fetcher);
    const { commerceApi } = await import(clientSource);
    await expect(commerceApi("/api/v1/checkout", { method: "POST", body: "{}" })).rejects.toMatchObject({ code: "SESSION_REFRESH_UNAVAILABLE" });
    expect(fetcher.mock.calls).toHaveLength(1);
  });

  it("never retries an expired authenticated checkout as a guest", async () => {
    sessionStorage.setItem(tokenKey, "expired");
    const fetcher = vi.fn(async () => response(null, 401));
    vi.stubGlobal("fetch", fetcher);
    const { commerceApi } = await import(clientSource);
    await expect(commerceApi("/api/v1/checkout", { method: "POST", body: "{}" })).rejects.toMatchObject({ status: 401 });
    expect(fetcher.mock.calls).toHaveLength(2);
  });

  it("signals expired account sessions for portal reauthentication, while Google errors stay on the login form", async () => {
    sessionStorage.setItem(tokenKey, "expired");
    const fetcher = vi.fn(async () => response(null, 401));
    vi.stubGlobal("fetch", fetcher);
    const { commerceApi, sessionExpiredEvent } = await import(clientSource);
    const expired = vi.fn();
    window.addEventListener(sessionExpiredEvent, expired);
    await expect(commerceApi("/api/v1/account/orders")).rejects.toMatchObject({ status: 401 });
    expect(sessionStorage.getItem(tokenKey)).toBeNull();
    expect(expired).toHaveBeenCalled();
    expired.mockClear();
    fetcher.mockClear();
    await expect(commerceApi("/api/v1/auth/google", { method: "POST", body: "{}" })).rejects.toMatchObject({ status: 401 });
    expect(fetcher.mock.calls).toHaveLength(1);
    expect(expired).not.toHaveBeenCalled();
  });

  it("does not log out a valid customer when a separate identity confirmation is rejected", async () => {
    sessionStorage.setItem(tokenKey, "valid");
    const fetcher = vi.fn(async () => new Response(JSON.stringify({
      error: { code: "REAUTHENTICATION_REQUIRED", message: "Confirm your identity again" },
    }), { status: 401 }));
    vi.stubGlobal("fetch", fetcher);
    const { commerceApi } = await import(clientSource);
    await expect(commerceApi("/api/v1/account", { method: "DELETE", body: "{}" })).rejects.toMatchObject({ code: "REAUTHENTICATION_REQUIRED" });
    expect(fetcher.mock.calls).toHaveLength(1);
    expect(sessionStorage.getItem(tokenKey)).toBe("valid");
  });

  it("uses a browser-wide lock for rotating the shared refresh cookie", async () => {
    const request = vi.fn(async (_name: string, callback: () => Promise<unknown>) => callback());
    vi.stubGlobal("navigator", { locks: { request } });
    vi.stubGlobal("fetch", vi.fn(async (url: string) => response(urlPath(url).endsWith("/refresh") ? { accessToken: "restored" } : [])));
    const { commerceApi } = await import(clientSource);
    await commerceApi("/api/v1/cart");
    expect(request).toHaveBeenCalledOnce();
    expect(request.mock.calls[0]![0]).toContain("commerce-session:");
  });

  it.each(["/api/v1/auth/google", "/api/v1/auth/logout"])("waits for older refresh responses before %s replaces the cookie", async (path) => {
    sessionStorage.setItem(tokenKey, "expired");
    const pending = deferred<Response>();
    const fetcher = vi.fn(async (url: string, init: RequestInit) => {
      if (urlPath(url).endsWith("/refresh")) return pending.promise;
      if (urlPath(url) === path) return response({ accessToken: "new-login" });
      return bearer(init) === "Bearer renewed" ? response([]) : response(null, 401);
    });
    vi.stubGlobal("fetch", fetcher);
    const { commerceApi } = await import(clientSource);
    const orders = commerceApi("/api/v1/account/orders");
    await vi.waitFor(() => expect(fetcher.mock.calls).toHaveLength(2));
    const changeSession = commerceApi(path, { method: "POST", body: "{}" });
    await Promise.resolve();
    expect(fetcher.mock.calls.some(([url]) => urlPath(url) === path)).toBe(false);
    pending.resolve(response({ accessToken: "renewed" }));
    await Promise.all([orders, changeSession]);
    expect(fetcher.mock.calls.some(([url]) => urlPath(url) === path)).toBe(true);
  });
});
