import { productRouteKey } from "@/lib/product-url";
import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { productAnalyticsItem } from "@/lib/commerce-analytics";
import { useCommerceImpression } from "@/lib/commerce-analytics-hooks";
import { priceIncludingTax } from "@/lib/catalog-price";
import {
  Check,
  ChevronRight,
  Heart,
  Minus,
  Plus,
  ShieldCheck,
  ShoppingBag,
  Truck,
} from "lucide-react";
import { money, products as fallbackProducts, type Product } from "@/data/commerce";
import { useCommerceWishlist } from "@/lib/commerce-wishlist";
import { useCommerceCart } from "@/lib/commerce-cart";
import { useStoreProducts } from "@/lib/store-products";
import { useStorefrontConfig } from "@/lib/storefront-config";
import { deliveryAnnouncement, deliveryEstimate } from "@/lib/delivery-policy";
import { StorePage } from "./StoreHeader";
import { toast, Toaster } from "sonner";
import { Route } from "@/routes/product.$productId";
function initialProductOptions(product: Product | undefined, requestedVariantId?: string) {
  const variants = product?.variants || [];
  const requested = variants.find((variant) => variant.id === requestedVariantId);
  const requiresChoice = variants.length > 1 || (product?.options || []).some((option) => option.values.length > 1);
  return requested?.options || (!requiresChoice ? (variants.find((variant) => variant.stock > 0) || variants[0])?.options : undefined) || {};
}

