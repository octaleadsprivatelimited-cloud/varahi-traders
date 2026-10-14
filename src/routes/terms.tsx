import { createFileRoute } from "@tanstack/react-router";
import { InformationPage } from "@/components/store/InformationPage";
import { pageSeo } from "@/lib/seo";
export const Route = createFileRoute("/terms")({
  component: () => <InformationPage kind="terms" />,
  head: () => pageSeo("/terms", "Terms and Conditions | Sri Varahi Traders", "Read the Sri Varahi Traders shopping terms for orders, payment, delivery, cancellations and consumer support."),
});
