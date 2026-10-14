import "./lib/error-capture";

import { consumeLastCapturedError } from "./lib/error-capture";
import { renderErrorPage } from "./lib/error-page";
import { createDocumentNonce, documentSecurityHeaders } from "../commerce-api/src/http-security";

const securedErrorResponse = () => {
  const html = renderErrorPage();
  return new Response(html, { status: 500, headers: { "content-type": "text/html; charset=utf-8", "Cache-Control": "no-store", ...documentSecurityHeaders(createDocumentNonce(), import.meta.env.PROD) } });
};

type ServerEntry = {
  fetch: (request: Request, env: unknown, ctx: unknown) => Promise<Response> | Response;
};

let serverEntryPromise: Promise<ServerEntry> | undefined;

async function getServerEntry(): Promise<ServerEntry> {
  if (!serverEntryPromise) {
    serverEntryPromise = import("@tanstack/react-start/server-entry").then(
      (m) => (m.default ?? m) as ServerEntry,
    );
  }
  return serverEntryPromise;
}

// h3 swallows in-handler throws into a normal 500 Response with body
// {"unhandled":true,"message":"HTTPError"} — try/catch alone never fires for those.
async function normalizeCatastrophicSsrResponse(response: Response): Promise<Response> {
  if (response.status < 500) return response;
  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.includes("application/json")) return response;

  const body = await response.clone().text();
  if (!isH3SwallowedErrorBody(body)) return response;

  console.error(consumeLastCapturedError() ?? new Error(`h3 swallowed SSR error: ${body}`));
  return securedErrorResponse();
}

function isH3SwallowedErrorBody(body: string): boolean {
  try {
    const payload = JSON.parse(body) as { unhandled?: unknown; message?: unknown };
    return payload.unhandled === true && payload.message === "HTTPError";
  } catch {
    return false;
  }
}

export default {
  async fetch(request: Request, env: unknown, ctx: unknown) {
    try {
      const handler = await getServerEntry();
      const nonce = createDocumentNonce();
      const requestHeaders = new Headers(request.headers);
      // Never trust a caller-supplied nonce. TanStack attaches this value only
      // to its own script assets and preserves it during client hydration.
      requestHeaders.set("x-varahi-csp-nonce", nonce);
      // Nitro supplies a wrapped Request. Construct from its public fields so
      // Undici never tries to read private state from the wrapper itself.
      const securedRequest = new Request(request.url, {
        method: request.method,
        headers: requestHeaders,
        ...(request.method === "GET" || request.method === "HEAD" ? {} : { body: request.body, duplex: "half" }),
      });
      const response = await handler.fetch(securedRequest, env, ctx);
      const normalized = await normalizeCatastrophicSsrResponse(response);
      if (!normalized.headers.get("content-type")?.includes("text/html")) return normalized;
      const url = new URL(request.url);
      const origin = process.env.APP_URL ? new URL(process.env.APP_URL).origin : url.origin;
      const canonical = new URL(url.pathname, origin).href.replace(/&/g, "&amp;").replace(/"/g, "&quot;");
      const privatePage = /^\/(admin|account|cart|checkout|login|track|transaction)(\/|$)/.test(url.pathname);
      const originalHtml = await normalized.text();
      // Route heads own canonical and social metadata. Supply only missing
      // fallback tags (for example error pages), never conflicting duplicates.
      const tags = [
        /<link\b[^>]*rel=["']canonical["']/i.test(originalHtml) ? "" : `<link rel="canonical" href="${canonical}"/>`,
        /<meta\b[^>]*property=["']og:url["']/i.test(originalHtml) ? "" : `<meta property="og:url" content="${canonical}"/>`,
        /<meta\b[^>]*property=["']og:site_name["']/i.test(originalHtml) ? "" : '<meta property="og:site_name" content="Sri Varahi Traders"/>',
        privatePage && !/<meta\b[^>]*name=["']robots["']/i.test(originalHtml) ? '<meta name="robots" content="noindex,nofollow"/>' : "",
      ].join("");
      const html = originalHtml.replace("</head>", `${tags}</head>`);
      const headers = new Headers(normalized.headers);
      for (const [name, value] of Object.entries(documentSecurityHeaders(nonce, import.meta.env.PROD))) headers.set(name, value);
      headers.set("Cache-Control", "no-store");
      headers.delete("content-length");
      if (privatePage) { headers.set("X-Robots-Tag", "noindex, nofollow"); headers.set("Cache-Control", "private, no-store"); }
      return new Response(html, { status: normalized.status, headers });
    } catch (error) {
      console.error(error);
      return securedErrorResponse();
    }
  },
};
