import { loadCatalog } from "@/lib/product-loader";
import { createFileRoute } from "@tanstack/react-router";
import { ShopPage } from "@/components/store/ShopPage";
import { pageSeo } from "@/lib/seo";
import shopLayoutCss from "@/shop-layout.css?url";

export const Route = createFileRoute("/shop")({
  loader: () => loadCatalog(),
  component: ShopPage,
  head: () => {
    const seo = pageSeo("/shop", "Shop Cold Pressed Oils | Sri Varahi Traders", "Browse Sri Varahi Traders by category, pack size and price. Compare cold-pressed cooking oils and bottle sizes, with current stock and delivery details.");
    return { ...seo, links: [...seo.links, { rel: "stylesheet", href: shopLayoutCss }] };
  },
});
