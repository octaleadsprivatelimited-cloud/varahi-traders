import { ChevronDown, Menu, Search, ShoppingBag, User, X } from "lucide-react";
import { Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { StoreBrand, useStorefrontConfig } from "@/lib/storefront-config";
import { useCommerceCartCount } from "@/lib/commerce-cart";
import { FloatingProductSearch } from "./FloatingProductSearch";
import { AccountLink } from "./AccountLink";
import { openAnalyticsPreferences } from "@/lib/analytics";
import { additionalAnnouncement, deliveryAnnouncement } from "@/lib/delivery-policy";

export function StoreHeader() {
  const config = useStorefrontConfig();
  const [menu, setMenu] = useState(false);
  const [search, setSearch] = useState(false);
  const count = useCommerceCartCount();

  useEffect(() => {
    if (!menu) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setMenu(false);
    };
    document.body.classList.add("mobile-overlay-open");
    window.addEventListener("keydown", closeOnEscape);
    return () => {
      document.body.classList.remove("mobile-overlay-open");
      window.removeEventListener("keydown", closeOnEscape);
    };
  }, [menu]);

  return (
    <>
      <div className="announcement">
        <span>{deliveryAnnouncement(config)}</span>
        <span>{additionalAnnouncement(config.announcement) || "Freshness protected"}</span>
        <span>Secure payments</span>
      </div>
      <header className="store-header multipage">
        <StoreBrand />
        <nav aria-label="Store navigation">
          <Link to="/shop">Shop all</Link>
          <Link to="/shop" search={{ category: "Cooking Oils" }}>Cooking oils</Link>
          <Link to="/shop" search={{ category: "Sesame Oils" }}>Sesame oils</Link>
          <Link to="/shop" search={{ category: "Coconut Oils" }}>Coconut oils</Link>
          <Link to="/track">Track order</Link>
        </nav>
        <div className="header-actions">
          <button type="button" aria-label="Search products" aria-expanded={search} aria-controls="page-product-search" onClick={() => setSearch((value) => !value)}>
            <Search />
          </button>
          <AccountLink
            className="desktop-only"
            ariaLabel="My account"
          >
            <User />
          </AccountLink>
          <Link to="/cart" aria-label={`Open bag with ${count} items`}>
            <ShoppingBag />
            <em>{count}</em>
          </Link>
          <button
            className="icon-btn mobile-only"
            type="button"
            aria-label={menu ? "Close navigation" : "Open navigation"}
            aria-expanded={menu}
            aria-controls="mobile-store-navigation"
            onClick={() => setMenu((open) => !open)}
          >
            {menu ? <X /> : <Menu />}
          </button>
        </div>
      </header>
      <div id="page-product-search"><FloatingProductSearch open={search} onClose={() => setSearch(false)} /></div>
      <AnimatePresence>
        {menu && (
          <>
            <motion.button
            className="mobile-menu-backdrop"
            type="button"
            aria-label="Close navigation"
            onClick={() => setMenu(false)}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.18 }}
          />
            <motion.div
              id="mobile-store-navigation"
              className="mobile-menu mobile-menu-dropdown"
              role="dialog"
              aria-modal="true"
              aria-label="Store navigation"
              initial={{ opacity: 0, y: -18, scaleY: 0.94 }}
              animate={{ opacity: 1, y: 0, scaleY: 1 }}
              exit={{ opacity: 0, y: -12, scaleY: 0.96 }}
              transition={{ type: "spring", stiffness: 360, damping: 30 }}
              style={{ transformOrigin: "top" }}
            >
              <div className="mobile-menu-heading">
              <span>Explore Sri Varahi Traders</span>
              <small>Cold-pressed oils for your kitchen</small>
            </div>
              <motion.div className="mobile-menu-item" initial={{ opacity: 0, y: -8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -8 }} transition={{ delay: 0.04 }}><Link to="/shop" onClick={() => setMenu(false)}>Shop all</Link></motion.div>
              <motion.div className="mobile-menu-item" initial={{ opacity: 0, y: -8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -8 }} transition={{ delay: 0.08 }}><Link to="/shop" search={{ category: "Cooking Oils" }} onClick={() => setMenu(false)}>Cooking oils</Link></motion.div>
              <motion.div className="mobile-menu-item" initial={{ opacity: 0, y: -8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -8 }} transition={{ delay: 0.12 }}><Link to="/shop" search={{ category: "Sesame Oils" }} onClick={() => setMenu(false)}>Sesame oils</Link></motion.div>
              <motion.div className="mobile-menu-item" initial={{ opacity: 0, y: -8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -8 }} transition={{ delay: 0.16 }}><Link to="/shop" search={{ category: "Coconut Oils" }} onClick={() => setMenu(false)}>Coconut oils</Link></motion.div>
              <motion.div className="mobile-menu-item" initial={{ opacity: 0, y: -8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -8 }} transition={{ delay: 0.2 }}><Link to="/shop" search={{ category: "Oil Combos" }} onClick={() => setMenu(false)}>Oil combos</Link></motion.div>
              <motion.div className="mobile-menu-item" initial={{ opacity: 0, y: -8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -8 }} transition={{ delay: 0.24 }}><AccountLink onNavigate={() => setMenu(false)}>My account</AccountLink></motion.div>
              <motion.div className="mobile-menu-item" initial={{ opacity: 0, y: -8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -8 }} transition={{ delay: 0.28 }}><Link to="/track" onClick={() => setMenu(false)}>Track order</Link></motion.div>
            </motion.div>
          </>
        )}
      </AnimatePresence>
    </>
  );
}

