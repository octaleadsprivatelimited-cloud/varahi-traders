import { productRouteKey } from "@/lib/product-url";
import { useEffect, useMemo, useState } from "react";
import { Link, useLocation, useNavigate } from "@tanstack/react-router";
import {
  Filter,
  Search,
  ShoppingBag,
  X,
} from "lucide-react";
import { trackCommerceEvent } from "@/lib/analytics";
import { analyticsItemsForProducts, productAnalyticsItem } from "@/lib/commerce-analytics";
import { useCommerceImpression } from "@/lib/commerce-analytics-hooks";
import { priceIncludingTax } from "@/lib/catalog-price";
import { Route } from "@/routes/shop";
import { money } from "@/data/commerce";
import { useStoreProducts } from "@/lib/store-products";
import { useCommerceCart } from "@/lib/commerce-cart";
import { StorePage } from "./StoreHeader";
import { CampaignSlot } from "@/lib/promotions";
export function ShopPage() {
  const products = useStoreProducts(Route.useLoaderData());
  const location = useLocation();
  const navigate = useNavigate();
  const params = new URLSearchParams(location.searchStr);
  const [category, setCategory] = useState(params.get("category") || "All"),
    [query, setQuery] = useState(params.get("q") || ""),
    [sort, setSort] = useState("featured"),
    [min, setMin] = useState(""),
    [max, setMax] = useState(""),
    [inStockOnly, setInStockOnly] = useState(false),
    [filters, setFilters] = useState(false),
    [quickProductId, setQuickProductId] = useState<string | null>(null),
    [selectedVariantId, setSelectedVariantId] = useState<string | null>(null);
  const cart = useCommerceCart();
  useEffect(() => {
    const next = new URLSearchParams(location.searchStr);
    setCategory(next.get("category") || "All");
    setQuery(next.get("q") || "");
  }, [location.searchStr]);
  useEffect(() => {
    if (!filters) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setFilters(false);
    };
    const closeOnWideScreen = () => {
      if (window.innerWidth > 850) setFilters(false);
    };
    document.body.classList.add("mobile-overlay-open");
    window.addEventListener("keydown", closeOnEscape);
    window.addEventListener("resize", closeOnWideScreen);
    return () => {
      document.body.classList.remove("mobile-overlay-open");
      window.removeEventListener("keydown", closeOnEscape);
      window.removeEventListener("resize", closeOnWideScreen);
    };
  }, [filters]);
  const categories = ["All", ...new Set(products.map((p) => p.category))];
  const quickProduct = products.find((product) => product.id === quickProductId);
  const selectedVariant = quickProduct?.variants?.find(
    (variant) => variant.id === selectedVariantId,
  );
  const openQuickAdd = (productId: string) => {
    const product = products.find((item) => item.id === productId);
    if (product) selectProduct(product);
    setQuickProductId(productId);
    setSelectedVariantId(product?.variants?.find((variant) => variant.stock > 0)?.id || null);
  };
  const shown = useMemo(
    () =>
      products
        .filter(
          (p) =>
            (category === "All" || p.category === category) &&
            `${p.name} ${p.category}`
              .toLowerCase()
              .includes(query.toLowerCase()) &&
            (!min || priceIncludingTax(p.price, p.taxRate) >= Number(min)) &&
            (!max || priceIncludingTax(p.price, p.taxRate) <= Number(max)) &&
            (!inStockOnly || p.variants?.some((variant) => variant.stock > 0)),
        )
        .sort((a, b) =>
          sort === "low"
            ? priceIncludingTax(a.price, a.taxRate) - priceIncludingTax(b.price, b.taxRate)
            : sort === "high"
              ? priceIncludingTax(b.price, b.taxRate) - priceIncludingTax(a.price, a.taxRate)
              : 0,
        ),
    [products, category, query, sort, min, max, inStockOnly],
  );
  useCommerceImpression("view_item_list", analyticsItemsForProducts(shown), "Shop");
  const selectProduct = (product: (typeof products)[number]) => {
    const item = productAnalyticsItem(product);
    if (item) trackCommerceEvent("select_item", { items: [item], item_list_name: "Shop" });
  };
  const filterContent = (
    <>
      <div className="mobile-filter-head">
        <h2>Filters</h2>
        <button aria-label="Close filters" onClick={() => setFilters(false)}>
          <X />
        </button>
      </div>
      <h3>Categories</h3>
      {categories.map((x) => (
        <button
          className={x === category ? "active" : ""}
          aria-pressed={x === category}
          onClick={() => setCategory(x)}
          key={x}
        >
          {x}
          <span>
            {x === "All"
              ? products.length
              : products.filter((p) => p.category === x).length}
          </span>
        </button>
      ))}
      <hr />
      <h3>Availability</h3>
      <label>
        <input
          type="checkbox"
          checked={inStockOnly}
          onChange={(e) => setInStockOnly(e.target.checked)}
        />{" "}
        In stock only
      </label>
      <hr />
      <h3>Price</h3>
      <div className="price-range">
        <input
          value={min}
          onChange={(e) => setMin(e.target.value)}
          type="number"
          min="0"
          aria-label="Minimum price in rupees"
          inputMode="numeric"
          placeholder="₹ Min"
        />
        <span>—</span>
        <input
          value={max}
          onChange={(e) => setMax(e.target.value)}
          type="number"
          min="0"
          aria-label="Maximum price in rupees"
          inputMode="numeric"
          placeholder="₹ Max"
        />
      </div>
      <button
        className="clear-filter"
        onClick={() => {
          setCategory("All");
          setMin("");
          setMax("");
          setInStockOnly(false);
        }}
      >
        Clear all filters
      </button>
    </>
  );
  return (
    <StorePage>
      <main className="shop-page">
        <CampaignSlot placement="SHOP_TOP" />
        <header className="shop-heading"><h1>Shop oils</h1></header>
        <div className="catalog-tools">
          <label>
            <Search />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              aria-label="Search cold-pressed oils"
              placeholder="Search groundnut, sesame, coconut oils…"
            />
          </label>
          <button
            className="catalog-filter-toggle"
            aria-expanded={filters}
            aria-controls="mobile-product-filters"
            onClick={() => setFilters(true)}
          >
            <Filter /> Filters
          </button>
          <select aria-label="Sort products" value={sort} onChange={(e) => setSort(e.target.value)}>
            <option value="featured">Featured</option>
            <option value="low">Price: low to high</option>
            <option value="high">Price: high to low</option>
          </select>
        </div>
        <div className="mobile-category-chips" aria-label="Browse product categories">
          {categories.map((item) => (
            <button
              type="button"
              className={item === category ? "active" : ""}
              aria-pressed={item === category}
              onClick={() => setCategory(item)}
              key={item}
            >
              {item}
            </button>
          ))}
        </div>
        <div className="catalog-layout">
          <aside>{filterContent}</aside>
          <section>
            <div className="results-title" aria-live="polite">
              <span>{shown.length} products</span>
            </div>
            {shown.length ? (
              <div className="catalog-grid">
                {shown.map((p) => (
                  <article
                    key={p.id}
                    className="catalog-card-clickable"
                    role="link"
                    tabIndex={0}
                    aria-label={`View ${p.name}`}
                    onClick={(event) => {
                      if ((event.target as HTMLElement).closest("a, button")) return;
                      selectProduct(p);
                      navigate({
                        to: "/product/$productId",
                        params: { productId: productRouteKey(p) },
                      });
                    }}
                    onKeyDown={(event) => {
                      if (event.target !== event.currentTarget) return;
                      if (event.key === "Enter" || event.key === " ") {
                        event.preventDefault();
                        selectProduct(p);
                        navigate({
                          to: "/product/$productId",
                          params: { productId: productRouteKey(p) },
                        });
                      }
                    }}
                  >
                    <Link
                      to="/product/$productId"
                      params={{ productId: productRouteKey(p) }}
                      onClick={() => selectProduct(p)}
                      className="catalog-art"
                      style={{ background: p.tone }}
                    >
                      {p.image ? (
                        <img src={p.image} alt={p.imageAlt || p.name} loading="lazy" />
                      ) : (
                        <span>{p.glyph}</span>
                      )}
                      {p.badge && <em>{p.badge}</em>}
                    </Link>
                    <Link
                      to="/product/$productId"
                      params={{ productId: productRouteKey(p) }}
                      onClick={() => selectProduct(p)}
                    >
                      <small>{p.category}</small>
                      <h2>{p.name}</h2>
                      <p>
                        {money(priceIncludingTax(p.price, p.taxRate))}
                        {p.mrp > p.price && <s>{money(priceIncludingTax(p.mrp, p.taxRate))}</s>}
                      </p>
                    </Link>
                    <button
                      className="catalog-add-bag"
                      type="button"
                      disabled={!p.variants?.some((variant) => variant.stock > 0)}
                      onClick={() => openQuickAdd(p.id)}
                    >
                      <ShoppingBag /> {p.variants?.some((variant) => variant.stock > 0) ? "Add to bag" : "Sold out"}
                    </button>
                  </article>
                ))}
              </div>
            ) : (
              <div className="no-results">
                <Search />
                <h2>No products found</h2>
                <p>Try clearing filters or using a broader search.</p>
                <button
                  onClick={() => {
                    setQuery("");
                    setMin("");
                    setMax("");
                    setCategory("All");
                    setInStockOnly(false);
                  }}
                >
                  Clear filters
                </button>
              </div>
            )}
          </section>
        </div>
        {filters && (
          <>
            <button
              className="filter-backdrop"
              aria-label="Close filters"
              onClick={() => setFilters(false)}
            />
            <aside
              id="mobile-product-filters"
              className="mobile-filters"
              role="dialog"
              aria-modal="true"
              aria-label="Product filters"
            >
              {filterContent}
            </aside>
          </>
        )}
        {quickProduct && (
          <>
            <button
              className="quick-add-backdrop"
              type="button"
              aria-label="Close product options"
              onClick={() => setQuickProductId(null)}
            />
            <section
              className="quick-add-modal"
              role="dialog"
              aria-modal="true"
              aria-labelledby="quick-add-title"
            >
              <header>
                <div>
                  <p>{quickProduct.category}</p>
                  <h2 id="quick-add-title">{quickProduct.name}</h2>
                </div>
                <button type="button" aria-label="Close product options" onClick={() => setQuickProductId(null)}><X /></button>
              </header>
              <p className="quick-add-label">Choose weight</p>
              <div className="quick-add-options">
                {quickProduct.variants?.map((variant) => (
                  <button
                    key={variant.id}
                    type="button"
                    className={variant.id === selectedVariantId ? "active" : ""}
                    aria-pressed={variant.id === selectedVariantId}
                    disabled={variant.stock < 1}
                    onClick={() => setSelectedVariantId(variant.id)}
                  >
                    <span>{variant.options.Weight || variant.title || "Option"}</span>
                    <strong>{money(priceIncludingTax(variant.price, quickProduct.taxRate))}</strong>
                  </button>
                ))}
              </div>
              <footer>
                <span>{selectedVariant ? `${selectedVariant.options.Weight || selectedVariant.title} · ${money(priceIncludingTax(selectedVariant.price, quickProduct.taxRate))}` : "Select an available weight"}</span>
                <button
                  type="button"
                  className="quick-add-confirm"
                  disabled={!selectedVariant}
                  onClick={() => {
                    if (!selectedVariant || !cart.add(quickProduct.id, selectedVariant.id)) return;
                    setQuickProductId(null);
                  }}
                >
                  <ShoppingBag /> Add to bag
                </button>
              </footer>
            </section>
          </>
        )}
      </main>
    </StorePage>
  );
}
