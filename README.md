# Sri Varahi Traders — Cold Pressed Oils

Independent client copy of the Ruchi commerce platform, adapted for cold-pressed oils. This folder has its own Git history, environment secrets, database, Docker volumes, uploads and browser storage. No Git remote or live provider accounts are configured.

## Same stack and feature set

React 19, TypeScript, TanStack Start/Router, Vite, Tailwind, Node.js 24, Express, Prisma, MySQL 8.4 and Redis. Includes responsive storefront, search/category filters, volume/pack variants, bag, wishlist, checkout, all-product/selected-product coupons, customer accounts, orders/invoices/tracking/support, admin catalog/inventory/marketing/settings, and the existing Cashfree/Shiprocket/email/consent-based analytics integrations. Reviews remain disabled, matching the source.

## Run locally

The generated `.env` is local-only, ignored by Git, and uses new random credentials. Do not copy another client's `.env`, database or uploads.

```sh
pnpm install --frozen-lockfile
pnpm --dir commerce-api install --frozen-lockfile
docker compose up -d mysql redis
pnpm --dir commerce-api db:deploy
pnpm --dir commerce-api seed
# Terminal 1
pnpm dev:api
# Terminal 2
pnpm dev
```

Preview: http://localhost:5180 · API: http://localhost:4010 · MySQL: localhost:3310 · Redis: localhost:6390. Docker project: `sri-varahi-traders`; database: `sri_varahi_traders`. These ports and resources are separate from the original store.

You can also double-click `START-WEBSITE.command` after installing dependencies to start this client, or `OPEN-WEBSITE.command` to open an already-running preview.

## Client setup before launch

- Eight oil products are demonstrations. Prices, stock, packaging illustrations, shipping rules, GST rates and coupon WELCOME10 are samples. Confirm actual details before taking orders. `Catalog purpose: Sample` excludes these products from search/merchant feeds.
- Add the client's real logo, business/legal details, FSSAI information, support contacts and final product photography through Admin Settings/Products. Review the inherited policy templates for this client.
- Google sign-in is intentionally disconnected: supply this client's FIREBASE_PROJECT_ID, FIREBASE_API_KEY, FIREBASE_AUTH_DOMAIN and FIREBASE_APP_ID. Set STORE_ADMIN_EMAIL to their verified admin Google account. Blank admin configuration grants no admin rights. There is no bypass login.
- Add this client's own Cashfree, Shiprocket, email and analytics settings. None of the old client's integrations, credentials, customer records, orders, verification tags or tracking IDs were copied. Production checkout retains the original shipping/payment readiness guards.
- Set APP_URL, VITE_PUBLIC_SITE_URL, CORS_ORIGINS, PUBLIC_UPLOAD_BASE_URL and primaryDomain for the verified live domain. Use a new hosted MySQL database, durable uploads directory and fresh production secrets.
- CI verifies this client code but has no automatic release/deployment job. Add a NEW GitHub remote and NEW hosting project when ready; never point this folder at the source store's deployment.

## Checks

```sh
pnpm lint
pnpm exec tsc --noEmit
pnpm test:api
pnpm build
```

See CLIENT-SETUP.md for isolation details and IMAGE-ASSETS.md for the generated hero asset.
