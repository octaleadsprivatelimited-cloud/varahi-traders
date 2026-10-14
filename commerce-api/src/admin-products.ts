import { AppError } from "./errors.js";
import type { StoredProduct, StoredVariant } from "./store.js";

export type AdminProductQuery = {
  search?: string;
  status?: "ALL" | StoredProduct["status"];
  category?: string;
  sortBy?: "updatedAt" | "name" | "inventory";
  sortOrder?: "asc" | "desc";
  page?: number;
  limit?: number;
};

export type AdminInventoryQuery = {
  search?: string;
  productId?: string;
  lowStock?: boolean;
  page?: number;
  limit?: number;
};

export function queryInteger(
  value: unknown,
  fallback: number,
  minimum: number,
  maximum: number,
) {
  if (value === undefined || value === "") return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum)
    throw new AppError(
      400,
      "INVALID_QUERY",
      `Expected an integer between ${minimum} and ${maximum}`,
    );
  return parsed;
}

function pagination(page: number, limit: number, total: number) {
  const totalPages = Math.max(1, Math.ceil(total / limit));
  return {
    page,
    limit,
    total,
    totalPages,
    hasNextPage: page < totalPages,
    hasPreviousPage: page > 1,
  };
}

function inventory(variant: StoredVariant) {
  const available = Math.max(0, variant.stock - variant.reserved);
  return {
    onHand: variant.stock,
    reserved: variant.reserved,
    available,
    lowStockAt: 5,
    lowStock: available <= 5,
  };
}

function productSummary(product: StoredProduct) {
  const activeVariants = product.variants.filter((variant) => variant.active);
  const prices = activeVariants.map((variant) => variant.price);
  const totalOnHand = activeVariants.reduce(
    (sum, variant) => sum + variant.stock,
    0,
  );
  const totalReserved = activeVariants.reduce(
    (sum, variant) => sum + variant.reserved,
    0,
  );
  return {
    id: product.id,
    name: product.name,
    slug: product.slug,
    status: product.status,
    category: product.category,
    brand: product.brand,
    thumbnail: product.media
      .slice()
      .sort((a, b) => a.position - b.position)[0]?.url,
    variantCount: product.variants.length,
    activeVariantCount: activeVariants.length,
    totalOnHand,
    totalReserved,
    available: Math.max(0, totalOnHand - totalReserved),
    priceRange: {
      min: prices.length ? Math.min(...prices) : 0,
      max: prices.length ? Math.max(...prices) : 0,
    },
    createdAt: product.createdAt,
    updatedAt: product.updatedAt,
  };
}

export function adminProductDetailDto(product: StoredProduct) {
  const options = new Map<string, string[]>();
  for (const variant of product.variants.filter((entry) => entry.active)) {
    for (const [name, value] of Object.entries(variant.attributes)) {
      const values = options.get(name) || [];
      if (!values.includes(value)) values.push(value);
      options.set(name, values);
    }
  }
  return {
    ...productSummary(product),
    description: product.description,
    taxRate: product.taxRate,
    hsnCode: product.hsnCode,
    specifications: product.specifications,
    seoTitle: product.seoTitle,
    seoDescription: product.seoDescription,
    options: [...options].map(([name, values]) => ({ name, values })),
    media: product.media
      .slice()
      .sort((a, b) => a.position - b.position)
      .map((item, position) => ({ ...item, position })),
    variants: product.variants.map((variant) => ({
      id: variant.id,
      sku: variant.sku,
      title: variant.title,
      active: variant.active,
      price: variant.price,
      mrp: variant.mrp,
      attributes: variant.attributes,
      weightGrams: variant.weightGrams,
      inventory: inventory(variant),
    })),
  };
}

