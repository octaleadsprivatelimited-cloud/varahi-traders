# Sri Varahi Traders — Cold Pressed Oils

Storefront and backend for **Sri Varahi Traders**, with eight sample cold-pressed oil products. Repository: [varahi-traders](https://github.com/octaleadsprivatelimited-cloud/varahi-traders), branch `codex/sri-varahi-traders`.

React 19, TypeScript, TanStack Start/Router, Vite, Tailwind, Node.js 24, Express and Prisma with MySQL 8.4. Includes catalog/search, volume and oil-combo variants, cart, wishlist, coupons, checkout, customer orders/support and an admin portal for products, inventory, marketing and settings. Google authentication, payments, shipping and transactional email require Varahi's own provider settings.

## Run locally

Install **Node.js 24**, **pnpm 11** and **Docker Desktop**, then start Docker.

```sh
pnpm setup:local
pnpm dev:local
```

Setup generates a private `.env` with fresh credentials if it is missing, installs locked dependencies, starts Varahi's MySQL/Redis containers, applies migrations and initializes missing sample products and permissions. It preserves existing configuration and products, and refuses to use a database outside Varahi's local configuration. Keep `.env` private; only example files belong in GitHub.

Open **http://localhost:5180/**. The API runs at **http://localhost:4010/**; `/ready` checks database connectivity. MySQL uses port **3310**, database **sri_varahi_traders**; optional Redis uses **6390**. Docker project: **sri-varahi-traders**.

On macOS, double-click `START-WEBSITE.command` to set up and open the website, or `OPEN-WEBSITE.command` to open an already running website. The launcher waits for both the API and storefront before opening the browser. Press Control-C to stop services started by the launcher.

To run the processes separately:

```sh
pnpm dev:api
# Another terminal
pnpm dev
```

## Verify

```sh
pnpm verify
# Database integration tests, using an isolated seeded test database:
pnpm verify:db
```

`verify` runs lint, TypeScript, API tests, the combined production build, a public asset secret scan and compiled storefront/startup smoke checks. `verify:db` creates and seeds `sri_varahi_traders_test` in the local Varahi container, then runs the entire API suite with database coverage. It temporarily changes test inventory while preserving the storefront database.

## Production setup

Use [`.env.production.example`](.env.production.example) as a hosting configuration checklist; replace placeholders in the hosting secret manager. Never upload local `.env` or live provider keys to GitHub. [HOSTINGER.md](HOSTINGER.md) describes the combined Node.js storefront/API deployment; [CLIENT-SETUP.md](CLIENT-SETUP.md) lists Varahi's resources and remaining business configuration.

Before launch, provide Varahi's domain, hosted MySQL database, persistent uploads, Firebase project and verified admin Google email (`STORE_ADMIN_EMAIL`). Set actual business/support details, approved products, photos, prices, stock, tax and delivery settings. Configure payment, shipping, email and optional analytics providers as needed. Blank Firebase/admin configuration keeps sign-in disabled. Production checkout enforces provider readiness.

The eight oil products, packaging illustrations and WELCOME10 coupon are samples. Products marked `Catalog purpose: Sample` are excluded from search and merchant feeds. GitHub CI verifies the code; it does not deploy a website or configure live provider accounts.
