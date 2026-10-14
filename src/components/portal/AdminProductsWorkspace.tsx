import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  Archive,
  ArrowDown,
  ArrowLeft,
  ArrowUp,
  Box,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  ImagePlus,
  Layers3,
  Package,
  Plus,
  RefreshCw,
  Save,
  Search,
  Trash2,
  UploadCloud,
  X,
} from "lucide-react";
import { toast } from "sonner";
import {
  money,
  productTypeTemplates,
  type ProductType,
  type VariantOption,
} from "@/data/commerce";
import { commerceApi } from "@/lib/commerce-api";
import { notifyStoreCatalogChanged } from "@/lib/store-products";

type ProductStatus = "DRAFT" | "ACTIVE" | "ARCHIVED";
type Pagination = {
  page: number;
  limit: number;
  total: number;
  totalPages: number;
  hasNextPage?: boolean;
  hasPreviousPage?: boolean;
};
type Facet = { value: string; count: number };
type ProductListItem = {
  id: string;
  name: string;
  slug: string;
  status: ProductStatus;
  category: string;
  brand?: string;
  thumbnail?: { url: string; alt: string } | string | null;
  variantCount: number;
  activeVariantCount: number;
  totalOnHand: number;
  totalReserved: number;
  available: number;
  priceRange: { min: number; max: number };
  createdAt: string;
  updatedAt: string;
};
type ProductListResponse = {
  items: ProductListItem[];
  pagination: Pagination;
  facets: { statuses: Facet[]; categories: Facet[]; brands: Facet[] };
};
type ProductMedia = {
  id: string;
  url: string;
  alt: string;
  type: "IMAGE" | "VIDEO";
  position: number;
  variantId?: string | null;
};
type LinkedProductImage = { localKey: string; url: string; alt: string };
type ProductVariant = {
  id?: string;
  sku: string;
  title: string;
  price: number;
  mrp: number;
  active: boolean;
  attributes: Record<string, string>;
  weightGrams: number;
  inventory: {
    onHand: number;
    reserved: number;
    available: number;
    lowStockAt: number;
    lowStock: boolean;
  };
};
type ProductDetail = {
  id: string;
  name: string;
  slug: string;
  description: string;
  category: string;
  brand?: string;
  status: ProductStatus;
  taxRate: number;
  hsnCode?: string;
  specifications: Record<string, string>;
  seoTitle?: string;
  seoDescription?: string;
  options: VariantOption[];
  media: ProductMedia[];
  variants: ProductVariant[];
  createdAt: string;
  updatedAt: string;
};
type EditorVariant = ProductVariant & { originalOnHand: number; localKey: string };
type ProductDraft = Omit<ProductDetail, "id" | "createdAt" | "updatedAt" | "variants"> & {
  id?: string;
  variants: EditorVariant[];
};

const emptyPagination: Pagination = { page: 1, limit: 25, total: 0, totalPages: 1 };
const defaultInventory = { onHand: 0, reserved: 0, available: 0, lowStockAt: 5, lowStock: true };

function slugify(value: string) {
  return value.toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");
}

function optionKey(attributes: Record<string, string>, options: VariantOption[]) {
  return options.map((option) => `${option.name}:${attributes[option.name] || ""}`).join("|");
}

function combinations(options: VariantOption[]) {
  if (!options.length) return [{}] as Record<string, string>[];
  return options.reduce<Record<string, string>[]>((rows, option) => {
    const values = option.values.map((value) => value.trim()).filter(Boolean).slice(0, 20);
    return rows.flatMap((row) => values.map((value) => ({ ...row, [option.name.trim()]: value })));
  }, [{}]).slice(0, 200);
}

function inferType(product?: ProductDetail): ProductType {
  if (!product || !product.options.length) return "standard";
  const names = product.options.map((option) => option.name.toLowerCase());
  const values = product.options.flatMap((option) => option.values).map((value) => value.toLowerCase());
  if (names.some((name) => name.includes("weight")) || values.some((value) => /\b(?:g|kg|ml|l)\b/.test(value))) return "grocery";
  if (names.some((name) => name.includes("pack") || name.includes("quantity"))) return "pack";
  if (names.some((name) => name.includes("size")) && values.some((value) => /^(?:xs|s|m|l|xl|xxl|xxxl)$/.test(value))) return "apparel";
  if (names.some((name) => name.includes("size")) && values.some((value) => /^\d+(?:\.5)?$/.test(value))) return "footwear";
  return "custom";
}

function makeSku(type: ProductType, index: number) {
  return `SKU-${type.slice(0, 3).toUpperCase()}-${Date.now().toString().slice(-6)}-${String(index + 1).padStart(3, "0")}`;
}

function freshDraft(): ProductDraft {
  const attributes: Record<string, string> = {};
  return {
    name: "",
    slug: "",
    description: "",
    category: "",
    brand: "",
    status: "DRAFT",
    taxRate: 18,
    hsnCode: "",
    specifications: {},
    seoTitle: "",
    seoDescription: "",
    options: [],
    media: [],
    variants: [{
      localKey: crypto.randomUUID(),
      sku: makeSku("standard", 0),
      title: "Default",
      price: 0,
      mrp: 0,
      active: true,
      attributes,
      weightGrams: 500,
      inventory: { ...defaultInventory },
      originalOnHand: 0,
    }],
  };
}

function detailToDraft(product: ProductDetail): ProductDraft {
  return {
    ...product,
    options: product.options.map((option) => ({ ...option, values: [...option.values] })),
    media: [...product.media].sort((left, right) => left.position - right.position),
    variants: product.variants.map((variant) => ({
      ...variant,
      localKey: variant.id || crypto.randomUUID(),
      attributes: { ...variant.attributes },
      inventory: { ...variant.inventory },
      originalOnHand: variant.inventory.onHand,
    })),
  };
}

function imageUrl(item: ProductListItem) {
  return typeof item.thumbnail === "string" ? item.thumbnail : item.thumbnail?.url;
}

