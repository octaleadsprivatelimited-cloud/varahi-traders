# Sri Varahi Traders: search and Merchant Center

Account owner: **admin@srivarahi.example**. Use this account for Google Analytics, Search Console and Merchant Center; do not create properties in another signed-in Google account.

## What the website publishes

- Canonical website: `https://srivarahitraders.example`.
- Search sitemap: `https://srivarahitraders.example/sitemap.xml`. It includes public information pages and every ACTIVE product with an active option, includes product images, and splits large catalogs automatically. Product variant URLs canonicalize to the parent product.
- Google Merchant XML feed: `https://srivarahitraders.example/merchant-feed.xml`. Schedule a daily fetch in Merchant Center, then refresh after significant stock or pricing updates. Items use stable variant IDs, `?variant=` landing pages, public product photos and current available inventory. Disabled options and draft/archived products are excluded. Out-of-stock options remain explicitly out of stock.
- Private feed diagnostics: Admin → Analytics. Resolve errors before expecting items to appear; warnings need review. A reachable feed is not Google approval or proof that products are visible.
- Product schema is server rendered with variant offers and breadcrumbs. No sample ratings, invented GTINs, MPNs, certifications, shipping promises or unsupported return guarantees are supplied.

Catalog prices are stored in **INR major units before GST**, not paise. Search product offers, feed prices and storefront product prices include the configured GST rate. Cart and checkout show the underlying subtotal and GST breakdown; shipping and applicable discounts are calculated at checkout. Do not divide catalog prices by 100.

The live catalog was empty when this work was prepared. Publish genuine products with usable photos before submitting a feed for review. Demonstration products are not submitted to Google and no longer appear in the initial HTML of an empty live catalog.

## Product data to complete

For each actual product, enter an accurate name, description, category, brand, image, pack sizes, price, tax rate and stock. Images must be publicly crawlable, show the actual product and satisfy Google's image quality requirements; URL validation cannot establish image quality or ownership. The feed checks URL syntax/public hosts but cannot guarantee a remote server will allow Google to fetch every image.

Use manufacturer-assigned identifiers if present. A shop SKU is not automatically an MPN. Single-option products can use `GTIN` / `MPN` specifications; for several options use specifications keyed as `GTIN:<option SKU>` / `MPN:<option SKU>`. Only enter `Identifier exists = no` when the manufacturer has not assigned identifiers, never merely because they are unknown. Feed warnings explain missing information without inventing it.

In Merchant Center, verify/claim `srivarahitraders.example`, provide the real business address and contact information, configure India/INR, delivery charges and transit times that match checkout, and link the published return/refund policy. The policy permits no change-of-mind returns or refunds while retaining required consumer remedies. Complete Google's business checks and review product diagnostics. Do not enter a fabricated address, GST number, customer service number or delivery promise. Free listings and Shopping ads are separate; creating this feed does not start paid ads.

Submit the sitemap in Search Console using the same owner account. Inspect the homepage and an actual product URL after publication, then check Product/Merchant listings reports and crawling errors. Search indexing and product visibility are decided by Google and are not guaranteed by metadata or a sitemap.

## Keyword and content map

These are specific content targets, **not measured search volumes, ranking promises or a claim of keyword exclusivity**. Product examples come from the project's catalog templates and must be used only when the corresponding real product is published.

| Page or actual product | Primary intent | Distinct supporting phrases |
| --- | --- | --- |
| Homepage | buy Indian spices online | Sri Varahi Traders; whole spices and masala blends |
| Shop | shop spice powders and masalas | spice pack sizes; Indian cooking spices online |
| Turmeric powder | buy turmeric powder online | haldi powder 100 g; turmeric powder for cooking |
| Kashmiri chilli powder | Kashmiri chilli powder online | Kashmiri mirch powder pack sizes; chilli powder for Indian recipes |
| Coriander powder | coriander powder online | dhania powder 100 g; ground coriander for cooking |
| Whole cumin | buy whole cumin seeds | jeera seeds 100 g; whole cumin for tempering |
| Black pepper | whole black pepper online | black peppercorns pack sizes; kali mirch for cooking |
| Garam masala | garam masala powder online | garam masala blend for curries; garam masala 100 g |
| Chaat masala | chaat masala online | chaat masala for snacks; chaat masala pack sizes |
| Sambar masala | sambar masala powder online | South Indian sambar powder; sambar masala pack sizes |

Use each main phrase naturally in that page's title and visible product description. Describe the real ingredients, net quantity, taste/use, allergen information, storage and manufacturer/expiry information where verified. Link related actual products from useful recipe or storage articles. Do not publish near-duplicate location pages or a page for every keyword. Do not use unsupported “organic”, “chemical-free”, “cures”, “highest curcumin”, origin or purity claims. “Lakadong” and “Malabar” require real provenance; do not apply them to generic turmeric or pepper. Metadata keyword tags do not replace useful content.

The implemented default product title is `<Product name> | Buy Online | Sri Varahi Traders`; per-product SEO fields can override it with an accurate, distinctive title and description. Category filter/search query URLs use the shop canonical instead of creating duplicate index pages. Dedicated category landing pages should be added only when their real inventory and explanatory content justify separate pages.

## Primary references

- [Google product data specification](https://support.google.com/merchants/answer/7052112?hl=en): required attributes, tax-inclusive India pricing, identifiers, image and inventory consistency.
- [Google product variant structured data](https://developers.google.com/search/docs/appearance/structured-data/product-variants): one parent canonical, distinct directly selectable variant URLs and initial HTML markup.
- [Google sitemap guidance](https://developers.google.com/search/docs/crawling-indexing/sitemaps/build-sitemap): canonical public URLs, accurate last-modified dates and file limits.
