import { useCallback, useEffect, useMemo, useState } from "react";
import { type Product } from "@/data/commerce";
import {
  getStoreProductsSnapshot,
  useStoreProducts,
} from "@/lib/store-products";
import { commerceApi } from "@/lib/commerce-api";
import { trackCommerceEvent } from "@/lib/analytics";
import { commerceAmount, productAnalyticsItem } from "@/lib/commerce-analytics";

export type CartEntry = {
  productId: string;
  variantId?: string;
  quantity: number;
  /** Retained only while migrating carts saved before canonical variant IDs. */
  variant?: Record<string, string>;
};

export const commerceCartStorageKey = "sri-varahi-traders-cart-v1";
const key = commerceCartStorageKey;
const read = (): CartEntry[] => {
  try {
    const value = JSON.parse(localStorage.getItem(key) || "[]");
    return Array.isArray(value) ? value : [];
  } catch {
    return [];
  }
};
const countEntries = (entries: CartEntry[]) =>
  entries.reduce((sum, entry) => sum + entry.quantity, 0);

export function useCommerceCartCount() {
  const [count, setCount] = useState(0);

  useEffect(() => {
    const sync = () => setCount(countEntries(read()));
    const hydrate = async () => {
      try {
        const remote = await commerceApi<Array<{
          product: { id: string };
          variantId: string;
          quantity: number;
        }>>("/api/v1/cart");
        const merged = new Map<string, CartEntry>();
        for (const item of remote)
          merged.set(item.variantId, {
            productId: item.product.id,
            variantId: item.variantId,
            quantity: item.quantity,
          });
        for (const item of read())
          if (item.variantId) {
            const existing = merged.get(item.variantId);
            merged.set(item.variantId, {
              ...item,
              quantity: Math.max(item.quantity, existing?.quantity || 0),
            });
          }
        localStorage.setItem(key, JSON.stringify([...merged.values()]));
        window.dispatchEvent(new Event("varahi-commerce-cart"));
      } catch {
        sync();
      }
    };
    sync();
    void hydrate();
    window.addEventListener("varahi-commerce-cart", sync);
    window.addEventListener("storage", sync);
    window.addEventListener("varahi-commerce-auth", hydrate);
    return () => {
      window.removeEventListener("varahi-commerce-cart", sync);
      window.removeEventListener("storage", sync);
      window.removeEventListener("varahi-commerce-auth", hydrate);
    };
  }, []);

  return count;
}
const sameOptions = (
  left: Record<string, string>,
  right: Record<string, string>,
) => {
  const leftEntries = Object.entries(left);
  return (
    leftEntries.length === Object.keys(right).length &&
    leftEntries.every(([name, value]) => right[name] === value)
  );
};

const unavailableProduct = (productId: string): Product => ({
  id: productId,
  name: "Unavailable item",
  category: "Saved item",
  price: 0,
  mrp: 0,

  badge: "Unavailable",
  tone: "#d8d8d2",
  glyph: "—",
  variants: [],
});

