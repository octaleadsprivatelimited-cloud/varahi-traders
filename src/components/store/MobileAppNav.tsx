import { Home, Package, ShoppingBag, Store, UserRound } from "lucide-react";
import { Link, useLocation } from "@tanstack/react-router";
import { useEffect } from "react";
import { useCommerceCartCount } from "@/lib/commerce-cart";
import { AccountLink } from "./AccountLink";

export function MobileAppNav() {
  const location = useLocation();
  const cartCount = useCommerceCartCount();
  const path = location.pathname;
  const accountTab = new URLSearchParams(location.searchStr).get("tab");
  const visible =
    path === "/" ||
    path === "/shop" ||
    path.startsWith("/product/") ||
    path === "/cart" ||
    path === "/track" ||
    path === "/account" ||
    path === "/login";

  useEffect(() => {
    document.body.classList.toggle("has-mobile-app-nav", visible);
    return () => document.body.classList.remove("has-mobile-app-nav");
  }, [visible]);

  if (!visible) return null;

  const shopActive = path === "/shop" || path.startsWith("/product/");
  const ordersActive =
    path === "/track" || (path === "/account" && accountTab === "My orders");
  const accountActive = path === "/account" && accountTab !== "My orders";

  return (
    <nav className="mobile-app-nav" aria-label="Primary mobile navigation">
      <Link
        to="/"
        className={path === "/" ? "active" : ""}
        aria-current={path === "/" ? "page" : undefined}
      >
        <Home />
        <span>Home</span>
      </Link>
      <Link
        to="/shop"
        className={shopActive ? "active" : ""}
        aria-current={shopActive ? "page" : undefined}
      >
        <Store />
        <span>Shop</span>
      </Link>
      <Link
        to="/cart"
        className={path === "/cart" ? "active cart-tab" : "cart-tab"}
        aria-current={path === "/cart" ? "page" : undefined}
      >
        <span className="mobile-app-nav-icon">
          <ShoppingBag />
          {cartCount > 0 && <em>{cartCount > 99 ? "99+" : cartCount}</em>}
        </span>
        <span>Bag</span>
      </Link>
      <Link
        to="/account"
        search={{ tab: "My orders" }}
        className={ordersActive ? "active" : ""}
        aria-current={ordersActive ? "page" : undefined}
      >
        <Package />
        <span>Orders</span>
      </Link>
      <AccountLink
        className={accountActive ? "active" : ""}
      >
        <UserRound />
        <span>Account</span>
      </AccountLink>
    </nav>
  );
}