function formatDate(value: string) {
  return new Intl.DateTimeFormat("en-IN", { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
}

function AuthRequired() {
  return (
    <div className="catalog-state panel">
      <AlertTriangle />
      <h3>Administrator sign-in required</h3>
      <p>Sign in with a staff account that can manage products and inventory.</p>
      <a className="primary" href="/login">Sign in</a>
    </div>
  );
}

export function AdminProductsWorkspace() {
  const [response, setResponse] = useState<ProductListResponse>({
    items: [], pagination: emptyPagination, facets: { statuses: [], categories: [], brands: [] },
  });
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState("ALL");
  const [category, setCategory] = useState("");
  const [sortBy, setSortBy] = useState("updatedAt");
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [editingId, setEditingId] = useState<string | "new" | null>(null);
  const authenticated = typeof window !== "undefined" && Boolean(sessionStorage.getItem("varahi_commerce_access_token"));

  const load = useCallback(async () => {
    if (!authenticated) { setLoading(false); return; }
    setLoading(true); setError("");
    try {
      const params = new URLSearchParams({ search, status, sortBy, sortOrder: sortBy === "name" ? "asc" : "desc", page: String(page), limit: "25" });
      if (category) params.set("category", category);
      const result = await commerceApi<ProductListResponse>(`/api/v1/admin/products?${params}`);
      setResponse(result);
      if (page > Math.max(1, result.pagination.totalPages)) setPage(Math.max(1, result.pagination.totalPages));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Products could not be loaded");
    } finally { setLoading(false); }
  }, [authenticated, category, page, search, sortBy, status]);

  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 250);
    return () => window.clearTimeout(timer);
  }, [load]);

  if (!authenticated) return <AuthRequired />;
  if (editingId) return <ProductEditor productId={editingId} categories={response.facets.categories.map((item) => item.value)} onClose={() => { setEditingId(null); void load(); }} />;

  const activeCount = response.facets.statuses.find((item) => item.value === "ACTIVE")?.count || 0;
  const draftCount = response.facets.statuses.find((item) => item.value === "DRAFT")?.count || 0;
  const archivedCount = response.facets.statuses.find((item) => item.value === "ARCHIVED")?.count || 0;
  return (
    <div className="catalog-workspace">
      <div className="editor-top catalog-heading">
        <div><p className="portal-eyebrow">Catalog</p><h2>Products</h2><span>Manage products, options, variants, pricing, media and availability.</span></div>
        <button className="primary" type="button" onClick={() => setEditingId("new")}><Plus /> Add product</button>
      </div>
      <div className="catalog-summary">
        <article className="panel"><Package /><span><small>All products</small><b>{response.pagination.total}</b></span></article>
        <article className="panel"><CheckCircle2 /><span><small>Active</small><b>{activeCount}</b></span></article>
        <article className="panel"><Layers3 /><span><small>Draft</small><b>{draftCount}</b></span></article>
        <article className="panel"><Archive /><span><small>Archived</small><b>{archivedCount}</b></span></article>
      </div>
      <section className="panel catalog-browser">
        <div className="catalog-tabs" role="tablist" aria-label="Product status">
          {["ALL", "ACTIVE", "DRAFT", "ARCHIVED"].map((value) => <button type="button" role="tab" aria-selected={status === value} className={status === value ? "active" : ""} key={value} onClick={() => { setStatus(value); setPage(1); }}>{value === "ALL" ? "All" : value[0] + value.slice(1).toLowerCase()}</button>)}
        </div>
        <div className="catalog-toolbar">
          <label><Search /><input value={search} onChange={(event) => { setSearch(event.target.value); setPage(1); }} placeholder="Search products, SKU, category or brand" aria-label="Search products" /></label>
          <select value={category} onChange={(event) => { setCategory(event.target.value); setPage(1); }} aria-label="Filter by category"><option value="">All categories</option>{response.facets.categories.map((item) => <option key={item.value} value={item.value}>{item.value} ({item.count})</option>)}</select>
          <select value={sortBy} onChange={(event) => { setSortBy(event.target.value); setPage(1); }} aria-label="Sort products"><option value="updatedAt">Recently updated</option><option value="name">Product name</option><option value="inventory">Inventory</option></select>
          <button type="button" className="secondary catalog-refresh" onClick={() => void load()} disabled={loading} aria-label="Refresh products"><RefreshCw className={loading ? "spin" : ""} /></button>
        </div>
        {error ? (
          <div className="catalog-state"><AlertTriangle /><h3>Products could not be loaded</h3><p>{error}</p><button className="secondary" type="button" onClick={() => void load()}>Try again</button></div>
        ) : loading && !response.items.length ? (
          <div className="catalog-state"><RefreshCw className="spin" /><h3>Loading products…</h3></div>
        ) : response.items.length ? (
          <div className="catalog-table-wrap" aria-busy={loading}>
            <table className="catalog-table"><thead><tr><th>Product</th><th>Status</th><th>Inventory</th><th>Variants</th><th>Price</th><th>Updated</th><th /></tr></thead>
              <tbody>{response.items.map((product) => <tr key={product.id}>
                <td><button type="button" className="catalog-product-cell" onClick={() => setEditingId(product.id)}>{imageUrl(product) ? <img src={imageUrl(product)} alt={typeof product.thumbnail === "object" ? product.thumbnail?.alt || "" : ""} /> : <span><ImagePlus /></span>}<i><b>{product.name}</b><small>{product.category}{product.brand ? ` · ${product.brand}` : ""}</small></i></button></td>
                <td><span className={`catalog-status ${product.status.toLowerCase()}`}>{product.status[0] + product.status.slice(1).toLowerCase()}</span></td>
                <td><b className={product.available <= 5 ? "catalog-low" : ""}>{product.available} available</b><small>{product.totalOnHand} on hand · {product.totalReserved} reserved</small></td>
                <td>{product.activeVariantCount} / {product.variantCount}</td>
                <td>{product.priceRange.min === product.priceRange.max ? money(product.priceRange.min) : `${money(product.priceRange.min)} – ${money(product.priceRange.max)}`}</td>
                <td>{formatDate(product.updatedAt)}</td>
                <td><button type="button" aria-label={`Edit ${product.name}`} onClick={() => setEditingId(product.id)}><ChevronRight /></button></td>
              </tr>)}</tbody>
            </table>
          </div>
        ) : (
          <div className="catalog-state"><Search /><h3>No matching products</h3><p>{search || category || status !== "ALL" ? "Try clearing a search or filter." : "Create your first product to begin selling."}</p>{!search && !category && status === "ALL" && <button className="primary" type="button" onClick={() => setEditingId("new")}><Plus /> Add product</button>}</div>
        )}
        <PaginationBar pagination={response.pagination} loading={loading} onPage={setPage} noun="products" />
      </section>
    </div>
  );
}

