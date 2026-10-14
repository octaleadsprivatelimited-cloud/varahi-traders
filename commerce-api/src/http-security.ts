import { randomBytes } from "node:crypto";
import { firebaseWebDefaults } from "./firebase-web-config.js";

export function baseSecurityHeaders(production: boolean): Record<string, string> {
  return {
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "no-referrer",
    // Firebase opens Google sign-in in a separate browsing context.
    "Cross-Origin-Opener-Policy": "same-origin-allow-popups",
    "Permissions-Policy": "camera=(), microphone=(), geolocation=(), browsing-topics=()",
    ...(production ? { "Strict-Transport-Security": "max-age=31536000" } : {}),
  };
}

export const createDocumentNonce = () => randomBytes(32).toString("base64url");
export function documentSecurityHeaders(nonce: string, production: boolean): Record<string, string> {
  if (!/^[A-Za-z0-9_-]{43}$/.test(nonce)) throw new Error("Invalid document nonce");
  const domain = process.env.FIREBASE_AUTH_DOMAIN || firebaseWebDefaults.FIREBASE_AUTH_DOMAIN;
  const authOrigin = /^[a-z0-9.-]+\.[a-z]+$/i.test(domain || "") ? `https://${domain}` : "";
  const scripts = ["'self'", `'nonce-${nonce}'`, "https://apis.google.com", "https://www.gstatic.com",
    "https://www.googletagmanager.com", "https://www.google-analytics.com", "https://www.clarity.ms",
    "https://scripts.clarity.ms", "https://connect.facebook.net", "https://sdk.cashfree.com"];
  const connect = ["'self'", authOrigin, "https://identitytoolkit.googleapis.com", "https://securetoken.googleapis.com",
    "https://firebaseinstallations.googleapis.com", "https://www.googleapis.com", "https://accounts.google.com",
    "https://www.google-analytics.com", "https://*.google-analytics.com", "https://www.googletagmanager.com",
    "https://*.clarity.ms", "https://www.facebook.com", "https://graph.facebook.com", "https://api.cashfree.com",
    "https://sandbox.cashfree.com", "https://sdk.cashfree.com", "https://payments.cashfree.com", "https://payments-test.cashfree.com"];
  if (!production) { scripts.push("'unsafe-inline'", "'unsafe-eval'"); connect.push("http:", "ws:", "wss:"); }
  const policy = [
    "default-src 'self'", "base-uri 'self'", "object-src 'none'", "frame-ancestors 'none'", "form-action 'self'",
    `script-src ${scripts.join(" ")}`, "script-src-attr 'none'", "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src 'self' data: https://fonts.gstatic.com", "img-src 'self' https: data: blob:",
    `connect-src ${connect.filter(Boolean).join(" ")}`,
    `frame-src 'self' ${authOrigin} https://accounts.google.com https://sdk.cashfree.com https://api.cashfree.com https://sandbox.cashfree.com https://payments.cashfree.com https://payments-test.cashfree.com`,
    "worker-src 'self' blob:", ...(production ? ["upgrade-insecure-requests"] : []),
  ].join("; ");
  return { ...baseSecurityHeaders(production), "Content-Security-Policy": policy };
}

/** Never serialize raw headers, query parameters, cookies or request bodies. */
export const privateRequestLog = (request: { id?: unknown; method?: unknown }) => ({ id: request.id, method: request.method });
export const privateResponseLog = (response: { statusCode?: unknown }) => ({ statusCode: response.statusCode });
export function privateErrorLog(error: { name?: unknown; code?: unknown; status?: unknown } | undefined) {
  return {
    type: typeof error?.name === "string" && /^[a-z]+$/i.test(error.name) ? error.name : "Error",
    ...(typeof error?.code === "string" && /^[A-Z_0-9]{1,80}$/.test(error.code) ? { code: error.code } : {}),
    ...(typeof error?.status === "number" ? { status: error.status } : {}),
  };
}

/** Enough to identify an operational failure, without SQL, values or stacks. */
export function internalFailureSummary(error: { name?: unknown; code?: unknown; meta?: { code?: unknown } } | undefined) {
  const safe = privateErrorLog(error);
  const databaseCode = typeof error?.meta?.code === "string" && /^\d{1,6}$/.test(error.meta.code) ? error.meta.code : "";
  return `Internal request failure: ${[safe.type, safe.code, databaseCode].filter(Boolean).join(" ")}`;
}
