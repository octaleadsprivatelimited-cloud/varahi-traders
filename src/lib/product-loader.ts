import { products as sampleProducts } from '@/data/commerce';
import { createServerFn } from '@tanstack/react-start';
import { mapProduct } from './store-products';
import { readPublicCatalog, readPublicProduct } from './public-catalog-reader';

export const loadProduct = createServerFn({ method: 'GET' })
  .validator((id: string) => id)
  .handler(async ({ data: id }) => {
    const product = await readPublicProduct(id);
    if (!product) {
      const sample = sampleProducts.find(product => product.id === id);
      if (!sample) return null;
      const catalog = await readPublicCatalog();
      const product = catalog.find(product => product.name === sample.name && product.category === sample.category);
      return product ? mapProduct(product, 0) : null;
    }
    return mapProduct(product, 0);
  });

/** Read the real catalog during SSR; an empty store must not index demo products. */
export const loadCatalog = createServerFn({ method: 'GET' }).handler(async () => {
  return (await readPublicCatalog()).map(mapProduct);
});