function PaginationBar({ pagination, loading, onPage, noun }: { pagination: Pagination; loading: boolean; onPage: (page: number) => void; noun: string }) {
  const pages = Math.max(1, pagination.totalPages);
  const start = pagination.total ? (pagination.page - 1) * pagination.limit + 1 : 0;
  const end = Math.min(pagination.total, pagination.page * pagination.limit);
  return <nav className="catalog-pagination" aria-label={`${noun} pages`}><small>{pagination.total ? `${start}–${end} of ${pagination.total} ${noun}` : `0 ${noun}`}</small><span><button type="button" disabled={loading || pagination.page <= 1} onClick={() => onPage(Math.max(1, pagination.page - 1))}><ChevronLeft /> Previous</button><b>Page {pagination.page} of {pages}</b><button type="button" disabled={loading || pagination.page >= pages} onClick={() => onPage(Math.min(pages, pagination.page + 1))}>Next <ChevronRight /></button></span></nav>;
}

function ProductEditor({ productId, categories, onClose }: { productId: string | "new"; categories: string[]; onClose: () => void }) {
  const isNew = productId === "new";
  const [draft, setDraft] = useState<ProductDraft>(() => freshDraft());
  const [type, setType] = useState<ProductType>("standard");
  const [loading, setLoading] = useState(!isNew);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [specifications, setSpecifications] = useState("");
  const [files, setFiles] = useState<File[]>([]);
  const [linkedImages, setLinkedImages] = useState<LinkedProductImage[]>([]);
  const [uploadMessage, setUploadMessage] = useState("");
  const [slugTouched, setSlugTouched] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const inventoryAdjustmentKeys = useRef(new Map<string, { delta: number; key: string }>());

  const load = useCallback(async () => {
    if (isNew) return;
    setLoading(true); setError("");
    try {
      const product = await commerceApi<ProductDetail>(`/api/v1/admin/products/${productId}`);
      setDraft(detailToDraft(product));
      setLinkedImages([]);
      inventoryAdjustmentKeys.current.clear();
      setType(inferType(product));
      setSpecifications(Object.entries(product.specifications).map(([key, value]) => `${key}: ${value}`).join("\n"));
      setSlugTouched(true);
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Product could not be loaded"); }
    finally { setLoading(false); }
  }, [isNew, productId]);

  useEffect(() => { void load(); }, [load]);

  const updateDraft = <K extends keyof ProductDraft>(key: K, value: ProductDraft[K]) => setDraft((current) => ({ ...current, [key]: value }));
  const updateVariant = (localKey: string, patch: Partial<EditorVariant>) => setDraft((current) => ({ ...current, variants: current.variants.map((variant) => variant.localKey === localKey ? { ...variant, ...patch, inventory: patch.inventory ? { ...patch.inventory } : variant.inventory } : variant) }));

  const applyOptions = (nextOptions: VariantOption[], selectedType = type) => {
    const clean = nextOptions.map((option) => ({ name: option.name.trim(), values: [...new Set(option.values.map((value) => value.trim()).filter(Boolean))] })).filter((option) => option.name);
    setDraft((current) => {
      const oldByKey = new Map<string, EditorVariant>();
      for (const variant of current.variants) {
        const key = optionKey(variant.attributes, current.options);
        const saved = oldByKey.get(key);
        if (!saved || (!saved.active && variant.active)) oldByKey.set(key, variant);
      }
      const base = current.variants.find((variant) => variant.active) || current.variants[0];
      const nextActive = combinations(clean).map((attributes, index) => {
        const existing = oldByKey.get(optionKey(attributes, clean));
        if (existing) return { ...existing, active: true, attributes, title: Object.values(attributes).join(" / ") || "Default" };
        return {
          localKey: crypto.randomUUID(), sku: makeSku(selectedType, index), title: Object.values(attributes).join(" / ") || "Default",
          price: base?.price || 0, mrp: base?.mrp || 0, active: true, attributes, weightGrams: base?.weightGrams || (selectedType === "grocery" ? 1000 : 500),
          inventory: { ...defaultInventory }, originalOnHand: 0,
        };
      });
      const retainedInactive = current.variants.filter((variant) => variant.id && !nextActive.some((active) => active.id === variant.id)).map((variant) => ({ ...variant, active: false }));
      return { ...current, options: clean, variants: [...nextActive, ...retainedInactive] };
    });
  };

  const chooseType = (nextType: ProductType) => {
    setType(nextType);
    applyOptions(productTypeTemplates[nextType].options.map((option) => ({ ...option, values: [...option.values] })), nextType);
  };

  const addOption = () => applyOptions([...draft.options, { name: `Option ${draft.options.length + 1}`, values: ["Value 1"] }], "custom");
  const changeOption = (index: number, patch: Partial<VariantOption>) => {
    const next = draft.options.map((option, optionIndex) => optionIndex === index ? { ...option, ...patch } : option);
    applyOptions(next, type);
  };

  const validationError = useMemo(() => {
    if (draft.name.trim().length < 2) return "Enter a product name.";
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(draft.slug)) return "Enter a valid URL handle using lowercase letters, numbers and hyphens.";
    if (draft.description.trim().length < 10) return "Add a product description of at least 10 characters.";
    if (draft.category.trim().length < 2) return "Choose or enter an item category.";
    const active = draft.variants.filter((variant) => variant.active);
    if (!active.length) return "At least one active variant is required.";
    if (new Set(active.map((variant) => variant.sku.trim().toLowerCase())).size !== active.length) return "Every active variant needs a unique SKU.";
    if (active.some((variant) => variant.sku.trim().length < 3)) return "Every active variant needs a SKU of at least 3 characters.";
    if (active.some((variant) => variant.price <= 0 || variant.mrp < variant.price)) return "Variant prices must be positive and MRP cannot be below selling price.";
    if (active.some((variant) => !Number.isInteger(variant.inventory.onHand) || variant.inventory.onHand < variant.inventory.reserved)) return "On-hand stock must be a whole number and cannot be below reserved stock.";
    return "";
  }, [draft]);

  const productPayload = (current: ProductDraft) => ({
    name: current.name.trim(), slug: current.slug, description: current.description.trim(), category: current.category.trim(),
    brand: current.brand?.trim() || undefined, status: current.status, taxRate: Number(current.taxRate), hsnCode: current.hsnCode?.trim() || undefined,
    specifications: Object.fromEntries(specifications.split("\n").map((line) => line.split(":")) .map(([key, ...value]) => [key?.trim(), value.join(":").trim()]).filter(([key, value]) => key && value)),
    seoTitle: current.seoTitle?.trim() || undefined, seoDescription: current.seoDescription?.trim() || undefined,
    media: [
      ...current.media.map((media, position) => ({ ...media, position, variantId: media.variantId || undefined })),
      ...linkedImages.map((image, index) => ({ url: image.url, alt: image.alt, type: "IMAGE" as const, position: current.media.length + index })),
    ],
    variants: current.variants.map((variant) => ({
      ...(variant.id ? { id: variant.id } : {}), sku: variant.sku.trim(), title: variant.title.trim(), price: Number(variant.price), mrp: Number(variant.mrp), active: variant.active,
      stock: variant.id ? variant.originalOnHand : variant.inventory.onHand, reserved: variant.inventory.reserved, attributes: variant.attributes, weightGrams: Number(variant.weightGrams),
    })),
  });

  const save = async () => {
    if (validationError) { setError(validationError); return; }
    if (draft.media.length + files.length + linkedImages.length > 30) { setError("A product can have up to 30 images. Remove an image before saving."); return; }
    setSaving(true); setError(""); setUploadMessage("");
    try {
      const saved = await commerceApi<ProductDetail>(isNew ? "/api/v1/admin/products" : `/api/v1/admin/products/${productId}`, { method: isNew ? "POST" : "PUT", body: JSON.stringify(productPayload(draft)) });
      // The product response confirms these links are saved. Keep their new IDs
      // if a later inventory/upload request fails, so retrying cannot add them twice.
      setDraft((current) => ({ ...current, media: saved.media }));
      setLinkedImages([]);
      const adjustments = draft.variants.filter((variant) => variant.id && variant.inventory.onHand !== variant.originalOnHand);
      for (const variant of adjustments) {
        const variantId = variant.id!;
        const delta = variant.inventory.onHand - variant.originalOnHand;
        const previousOperation = inventoryAdjustmentKeys.current.get(variantId);
        const operation = previousOperation?.delta === delta
          ? previousOperation
          : { delta, key: crypto.randomUUID() };
        inventoryAdjustmentKeys.current.set(variantId, operation);
        const adjusted = await commerceApi<AdjustmentResponse>(`/api/v1/admin/inventory/${variantId}`, {
          method: "PATCH", headers: { "Idempotency-Key": operation.key },
          body: JSON.stringify({ quantity: delta, reason: "Stock correction from product editor" }),
        });
        setDraft((current) => ({
          ...current,
          variants: current.variants.map((currentVariant) => currentVariant.id === variantId ? {
            ...currentVariant,
            inventory: { ...currentVariant.inventory, ...adjusted.inventory },
            originalOnHand: adjusted.inventory.onHand,
          } : currentVariant),
        }));
      }
      let latest = saved;
      const uploadErrors: string[] = [];
      for (let index = 0; index < files.length; index++) {
        setUploadMessage(`Converting and uploading image ${index + 1} of ${files.length}…`);
        const body = new FormData(); body.append("image", files[index]!); body.append("alt", `${draft.name} product image`); body.append("position", String(saved.media.length + index));
        try { await commerceApi(`/api/v1/admin/products/${saved.id}/media/upload`, { method: "POST", body }); }
        catch (reason) { uploadErrors.push(`${files[index]!.name}: ${reason instanceof Error ? reason.message : "upload failed"}`); }
      }
      latest = await commerceApi<ProductDetail>(`/api/v1/admin/products/${saved.id}`);
      notifyStoreCatalogChanged();
      setDraft(detailToDraft(latest)); inventoryAdjustmentKeys.current.clear(); setSpecifications(Object.entries(latest.specifications).map(([key, value]) => `${key}: ${value}`).join("\n")); setFiles([]); setLinkedImages([]); setUploadMessage("");
      if (uploadErrors.length) { setError(`Product saved, but ${uploadErrors.length} image upload${uploadErrors.length === 1 ? "" : "s"} failed: ${uploadErrors.join("; ")}`); toast.warning("Product saved with image upload errors"); }
      else { toast.success(isNew ? "Product created" : "Product updated"); if (isNew) onClose(); }
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Product could not be saved"); }
    finally { setSaving(false); setUploadMessage(""); }
  };

  const archive = async () => {
    if (!draft.id || !window.confirm(`Archive “${draft.name}”? It will be hidden from the storefront.`)) return;
    setSaving(true); setError("");
    try { await commerceApi(`/api/v1/admin/products/${draft.id}`, { method: "DELETE" }); notifyStoreCatalogChanged(); toast.success("Product archived"); onClose(); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "Product could not be archived"); }
    finally { setSaving(false); }
  };

  const reorderMedia = async (index: number, direction: -1 | 1) => {
    if (!draft.id) return;
    const target = index + direction; if (target < 0 || target >= draft.media.length) return;
    const next = [...draft.media]; [next[index], next[target]] = [next[target]!, next[index]!];
    setSaving(true); setError("");
    try {
      await commerceApi(`/api/v1/admin/products/${draft.id}/media/order`, { method: "PUT", body: JSON.stringify({ mediaIds: next.map((media) => media.id) }) });
      notifyStoreCatalogChanged();
      setDraft((current) => ({ ...current, media: next.map((media, position) => ({ ...media, position })) })); toast.success("Image order updated");
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Image order could not be updated"); }
    finally { setSaving(false); }
  };

  const updateMedia = async (media: ProductMedia) => {
    if (!draft.id) return;
    setSaving(true); setError("");
    try { await commerceApi(`/api/v1/admin/products/${draft.id}/media/${media.id}`, { method: "PATCH", body: JSON.stringify({ alt: media.alt, variantId: media.variantId || null }) }); notifyStoreCatalogChanged(); toast.success("Image details updated"); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "Image details could not be updated"); }
    finally { setSaving(false); }
  };

  const removeMedia = async (media: ProductMedia) => {
    if (!draft.id || !window.confirm("Remove this image from the product?")) return;
    setSaving(true); setError("");
    try { await commerceApi(`/api/v1/admin/products/${draft.id}/media/${media.id}`, { method: "DELETE" }); notifyStoreCatalogChanged(); setDraft((current) => ({ ...current, media: current.media.filter((item) => item.id !== media.id) })); toast.success("Image removed"); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "Image could not be removed"); }
    finally { setSaving(false); }
  };

  if (loading) return <div className="catalog-state panel"><RefreshCw className="spin" /><h3>Loading product…</h3></div>;
  if (error && !draft.id && !isNew) return <div className="catalog-state panel"><AlertTriangle /><h3>Product could not be opened</h3><p>{error}</p><span><button type="button" className="secondary" onClick={onClose}>Back</button><button type="button" className="primary" onClick={() => void load()}>Try again</button></span></div>;

  const activeVariants = draft.variants.filter((variant) => variant.active);
  return (
    <div className="product-admin-editor">
      <div className="editor-top product-editor-heading"><div><button type="button" className="catalog-back" onClick={onClose}><ArrowLeft /> Products</button><p className="portal-eyebrow">{isNew ? "New product" : draft.status}</p><h2>{isNew ? "Add product" : draft.name}</h2><span>{isNew ? "Create a flexible product with inventory tracked per variant." : `Last loaded from the live catalog · ${activeVariants.length} active variants`}</span></div><div>{draft.id && draft.status !== "ARCHIVED" && <button type="button" className="secondary danger" onClick={() => void archive()} disabled={saving}><Archive /> Archive</button>}<button type="button" className="primary" onClick={() => void save()} disabled={saving || Boolean(validationError)}>{saving ? <RefreshCw className="spin" /> : <Save />}{saving ? "Saving…" : "Save"}</button></div></div>
      {(error || validationError) && <p className="catalog-alert" role="alert"><AlertTriangle />{error || validationError}</p>}
      <div className="product-admin-layout">
        <div className="product-admin-main">
          <section className="panel product-admin-card"><header><div><h3>Product information</h3><p>The customer-facing title, description and item classification.</p></div></header>
            <label>Title<input value={draft.name} onChange={(event) => { const name = event.target.value; setDraft((current) => ({ ...current, name, slug: slugTouched ? current.slug : slugify(name) })); }} placeholder="e.g. Handloom wrap dress" /></label>
            <label>Description<textarea value={draft.description} onChange={(event) => updateDraft("description", event.target.value)} placeholder="Materials, fit, use and care details" /></label>
            <div className="product-form-grid"><label>Item type / category<input list="admin-product-categories" value={draft.category} onChange={(event) => updateDraft("category", event.target.value)} placeholder="e.g. Dresses or Pulses" /><datalist id="admin-product-categories">{categories.map((item) => <option value={item} key={item} />)}</datalist></label><label>Brand / vendor<input value={draft.brand || ""} onChange={(event) => updateDraft("brand", event.target.value)} placeholder="Store brand" /></label></div>
          </section>
          <ProductMediaEditor draft={draft} files={files} linkedImages={linkedImages} onLinkedImages={setLinkedImages} saving={saving} uploadMessage={uploadMessage} fileInput={fileInput} onFiles={setFiles} onDraft={setDraft} onReorder={reorderMedia} onUpdate={updateMedia} onRemove={removeMedia} />
          <section className="panel product-admin-card"><header><div><h3>Selling model</h3><p>Start with a template, then customize the option names and values.</p></div></header><div className="product-type-grid">{(Object.keys(productTypeTemplates) as ProductType[]).map((item) => <button type="button" key={item} className={type === item ? "active" : ""} onClick={() => chooseType(item)}><b>{item === "apparel" ? "L · XL" : item === "footwear" ? "7 · 8" : item === "grocery" ? "1 kg" : item === "pack" ? "× 6" : item === "custom" ? "+" : "1"}</b><span>{productTypeTemplates[item].label}</span><small>{productTypeTemplates[item].description}</small></button>)}</div></section>
          <section className="panel product-admin-card"><header><div><h3>Options</h3><p>Every combination becomes a controlled sellable variant.</p></div><button type="button" className="secondary" onClick={addOption} disabled={draft.options.length >= 3}><Plus /> Add option</button></header>{draft.options.length ? <div className="product-options">{draft.options.map((option, index) => <div key={`${option.name}-${index}`}><label>Option name<input value={option.name} onChange={(event) => changeOption(index, { name: event.target.value })} /></label><label>Values<input value={option.values.join(", ")} onChange={(event) => changeOption(index, { values: event.target.value.split(",") })} aria-label={`${option.name} values`} /></label><button type="button" aria-label={`Remove ${option.name}`} onClick={() => applyOptions(draft.options.filter((_, itemIndex) => itemIndex !== index), type)}><X /></button></div>)}</div> : <p className="product-empty-inline">One standard variant; no customer selection required.</p>}</section>
          <VariantTable variants={draft.variants} onUpdate={updateVariant} />
          <section className="panel product-admin-card"><header><div><h3>Specifications & search</h3><p>Structured details and optional search preview content.</p></div></header><label>Specifications, one “Label: Value” per line<textarea value={specifications} onChange={(event) => setSpecifications(event.target.value)} placeholder="Material: Linen&#10;Country of origin: India" /></label><div className="product-form-grid"><label>SEO title<input maxLength={70} value={draft.seoTitle || ""} onChange={(event) => updateDraft("seoTitle", event.target.value)} placeholder={draft.name || "Product title"} /></label><label>URL handle<input value={draft.slug} onChange={(event) => { setSlugTouched(true); updateDraft("slug", slugify(event.target.value)); }} placeholder="product-url-handle" /><small>Public URL: /product/{draft.slug || "your-product-name"}</small><small>Generated from the title for new products. Edit this handle to customize the URL.</small></label></div><label>SEO description<textarea maxLength={170} value={draft.seoDescription || ""} onChange={(event) => updateDraft("seoDescription", event.target.value)} /></label></section>
        </div>
        <aside><section className="panel product-admin-card product-publish"><header><div><h3>Publishing</h3><p>Storefront visibility and tax treatment.</p></div></header><label>Status<select value={draft.status} onChange={(event) => updateDraft("status", event.target.value as ProductStatus)}><option value="DRAFT">Draft</option><option value="ACTIVE">Active</option><option value="ARCHIVED">Archived</option></select></label><label>GST rate (%)<input type="number" min="0" max="100" step="0.01" value={draft.taxRate} onChange={(event) => updateDraft("taxRate", Number(event.target.value))} /></label><label>HSN code<input inputMode="numeric" value={draft.hsnCode || ""} onChange={(event) => updateDraft("hsnCode", event.target.value.replace(/\D/g, "").slice(0, 8))} placeholder="4–8 digits" /></label><dl><div><dt>Selling model</dt><dd>{productTypeTemplates[type].label}</dd></div><div><dt>Options</dt><dd>{draft.options.length}</dd></div><div><dt>Active variants</dt><dd>{activeVariants.length}</dd></div><div><dt>Images</dt><dd>{draft.media.length + files.length + linkedImages.length}</dd></div></dl></section></aside>
      </div>
    </div>
  );
}

