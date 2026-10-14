/** Saved admin URL handles are authoritative; IDs support legacy catalog data. */
export function productRouteKey(product: { id: string; slug?: string }) {
  return product.slug || product.id;
}

export function productPath(product: { id: string; slug?: string }) {
  return `/product/${encodeURIComponent(productRouteKey(product))}`;
}
