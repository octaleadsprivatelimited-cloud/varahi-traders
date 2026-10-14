import { useEffect, useState } from "react";
import { commerceApi } from "./commerce-api";

const storageKey = "sri-varahi-traders-wishlist-v1";

function readWishlist() {
  try {
    const value = JSON.parse(localStorage.getItem(storageKey) || "[]");
    return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}

function authenticated() {
  return Boolean(sessionStorage.getItem("varahi_commerce_access_token"));
}

export function useCommerceWishlist() {
  const [saved, setSaved] = useState<string[]>([]);
  const persistLocal = (next: string[]) => {
    setSaved(next);
    localStorage.setItem(storageKey, JSON.stringify(next));
    window.dispatchEvent(new Event("varahi-commerce-wishlist"));
  };

  useEffect(() => {
    let active = true;
    const hydrate = async () => {
      const local = readWishlist();
      if (!authenticated()) {
        if (active) setSaved(local);
        return;
      }
      try {
        const remote = await commerceApi<Array<{ id: string }>>("/api/v1/wishlist");
        if (!active) return;
        const merged = [...new Set([...remote.map((item) => item.id), ...local])];
        persistLocal(merged);
        await Promise.all(
          local
            .filter((id) => !remote.some((item) => item.id === id))
            .map((id) => commerceApi(`/api/v1/wishlist/${encodeURIComponent(id)}`, { method: "PUT" })),
        );
      } catch {
        if (active) setSaved(local);
      }
    };
    const syncLocal = () => setSaved(readWishlist());
    void hydrate();
    window.addEventListener("varahi-commerce-auth", hydrate);
    window.addEventListener("varahi-commerce-wishlist", syncLocal);
    window.addEventListener("storage", syncLocal);
    return () => {
      active = false;
      window.removeEventListener("varahi-commerce-auth", hydrate);
      window.removeEventListener("varahi-commerce-wishlist", syncLocal);
      window.removeEventListener("storage", syncLocal);
    };
  }, []);

  const toggle = async (productId: string) => {
    const removing = saved.includes(productId);
    const next = removing ? saved.filter((id) => id !== productId) : [...saved, productId];
    persistLocal(next);
    if (!authenticated()) return { saved: !removing, synced: false };
    try {
      await commerceApi(`/api/v1/wishlist/${encodeURIComponent(productId)}`, {
        method: removing ? "DELETE" : "PUT",
      });
      return { saved: !removing, synced: true };
    } catch (error) {
      persistLocal(saved);
      throw error;
    }
  };

  return { saved, toggle };
}
