# Sri Varahi Traders backend architecture

The React storefront lives in `src/`; the Express API and Prisma/MySQL persistence live in `commerce-api/`. Local development uses separate storefront and API processes. Production `hostinger.mjs` serves both in one Node.js 24 process and supplies direct catalog/settings readers to server rendering.

## Persistence and sessions

MySQL 8.4 stores products, inventory, customers, sessions, orders, payments, coupons, settings, encrypted integrations and notifications. MySQL transactions and row locks protect stock reservations and payment/order transitions. Redis is an optional local service; correctness does not depend on it.

Google identity verification through Firebase is the only sign-in method. Only the verified Google email configured in `STORE_ADMIN_EMAIL` receives administrator permissions. Other identities are customers. Role changes revoke prior sessions. Access tokens are short lived; refresh sessions use secure HttpOnly cookies and MySQL persistence. Empty Firebase settings keep authentication disabled.

## Commerce safeguards

- Checkout reads prices, discounts, tax and stock on the server from submitted variant IDs and quantities.
- Order creation and inventory reservations are persisted transactionally with idempotency controls.
- Online payment acceptance requires provider verification or a valid signed webhook; browser callbacks do not establish payment success.
- Integration secrets use authenticated encryption with `INTEGRATION_ENCRYPTION_KEY`; public endpoints expose validated public configuration only.
- Admin routes enforce backend permissions. Catalog media uploads are validated and converted to WebP in a durable writable upload directory.
- Order confirmations are persisted with accepted orders/payments. The production worker processes `order.confirmed` email notifications with database locking, retry limits and provider idempotency keys.
- Public storefront rendering has security headers and per-document CSP nonces. Customer/admin/API paths use private caching and search exclusions.

## Startup and operations

Production applies committed MySQL migrations before readiness. It rejects insecure production origins and memory-only production mode. Backup the database, persistent uploads and encryption key separately. Configure provider credentials and verify delivery/payment/shipping behavior before launch. Backend tests cover authentication, checkout, coupons, payments, privacy, persistence and inventory concurrency.
