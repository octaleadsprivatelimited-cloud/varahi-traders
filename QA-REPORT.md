# Sri Varahi Traders verification — 14 October 2026

- 334 automated API, authentication, payments, coupons, checkout, database and security tests passed using this client's isolated database.
- Frontend lint, TypeScript and full Node/Vite production build passed.
- Compiled SSR smoke passed for 24 storefront/account/admin pages, security headers, nonce handling, 404s and variant pricing.
- Production startup smoke passed. Static file and asset-scan paths work when the Desktop folder contains spaces.
- Public asset scan checked 71 files with the new local server secrets loaded: no secrets or private configuration exposed.
- New database contains 8 sample oil products, 24 variants, 0 customer accounts, 0 orders and 0 configured integrations. Seeding can be repeated without duplicating or overwriting products.
- Mobile preview: category filter returned two oil combos; selected 4 × 1 L Everyday Oil Duo; added to bag; WELCOME10 applied 10% to ₹1,400, giving ₹140 discount, ₹1,260 before GST, then ₹1,330 including ₹70 GST and free shipping at checkout. No order was placed. The test bag and coupon were cleared.
- Mobile checkout coupon controls remained 44px tall and within the page; no horizontal page overflow was observed.
- Original Ruchi source remained clean at 35b3018; its frontend and API processes stayed running on 5175 / 4001. This new client runs separately on 5180 / 4010, MySQL 3310 and Redis 6390. No original deployment was changed.
- Original Firebase identifiers, Google verification token, FSSAI number, support contact and refresh-cookie name are absent from the new application's runtime source. New client Firebase/sign-in is disabled until configured; all production readiness protections remain.

Screenshots are available locally in `.artifacts/`. Startup instructions and deferred client integration details are in README.md and CLIENT-SETUP.md.
