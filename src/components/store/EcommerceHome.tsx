import { productRouteKey } from "@/lib/product-url";
import { useEffect, useRef, useState } from "react";
import { Link, useNavigate } from "@tanstack/react-router";
import {
  ArrowRight,
  ChevronDown,
  Heart,
  Menu,
  Minus,
  Plus,
  Search,
  ShieldCheck,
  ShoppingBag,
  Sparkles,
  Truck,
  User,
  X,
} from "lucide-react";
import { openAnalyticsPreferences, trackCommerceEvent } from "@/lib/analytics";
import { analyticsItemsForCart, analyticsItemsForProducts, productAnalyticsItem } from "@/lib/commerce-analytics";
import { useCommerceImpression } from "@/lib/commerce-analytics-hooks";
import { priceIncludingTax } from "@/lib/catalog-price";
import { Route } from "@/routes/index";
import { categories, money, type Product } from "@/data/commerce";
import { useStoreProducts } from "@/lib/store-products";
import { toast, Toaster } from "sonner";
import { StoreBrand, useStorefrontConfig } from "@/lib/storefront-config";
import { additionalAnnouncement, deliveryAnnouncement } from "@/lib/delivery-policy";
import { CampaignSlot } from "@/lib/promotions";
import { useCommerceCart } from "@/lib/commerce-cart";
import { FloatingProductSearch } from "./FloatingProductSearch";
import { useCommerceWishlist } from "@/lib/commerce-wishlist";
import { AnimatePresence, motion } from "motion/react";

const Logo = () => <StoreBrand />;

function ProductCard({
  product,
  onAdd,
  liked,
  onWishlist,
}: {
  product: Product;
  onAdd: (p: Product, variantId: string) => void;
  liked: boolean;
  onWishlist: (productId: string) => void;
}) {
  const navigate = useNavigate();
  const requiresVariantSelection =
    (product.variants?.length || 0) > 1 ||
    (product.options || []).some((option) => option.values.length > 1);
  const chosenVariant =
    product.variants?.find((variant) => variant.stock > 0) ||
    product.variants?.[0];
  const hasAvailableVariant = Boolean(product.variants?.some((variant) => variant.stock > 0));
  const basePrice = chosenVariant?.price ?? product.price;
  const baseMrp = chosenVariant?.mrp ?? product.mrp;
  const selectProduct = () => {
    const item = productAnalyticsItem(product);
    if (item) trackCommerceEvent("select_item", { items: [item], item_list_name: "Home favourites" });
  };
  const openProduct = () => {
    selectProduct();
    return navigate({
      to: "/product/$productId",
      params: { productId: productRouteKey(product) },
    });
  };
  return (
    <article
      className="product-card product-card-clickable"
      role="link"
      tabIndex={0}
      aria-label={`View ${product.name}`}
      onClick={(event) => {
        if ((event.target as HTMLElement).closest("a, button")) return;
        openProduct();
      }}
      onKeyDown={(event) => {
        if (event.target !== event.currentTarget) return;
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          openProduct();
        }
      }}
    >
      <div className="product-art" style={{ background: product.tone }}>
        {product.badge && <span className="tag">{product.badge}</span>}
        <button
          className={`heart ${liked ? "active" : ""}`}
          onClick={() => onWishlist(product.id)}
          aria-label="Save to wishlist"
        >
          <Heart />
        </button>
        {product.image ? (
          <img src={product.image} alt={product.imageAlt || product.name} loading="lazy" />
        ) : (
          <span className="art-glyph">{product.glyph}</span>
        )}
        {!hasAvailableVariant ? (
          <button className="quick" disabled>Sold out</button>
        ) : requiresVariantSelection ? (
          <Link
            className="quick"
            to="/product/$productId"
            params={{ productId: productRouteKey(product) }}
            onClick={selectProduct}
          >
            Choose options <ArrowRight />
          </Link>
        ) : (
          <button
            className="quick"
            disabled={!chosenVariant || chosenVariant.stock < 1}
            onClick={() => chosenVariant && chosenVariant.stock > 0 && onAdd(product, chosenVariant.id)}
          >
            Quick add <Plus />
          </button>
        )}
      </div>
      <div className="product-info">
        <p>{product.category}</p>
        <h3>{product.name}</h3>
        <div className="price">
          {money(priceIncludingTax(basePrice, product.taxRate))}{" "}
          {baseMrp > basePrice && <s>{money(priceIncludingTax(baseMrp, product.taxRate))}</s>}
        </div>
      </div>
    </article>
  );
}

