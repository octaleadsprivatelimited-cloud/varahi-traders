# Independent client handoff

Brand: **Sri Varahi Traders**. Category: **cold-pressed edible oils**.

Created from source commit 35b3018 of the existing commerce application. Only tracked source was exported; no Git remote/history, `.env`, database records, uploaded customer media, build output or node_modules were copied.

| Resource | This client |
| --- | --- |
| Desktop folder | Sri Varahi Traders |
| Frontend | 5180 |
| API | 4010 |
| MySQL | 3310 / sri_varahi_traders |
| Redis | 6390 |
| Docker project | sri-varahi-traders |
| Docker volumes | varahi_mysql / varahi_redis (project scoped) |
| Browser data | varahi / sri-varahi-traders namespaced |
| Production uploads | ~/.local/share/sri-varahi-traders/<new-domain>/uploads |
| Git remote | https://github.com/octaleadsprivatelimited-cloud/varahi-traders.git |
| Source branch | codex/sri-varahi-traders |
| Client integrations | Unconfigured |

The working demo has eight sample oil products and the same checkout/coupon/account/admin capabilities. Auth, payments, shipping, mail and analytics need the new client's own configuration. Contact details and legal identifiers remain empty at the user's request. No external orders or messages are sent by cloning or previewing.
