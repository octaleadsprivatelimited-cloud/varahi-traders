import { CustomersWorkspace } from "./CustomersWorkspace";
import { ReturnsWorkspace } from "./ReturnsWorkspace";
import { SupportWorkspace } from "./SupportWorkspace";

export type CustomerOperationsTab =
  "Customers" | "Returns" | "Support";

export function AdminCustomerOperations({
  module,
}: {
  module: CustomerOperationsTab;
}) {
  if (module === "Customers") return <CustomersWorkspace />;
  if (module === "Returns") return <ReturnsWorkspace />;
  return <SupportWorkspace />;
}
