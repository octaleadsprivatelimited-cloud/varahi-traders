# Sri Varahi Traders backend setup

Run all commands below from the repository root. Use Node.js 24, pnpm 11 and a running Docker daemon.

## Local configuration

```sh
pnpm setup:local
pnpm dev:local
```

Setup generates a private root `.env` only when missing, installs locked dependencies, starts `sri-varahi-traders` MySQL/Redis services, applies committed MySQL migrations and seeds missing sample products/permissions. It preserves existing configuration and refuses to target a database outside Varahi's local setup. No login accounts are seeded.

API: `http://localhost:4010`. `GET /health` checks the process and `GET /ready` checks MySQL persistence. `pnpm --dir commerce-api db:smoke` checks the configured database connection. The root `.env` is ignored by Git and read by development, migration and seed commands.

## Isolated database tests

Create a dedicated local database; these commands only target the Varahi MySQL container:

```sh
pnpm verify:db
```

`verify-database.mjs` validates the local Varahi configuration, changes only the database name to `sri_varahi_traders_test`, migrates/seeds that database, then runs all API tests with database coverage enabled. It never resets a database. Tests temporarily change test inventory and clean up their own records. Normal `pnpm test:api` runs unit/API tests with database integration cases skipped.

## Production

Follow [`../HOSTINGER.md`](../HOSTINGER.md) and use root `.env.production.example` in the hosting secret manager. The active schema and migrations target MySQL; there is no alternate database migration tree.

Configure the real Varahi origin, durable MySQL database and uploads, independent JWT/encryption secrets, and exact HTTPS CORS origins. The combined Node entry point applies migrations, waits for persistence and starts the notification worker. GitHub CI verifies the source; it does not deploy or promote release branches.

Supply Varahi's four Firebase web fields together and configure Google/authorized domains in Firebase. Set `STORE_ADMIN_EMAIL` to the verified Google account that should administer Varahi. Check `/api/v1/auth/providers`, then verify customer and administrator sign-in. Email/password and phone OTP are disabled. Application sessions and disabled accounts are checked against MySQL.

Configure Cashfree test/live credentials and webhook signatures separately, plus shipping/delivery readiness and a verified transactional email sender. Online payments are accepted only after server verification. Accepted COD orders and verified payments queue one persisted order confirmation; the production worker retries eligible email delivery. Complete real business/support details and check provider delivery records before launch.

After a release, verify `/ready`, storefront pages, catalog uploads, authentication, controlled checkout and search feeds. Preserve encrypted backups and the integration encryption key. Roll back only to application code compatible with the deployed schema; never use `migrate dev`, `db push` or a database reset during production deployment.
