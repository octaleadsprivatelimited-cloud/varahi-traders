import { createFileRoute } from "@tanstack/react-router";
import { InformationPage } from "@/components/store/InformationPage";
import { pageSeo } from "@/lib/seo";
export const Route = createFileRoute("/privacy")({
  component: () => <InformationPage kind="privacy" />,
  head: () => pageSeo("/privacy", "Privacy Policy | Sri Varahi Traders", "How Sri Varahi Traders handles Google sign-in, order information, browser storage, optional analytics and privacy requests."),
});
