import { type PrismaClient, type ProviderKind } from "@prisma/client";
import type { AppConfig } from "./config.js";
import {
  renderEmailNotification,
} from "./notification-content.js";
import { SecretVault } from "./security.js";

class DeliveryNotConfigured extends Error {}
class DeliveryWindowExpired extends Error {}
export async function processNotificationBatch({ db, config, request = fetch }: { db: PrismaClient; config: AppConfig; request?: typeof fetch }) {
const vault = new SecretVault(config.INTEGRATION_ENCRYPTION_KEY);
const environment = config.NODE_ENV === "production" ? "LIVE" : "TEST";
const maxAttempts = 5;
const publicRecord = (value: unknown) =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

async function configuredIntegration(kind: ProviderKind, provider: string) {
  const integration = await db.integrationConfig.findFirst({
    where: {
      kind,
      provider: { equals: provider },
      enabled: true,
      environment,
    },
    orderBy: [{ priority: "asc" }, { updatedAt: "desc" }, { id: "asc" }],
  });
  if (!integration)
    throw new DeliveryNotConfigured(
      `No enabled ${provider} ${kind.toLowerCase()} integration is configured`,
    );
  return {
    credentials: vault.decrypt<Record<string, string>>(
      Buffer.from(integration.encryptedCredentials).toString("base64"),
    ),
    publicConfig: publicRecord(integration.publicConfig),
  };
}

async function sendEmail(notification: {
  id: string;
  template: string;
  destination: string;
  payload: unknown;
  firstAttemptAt?: Date | null;
}) {
  const { credentials, publicConfig } = await configuredIntegration(
      "EMAIL",
      "resend",
    ),
    fromEmail = String(publicConfig.fromEmail || "").trim();
  if (
    fromEmail.length > 254 ||
    !/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(fromEmail)
  )
    throw new DeliveryNotConfigured("Resend requires a valid publicConfig.fromEmail");
  if (!credentials.apiKey)
    throw new DeliveryNotConfigured("Resend requires an apiKey credential");
  const fromName = String(publicConfig.fromName || "")
      .replace(/[\r\n]/g, " ")
      .replace(/["\\]/g, "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 100),
    from = fromName ? `"${fromName}" <${fromEmail}>` : fromEmail,
    content = renderEmailNotification(
      notification.template,
      publicRecord(notification.payload),
    ),
    firstAttemptAt = notification.firstAttemptAt || new Date();
  if (Date.now() - firstAttemptAt.getTime() >= 23 * 60 * 60_000) throw new DeliveryWindowExpired("Automatic delivery stopped after the safe idempotency window; verify provider delivery before retrying manually");
  if (!notification.firstAttemptAt) await db.notification.update({ where: { id: notification.id }, data: { firstAttemptAt } });
  const response = await request("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        authorization: `Bearer ${credentials.apiKey}`,
        "content-type": "application/json",
        "idempotency-key": notification.id,
      },
      body: JSON.stringify({
        from,
        to: notification.destination,
        subject: content.subject,
        html: content.html,
        text: content.text,
      }),
      signal: AbortSignal.timeout(10_000),
    }),
    body = (await response.json().catch(() => ({}))) as { id?: string };
  if ([401, 403].includes(response.status)) throw new DeliveryNotConfigured("Resend authorization or sender configuration requires attention");
  if (!response.ok)
    throw new Error(
      `Resend rejected notification with status ${response.status}`,
    );
  if (!body.id) throw new Error("Resend accepted response did not include a message ID");
  return body.id;
}

  const batch = await db.$transaction(async (tx) => {
    await tx.notification.updateMany({
      where: {
        status: "PROCESSING",
        channel: "EMAIL",
        template: "order.confirmed",
        lockedAt: { lt: new Date(Date.now() - 15 * 60_000) },
      },
      data: { status: "QUEUED", lockedAt: null },
    });
    const due = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT \`id\` FROM \`Notification\`
      WHERE \`status\` = 'QUEUED'
        AND \`channel\` = 'EMAIL'
        AND \`template\` = 'order.confirmed'
        AND \`nextAttemptAt\` <= NOW()
      ORDER BY \`createdAt\` ASC
      LIMIT 50
      FOR UPDATE SKIP LOCKED
    `;
    if (!due.length) return [];
    const ids = due.map(({ id }) => id);
    await tx.notification.updateMany({
      where: { id: { in: ids }, status: "QUEUED" },
      data: { status: "PROCESSING", lockedAt: new Date() },
    });
    return tx.notification.findMany({ where: { id: { in: ids } } });
  });
  let sent = 0,
    retried = 0,
    failed = 0, deferred = 0;
  for (const notification of batch) {
    try {
      const providerMessageId = await sendEmail(notification);
      await db.notification.update({
        where: { id: notification.id },
        data: {
          status: "SENT",
          sentAt: new Date(),
          providerMessageId,
          error: null,
          lockedAt: null,
        },
      });
      sent += 1;
    } catch (error) {
      const unconfigured = error instanceof DeliveryNotConfigured;
      const attempts = notification.attempts + (unconfigured ? 0 : 1),
        exhausted = error instanceof DeliveryWindowExpired || (!unconfigured && attempts >= maxAttempts),
        delayMinutes = unconfigured ? 5 : Math.min(60, 2 ** attempts);
      await db.notification.update({
        where: { id: notification.id },
        data: {
          status: exhausted ? "FAILED" : "QUEUED",
          attempts,
          nextAttemptAt: new Date(Date.now() + delayMinutes * 60_000),
          lockedAt: null,
          error:
            error instanceof Error
              ? error.message.slice(0, 500)
              : "Delivery failed",
        },
      });
      unconfigured ? (deferred += 1) : exhausted ? (failed += 1) : (retried += 1);
    }
  }
  return { processed: batch.length, sent, retried, failed, deferred };
}

export function startNotificationWorker(options: { db: PrismaClient; config: AppConfig; request?: typeof fetch; intervalMs?: number }) {
  let stopped = false;
  let active: Promise<unknown> = Promise.resolve();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const run = () => {
    if (stopped) return;
    active = processNotificationBatch(options).then(result => {
      if (result.processed) console.log(JSON.stringify({ worker: "notifications", ...result }));
    }).catch(() => { console.error("Notification worker failed; queued messages will be retried."); }).finally(() => {
      if (!stopped) { timer = setTimeout(run, options.intervalMs || 30_000); timer.unref(); }
    });
  };
  run();
  return async () => { stopped = true; if (timer) clearTimeout(timer); await active; };
}
