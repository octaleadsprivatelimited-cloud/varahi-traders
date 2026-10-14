# Commerce API deployment

## Local verification

1. Copy `.env.example` to `.env` and replace every placeholder secret.
2. Start MySQL 8.4 with `docker compose up -d mysql`.
3. Apply checked-in migrations with `pnpm db:deploy`, then `pnpm seed`.
4. Start the API with `pnpm dev`; the health check is `GET /health`.
5. Run `pnpm test` and `pnpm build` before deployment.

Seed data contains the catalog and role permissions without default login accounts. The sole administrator, the account configured in `STORE_ADMIN_EMAIL`, receives ADMIN access only after Google identity verification. No bootstrap password or local account credential is created.

## Firebase Google customer and staff sign-in

1. In Firebase Console, register a Web app and enable **Authentication → Sign-in method → Google**. Keep Email/Password and Phone providers disabled.
2. In **Authentication → Settings → Authorized domains**, add the production storefront hostname and `localhost` for local use. Use hostnames without paths or ports.
3. The Sri Varahi Traders project defaults are in `src/firebase-web-config.ts`. For another project, supply `FIREBASE_PROJECT_ID`, `FIREBASE_API_KEY`, `FIREBASE_AUTH_DOMAIN`, and `FIREBASE_APP_ID` together. Any explicit Firebase field disables every checked-in default, preventing mixed-project settings.
4. Confirm `/api/v1/auth/providers` returns `firebase.enabled: true` and the intended project ID. Sign in at `/login` with the Google popup. The browser sends its Firebase ID token to `/api/v1/auth/google`; a raw Google OAuth token is not accepted.

Google is the sole provider. The server verifies Firebase signatures, issuer, audience, verified email and the `google.com` provider with the Admin SDK. The browser configuration is public. This verification-only flow uses public signing certificates and an explicit project ID; no OAuth client secret or service-account private key is required. Firebase emulator tokens are rejected. Application session revocation and disabled accounts are checked against MySQL; this flow does not query Firebase user revocation status on each request.

Admin → Integrations → Authentication shows the current deployment status without editable credentials. Legacy Google client-ID integration records do not control sign-in. Firebase Console manages providers and authorized domains; hosting configuration selects the project.

Existing Google subject mappings preserve accounts. Only verified Gmail addresses can automatically claim an existing email-only account. Workspace and other non-Gmail accounts require explicit subject provisioning; Firebase Google tokens do not supply a trusted hosted-domain assertion. Only the account configured in `STORE_ADMIN_EMAIL` receives ADMIN access after verified Google sign-in. Every other identity receives CUSTOMER access, including former staff. Authenticator enrollment and codes are no longer used.