export function EcommerceHome() {
  const storefront = useStorefrontConfig(),
    products = useStoreProducts(Route.useLoaderData()),cart = useCommerceCart();
  const wishlist = useCommerceWishlist();
  const [menu, setMenu] = useState(false),
    [search, setSearch] = useState(false),
    [cartOpen, setCartOpen] = useState(false),[email, setEmail] = useState("");
  const categoryScroller = useRef<HTMLDivElement>(null);
  const categoryPausedUntil = useRef(0);
  const count=cart.count,subtotal=cart.subtotal;
  useCommerceImpression("view_item_list", analyticsItemsForProducts(products), "Home favourites");
  useCommerceImpression("view_cart", analyticsItemsForCart(cart.lines), undefined, cartOpen);
  const add = (p: Product,variantId:string) => {
    if (!cart.add(p.id,variantId)) {
      toast.error("That option is currently unavailable");
      return;
    }
    toast.success(`${p.name} added to bag`);
  };
  const toggleWishlist = async (productId: string) => {
    const removing = wishlist.saved.includes(productId);
    try {
      const result = await wishlist.toggle(productId);
      toast.success(
        removing
          ? "Removed from wishlist"
          : result.synced
            ? "Saved to your wishlist"
            : "Saved on this device · sign in to sync",
      );
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Wishlist could not be updated");
    }
  };
  useEffect(() => {
    if (!menu && !cartOpen) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setMenu(false);
        setCartOpen(false);
      }
    };
    document.body.classList.add("mobile-overlay-open");
    window.addEventListener("keydown", closeOnEscape);
    return () => {
      document.body.classList.remove("mobile-overlay-open");
      window.removeEventListener("keydown", closeOnEscape);
    };
  }, [menu, cartOpen]);
  useEffect(() => {
    const scroller = categoryScroller.current;
    const mobile = window.matchMedia("(max-width: 800px)");
    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
    if (!scroller || !mobile.matches || reducedMotion.matches) return;
    const timer = window.setInterval(() => {
      if (Date.now() < categoryPausedUntil.current) return;
      const firstCard = scroller.querySelector<HTMLElement>(".category-card");
      if (!firstCard) return;
      const gap = Number.parseFloat(getComputedStyle(scroller).columnGap || "0");
      const step = firstCard.getBoundingClientRect().width + gap;
      const atEnd = scroller.scrollLeft + scroller.clientWidth >= scroller.scrollWidth - step / 2;
      scroller.scrollTo({ left: atEnd ? 0 : scroller.scrollLeft + step, behavior: "smooth" });
    }, 2600);
    return () => window.clearInterval(timer);
  }, []);
  const pauseCategoryScroll = () => {
    categoryPausedUntil.current = Date.now() + 7000;
  };
  return (
    <div id="top" className="store-shell">
      <Toaster position="bottom-center" richColors />
      <CampaignSlot placement="HOME_HERO" />
      <div className="announcement">
        <span>{deliveryAnnouncement(storefront)}</span>
        <span>{additionalAnnouncement(storefront.announcement) || "Quality checked at every step"}</span>
        <span>Secure, careful delivery</span>
      </div>
      <header className="store-header">
        <button
          aria-label={menu ? "Close navigation" : "Open navigation"}
          aria-expanded={menu}
          aria-controls="mobile-store-navigation"
          className="icon-btn mobile-only"
          onClick={() => setMenu((open) => !open)}
        >
          {menu ? <X /> : <Menu />}
        </button>
        <Logo />
        <nav>
          <Link to="/shop">Oil collection</Link>
          <Link to="/shop">
            Shop <ChevronDown />
          </Link>
          <a href="#journal">Recipes & notes</a>
          <a href="#values">Our promise</a>
        </nav>
        <div className="header-actions">
          <button aria-label="Search products" aria-expanded={search} aria-controls="home-product-search" onClick={() => setSearch(!search)}>
            <Search />
          </button>
          <Link
            to="/account"
            search={{ tab: "My overview" }}
            className="desktop-only"
            title="My account"
          >
            <User />
          </Link>
          <button
            aria-label={`Open bag with ${count} items`}
            onClick={() => setCartOpen(true)}
          >
            <ShoppingBag />
            <em>{count}</em>
          </button>
        </div>
      </header>
      <div id="home-product-search"><FloatingProductSearch open={search} onClose={() => setSearch(false)} /></div>
      <AnimatePresence>
        {menu && (
          <>
            <motion.button
              className="mobile-menu-backdrop"
              aria-label="Close navigation"
              onClick={() => setMenu(false)}
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.2 }}
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
              {[
                ["Shop all oils", "/shop"],
                ["Cooking Oils", "/shop?category=Cooking%20Oils"],
                ["Sesame Oils", "/shop?category=Sesame%20Oils"],
                ["Coconut Oils", "/shop?category=Coconut%20Oils"],
                ["Oil Combos", "/shop?category=Oil%20Combos"],
                ["Recipes & notes", "#journal"],
                ["Our promise", "#values"],
              ].map(([label, href], index) => (
                <motion.a
                  key={label}
                  href={href}
                  onClick={() => setMenu(false)}
                  initial={{ opacity: 0, y: -8 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ delay: 0.04 + index * 0.035, duration: 0.22 }}
                >
                  {label}
                  <ArrowRight />
                </motion.a>
              ))}
            </motion.div>
          </>
        )}
      </AnimatePresence>
      <main>
        <CampaignSlot placement="HOME_INLINE" />
        <section className="hero home-hero">
          <div className="hero-copy">
            <p className="eyebrow">Traditionally pressed · Everyday goodness</p>
            <h1>
              Honest oils for<br />
              <em>considered kitchens.</em>
            </h1>
            <p>
              Discover groundnut, sesame and coconut oils,
              cold pressed for the everyday rituals of your kitchen.
            </p>
            <div>
              <Link className="btn dark" to="/shop">
                Shop oils <ArrowRight />
              </Link>
              <a className="text-link home-hero-secondary" href="#values">
                Why Sri Varahi Traders
              </a>
            </div>
          </div>
          <div className="hero-art">
            <picture>
              <source
                media="(max-width: 800px)"
                srcSet="/images/varahi-oils-hero.png"
              />
              <img
                src="/images/varahi-oils-hero.png"
                alt="Glass bottles of cold-pressed oils with coconut, groundnuts and sesame seeds"
              />
            </picture>
          </div>
        </section>
        <section id="new" className="section products">
          <div className="product-grid">
            {products.map((p) => (
              <ProductCard
                key={p.id}
                product={p}
                onAdd={add}
                liked={wishlist.saved.includes(p.id)}
                onWishlist={(id) => void toggleWishlist(id)}
              />
            ))}
          </div>
          <Link to="/shop" className="btn outline">
            Browse all products <ArrowRight />
          </Link>
        </section>
        <section className="trust-row" aria-label="Sri Varahi Traders guarantees">
          <div className="trust-track">
            <span><ShoppingBag /> Oils for everyday cooking</span>
            <span><Truck /> Delivery options at checkout</span>
            <span><ShieldCheck /> Secure, encrypted checkout</span>
            <span><Sparkles /> Groundnut, sesame and coconut</span>
            <span>✓ Carefully packed for your pantry</span>
            <span aria-hidden="true"><ShoppingBag /> Oils for everyday cooking</span>
            <span aria-hidden="true"><Truck /> Delivery options at checkout</span>
            <span aria-hidden="true"><ShieldCheck /> Secure, encrypted checkout</span>
            <span aria-hidden="true"><Sparkles /> Groundnut, sesame and coconut</span>
            <span aria-hidden="true">✓ Carefully packed for your pantry</span>
          </div>
        </section>
        <section id="shop" className="section categories">
          <div className="section-head">
            <div>
              <p className="eyebrow">Find your everyday oil</p>
              <h2>An oil for every Indian kitchen.</h2>
            </div>
            <a href="#new">
              View all collections <ArrowRight />
            </a>
          </div>
          <div
            className="category-grid"
            ref={categoryScroller}
            onPointerDown={pauseCategoryScroll}
            onPointerEnter={pauseCategoryScroll}
            onFocus={pauseCategoryScroll}
            aria-label="Find your everyday oil collections"
          >
            {categories.map(([name, copy, glyph, tone], i) => (
              <Link
                to="/shop"
                search={{ category: name }}
                className="category-card"
                key={name}
                style={{ background: tone }}
              >
                <span className="count">0{i + 1}</span>
                <span className="category-glyph">{glyph}</span>
                <div>
                  <h3>{name}</h3>
                  <p>{copy}</p>
                  <ArrowRight />
                </div>
              </Link>
            ))}
          </div>
        </section>
        <section id="values" className="story story-compact">
          <div className="story-art">
            <span>
              Rooted in<br /><i>goodness.</i>
            </span>
          </div>
          <div className="story-copy">
            <p className="eyebrow">Our oil collection</p>
            <h2>Tradition, bottled for today.</h2>
            <p>
              From familiar kitchen staples to oils for traditional recipes, explore a thoughtful collection for everyday cooking.
            </p>
            <div className="principles">
              <div>
                <b>01</b>
                <span>
                  <strong>Everyday essentials</strong>
                </span>
              </div>
              <div>
                <b>02</b>
                <span>
                  <strong>Traditional pressing</strong>
                </span>
              </div>
              <div>
                <b>03</b>
                <span>
                  <strong>Thoughtfully packed</strong>
                </span>
              </div>
            </div>
          </div>
        </section>
        <section id="journal" className="section newsletter">
          <p className="eyebrow">Notes from our kitchen</p>
          <h2>Good things from our kitchen.</h2>
          <p>
            Oil guides, recipes and news from Sri Varahi Traders.
            Sent occasionally.
          </p>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              if (email.includes("@")) {
                toast.success("Welcome to the list");
                setEmail("");
              } else toast.error("Enter a valid email");
            }}
          >
            <input
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="Your email address"
            />
            <button>
              Join the list <ArrowRight />
            </button>
          </form>
          <small>By subscribing, you agree to our privacy policy.</small>
        </section>
      </main>
      <footer>
        <div>
          <Logo />
          <p>
            <strong>{(storefront.legalName || storefront.storeName).toUpperCase()}</strong>
            <br />
            {storefront.fssaiLicense && <>FSSAI Lic. No.: {storefront.fssaiLicense}<br /></>}
            {storefront.footerTagline}
            <br />
            Client preview · Sample products and illustrative prices.
          </p>
        </div>
        <HomeFooterSection title="Shop">
          <Link to="/shop" search={{ category: "Cooking Oils" }}>Cooking Oils</Link>
          <Link to="/shop" search={{ category: "Sesame Oils" }}>Sesame Oils</Link>
          <Link to="/shop" search={{ category: "Coconut Oils" }}>Coconut Oils</Link>
          <Link to="/shop" search={{ category: "Oil Combos" }}>Oil Combos</Link>
        </HomeFooterSection>
        <HomeFooterSection title="Company">
          <a href="#values">Our promise</a>
          <a href="#journal">Recipes & notes</a>
          <Link to="/privacy">Privacy</Link>
          <Link to="/terms">Terms</Link>
          <button type="button" className="cookie-preferences-link" onClick={openAnalyticsPreferences}>Cookie preferences</button>
        </HomeFooterSection>
        <HomeFooterSection title="Help">
          <Link to="/contact">Contact</Link>
          <Link to="/shipping-returns">Shipping & returns</Link>
          <Link to="/track">Track order</Link>
          <Link to="/account" search={{ tab: "Support" }}>Support</Link>
        </HomeFooterSection>
        <HomeFooterSection title="Portals">
          <a href="/account">Customer account</a>
          <a href="/admin">Store admin</a>
          <Link to="/account" search={{ tab: "Support" }}>Support</Link>
        </HomeFooterSection>
        <p className="developer-credit">
          <strong className="copyright-badge">
            © {new Date().getFullYear()} {(storefront.legalName || storefront.storeName).toUpperCase()}. All rights reserved.
          </strong>
          <span className="developer-attribution">
            Developed by{" "}
            <a href="https://octaleads.com" target="_blank" rel="noreferrer">
              Octaleads
            </a>
          </span>
        </p>
      </footer>
      {cartOpen && (
        <>
          <button
            className="drawer-backdrop"
            onClick={() => setCartOpen(false)}
            aria-label="Close cart"
          />
          <aside className="cart-drawer">
            <div className="drawer-head">
              <div>
                <p>Your bag</p>
                <span>
                  {count} {count === 1 ? "item" : "items"}
                </span>
              </div>
              <button onClick={() => setCartOpen(false)}>
                <X />
              </button>
            </div>
            <div className="cart-items">
              {!count ? (
                <div className="empty">
                  <ShoppingBag />
                  <h3>Your bag is empty</h3>
                  <p>Cold-pressed oils are waiting.</p>
                  <button
                    onClick={() => setCartOpen(false)}
                    className="btn dark"
                  >
                    Continue shopping
                  </button>
                </div>
              ) : (
                cart.lines.map(({product:p,entry,index,variant,unitPrice,available,unresolved}) => (
                    <div className="cart-line" key={`${p.id}-${index}`}>
                      <div
                        className="cart-thumb"
                        style={{ background: p.tone }}
                      >
                        {variant?.image || p.image ? (
                          <img
                            src={variant?.image || p.image}
                            alt={variant?.imageAlt || p.imageAlt || p.name}
                          />
                        ) : (
                          p.glyph
                        )}
                      </div>
                      <div>
                        <h4>{p.name}</h4>
                        <p>
                          {variant?.title ||
                            (variant && Object.values(variant.options).join(" / ")) ||
                            p.category}
                        </p>
                        {unresolved && (
                          <small role="alert">
                            This saved item is no longer available.{" "}
                            <button onClick={() => cart.update(index, 0)}>
                              Remove
                            </button>
                          </small>
                        )}
                        <div className="qty">
                          <button onClick={() => cart.update(index, entry.quantity - 1)}>
                            <Minus />
                          </button>
                          <span>{entry.quantity}</span>
                          <button
                            onClick={() => cart.update(index, entry.quantity + 1)}
                            disabled={unresolved || entry.quantity >= available}
                            aria-label={`Increase ${p.name} quantity`}
                          >
                            <Plus />
                          </button>
                        </div>
                      </div>
                      <strong>{money(unitPrice * entry.quantity)}</strong>
                    </div>
                  ))
              )}
            </div>
            {!!count && (
              <div className="cart-total">
                <div>
                  <span>Subtotal before GST</span>
                  <strong>{money(subtotal)}</strong>
                </div>
                <p>Shipping and taxes calculated at checkout.</p>
                <Link className="btn dark" to="/checkout">
                  Secure checkout <ShieldCheck />
                </Link>
              </div>
            )}
          </aside>
        </>
      )}
    </div>
  );
}

function HomeFooterSection({ title, children }: { title: string; children: React.ReactNode }) {
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