type MediaEditorProps = {
  draft: ProductDraft;
  files: File[];
  linkedImages: LinkedProductImage[];
  onLinkedImages: (images: LinkedProductImage[]) => void;
  saving: boolean;
  uploadMessage: string;
  fileInput: React.RefObject<HTMLInputElement | null>;
  onFiles: (files: File[]) => void;
  onDraft: React.Dispatch<React.SetStateAction<ProductDraft>>;
  onReorder: (index: number, direction: -1 | 1) => Promise<void>;
  onUpdate: (media: ProductMedia) => Promise<void>;
  onRemove: (media: ProductMedia) => Promise<void>;
};

function ProductMediaEditor({ draft, files, linkedImages, onLinkedImages, saving, uploadMessage, fileInput, onFiles, onDraft, onReorder, onUpdate, onRemove }: MediaEditorProps) {
  const [linkedUrl, setLinkedUrl] = useState("");
  const [linkedAlt, setLinkedAlt] = useState("");
  const [linkedError, setLinkedError] = useState("");
  const mediaCount = draft.media.length + files.length + linkedImages.length;
  const addImageUrl = () => {
    if (saving) return;
    setLinkedError("");
    if (mediaCount >= 30) { setLinkedError("A product can have up to 30 images. Remove one before adding another."); return; }
    try {
      const input = linkedUrl.trim();
      const url = input.startsWith("/") && !input.startsWith("//")
        ? new URL(input, window.location.origin)
        : new URL(input);
      if (url.protocol !== "https:" || url.username || url.password || url.href.length > 2000) throw new Error("invalid");
      if (draft.media.some((image) => image.url === url.href) || linkedImages.some((image) => image.url === url.href)) {
        setLinkedError("This image is already attached or queued.");
        return;
      }
      onLinkedImages([...linkedImages, { localKey: crypto.randomUUID(), url: url.href, alt: (linkedAlt.trim() || `${draft.name.trim() || "Product"} image`).slice(0, 200) }]);
      setLinkedUrl("");
      setLinkedAlt("");
    } catch { setLinkedError("Enter an HTTPS image URL or a path starting with / on this HTTPS website."); }
  };
  const changeMedia = (id: string, patch: Partial<ProductMedia>) => onDraft((current) => ({ ...current, media: current.media.map((media) => media.id === id ? { ...media, ...patch } : media) }));
  const removeFile = (index: number) => onFiles(files.filter((_, itemIndex) => itemIndex !== index));
  return <section className="panel product-admin-card product-media"><header><div><h3>Media</h3><p>Uploaded images are converted to WebP. Reorder them to choose the storefront cover.</p></div><button type="button" className="secondary" onClick={() => fileInput.current?.click()} disabled={saving || mediaCount >= 30}><ImagePlus /> Add images</button></header>
    <input ref={fileInput} className="product-file-input" type="file" accept="image/jpeg,image/png,image/webp,image/avif,image/heic" multiple disabled={saving} onChange={(event) => { onFiles([...files, ...Array.from(event.target.files || [])].slice(0, Math.max(0, 30 - draft.media.length - linkedImages.length))); event.target.value = ""; }} />
    <div className="product-form-grid" style={{ paddingTop: 16 }}>
      <label>Image URL<input value={linkedUrl} onChange={(event) => { setLinkedUrl(event.target.value); setLinkedError(""); }} inputMode="url" autoCapitalize="none" autoCorrect="off" spellCheck={false} placeholder="https://example.com/product.webp" maxLength={2000} disabled={saving || mediaCount >= 30} aria-describedby="product-image-url-help" aria-invalid={Boolean(linkedError)} /></label>
      <label>Image alt text (optional)<input value={linkedAlt} onChange={(event) => setLinkedAlt(event.target.value)} maxLength={200} placeholder={draft.name || "Describe the product image"} disabled={saving || mediaCount >= 30} /></label>
    </div>
    <div className="product-upload-status" style={{ flexWrap: "wrap" }}><button type="button" className="secondary" onClick={addImageUrl} disabled={saving || mediaCount >= 30 || !linkedUrl.trim()}><Plus /> Add image URL</button><span id="product-image-url-help" style={{ flex: "1 1 220px" }}>Links are added when you save. Keep the image publicly accessible.</span></div>
    {linkedError && <p className="catalog-alert" role="alert">{linkedError}</p>}
    {!mediaCount ? <button type="button" className="product-dropzone" disabled={saving} onClick={() => fileInput.current?.click()}><UploadCloud /><b>Upload product images</b><span>JPEG, PNG, WebP, AVIF or HEIC · up to 10 MB each</span></button> : <div className="product-media-grid">
      {draft.media.map((media, index) => <article key={media.id}><div>{media.type === "IMAGE" ? <img src={media.url} alt={media.alt} /> : <span>Video</span>}{index === 0 && <em>Cover</em>}</div><label>Alt text<input value={media.alt} onChange={(event) => changeMedia(media.id, { alt: event.target.value })} /></label><label>Variant<select value={media.variantId || ""} onChange={(event) => changeMedia(media.id, { variantId: event.target.value || null })}><option value="">All variants</option>{draft.variants.filter((variant) => variant.active && variant.id).map((variant) => <option key={variant.id} value={variant.id}>{variant.title}</option>)}</select></label><footer><button type="button" disabled={saving || index === 0} aria-label="Move image up" onClick={() => void onReorder(index, -1)}><ArrowUp /></button><button type="button" disabled={saving || index === draft.media.length - 1} aria-label="Move image down" onClick={() => void onReorder(index, 1)}><ArrowDown /></button><button type="button" disabled={saving} onClick={() => void onUpdate(media)}><Save /> Details</button><button type="button" disabled={saving} className="danger-text" aria-label="Remove image" onClick={() => void onRemove(media)}><Trash2 /></button></footer></article>)}
      {linkedImages.map((image, index) => <article className="product-media-pending" key={image.localKey}><div><img src={image.url} alt={image.alt} referrerPolicy="no-referrer" /><em>On save</em></div><b>{image.alt}</b><small title={image.url} style={{ whiteSpace: "normal", overflowWrap: "anywhere" }}>{image.url}</small><footer><button type="button" disabled={saving} onClick={() => onLinkedImages(linkedImages.filter((entry) => entry.localKey !== image.localKey))} aria-label={`Remove queued image ${index + 1}`}><Trash2 /> Remove</button></footer></article>)}
      {files.map((file, index) => <article className="product-media-pending" key={`${file.name}-${file.lastModified}`}><div><ImagePlus /><em>On save</em></div><b>{file.name}</b><small>{(file.size / 1024 / 1024).toFixed(1)} MB · queued for WebP conversion</small><footer><button type="button" disabled={saving} onClick={() => removeFile(index)} aria-label={`Remove ${file.name}`}><Trash2 /></button></footer></article>)}
    </div>}
    {uploadMessage && <p className="product-upload-status"><RefreshCw className="spin" />{uploadMessage}</p>}
  </section>;
}

