import { createFileRoute } from "@tanstack/react-router";
import { TransactionPage } from "@/components/store/TransactionPage";
export const Route = createFileRoute("/transaction/$orderNumber")({
  component: TransactionRoute,
  head: () => ({ meta: [{ title: "Transaction details | Sri Varahi Traders" }, { name: "robots", content: "noindex, nofollow" }] }),
});
function TransactionRoute() {
  const { orderNumber } = Route.useParams();
  return <TransactionPage orderNumber={orderNumber} />;
}