export function useCommerceCart() {
  const products = useStoreProducts();
  const [items, setItems] = useState<CartEntry[]>([]);
  const syncRemote = useCallback((next: CartEntry[], previous: CartEntry[]) => {
    const nextByVariant = new Map(
      next.filter((item) => item.variantId).map((item) => [item.variantId!, item.quantity]),
    );
    const previousVariants = previous.map((item) => item.variantId).filter(Boolean) as string[];
    for (const [variantId, quantity] of nextByVariant)
      void commerceApi("/api/v1/cart/items", {
        method: "PUT",
        body: JSON.stringify({ variantId, quantity }),
      }).catch(() => undefined);
    for (const variantId of previousVariants)
      if (!nextByVariant.has(variantId))
        void commerceApi("/api/v1/cart/items", {
          method: "PUT",
          body: JSON.stringify({ variantId, quantity: 0 }),
        }).catch(() => undefined);
  }, []);
  const save = useCallback((next: CartEntry[], sync = true) => {
    const previous = read();
    setItems(next);
    localStorage.setItem(key, JSON.stringify(next));
    window.dispatchEvent(new Event("varahi-commerce-cart"));
    if (sync) syncRemote(next, previous);
  }, [syncRemote]);

  useEffect(() => {
    const sync = () => setItems(read());
    sync();
    window.addEventListener("varahi-commerce-cart", sync);
    window.addEventListener("storage", sync);
    return () => {
      window.removeEventListener("varahi-commerce-cart", sync);
      window.removeEventListener("storage", sync);
    };
  }, [save]);

  useEffect(() => {
    let active = true;
    const hydrate = async () => {
      try {
        const remote = await commerceApi<Array<{
          product: { id: string };
          variantId: string;
          quantity: number;
        }>>("/api/v1/cart");
        if (!active) return;
        const merged = new Map<string, CartEntry>();
        for (const item of remote)
          merged.set(item.variantId, {
            productId: item.product.id,
            variantId: item.variantId,
            quantity: item.quantity,
          });
        for (const item of read()) {
          if (!item.variantId) continue;
          const existing = merged.get(item.variantId);
          merged.set(item.variantId, {
            ...item,
            quantity: Math.max(item.quantity, existing?.quantity || 0),
          });
        }
        const next = [...merged.values()];
        save(next, false);
        syncRemote(
          next,
          remote.map((item) => ({
            productId: item.product.id,
            variantId: item.variantId,
            quantity: item.quantity,
          })),
        );
      } catch {
        // Local cart remains usable while the API is unavailable.
      }
    };
    void hydrate();
    window.addEventListener("varahi-commerce-auth", hydrate);
    return () => {
      active = false;
      window.removeEventListener("varahi-commerce-auth", hydrate);
    };
  }, [save, syncRemote]);

  useEffect(() => {
    const current = read();
    let changed = false;
    const migrated = current.map((entry) => {
      if (entry.variantId || !entry.variant) return entry;
      const product = products.find((item) => item.id === entry.productId);
      const variant = product?.variants?.find((candidate) =>
        sameOptions(candidate.options, entry.variant || {}),
      );
      if (!variant) return entry;
      changed = true;
      return {
        productId: entry.productId,
        variantId: variant.id,
        variant: variant.options,
        quantity: entry.quantity,
      };
    });
    if (changed) save(migrated);
  }, [products, save]);

  const lines = useMemo(
    () =>
      items
        .map((entry, index) => {
          const catalogProduct = products.find(
            (item) => item.id === entry.productId,
          );
          const product = catalogProduct || unavailableProduct(entry.productId);
          const selectedVariant =
            product.variants?.find((variant) => variant.id === entry.variantId) ||
            product.variants?.find((variant) =>
              sameOptions(variant.options, entry.variant || {}),
            );
          return {
            entry,
            index,
            product,
            variant: selectedVariant,
            unitPrice: selectedVariant?.price ?? product.price,
            available: selectedVariant?.stock ?? 0,
            unresolved: !catalogProduct || !selectedVariant,
            missingProduct: !catalogProduct,
          };
        }),
    [items, products],
  );

  const add = (productId: string, variantId: string, quantity = 1) => {
    if (!Number.isInteger(quantity) || quantity < 1) return false;
    const product = getStoreProductsSnapshot().find(
      (item) => item.id === productId,
    );
    const variant = product?.variants?.find((item) => item.id === variantId);
    if (!product || !variant || variant.stock < 1) return false;
    const current = read();
    const index = current.findIndex(
      (entry) =>
        entry.productId === productId && entry.variantId === variantId,
    );
    const next = [...current];
    if (index >= 0) {
      const existing = next[index]!;
      next[index] = {
        ...existing,
        variant: variant.options,
        quantity: Math.min(20, variant.stock, existing.quantity + quantity),
      };
    } else {
      next.push({
        productId,
        variantId,
        variant: variant.options,
        quantity: Math.min(20, variant.stock, Math.max(1, quantity)),
      });
    }
    const acceptedQuantity = next.find((entry) => entry.variantId === variantId)!.quantity - (index >= 0 ? current[index]!.quantity : 0);
    if (acceptedQuantity <= 0) return false;
    save(next);
    const item = productAnalyticsItem(product, variant, acceptedQuantity);
    if (item) trackCommerceEvent("add_to_cart", { items: [item], currency: "INR", value: commerceAmount(item.price * item.quantity) });
    return true;
  };

  const update = (index: number, quantity: number) => {
    if (!Number.isInteger(quantity)) return;
    const current = read();
    const previous = current[index];
    if (!previous) return;
    const line = lines.find((candidate) => candidate.index === index);
    const safeQuantity = line
      ? Math.min(20, Math.max(0, line.available), quantity)
      : quantity;
    save(
      safeQuantity < 1
        ? current.filter((_, itemIndex) => itemIndex !== index)
        : current.map((entry, itemIndex) =>
            itemIndex === index
              ? { ...entry, quantity: safeQuantity }
              : entry,
          ),
    );
    const delta = Math.max(0, safeQuantity) - previous.quantity;
    const item = line?.variant && productAnalyticsItem(line.product, line.variant, Math.abs(delta));
    if (item && delta !== 0) trackCommerceEvent(delta > 0 ? "add_to_cart" : "remove_from_cart", {
      items: [item], currency: "INR", value: commerceAmount(item.price * item.quantity),
    });
  };
  const clear = () => save([]);
  const subtotal = lines.reduce(
    (sum, line) => sum + line.unitPrice * line.entry.quantity,
    0,
  );

  return {
    items,
    lines,
    count: countEntries(items),
    subtotal,
    add,
    update,
    clear,
  };
}
