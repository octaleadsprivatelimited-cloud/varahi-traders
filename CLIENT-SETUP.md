# Sri Varahi Traders configuration

Brand: **Sri Varahi Traders**. Category: **cold-pressed edible oils**.

| Resource | Varahi configuration |
| --- | --- |
| Storefront | http://localhost:5180 |
| API | http://localhost:4010 |
| MySQL | localhost:3310 / sri_varahi_traders |
| Redis, optional | localhost:6390 |
| Docker project | sri-varahi-traders |
| Docker volumes | varahi_mysql / varahi_redis, project scoped |
| Browser storage | varahi / sri-varahi-traders namespaced |
| Production uploads | ~/.local/share/sri-varahi-traders/<domain>/uploads, or explicit UPLOAD_DIR |
| GitHub | https://github.com/octaleadsprivatelimited-cloud/varahi-traders |
| Branch | codex/sri-varahi-traders |
| Client integrations | Pending Varahi provider configuration |

Run `pnpm setup:local` for dependency installation, a private local environment, migrations and sample catalog initialization. Existing local credentials and products are preserved. No customer or administrator account is seeded; `STORE_ADMIN_EMAIL` grants administrator access only after that Google identity is verified.

Production settings belong in the hosting secret manager. Use `.env.production.example`, then follow `HOSTINGER.md` and `commerce-api/DEPLOYMENT.md`. Required launch inputs include the real domain/database, Firebase project, verified admin email, business and support details, approved catalog, and required payment/shipping/email settings. Optional analytics remain disconnected until configured.

The repository contains Varahi storefront/backend source, MySQL migrations, tests and oil assets. Environment secrets, uploads, dependency folders and generated builds are ignored by Git.
