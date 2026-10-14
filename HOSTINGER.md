# Hostinger deployment

Deploy the repository as a Node.js web app using GitHub, with Node 24 and the repository root as the app directory.

- Install: `pnpm install --frozen-lockfile`
- Build: `pnpm build:hostinger`
- Entry point: `hostinger.mjs`
- Start: `pnpm start`
- Output directory: `.` (the entry point needs both `.output/` and `commerce-api/`)

The single process serves the React storefront and Express API on Hostinger's `PORT`. Do not set `VITE_COMMERCE_API_URL`: production browser requests use the same domain. The app requires a Hostinger MySQL database; Redis is optional and is not used for authentication or inventory correctness.

## Environment

Set these in Hostinger's environment settings, never in GitHub source:

```
NODE_ENV=production
USE_DATABASE=true
APP_URL=https://YOUR-TEMPORARY-DOMAIN
DATABASE_URL=mysql://USER:URL_ENCODED_PASSWORD@HOST:3306/DATABASE
JWT_SECRET=<unique random value of at least 32 characters>
JWT_REFRESH_SECRET=<different random value of at least 32 characters>
INTEGRATION_ENCRYPTION_KEY=<different random value of at least 32 characters>
TRUST_PROXY=1
```

`CORS_ORIGINS` and `PUBLIC_UPLOAD_BASE_URL` default to APP_URL and APP_URL/uploads. Override only if needed. Do not copy development environment values or deploy development/demo accounts. Keep the encryption key stable across deployments so saved integration credentials remain readable.

The Hostinger entry point runs `prisma migrate deploy` before accepting requests. It applies committed migrations only; it never resets the database or uses development migrations. Keep backups before releases. Authentication failures stop startup with a sanitized error code.

Alternatively, replace DATABASE_URL with all four `DATABASE_HOST`, `DATABASE_USER`, `DATABASE_PASSWORD`, and `DATABASE_NAME` fields (`DATABASE_PORT` defaults to 3306). Enter the password unchanged in the dedicated password field; the server URL-encodes it. All four fields must be supplied together and take precedence over DATABASE_URL. Use the database hostname shown by Hostinger for this hosting plan.

For a new empty database, set `SEED_CATALOG=true` for its first start. This creates the initial products, coupon and role permissions only when there are no products or orders. Remove this flag after initialization. The only administrator is `admin@srivarahi.example`, granted ADMIN access only after verified Google sign-in. All other identities are customers. No manual role bootstrap or authenticator code is needed. The role-policy migration revokes existing sessions, clears obsolete role assignments and authenticator enrollment, and requires everyone to sign in again.

## SEO and integrations

`/sitemap.xml` uses APP_URL and active catalog products. `/robots.txt` points at that sitemap and excludes private/customer/admin flows. HTML includes canonical URLs, private-page noindex metadata, and product titles, descriptions, and JSON-LD. Set APP_URL to the new origin when moving to a custom domain.

Customers and the sole administrator sign in only with Google through Firebase; no authenticator code is required. Email/password and mobile SMS OTP are disabled. Enable Google in Firebase Console and add the temporary Hostinger hostname under Authentication → Settings → Authorized domains. Add custom storefront hostnames there before switching domains.

`commerce-api/src/firebase-web-config.ts` contains the Sri Varahi Traders public web identifiers. These are intended for the browser, unlike JWT and integration secrets. To override the project, supply the complete set `FIREBASE_PROJECT_ID`, `FIREBASE_API_KEY`, `FIREBASE_AUTH_DOMAIN`, and `FIREBASE_APP_ID`. Any one explicit Firebase field disables all default fields, so partial overrides fail closed. The backend returns the active public settings from `/api/v1/auth/providers`. It verifies Firebase ID tokens with the Admin SDK and requires Google as the sign-in provider. This token-verification flow does not require a service-account private key or OAuth client secret.

Admin → Integrations → Authentication displays read-only deployment status. Legacy saved Google client-ID records are ignored; manage Firebase authentication in its console and the hosting configuration. Cashfree credentials remain editable in Admin → Integrations. Until Cashfree credentials are configured, online checkout is unavailable and COD remains available. Configure Cashfree signed webhooks before enabling online payments.

## Order confirmation email

In **Admin → Integrations → Communication → Resend**, configure an API key and a sender email on a verified Resend domain, then enable the **Live** integration. Set the legal business name, postal address, support contacts and optional GSTIN under **Store identity & branding** before accepting orders. Those details are saved with each order's confirmation; later settings changes do not rewrite an already queued message.

The production Hostinger process starts the email worker automatically. It sends one confirmation for each accepted COD order or verified online payment, with items, customer and delivery details, charges and business information. Pending/failed payments do not send confirmations. The worker processes only `order.confirmed` email messages; it does not send historical SMS or unrelated queued notifications. Missing credentials or an unverified sender leave messages queued for retry. Verify delivery using a controlled order after configuring Resend; code deployment alone does not establish email delivery.

## Deployment checks

Check `/ready` reports `mysql` and `/api/v1/auth/providers` reports Firebase enabled for the intended project, then `/`, `/shop`, an active `/product/<id>`, `/login`, `/robots.txt`, `/sitemap.xml`, and a missing product (404). Confirm CSS/JS return 200, phone entry enforces ten digits with +91, and no frontend request points to localhost. Check browser console and Hostinger runtime logs. Verify real Google/Cashfree flows only after configuring their provider accounts.