export function ProductDetailPage() {
  const { productId } = Route.useParams();
  const requestedVariantId = Route.useSearch().variant;
  const navigate = useNavigate();
  const loadedProduct = Route.useLoaderData();
  const initialProducts = useMemo(() => loadedProduct ? [loadedProduct] : undefined, [loadedProduct]);
  const products = useStoreProducts(initialProducts);
  const storefront = useStorefrontConfig();
  const legacyProduct = fallbackProducts.find((item) => item.id === productId);
  const product =
    products.find((item) => item.id === productId || item.slug === productId || item.id === loadedProduct?.id) || loadedProduct ||
    (legacyProduct
      ? products.find(
          (item) =>
            item.name.toLowerCase() === legacyProduct.name.toLowerCase() &&
            item.category.toLowerCase() === legacyProduct.category.toLowerCase(),
        )
      : undefined);
  const [qty, setQty] = useState(1);
  const [selection, setSelection] = useState(() => ({ productId: product?.id, requestedVariantId, options: initialProductOptions(product, requestedVariantId) }));
  // Route changes must render the requested option immediately, including SSR.
  const selected = selection.productId === product?.id && selection.requestedVariantId === requestedVariantId
    ? selection.options
    : initialProductOptions(product, requestedVariantId);
  const cart = useCommerceCart();
  const wishlist = useCommerceWishlist();
  const [gallerySelection, setGallerySelection] = useState({ key: "", url: "" });
  const [wishlistBusy, setWishlistBusy] = useState(false);
  useEffect(() => { setQty(1); }, [product?.id, requestedVariantId]);
  const selectedVariant = product?.variants?.find(
    (variant) =>
      Object.keys(variant.options).length === Object.keys(selected).length &&
      Object.entries(selected).every(
        ([name, value]) => variant.options[name] === value,
      ),
  );
  const viewedItem = product && productAnalyticsItem(product, selectedVariant);
  useCommerceImpression("view_item", viewedItem ? [viewedItem] : []);
  if (!product)
    return (
      <StorePage>
        <main className="product-page module-empty">
          <ShoppingBag />
          <h2>Loading product details…</h2>
        </main>
      </StorePage>
    );
  const requiresVariantSelection =
    (product.variants?.length || 0) > 1 ||
    (product.options || []).some((option) => option.values.length > 1);
  const selectableOptions = requiresVariantSelection
    ? product.options || []
    : [];
  const basePrice = selectedVariant?.price ?? product.price;
  const baseMrp = selectedVariant?.mrp ?? product.mrp;
  const price = priceIncludingTax(basePrice, product.taxRate);
  const mrp = priceIncludingTax(baseMrp, product.taxRate);
  const hasAvailableVariant = Boolean(product.variants?.some((variant) => variant.stock > 0));
  const missingOptions = selectableOptions
    .map((option) => option.name)
    .filter((name) => !selected[name]);
  const selectionPending = requiresVariantSelection && !selectedVariant;
  const selectionPrompt = missingOptions.length
    ? `Select ${missingOptions.join(" and ")}`
    : "Select a variant";
  const chooseOption = (name: string, value: string) => {
    const next = { ...selected, [name]: value };
    setSelection({ productId: product.id, requestedVariantId, options: next });
    setQty(1);
    const variant = product.variants?.find((candidate) => Object.keys(candidate.options).length === Object.keys(next).length && Object.entries(next).every(([key, selectedValue]) => candidate.options[key] === selectedValue));
    if (variant) void navigate({ to: "/product/$productId", params: { productId: productRouteKey(product) }, search: { variant: variant.id }, replace: true, resetScroll: false });
  };
  const optionAvailable = (name: string, value: string) =>
    product.variants?.some(
      (variant) =>
        variant.stock > 0 &&
        variant.options[name] === value &&
        Object.entries(selected).every(
          ([selectedName, selectedValue]) =>
            selectedName === name ||
            variant.options[selectedName] === selectedValue,
        ),
    );
  const primaryImage = selectedVariant?.image || product.image;
  const primaryAlt = selectedVariant?.imageAlt || product.imageAlt || product.name;
  const galleryImages = [
    ...(primaryImage ? [{ url: primaryImage, alt: primaryAlt }] : []),
    ...(product.images || []).filter((image) => image.url !== primaryImage),
  ].filter((image, index, images) => images.findIndex((item) => item.url === image.url) === index);
  const galleryKey = `${product.id}:${selectedVariant?.id || "default"}`;
  const activeImage = gallerySelection.key === galleryKey
    ? galleryImages.find((image) => image.url === gallerySelection.url) || galleryImages[0]
    : galleryImages[0];
  const toggleWishlist = async () => {
    setWishlistBusy(true);
    try {
      const result = await wishlist.toggle(product.id);
      toast.success(result.saved ? (result.synced ? "Saved to your wishlist" : "Saved on this device · sign in to sync") : "Removed from wishlist");
    } catch {
      toast.error("Wishlist could not be updated. Please try again.");
    } finally {
      setWishlistBusy(false);
    }
  };
  const add = () => {
    if (
      !selectedVariant ||
      selectedVariant.stock < 1 ||
      !cart.add(product.id, selectedVariant.id, qty)
    ) {
      toast.error(selectionPrompt);
      return false;
    }
    toast.success("Added to your bag");
    return true;
  };
  return (
    <StorePage>
      <Toaster richColors position="bottom-center" />
      <main className="product-page product-page-refined">
        <div className="breadcrumbs">
          <a href="/">Home</a>
          <ChevronRight />
          <a href="/shop">Shop</a>
          <ChevronRight />
          <span>{product.name}</span>
        </div>
        <section className="product-detail">
          <div className="product-gallery" aria-label="Product photos">
            <div className="detail-art main">
              {activeImage ? <img src={activeImage.url} alt={activeImage.alt} fetchPriority="high" /> : product.glyph}
            </div>
            {galleryImages.length > 1 && <div className="product-thumbnails" aria-label="Choose a product photo">
              {galleryImages.map((image, index) => <button
                type="button"
                key={image.url}
                aria-label={`View product photo ${index + 1}`}
                aria-pressed={activeImage?.url === image.url}
                onClick={() => setGallerySelection({ key: galleryKey, url: image.url })}
              >
                <img src={image.url} alt={image.alt} loading="lazy" />
              </button>)}
            </div>}
          </div>
          <div className="buy-panel">
            <p className="eyebrow">{product.category}</p>
            <h1>{product.name}</h1>
            <div className="detail-price">
              {money(price)} {baseMrp > basePrice && <s>{money(mrp)}</s>}
              {baseMrp > basePrice && mrp > price && (
                <span>{Math.round((1 - price / mrp) * 100)}% off</span>
              )}
            </div>
            <p className="tax-note">Inclusive of all taxes</p>
            <p className={`product-availability${hasAvailableVariant ? " available" : ""}`}>
              <span aria-hidden="true" />{hasAvailableVariant ? "In stock" : "Currently sold out"}
            </p>
            <p className="detail-copy">
              {product.description || "Explore cold-pressed oils for everyday Indian cooking."}
            </p>
            {selectableOptions.map((opt) => (
              <div className="option-picker" key={opt.name}>
                <div>
                  <b>Select {opt.name}</b>
                  {opt.name.toLowerCase() === "size" && <button type="button">Size guide</button>}
                </div>
                <div>
                  {opt.values.map((v) => (
                    <button
                      onClick={() => chooseOption(opt.name, v)}
                      className={selected[opt.name] === v ? "active" : ""}
                      aria-pressed={selected[opt.name] === v}
                      disabled={!optionAvailable(opt.name, v)}
                      key={v}
                    >
                      {v}
                    </button>
                  ))}
                </div>
              </div>
            ))}
            {selectableOptions.length === 0 && selectedVariant && Object.keys(selectedVariant.options).length > 0 && <div className="product-pack-details">
              {Object.entries(selectedVariant.options).map(([name, value]) => <p key={name}><span>{name}</span><strong>{value}</strong></p>)}
            </div>}
            <p className="quantity-label">Quantity</p>
            <div className="buy-actions">
              <div className="quantity">
                <button aria-label="Decrease quantity" disabled={qty <= 1} onClick={() => setQty(Math.max(1, qty - 1))}>
                  <Minus />
                </button>
                <span>{qty}</span>
                <button
                  aria-label="Increase quantity"
                  onClick={() =>
                    setQty(
                      Math.min(20, selectedVariant?.stock || 1, qty + 1),
                    )
                  }
                  disabled={!selectedVariant || qty >= selectedVariant.stock}
                >
                  <Plus />
                </button>
              </div>
              <button
                className="add-bag"
                onClick={add}
                disabled={!selectedVariant || selectedVariant.stock < 1}
              >
                <ShoppingBag />
                {!hasAvailableVariant ? "Sold out" : selectionPending ? selectionPrompt : "Add to bag"}
              </button>
              <button className="save" aria-label={wishlist.saved.includes(product.id) ? "Remove from wishlist" : "Save to wishlist"} aria-pressed={wishlist.saved.includes(product.id)} disabled={wishlistBusy} onClick={() => void toggleWishlist()}>
                <Heart fill={wishlist.saved.includes(product.id) ? "currentColor" : "none"} />
              </button>
            </div>
            <a
              className="buy-now"
              href="/checkout"
              aria-disabled={!selectedVariant || selectedVariant.stock < 1}
              onClick={(event) => {
                if (!add()) event.preventDefault();
              }}
            >
              {!hasAvailableVariant ? "Sold out" : selectionPending ? `${selectionPrompt} to buy` : "Buy it now"}
            </a>
            <div className="delivery-box">
              <div>
                <Truck />
                <span>
                  <b>Delivery</b>
                  <small>{deliveryAnnouncement(storefront)} · Estimated {deliveryEstimate(storefront)}</small>
                </span>
              </div>
              <div>
                <ShieldCheck />
                <span>
                  <b>Secure checkout</b>
                  <small>Encrypted payments and verified providers</small>
                </span>
              </div>
              <div>
                <Check />
                <span>
                  <b>Freshness promise</b>
                  <small>Cold-pressed oils, carefully packed for your pantry</small>
                </span>
              </div>
            </div>
            <section className="product-details-accordion" aria-label="Product information">
              <details open>
                <summary>Product details<Plus aria-hidden="true" /></summary>
            <dl>
              {Object.entries(product.specifications || {}).map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}
              {product.brand ? <div><dt>Brand</dt><dd>{product.brand}</dd></div> : null}
              {selectedVariant?.sku && <div>
                <dt>SKU</dt>
                <dd>{selectedVariant.sku}</dd>
              </div>}
            </dl>
              </details>
              <details>
                <summary>Delivery & returns<Plus aria-hidden="true" /></summary>
                <p>Delivery availability and charges are shown at checkout. For order concerns and the applicable return terms, see our <a href="/shipping-returns">delivery and refund policy</a>.</p>
                <a className="product-help-link" href="/contact">Need help? Contact us <ChevronRight size={14} /></a>
              </details>
            </section>
          </div>
        </section>

      </main>
    </StorePage>
  );
}