See [Firebase Google sign-in](https://firebase.google.com/docs/auth/web/google-signin) and [Firebase ID token verification](https://firebase.google.com/docs/auth/admin/verify-id-tokens).

## Production release

GitHub Actions checks production dependencies for high/critical advisories, runs lint, the API build and tests against MySQL 8.4, the Hostinger build, and smoke checks of the compiled storefront and delayed database startup. Successful runs on `codex/hostinger-deployment` promote that exact commit to `codex/production-release`. Promotion skips an outdated source head and never force-pushes. Pull requests have read-only permissions and cannot publish.

In Hostinger, connect `octaleadsprivatelimited-cloud/demo-E-commerce-2026`, choose **codex/production-release**, and enable automatic deployments. Keep the Node.js version at 24, the project root at `/`, the build command at `pnpm build:hostinger`, and the entry file at `hostinger.mjs`. Do not enable automatic deployment from the source branch: that would bypass CI. The deployment branch appears after the first successful CI run. Confirm Hostinger's completed deployment commit matches that branch, then check `/ready`, the storefront, login, sitemap, and the email provider delivery record. A passing CI run or promoted branch alone is not proof of a successful Hostinger release.

- Inject database, JWT, encryption and provider secrets from the hosting secret manager. Never commit `.env`.
- Use MySQL 8.4 TLS, a least-privilege application role, connection pooling, encrypted backups and point-in-time recovery.
- Run `prisma migrate deploy` as a release job before starting new application instances. Do not use `migrate dev` or `db push` in production.
- Terminate TLS at the load balancer, restrict CORS to exact storefront origins, and forward the real client IP only from trusted proxies.
- Configure provider webhook secrets before enabling an integration. Test invalid signatures, duplicate events, replays, delayed events, refunds, and shipping regressions.
- Replace development payment and shipping adapters with live provider adapters. The development adapters intentionally fail closed when `NODE_ENV=production`.
- Alert on elevated 5xx/429 rates, checkout failures, webhook backlog, stock conflicts, payment/order mismatches and notification failures.

## Rollback and recovery

Application rollback must remain compatible with the deployed database migration. Use expand/contract migrations for destructive changes. Keep daily encrypted snapshots and binary log archiving, test restores monthly, and reconcile order totals, payments, refunds, shipments and inventory after recovery.

## MySQL migration

The Hostinger entry point opens its HTTP port before migration checks to meet the host's three-second startup deadline. Health and readiness return an uncached `503 SERVICE_STARTING` with `Retry-After: 1` until MySQL and the application are ready. Customer requests wait up to ten seconds for initialization, avoiding a cold-start error page during normal worker startup; they return the same temporary response if initialization still has not completed. Migration failures still terminate startup; the storefront never falls back to temporary data. CI tests the compiled entry point against an unresponsive database to verify this behavior.

The active Prisma migration history targets a new MySQL 8.4 database. The original
PostgreSQL migrations are preserved in `prisma/postgresql-migrations` for recovery.
Do not apply the MySQL baseline to an existing PostgreSQL database. Existing
PostgreSQL production data requires a separate export/import with row-count,
foreign-key, money-total and inventory reconciliation before switching traffic.
The local setup uses a new Docker volume and does not delete the previous database.

Use the root `.env` for local development, migration and catalog initialization:

```sh
node --env-file=../.env node_modules/prisma/build/index.js migrate deploy
node --env-file=../.env --import tsx prisma/seed.ts
```

Sign in with the account configured in `STORE_ADMIN_EMAIL` to initialize the sole administrator role. The server grants it only after verifying that Google identity, never from an ordinary access-token request, a refresh session or a supplied profile email. Other users always receive CUSTOMER access. The role-policy migration clears former role assignments and authenticator enrollment and invalidates all previous sessions. When a Google login changes an account's role, its earlier sessions are revoked again. Existing Google subject mappings are preserved; legacy email-only accounts can be linked automatically only for verified Gmail addresses.

## Cashfree setup

1. Open the admin Integrations page, choose Cashfree in the Test workspace and
   save the sandbox App ID and secret key. Alternatively set `CASHFREE_CLIENT_ID`,
   `CASHFREE_CLIENT_SECRET`, and `CASHFREE_ENVIRONMENT=TEST` in the server environment.
2. Configure the storefront domain in Cashfree and register the HTTPS API endpoint
   `/webhooks/cashfree` for payment and refund events. Local webhook testing needs
   a public HTTPS tunnel configured separately; do not use localhost as a public endpoint.
3. Exercise successful, failed, abandoned and retried payments in sandbox. Checkout
   uses the Cashfree v3 modal; the backend verifies amount, currency and transaction
   ID before marking the order paid. A browser callback alone is insufficient.
4. Test partial/full refunds, duplicate webhook deliveries and failed refunds.
   Accepted refunds remain PENDING until a signed refund success confirms completion.
5. Configure Live credentials and live webhooks separately before production.
   The browser receives only the payment session and environment, never the secret.

Without Cashfree credentials the store offers cash on delivery and explains that
online payment is unavailable. Configure Firebase Google sign-in before the first administrator sign-in. If its configuration is deferred, customer and administrator sign-in remain unavailable. Mobile SMS OTP is disabled in every environment. Production shipping and
email delivery require their respective provider configuration.

## Order confirmation delivery

Configure **Integrations → Communication → Resend** with a valid API key and a sender on a verified domain. Choose the Live workspace for production. Populate the legal name, business postal address, support contacts and optional GSTIN in **Store identity & branding**; confirmations use the business details captured when the order was created.

Use a sending-only API key restricted to the verified transactional subdomain, such as `updates.srivarahitraders.example`. Keep the existing Zoho MX and root SPF records; add only the exact sender records generated by Resend. The sender can be `orders@updates.srivarahitraders.example`, with the display name `SRI VARAHI TRADERS · Sri Varahi Traders`. Save the key through the encrypted integration form; never commit it. The admin connection probe cannot list domains with a sending-only key and reports that limitation instead of rejecting the key. Confirm actual delivery using a controlled order confirmation to the owner's inbox and the corresponding Resend delivery event.

Order acceptance and its confirmation are persisted transactionally. Accepted COD orders queue immediately; online orders queue only after payment verification. Each order has one deterministic notification ID, so duplicate callbacks and payment retries cannot add duplicate confirmations. Messages include line items, quantities and prices, discounts, tax, shipping, total, payment status, customer contact, delivery address and business contact details.

`hostinger.mjs` and the API server run the production notification worker automatically every 30 seconds after the previous batch completes. It processes only EMAIL / `order.confirmed`, with MySQL row locks for concurrent workers. Manual runs use `pnpm notifications:process`. Missing provider/sender configuration defers delivery without exhausting retry attempts. Transient delivery failures retry with backoff; a provider idempotency key is reused, and automatic retry stops before its safe delivery window expires. Failed messages require checking provider history before manual retry. A test response or a queued notification is not proof of delivered email.

Integration references: [Cashfree orders](https://www.cashfree.com/docs/api-reference/payments/latest/orders/create-order),
[refunds](https://www.cashfree.com/docs/api-reference/payments/latest/refunds/create-refund),
[signature verification](https://www.cashfree.com/docs/payments/online/webhooks/signature-verification),
and [refund webhook data](https://github.com/cashfree/cashfree-pg/blob/main/docs/RefundWebhookDataEntity.md).
