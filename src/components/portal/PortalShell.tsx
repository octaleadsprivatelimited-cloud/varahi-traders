import { useEffect, useState, type ReactNode } from "react";
import { LogOut, Menu, Search, ShoppingBag, X } from "lucide-react";
import { Link } from "@tanstack/react-router";
import { useStorefrontConfig } from "@/lib/storefront-config";

export function PortalShell({
  title,
  subtitle,
  nav,
  active,
  onNavigate,
  portalPath = "/admin",
  userName = "Signed-in user",
  userRole = "Portal access",
  onLogout,
  signingOut = false,
  children,
}: {
  title: string;
  subtitle: string;
  nav: Array<[string, ReactNode]>;
  active: string;
  onNavigate?: (label: string) => void;
  portalPath?: "/admin" | "/account";
  userName?: string;
  userRole?: string;
  onLogout?: () => void;
  signingOut?: boolean;
  children: ReactNode;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [search, setSearch] = useState("");
  const storefront = useStorefrontConfig();
  const storeInitials = storefront.storeName
    .split(/\s+/)
    .map((part) => part[0])
    .join("")
    .slice(0, 2)
    .toUpperCase();
  const userInitials = userName
    .split(/\s+/)
    .map((part) => part[0])
    .join("")
    .slice(0, 2)
    .toUpperCase();
  const navigateFromSearch = () => {
    const query = search.trim().toLowerCase();
    if (!query) return;
    const match = nav.find(([label]) => label.toLowerCase().includes(query));
    if (!match) return;
    onNavigate?.(match[0]);
    setSearch("");
    setMenuOpen(false);
  };
  const brand = (
    <>
      {storefront.logoUrl ? (
        <>
          <img src={storefront.logoUrl} alt="" />
          <span>{storefront.storeName}</span>
        </>
      ) : (
        <>
          <i>{storeInitials}</i>
          <span>{storefront.storeName}</span>
        </>
      )}
    </>
  );
  useEffect(() => {
    if (!menuOpen) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setMenuOpen(false);
    };
    document.body.classList.add("mobile-overlay-open");
    window.addEventListener("keydown", closeOnEscape);
    return () => {
      document.body.classList.remove("mobile-overlay-open");
      window.removeEventListener("keydown", closeOnEscape);
    };
  }, [menuOpen]);
  return (
    <div className={`portal${menuOpen ? " portal-drawer-open" : ""}`}>
      {menuOpen && (
        <button
          className="portal-drawer-backdrop"
          aria-label="Close navigation"
          onClick={() => setMenuOpen(false)}
        />
      )}
      <aside
        aria-label={portalPath === "/account" ? "Account navigation" : "Admin navigation"}
        aria-modal={menuOpen || undefined}
        role={menuOpen ? "dialog" : undefined}
      >
        <div className="portal-mobile-head">
          <Link to="/" className="portal-logo">
            {brand}
          </Link>
          <button
            aria-label="Close navigation"
            onClick={() => setMenuOpen(false)}
          >
            <X />
          </button>
        </div>
        <Link to="/" className="portal-logo portal-desktop-logo">
          {brand}
        </Link>
        <div className="portal-nav">
          {nav.map(([label, icon]) => (
            portalPath === "/admin" ? <Link
              aria-label={label}
              to="/admin/$section"
              params={{ section: label.toLowerCase().replaceAll(" ", "-") }}
              onClick={() => setMenuOpen(false)}
              className={label === active ? "active" : ""}
              key={label}
            >
              {icon}
              <span>{label}</span>
              {label === active && <i />}
            </Link> : <Link
              aria-label={label}
              to={portalPath}
              search={{ tab: label }}
              onClick={() => setMenuOpen(false)}
              className={label === active ? "active" : ""}
              key={label}
            >
              {icon}
              <span>{label}</span>
              {label === active && <i />}
            </Link>
          ))}
        </div>
        <div className="portal-user">
          <div>{userInitials}</div>
          <span>
            <b>{userName}</b>
            <small>{userRole}</small>
          </span>
          {onLogout && (
            <button
              className="portal-logout"
              type="button"
              onClick={onLogout}
              disabled={signingOut}
              aria-label="Sign out"
              title="Sign out"
            >
              <LogOut />
            </button>
          )}
        </div>
      </aside>
      <div className="portal-main">
        <header>
          <button
            className="portal-menu"
            type="button"
            aria-label="Open navigation"
            onClick={() => setMenuOpen(true)}
          >
            <Menu />
          </button>
          <div className="portal-titlebar">
            <small><span>{storefront.storeName}</span><b>/</b>{active}</small>
            <h1>{title}</h1>
            <p>{subtitle}</p>
          </div>
          <div className="portal-tools">
            <label>
              <Search />
              <input
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.preventDefault();
                    navigateFromSearch();
                  }
                }}
                placeholder="Find a section…"
                aria-label="Find a portal section"
              />
            </label>
            <Link to="/" title="View store" aria-label="View store">
              <ShoppingBag />
            </Link>
          </div>
        </header>
        <main>{children}</main>
      </div>
    </div>
  );
}