export function storefrontProductDto(product: StoredProduct) {
  const detail = adminProductDetailDto(product);
  const activeVariantIds = new Set(
    product.variants.filter((variant) => variant.active).map((variant) => variant.id),
  );
  return {
    id: detail.id,
    name: detail.name,
    slug: detail.slug,
    description: detail.description,
    category: detail.category,
    brand: detail.brand,
    status: detail.status,
    taxRate: detail.taxRate,
    hsnCode: detail.hsnCode,
    specifications: detail.specifications,
    seoTitle: detail.seoTitle,
    seoDescription: detail.seoDescription,
    media: detail.media.filter(
      (item) => !item.variantId || activeVariantIds.has(item.variantId),
    ),
    variants: detail.variants
      .filter((variant) => variant.active)
      .map((variant) => ({
        id: variant.id,
        sku: variant.sku,
        title: variant.title,
        price: variant.price,
        mrp: variant.mrp,
        stock: variant.inventory.onHand,
        reserved: variant.inventory.reserved,
        attributes: variant.attributes,
        weightGrams: variant.weightGrams,
      })),
    createdAt: detail.createdAt,
    updatedAt: detail.updatedAt,
  };
}

export function listAdminProducts(
  products: StoredProduct[],
  query: AdminProductQuery,
) {
  const search = query.search?.trim().toLowerCase() || "";
  const category = query.category?.trim().toLowerCase() || "";
  const searched = products.filter((product) => {
    const haystack = [
      product.name,
      product.slug,
      product.category,
      product.brand || "",
      ...product.variants.flatMap((variant) => [variant.sku, variant.title]),
    ]
      .join(" ")
      .toLowerCase();
    return !search || haystack.includes(search);
  });
  const filtered = searched.filter(
    (product) =>
      (!query.status || query.status === "ALL" || product.status === query.status) &&
      (!category || product.category.toLowerCase() === category),
  );
  const direction = query.sortOrder === "asc" ? 1 : -1;
  const sortBy = query.sortBy || "updatedAt";
  const items = filtered.map(productSummary).sort((a, b) => {
    if (sortBy === "name")
      return a.name.localeCompare(b.name) * direction || a.id.localeCompare(b.id);
    if (sortBy === "inventory")
      return (a.available - b.available) * direction || a.id.localeCompare(b.id);
    return (
      a.updatedAt.localeCompare(b.updatedAt) * direction || a.id.localeCompare(b.id)
    );
  });
  const page = query.page || 1;
  const limit = query.limit || 25;
  const count = <T extends string | undefined>(values: T[]) =>
    [...new Set(values.filter(Boolean))].map((value) => ({
      value,
      count: values.filter((candidate) => candidate === value).length,
    }));
  return {
    items: items.slice((page - 1) * limit, page * limit),
    pagination: pagination(page, limit, items.length),
    facets: {
      statuses: count(searched.map((product) => product.status)),
      categories: count(searched.map((product) => product.category)),
      brands: count(searched.map((product) => product.brand)),
    },
  };
}

export function listAdminInventory(
  products: StoredProduct[],
  query: AdminInventoryQuery,
) {
  const search = query.search?.trim().toLowerCase() || "";
  const items = products
    .filter((product) => !query.productId || product.id === query.productId)
    .flatMap((product) =>
      product.variants.map((variant) => ({
        productId: product.id,
        product: product.name,
        productStatus: product.status,
        variantId: variant.id,
        active: variant.active,
        sku: variant.sku,
        title: variant.title,
        attributes: variant.attributes,
        ...inventory(variant),
      })),
    )
    .filter((item) => {
      const matchesSearch =
        !search ||
        `${item.product} ${item.sku} ${item.title}`
          .toLowerCase()
          .includes(search);
      return matchesSearch && (!query.lowStock || item.lowStock);
    })
    .sort(
      (a, b) =>
        a.product.localeCompare(b.product) ||
        a.sku.localeCompare(b.sku) ||
        a.variantId.localeCompare(b.variantId),
    );
  const page = query.page || 1;
  const limit = query.limit || 25;
  return {
    items: items.slice((page - 1) * limit, page * limit),
    pagination: pagination(page, limit, items.length),
  };
}

export function paginatedMovements<T>(items: T[], page: number, limit: number) {
  return {
    items: items.slice((page - 1) * limit, page * limit),
    pagination: pagination(page, limit, items.length),
  };
}
