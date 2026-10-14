# Sri Varahi Traders: search and Merchant Center

Account owner: **Varahi’s approved Google account**. Use this account for Google Analytics, Search Console and Merchant Center; do not create properties in another signed-in Google account.

## What the website publishes

- Canonical website: `https://<Varahi-domain>`.
- Search sitemap: `https://<Varahi-domain>/sitemap.xml`. It includes public information pages and every ACTIVE product with an active option, includes product images, and splits large catalogs automatically. Product variant URLs canonicalize to the parent product.
- Google Merchant XML feed: `https://<Varahi-domain>/merchant-feed.xml`. Schedule a daily fetch in Merchant Center, then refresh after significant stock or pricing updates. Items use stable variant IDs, `?variant=` landing pages, public product photos and current available inventory. Disabled options and draft/archived products are excluded. Out-of-stock options remain explicitly out of stock.
- Private feed diagnostics: Admin → Analytics. Resolve errors before expecting items to appear; warnings need review. A reachable feed is not Google approval or proof that products are visible.
- Product schema is server rendered with variant offers and breadcrumbs. No sample ratings, invented GTINs, MPNs, certifications, shipping promises or unsupported return guarantees are supplied.

Catalog prices are stored in **INR major units before GST**, not paise. Search product offers, feed prices and storefront product prices include the configured GST rate. Cart and checkout show the underlying subtotal and GST breakdown; shipping and applicable discounts are calculated at checkout. Do not divide catalog prices by 100.

The local catalog contains eight sample oil products; a production catalog needs approved products. Publish genuine products with usable photos before submitting a feed for review. Demonstration products are not submitted to Google and no longer appear in the initial HTML of an empty live catalog.

## Product data to complete

For each actual product, enter an accurate name, description, category, brand, image, pack sizes, price, tax rate and stock. Images must be publicly crawlable, show the actual product and satisfy Google's image quality requirements; URL validation cannot establish image quality or ownership. The feed checks URL syntax/public hosts but cannot guarantee a remote server will allow Google to fetch every image.

Use manufacturer-assigned identifiers if present. A shop SKU is not automatically an MPN. Single-option products can use `GTIN` / `MPN` specifications; for several options use specifications keyed as `GTIN:<option SKU>` / `MPN:<option SKU>`. Only enter `Identifier exists = no` when the manufacturer has not assigned identifiers, never merely because they are unknown. Feed warnings explain missing information without inventing it.

In Merchant Center, verify/claim `<Varahi-domain>`, provide the real business address and contact information, configure India/INR, delivery charges and transit times that match checkout, and link the published return/refund policy. The policy permits no change-of-mind returns or refunds while retaining required consumer remedies. Complete Google's business checks and review product diagnostics. Do not enter a fabricated address, GST number, customer service number or delivery promise. Free listings and Shopping ads are separate; creating this feed does not start paid ads.

Submit the sitemap in Search Console using the same owner account. Inspect the homepage and an actual product URL after publication, then check Product/Merchant listings reports and crawling errors. Search indexing and product visibility are decided by Google and are not guaranteed by metadata or a sitemap.

## Keyword and content map

These are specific content targets, **not measured search volumes, ranking promises or a claim of keyword exclusivity**. Product examples come from the project's catalog templates and must be used only when the corresponding real product is published.

| Page or actual product | Primary intent | Distinct supporting phrases |
| --- | --- | --- |
| Homepage | cold pressed oils online | Sri Varahi Traders; oils for Indian cooking |
| Shop | shop cold pressed edible oils | oil bottle volumes; kitchen oil combos |
| Groundnut oil | cold pressed groundnut oil | groundnut oil 500 ml and 1 L |
| Sesame oil | cold pressed sesame oil | sesame oil for traditional recipes |
| Coconut oil | cold pressed coconut oil | coconut oil bottle sizes |
| Sunflower oil | cold pressed sunflower oil | sunflower oil for everyday cooking |
| Mustard oil | cold pressed mustard oil | mustard oil bottle sizes |
| Safflower oil | cold pressed safflower oil | safflower oil for cooking |
| Oil combos | kitchen oil combo packs | mixed oil bottles; pantry oil bundles |

Use each phrase naturally in the corresponding approved product’s title and visible description. Describe verified oil ingredients, net volume, cooking uses, storage, allergen and manufacturer/expiry details. Add origin or certification claims only when supported by the actual product. Metadata keyword tags do not replace useful content.

The implemented default product title is `<Product name> | Buy Online | Sri Varahi Traders`; per-product SEO fields can override it with an accurate, distinctive title and description. Category filter/search query URLs use the shop canonical instead of creating duplicate index pages. Dedicated category landing pages should be added only when their real inventory and explanatory content justify separate pages.

## Primary references

- [Google product data specification](https://support.google.com/merchants/answer/7052112?hl=en): required attributes, tax-inclusive India pricing, identifiers, image and inventory consistency.
- [Google product variant structured data](https://developers.google.com/search/docs/appearance/structured-data/product-variants): one parent canonical, distinct directly selectable variant URLs and initial HTML markup.
- [Google sitemap guidance](https://developers.google.com/search/docs/crawling-indexing/sitemaps/build-sitemap): canonical public URLs, accurate last-modified dates and file limits.
