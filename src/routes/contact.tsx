import { createFileRoute } from "@tanstack/react-router";
import { InformationPage } from "@/components/store/InformationPage";
import { pageSeo } from "@/lib/seo";
export const Route = createFileRoute("/contact")({
  component: () => <InformationPage kind="contact" />,
  head: () => pageSeo("/contact", "Contact Sri Varahi Traders | Order & Product Support", "Contact Sri Varahi Traders for help with orders, delivery, product questions, payment issues and customer support."),
});
