# Sri Varahi Traders verification

- `pnpm setup:local` passed against MySQL `sri_varahi_traders` on port 3310; existing `.env` credentials were preserved. A repeat run with unrelated inherited database fields still targeted only Varahi's database.
- `pnpm dev:local` started both API and storefront from stopped processes and waited for readiness. API health/readiness passed with MySQL persistence and eight oil products. The browser rendered the Varahi storefront on port 5180.
- Frontend lint and TypeScript passed. `pnpm verify` passed API tests (323 passed; 11 database-dependent cases skipped), backend/combined production builds and compiled smoke checks.
- `pnpm verify:db` passed all **334 tests across 41 files**, including MySQL integration cases, using the separate `sri_varahi_traders_test` database.
- Compiled SSR smoke passed for 24 storefront/account/admin pages, CSP nonces, security headers, private caching, real 404s and variant prices. Delayed database startup smoke passed.
- Public asset secret scan passed for 71 files, including a separate run with the local private environment loaded. Tracked source passed an exact-value scan for local database/JWT/encryption secrets.
- Frontend and backend production dependency audits reported no known vulnerabilities.
- Obsolete PostgreSQL migrations, a stale app launcher, unused clothing editor/templates, unrelated deployment repository references and earlier product/QA content were removed. Product fixtures and documentation now describe Varahi oils; new order numbers use the SVT prefix. Oil-volume Merchant measures are covered by tests.

Production setup is prepared in `.env.production.example`, HOSTINGER.md and commerce-api/DEPLOYMENT.md. Live hosting/domain, Firebase/admin identity, payment, shipping and email configuration remain pending Varahi's actual provider settings. No live integration or deployment was activated. Environment secrets, generated builds, uploads and local verification logs are excluded from GitHub.

GitHub CI runs both MySQL 8.4 and MariaDB 11.4 checks on pushes to `codex/sri-varahi-traders`; its current run is the authoritative remote verification result.