export function StoreFooter() {
  const config = useStorefrontConfig();
  return (
    <footer className="page-footer">
      <div>
        <StoreBrand footer />
        <p>
          <strong>{(config.legalName || config.storeName).toUpperCase()}</strong>
          <br />
          {config.fssaiLicense && <>FSSAI Lic. No.: {config.fssaiLicense}<br /></>}
          {config.footerTagline}
          <br />
          Client preview · Sample products and illustrative prices.
        </p>
      </div>
      <FooterSection title="Shop">
        <Link to="/shop">All products</Link>
        <Link to="/shop" search={{ category: "Sesame Oils" }}>Sesame oils</Link>
        <Link to="/shop" search={{ category: "Coconut Oils" }}>Coconut oils</Link>
      </FooterSection>
      <FooterSection title="Customer care">
        <AccountLink>My account</AccountLink>
        <Link to="/track">Track order</Link>
        <Link to="/account" search={{ tab: "Returns" }}>Returns</Link>
        <Link to="/shipping-returns">Returns &amp; refund policy</Link>
        <Link to="/contact">Contact</Link>
      </FooterSection>
      <FooterSection title="Company">
        <Link to="/" hash="values">Our promise</Link>
        <Link to="/" hash="journal">Recipes &amp; notes</Link>
        <Link to="/admin">Admin portal</Link>
        <Link to="/privacy">Privacy</Link>
        <Link to="/terms">Terms</Link>
        <button type="button" className="cookie-preferences-link" onClick={openAnalyticsPreferences}>Cookie preferences</button>
      </FooterSection>
      <p className="developer-credit">
        <strong className="copyright-badge">
          © {new Date().getFullYear()} {(config.legalName || config.storeName).toUpperCase()}. All rights reserved.
        </strong>
        <span className="developer-attribution">
          Developed by{" "}
          <a href="https://octaleads.com" target="_blank" rel="noreferrer">
            Octaleads
          </a>
        </span>
      </p>
    </footer>
  );
}

function FooterSection({ title, children }: { title: string; children: React.ReactNode }) {
  const [open, setOpen] = useState(false);

  return (
    <section className="footer-section">
      <button type="button" aria-expanded={open} onClick={() => setOpen((value) => !value)}>
        <span>{title}</span>
        <ChevronDown />
      </button>
      <div className={`footer-section-content${open ? " open" : ""}`}>{children}</div>
    </section>
  );
}

export function StorePage({ children }: { children: React.ReactNode }) {
  return (
    <div className="store-shell">
      <StoreHeader />
      {children}
      <StoreFooter />
    </div>
  );
}