function VariantTable({ variants, onUpdate }: { variants: EditorVariant[]; onUpdate: (key: string, patch: Partial<EditorVariant>) => void }) {
  const active = variants.filter((variant) => variant.active);
  const inactive = variants.filter((variant) => !variant.active);
  const rows = [...active, ...inactive];
  return <section className="panel product-admin-card product-variants"><header><div><h3>Variants</h3><p>{active.length} active sellable combination{active.length === 1 ? "" : "s"}. Reserved stock is protected.</p></div></header><div className="product-variant-scroll"><table><thead><tr><th>Variant</th><th>SKU</th><th>Price</th><th>MRP</th><th>On hand</th><th>Reserved</th><th>Weight</th><th>Sell</th></tr></thead><tbody>{rows.map((variant) => <tr key={variant.localKey} className={variant.active ? "" : "inactive"}><td><b>{variant.title || "Default"}</b>{Object.keys(variant.attributes).length > 0 && <small>{Object.entries(variant.attributes).map(([key, value]) => `${key}: ${value}`).join(" · ")}</small>}</td><td><input aria-label={`${variant.title} SKU`} value={variant.sku} onChange={(event) => onUpdate(variant.localKey, { sku: event.target.value })} /></td><td><span className="catalog-money-input"><i>₹</i><input aria-label={`${variant.title} price`} type="number" min="0.01" step="0.01" value={variant.price} onChange={(event) => onUpdate(variant.localKey, { price: Number(event.target.value) })} /></span></td><td><span className="catalog-money-input"><i>₹</i><input aria-label={`${variant.title} MRP`} type="number" min="0.01" step="0.01" value={variant.mrp} onChange={(event) => onUpdate(variant.localKey, { mrp: Number(event.target.value) })} /></span></td><td><input aria-label={`${variant.title} on hand`} type="number" min={variant.inventory.reserved} step="1" value={variant.inventory.onHand} onChange={(event) => { const onHand = Number(event.target.value); onUpdate(variant.localKey, { inventory: { ...variant.inventory, onHand, available: onHand - variant.inventory.reserved, lowStock: onHand - variant.inventory.reserved <= variant.inventory.lowStockAt } }); }} /></td><td><b>{variant.inventory.reserved}</b></td><td><span className="catalog-weight-input"><input aria-label={`${variant.title} weight grams`} type="number" min="1" step="1" value={variant.weightGrams} onChange={(event) => onUpdate(variant.localKey, { weightGrams: Number(event.target.value) })} /><i>g</i></span></td><td><label className="catalog-toggle"><input type="checkbox" checked={variant.active} disabled={!variant.id} onChange={(event) => onUpdate(variant.localKey, { active: event.target.checked })} /><span /></label></td></tr>)}</tbody></table></div>{inactive.length > 0 && <p className="product-variant-note">Inactive variants are retained for order history and can be reactivated.</p>}</section>;
}

