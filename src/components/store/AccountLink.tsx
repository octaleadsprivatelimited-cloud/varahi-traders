import { useNavigate } from "@tanstack/react-router";
import type { MouseEvent, ReactNode } from "react";
import { loadPortalSession } from "@/lib/portal-auth";

type AccountLinkProps = {
  children: ReactNode;
  className?: string;
  ariaLabel?: string;
  customerTab?: string;
  onNavigate?: () => void;
};

export function AccountLink({
  children,
  className,
  ariaLabel,
  customerTab = "My overview",
  onNavigate,
}: AccountLinkProps) {
  const navigate = useNavigate();

  const openAccount = async (event: MouseEvent<HTMLAnchorElement>) => {
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    onNavigate?.();

    try {
      const session = await loadPortalSession();
      if (session.role === "CUSTOMER") {
        await navigate({ to: "/account", search: { tab: customerTab } });
      } else {
        await navigate({ to: "/admin" });
      }
    } catch {
      await navigate({ to: "/login" });
    }
  };

  return (
    <a
      href="/login"
      className={className}
      aria-label={ariaLabel}
      onClick={openAccount}
    >
      {children}
    </a>
  );
}
