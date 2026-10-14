const base = (process.env.SMOKE_API_URL || "http://127.0.0.1:4010").replace(
  /\/$/,
  "",
);

async function call(path: string, init: RequestInit = {}) {
  const response = await fetch(`${base}${path}`, {
    ...init,
    headers: { "content-type": "application/json", ...init.headers },
  });
  const body = (await response.json()) as any;
  if (!response.ok)
    throw new Error(
      `${path}: ${response.status} ${body?.error?.code || "ERROR"}`,
    );
  return { response, data: body.data };
}

const health = await call("/health");
const ready = await call("/ready");
const products = await call("/api/v1/products");
const catalog = Array.isArray(products.data) ? products.data : products.data?.items;
if (!Array.isArray(catalog) || catalog.length === 0)
  throw new Error("published catalog is empty");
console.log(
  JSON.stringify({
    healthy: health.data.status === "healthy",
    ready: ready.data.status === "ready",
    persistence: ready.data.persistence,
    products: catalog.length,
  }),
);
