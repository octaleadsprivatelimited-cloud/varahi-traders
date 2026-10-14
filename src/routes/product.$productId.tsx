import { createFileRoute, notFound, redirect } from '@tanstack/react-router';
import { ProductDetailPage } from '@/components/store/ProductDetailPage';
import { loadProduct } from '@/lib/product-loader';
import { productRouteKey } from '@/lib/product-url';
import { productSeo } from '@/lib/seo';

export const Route = createFileRoute('/product/$productId')({
  validateSearch: (search: Record<string, unknown>): { variant?: string } => ({
    variant: typeof search.variant === 'string' && search.variant.length <= 100 ? search.variant : undefined,
  }),
  loaderDeps: ({ search }) => ({ variant: search.variant }),
  loader: async ({ params, deps }) => {
    const product = await loadProduct({ data: params.productId });
    if (!product) throw notFound();
    if (productRouteKey(product) !== params.productId) throw redirect({ to: '/product/$productId', params: { productId: productRouteKey(product) }, search: { variant: deps.variant }, statusCode: 301 });
    return product;
  },
  component: ProductDetailPage,
  head: ({ loaderData: product }) => product ? productSeo(product) : {
    meta: [{ title: 'Product not found | Sri Varahi Traders' }, { name: 'robots', content: 'noindex, nofollow' }],
  },
});