type InventoryRow = {
  productId: string;
  product: string;
  variantId: string;
  sku: string;
  title: string;
  onHand: number;
  reserved: number;
  available: number;
  lowStock: boolean;
  lowStockAt?: number;
  updatedAt?: string;
};
type InventoryResponse = { items: InventoryRow[]; pagination: Pagination };
type InventoryMovement = { id: string; quantity: number; reason: string; referenceId?: string | null; createdAt: string };
type MovementResponse = { variantId: string; items: InventoryMovement[]; pagination: Pagination };
type AdjustmentResponse = { inventory: { onHand: number; reserved: number; available: number; lowStockAt?: number; lowStock?: boolean }; movement: InventoryMovement; replayed: boolean };

export function AdminInventoryWorkspace() {
  const [response, setResponse] = useState<InventoryResponse>({ items: [], pagination: emptyPagination });
  const [search, setSearch] = useState("");
  const [lowStock, setLowStock] = useState(false);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const authenticated = typeof window !== "undefined" && Boolean(sessionStorage.getItem("varahi_commerce_access_token"));

  const load = useCallback(async () => {
    if (!authenticated) { setLoading(false); return; }
    setLoading(true); setError("");
    try {
      const params = new URLSearchParams({ search, lowStock: String(lowStock), page: String(page), limit: "25" });
      const result = await commerceApi<InventoryResponse>(`/api/v1/admin/inventory?${params}`);
      setResponse(result);
      setSelectedId((current) => current && result.items.some((item) => item.variantId === current) ? current : result.items[0]?.variantId || null);
      if (page > Math.max(1, result.pagination.totalPages)) setPage(Math.max(1, result.pagination.totalPages));
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Inventory could not be loaded"); }
    finally { setLoading(false); }
  }, [authenticated, lowStock, page, search]);

  useEffect(() => { const timer = window.setTimeout(() => void load(), 250); return () => window.clearTimeout(timer); }, [load]);
  if (!authenticated) return <AuthRequired />;
  const selected = response.items.find((item) => item.variantId === selectedId) || null;
  const onAdjusted = (inventory: AdjustmentResponse["inventory"]) => setResponse((current) => ({ ...current, items: current.items.map((item) => item.variantId === selectedId ? { ...item, ...inventory, lowStock: inventory.lowStock ?? item.lowStock } : item) }));
  return <div className="inventory-workspace"><div className="editor-top catalog-heading"><div><p className="portal-eyebrow">Catalog</p><h2>Inventory</h2><span>Track available stock, protect reservations and keep an auditable movement history.</span></div><button className="secondary" type="button" onClick={() => void load()} disabled={loading}><RefreshCw className={loading ? "spin" : ""} /> Refresh</button></div>
    <section className="panel inventory-browser"><div className="catalog-toolbar inventory-toolbar"><label><Search /><input value={search} onChange={(event) => { setSearch(event.target.value); setPage(1); }} placeholder="Search product, variant or SKU" aria-label="Search inventory" /></label><label className="inventory-low-filter"><input type="checkbox" checked={lowStock} onChange={(event) => { setLowStock(event.target.checked); setPage(1); }} /> Low stock only</label><small>{response.pagination.total} SKU{response.pagination.total === 1 ? "" : "s"}</small></div>
      {error ? <div className="catalog-state"><AlertTriangle /><h3>Inventory could not be loaded</h3><p>{error}</p><button className="secondary" type="button" onClick={() => void load()}>Try again</button></div> : loading && !response.items.length ? <div className="catalog-state"><RefreshCw className="spin" /><h3>Loading inventory…</h3></div> : response.items.length ? <div className="inventory-layout"><div><div className="catalog-table-wrap"><table className="catalog-table inventory-table"><thead><tr><th>Product / variant</th><th>SKU</th><th>On hand</th><th>Reserved</th><th>Available</th><th /></tr></thead><tbody>{response.items.map((item) => <tr className={selectedId === item.variantId ? "selected" : ""} key={item.variantId} onClick={() => setSelectedId(item.variantId)}><td><b>{item.product}</b><small>{item.title}</small></td><td>{item.sku}</td><td>{item.onHand}</td><td>{item.reserved}</td><td><span className={item.lowStock ? "catalog-stock-badge low" : "catalog-stock-badge"}>{item.available}</span></td><td><button type="button" aria-label={`Manage ${item.sku}`} onClick={() => setSelectedId(item.variantId)}><ChevronRight /></button></td></tr>)}</tbody></table></div><PaginationBar pagination={response.pagination} loading={loading} onPage={setPage} noun="SKUs" /></div>{selected ? <InventoryDetail row={selected} onAdjusted={onAdjusted} onRefresh={load} /> : <div className="catalog-state inventory-selection"><Box /><h3>Select a variant</h3><p>Choose a SKU to adjust its stock or review history.</p></div>}</div> : <div className="catalog-state"><Search /><h3>No inventory found</h3><p>{search || lowStock ? "Clear the filters to see more variants." : "Product variants will appear here after they are created."}</p></div>}
    </section></div>;
}

function InventoryDetail({ row, onAdjusted, onRefresh }: { row: InventoryRow; onAdjusted: (inventory: AdjustmentResponse["inventory"]) => void; onRefresh: () => Promise<void> }) {
  const [quantity, setQuantity] = useState("");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [movements, setMovements] = useState<MovementResponse>({ variantId: row.variantId, items: [], pagination: { ...emptyPagination, limit: 10 } });
  const [movementPage, setMovementPage] = useState(1);
  const keyRef = useRef(crypto.randomUUID());

  const loadMovements = useCallback(async () => {
    setError("");
    try { setMovements(await commerceApi<MovementResponse>(`/api/v1/admin/inventory/${row.variantId}/movements?page=${movementPage}&limit=10`)); }
    catch (reasonValue) { setError(reasonValue instanceof Error ? reasonValue.message : "Movement history could not be loaded"); }
  }, [movementPage, row.variantId]);
  useEffect(() => { setMovementPage(1); setQuantity(""); setReason(""); keyRef.current = crypto.randomUUID(); }, [row.variantId]);
  useEffect(() => { void loadMovements(); }, [loadMovements]);
  const resetKey = () => { keyRef.current = crypto.randomUUID(); };
  const adjustment = Number(quantity);
  const resulting = row.onHand + (Number.isFinite(adjustment) ? adjustment : 0);
  const invalid = !Number.isInteger(adjustment) || adjustment === 0 || reason.trim().length < 3 || resulting < row.reserved;
  const submit = async () => {
    if (invalid) return;
    setBusy(true); setError("");
    try {
      const result = await commerceApi<AdjustmentResponse>(`/api/v1/admin/inventory/${row.variantId}`, { method: "PATCH", headers: { "Idempotency-Key": keyRef.current }, body: JSON.stringify({ quantity: adjustment, reason: reason.trim() }) });
      notifyStoreCatalogChanged();
      onAdjusted(result.inventory); setQuantity(""); setReason(""); resetKey(); await loadMovements(); await onRefresh(); toast.success(result.replayed ? "Stock adjustment was already applied" : "Inventory adjusted");
    } catch (reasonValue) { setError(reasonValue instanceof Error ? reasonValue.message : "Inventory could not be adjusted"); }
    finally { setBusy(false); }
  };
  return <aside className="inventory-detail"><header><div><p className="portal-eyebrow">Selected SKU</p><h3>{row.product}</h3><span>{row.title} · {row.sku}</span></div><span className={row.lowStock ? "catalog-stock-badge low" : "catalog-stock-badge"}>{row.lowStock ? "Low stock" : "In stock"}</span></header><div className="inventory-numbers"><span><small>On hand</small><b>{row.onHand}</b></span><span><small>Reserved</small><b>{row.reserved}</b></span><span><small>Available</small><b>{row.available}</b></span></div>
    <section className="inventory-adjust"><h4>Adjust stock</h4><p>Use a positive number for received stock and a negative number for damage, loss or correction.</p><label>Adjustment<input type="number" step="1" value={quantity} onChange={(event) => { setQuantity(event.target.value); resetKey(); }} placeholder="e.g. 12 or -2" /></label><label>Reason<textarea value={reason} onChange={(event) => { setReason(event.target.value); resetKey(); }} placeholder="Required for the audit trail" /></label><div className={resulting < row.reserved ? "inventory-result invalid" : "inventory-result"}><span>Resulting on hand</span><b>{resulting}</b></div>{resulting < row.reserved && <small className="danger-text">Cannot go below {row.reserved} reserved units.</small>}<button type="button" className="primary" disabled={busy || invalid} onClick={() => void submit()}>{busy ? <RefreshCw className="spin" /> : <Save />}{busy ? "Applying…" : "Apply adjustment"}</button></section>
    <section className="inventory-history"><div><h4>Movement history</h4><button type="button" aria-label="Refresh movement history" onClick={() => void loadMovements()}><RefreshCw /></button></div>{error && <p className="catalog-alert"><AlertTriangle />{error}</p>}{movements.items.length ? movements.items.map((movement) => <article key={movement.id}><i className={movement.quantity > 0 ? "positive" : "negative"}>{movement.quantity > 0 ? "+" : ""}{movement.quantity}</i><span><b>{movement.reason}</b><small>{formatDate(movement.createdAt)}{movement.referenceId ? ` · ${movement.referenceId}` : ""}</small></span></article>) : <p>No stock movements recorded yet.</p>}{movements.pagination.totalPages > 1 && <nav><button type="button" disabled={movementPage <= 1} onClick={() => setMovementPage((current) => current - 1)}><ChevronLeft /></button><span>{movementPage} / {movements.pagination.totalPages}</span><button type="button" disabled={movementPage >= movements.pagination.totalPages} onClick={() => setMovementPage((current) => current + 1)}><ChevronRight /></button></nav>}</section>
  </aside>;
}
