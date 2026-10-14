# Commerce platform architecture

The storefront in `src/` is the launch surface. `commerce-api/` defines the new backend boundary and normalized Prisma model. The previous political-campaign applications under `apps/` are legacy and are intentionally not imported by the commerce application; they can be removed after any uncommitted work there is archived.

## Runtime topology

`CDN / WAF -> Nginx -> React storefront -> Node API -> MySQL 8.4`

Redis backs rate limits, refresh-session revocation, catalog cache, idempotency locks and BullMQ. Workers process verified webhooks, notification delivery, search indexing and shipment refreshes. API nodes are stateless and scale horizontally.

## Security invariants

- Checkout accepts variant IDs and quantities only. `PricingService` reads authoritative prices, inventory and tax rates and calculates totals server-side.
- Order creation and stock reservation share a serializable database transaction. A unique idempotency key prevents duplicate orders; stock is updated with an optimistic version or row lock.
- Payment success is accepted only from a signed provider webhook or server-to-server verification. The order state machine records an append-only history entry in the same transaction.
- Integration secrets are envelope-encrypted with `INTEGRATION_ENCRYPTION_KEY`; public APIs return only provider, environment, enabled state and masked identifiers.
- Refresh tokens use secure, HttpOnly, SameSite cookies. Access tokens are short-lived. Admin routes require backend RBAC, audit logging and TOTP step-up for credentials, refunds and permissions.
- Webhooks use the unparsed request body, constant-time signature comparison, timestamp tolerance, unique provider event IDs and asynchronous processing.
- Uploads use signed object-storage URLs, allow-listed MIME signatures, generated names, size limits and an asynchronous malware-scanning quarantine.

## Modules

Auth/RBAC, catalog/search, carts, pricing/coupons, checkout, payments, orders, inventory, shipping/tracking, returns/refunds, reviews, notifications, integrations, analytics, support, webhooks and audit are independent modules behind repository/service/controller boundaries. `PaymentProvider` and `ShippingProvider` contracts keep checkout provider-neutral.

## Required production sequence

1. Create and review the initial Prisma migration; never run destructive resets in production.
2. Seed catalog permissions. Google through Firebase is the sole login provider; only verified Google login for <client-admin-email> grants ADMIN access. Other identities are customers. Role changes invalidate existing sessions, and the application never requires authenticator codes.
3. Configure MySQL 8.4 TLS, Redis ACL/TLS, strict CORS, Helmet CSP, per-route rate limits and secret-manager injection.
4. Register provider webhooks and test replay, duplicate, invalid-signature, partial-refund and delayed-event paths.
5. Run unit, integration, Playwright and security suites before traffic cutover.

## Backups and recovery

Use daily encrypted snapshots plus binary log archiving, 30-day retention and cross-region copies. Perform a monthly restore into an isolated account, validate row counts and order/payment consistency, and record RPO/RTO. Object storage uses versioning and lifecycle retention. Secrets and encryption keys are backed up separately with restricted access.
