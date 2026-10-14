import { describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "@prisma/client";
import type { AppConfig } from "../src/config.js";
import { SecretVault } from "../src/security.js";
import { processNotificationBatch } from "../src/notification-worker.js";
const config = { NODE_ENV: "test", INTEGRATION_ENCRYPTION_KEY: "x".repeat(32) } as AppConfig;
function fixture(configured = true, firstAttemptAt?: Date) {
  const notification = { id: "notification-1", template: "order.confirmed", channel: "EMAIL", destination: "buyer@example.com", payload: { orderNumber: "RU-1" }, attempts: 0, firstAttemptAt };
  const update = vi.fn(async () => ({}));
  const query = vi.fn(async (_sql: TemplateStringsArray) => [{ id: notification.id }]);
  const tx = { $queryRaw: query, notification: { updateMany: vi.fn(async () => ({ count: 1 })), findMany: vi.fn(async () => [notification]) } };
  const encrypted = Buffer.from(new SecretVault(config.INTEGRATION_ENCRYPTION_KEY).encrypt({ apiKey: "test-secret" }), "base64");
  const db = { $transaction: async (fn: (client: typeof tx) => unknown) => fn(tx), notification: { update }, integrationConfig: { findFirst: vi.fn(async () => configured ? { encryptedCredentials: encrypted, publicConfig: { fromEmail: "orders@example.com", fromName: "Store" } } : null) } };
  return { db: db as unknown as PrismaClient, update, query };
}
describe("notification delivery", () => {
  it("claims MySQL rows and sends a stable Resend idempotency key before marking SENT", async () => {
    const f = fixture(); const request = vi.fn(async () => new Response(JSON.stringify({ id: "resend-id" }), { status: 200 }));
    expect(await processNotificationBatch({ ...f, config, request })).toMatchObject({ processed: 1, sent: 1 });
    expect(f.query.mock.calls[0]?.[0].join(" ")).toContain("`Notification`");
    const call = request.mock.calls[0] as unknown as [string, RequestInit];
    expect(call[0]).toBe("https://api.resend.com/emails");
    expect(call[1].headers).toMatchObject({ "idempotency-key": "notification-1" });
    expect(JSON.parse(String(call[1].body))).toMatchObject({ to: "buyer@example.com", subject: expect.stringContaining("RU-1") });
    expect(f.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: "SENT", providerMessageId: "resend-id" }) }));
  });
  it("defers missing credentials without exhausting attempts or pretending mail was sent", async () => {
    const f = fixture(false); const request = vi.fn();
    expect(await processNotificationBatch({ ...f, config, request })).toMatchObject({ sent: 0, deferred: 1 });
    expect(request).not.toHaveBeenCalled();
    expect(f.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: "QUEUED", attempts: 0 }) }));
  });
  it("does not resend an uncertain delivery after the provider idempotency window", async () => {
    const f = fixture(true, new Date(Date.now() - 24 * 60 * 60_000)); const request = vi.fn();
    expect(await processNotificationBatch({ ...f, config, request })).toMatchObject({ sent: 0, failed: 1 });
    expect(request).not.toHaveBeenCalled();
    expect(f.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: "FAILED", error: expect.stringContaining("safe idempotency window") }) }));
  });
  it.each([new Response("{}", { status: 500 }), new Response("{}", { status: 200 })])("retries provider failure or missing acknowledgment without marking SENT", async response => {
    const f = fixture();
    expect(await processNotificationBatch({ ...f, config, request: async () => response })).toMatchObject({ sent: 0, retried: 1 });
    expect(f.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: "QUEUED", attempts: 1 }) }));
  });
});
