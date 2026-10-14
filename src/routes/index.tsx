import { loadCatalog } from "@/lib/product-loader";
import { createFileRoute } from "@tanstack/react-router";
import { EcommerceHome } from "@/components/store/EcommerceHome";
import { pageSeo, storeStructuredData } from "@/lib/seo";

export const Route = createFileRoute("/")({
  loader: () => loadCatalog(),
  component: EcommerceHome,
  head: () => ({
    ...pageSeo("/", "Cold Pressed Oils | Sri Varahi Traders", "Explore cold-pressed groundnut, sesame, coconut and cooking oils from Sri Varahi Traders. Compare bottle sizes and discover your everyday oil."),
    scripts: [storeStructuredData],
  }),
});
