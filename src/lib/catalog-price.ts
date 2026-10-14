/** Catalog/API amounts are INR major units before GST, never paise. */
export function priceIncludingTax(basePrice: number, taxRate = 0) {
  const tax = Math.round(basePrice * taxRate) / 100;
  return Math.round((basePrice + tax) * 100) / 100;
}
