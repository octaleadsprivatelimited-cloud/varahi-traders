import { createFileRoute, redirect } from "@tanstack/react-router";
import { AdminPortal } from "@/components/portal/AdminPortal";

export const Route = createFileRoute("/admin/$section")({
  beforeLoad: ({ params }) => {
    if (params.section.toLowerCase() === "reviews") throw redirect({ to: "/admin", replace: true });
  },
  component: AdminPortal,
  head: ({ params }) => ({
    meta: [{ title: `${params.section.replaceAll("-", " ")} · Commerce admin` }],
  }),
});
