import { createFileRoute } from "@tanstack/react-router";
import { AdminPortal } from "@/components/portal/AdminPortal";

export const Route = createFileRoute("/admin/")({ component: AdminPortal });
