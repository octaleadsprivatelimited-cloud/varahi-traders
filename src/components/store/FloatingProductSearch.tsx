import { productPath } from "@/lib/product-url";
import { useEffect, useRef, useState } from "react";
import { ArrowRight, Search, X } from "lucide-react";
import { commerceApi, type ApiSearchSuggestion } from "@/lib/commerce-api";
import { priceIncludingTax } from "@/lib/catalog-price";
import { money } from "@/data/commerce";

export function FloatingProductSearch({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [query, setQuery] = useState("");
  const [suggestions, setSuggestions] = useState<ApiSearchSuggestion[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    const focusTimer = window.setTimeout(() => input.current?.focus({ preventScroll: true }), 50);
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => {
      window.clearTimeout(focusTimer);
      window.removeEventListener("keydown", closeOnEscape);
    };
  }, [open, onClose]);

  useEffect(() => {
    const value = query.trim();
    if (!open || value.length < 2) {
      setSuggestions([]);
      setLoading(false);
      setError("");
      return;
    }
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      setLoading(true);
      setError("");
      commerceApi<ApiSearchSuggestion[]>(
        `/api/v1/search/suggestions?q=${encodeURIComponent(value)}`,
        { signal: controller.signal },
      )
        .then(setSuggestions)
        .catch((requestError: unknown) => {
          if (requestError instanceof DOMException && requestError.name === "AbortError") return;
          setSuggestions([]);
          setError("Suggestions are temporarily unavailable. You can still search the shop.");
        })
        .finally(() => {
          if (!controller.signal.aborted) setLoading(false);
        });
    }, 220);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [open, query]);

  if (!open) return null;
  return (
    <>
      <button className="search-float-backdrop" type="button" aria-label="Close product search" onClick={onClose} />
      <form
        className="search-bar search-float"
        role="search"
        aria-label="Product search"
        onSubmit={(event) => {
          event.preventDefault();
          const value = query.trim();
          if (value) window.location.assign(`/shop?q=${encodeURIComponent(value)}`);
        }}
      >
        <Search aria-hidden="true" />
        <input ref={input} aria-label="Search products" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search groundnut, sesame, coconut oils…" />
        <button type="submit" aria-label="Submit search" disabled={!query.trim()}><ArrowRight /></button>
        <button type="button" aria-label="Close search" onClick={onClose}><X /></button>
      </form>
      {query.trim().length >= 2 && (
        <div className="search-float-results" aria-live="polite">
          {loading && <p className="search-result-state">Finding products…</p>}
          {!loading && error && <p className="search-result-state search-result-error">{error}</p>}
          {!loading && !error && suggestions.length === 0 && (
            <p className="search-result-state">No matching products found.</p>
          )}
          {!loading && suggestions.map((suggestion) => (
            <a key={suggestion.id} href={productPath(suggestion)} onClick={onClose}>
              <span className="search-result-thumb">
                {suggestion.image ? <img src={suggestion.image} alt="" /> : <Search aria-hidden="true" />}
              </span>
              <span><strong>{suggestion.name}</strong><small>{suggestion.category}</small></span>
              <b>{money(priceIncludingTax(suggestion.price, suggestion.taxRate))}</b>
            </a>
          ))}
          <a className="search-view-all" href={`/shop?q=${encodeURIComponent(query.trim())}`} onClick={onClose}>
            View all results <ArrowRight aria-hidden="true" />
          </a>
        </div>
      )}
    </>
  );
}
