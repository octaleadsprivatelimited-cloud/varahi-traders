import { expect, it } from "vitest";
import { baseSecurityHeaders, createDocumentNonce, documentSecurityHeaders, internalFailureSummary } from "../src/http-security.js";

it("uses unpredictable per-document nonces without granting arbitrary inline script execution", () => {
  const nonce = createDocumentNonce(), another = createDocumentNonce();
  expect(nonce).not.toBe(another);
  const headers = documentSecurityHeaders(nonce, true), policy = headers["Content-Security-Policy"]!;
  expect(policy).toContain(`'nonce-${nonce}'`);
  const scripts = policy.split("; ").find(value => value.startsWith("script-src "))!;
  expect(scripts).not.toContain("unsafe-inline"); expect(scripts).not.toContain("unsafe-eval");
  expect(policy).toContain("frame-ancestors 'none'"); expect(policy).toContain("object-src 'none'");
  expect(policy).toContain("https://sdk.cashfree.com"); expect(policy).toContain("https://payments-test.cashfree.com");
  expect(policy).toContain("https://identitytoolkit.googleapis.com");
  expect(headers["Cross-Origin-Opener-Policy"]).toBe("same-origin-allow-popups");
  expect(headers["Referrer-Policy"]).toBe("no-referrer"); expect(headers["Strict-Transport-Security"]).toContain("31536000");
  expect(() => documentSecurityHeaders("caller-value; script-src *", true)).toThrow();
});
it("permits local development connections without weakening production policies", () => {
  const nonce = createDocumentNonce();
  expect(documentSecurityHeaders(nonce, false)["Content-Security-Policy"]).toContain("ws:");
  expect(documentSecurityHeaders(nonce, true)["Content-Security-Policy"]).not.toContain(" ws:");
  expect(baseSecurityHeaders(false)).not.toHaveProperty("Strict-Transport-Security");
});
it("reports internal diagnostic codes without logging SQL, contacts or exception messages", () => {
  const error = { name: "PrismaClientKnownRequestError", code: "P2010", message: "private@example.com", stack: "private SQL values", meta: { code: "1054", message: "SELECT private@example.com" } };
  expect(internalFailureSummary(error)).toBe("Internal request failure: PrismaClientKnownRequestError P2010 1054");
  expect(internalFailureSummary({ name: "user@example.com", code: "secret@example.com", meta: { code: "9876543210" } })).toBe("Internal request failure: Error");
});
