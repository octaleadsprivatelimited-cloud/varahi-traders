import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  Outlet,
  Link,
  createRootRouteWithContext,
  useRouter,
  HeadContent,
  Scripts,
} from "@tanstack/react-router";
import type { ReactNode } from "react";
import { StorefrontProvider, useHasStorefrontProvider, useStorefrontConfig } from "../lib/storefront-config";
import { loadStorefront } from "../lib/storefront-loader";
import { PromotionsProvider } from "../lib/promotions";
import { MobileAppNav } from "../components/store/MobileAppNav";
import { AnalyticsConsent } from "../components/store/AnalyticsConsent";
import { StorePage } from "../components/store/StoreHeader";
import { ArrowRight, Search } from "lucide-react";

import appCss from "../styles.css?url";
import fixesCss from "../feature-fixes.css?url";
import portalFixCss from "../portal-nav-fix.css?url";
import commerceGrowthCss from "../commerce-growth.css?url";
import authGrowthCss from "../auth-growth.css?url";
import uploadCss from "../upload.css?url";
import customerOperationsCss from "../customer-operations.css?url";
import mobileCommerceCss from "../mobile-commerce.css?url";
import productDetailCss from "../product-detail.css?url";
import analyticsConsentCss from "../analytics-consent.css?url";
import brandingCss from "../branding-settings.css?url";
import homeDeliveryCss from "../home-delivery.css?url";

function NotFoundComponent() {
  const hasProvider = useHasStorefrontProvider();
  return hasProvider ? <NotFoundPage /> : <StorefrontProvider><NotFoundPage /><AnalyticsConsent /></StorefrontProvider>;
}
function NotFoundPage() {
  const config = useStorefrontConfig();
  return (
    <><title>{`Page not found | ${config.storeName}`}</title><meta name="robots" content="noindex, follow" /><StorePage><main className="store-not-found">
      <div className="not-found-art" aria-hidden="true"><span>4</span><i><Search /></i><span>4</span></div>
      <p className="eyebrow">A little off the pantry path</p>
      <h1>We couldn’t find this page.</h1>
      <p>This link may have changed, or the product may no longer be available. Explore the shop to find your next favourite.</p>
      <div className="not-found-actions"><Link to="/shop">Explore the shop <ArrowRight /></Link><Link to="/">Back to home</Link></div>
      <div className="not-found-help"><Link to="/track">Track an order</Link><Link to="/contact">Contact us</Link></div>
    </main></StorePage></>
  );
}

function ErrorComponent({ error, reset }: { error: Error; reset: () => void }) {
  console.error(error);
  const router = useRouter();

  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4">
      <div className="max-w-md text-center">
        <h1 className="text-xl font-semibold tracking-tight text-foreground">
          This page didn't load
        </h1>
        <p className="mt-2 text-sm text-muted-foreground">
          Something went wrong on our end. You can try refreshing or head back home.
        </p>
        <div className="mt-6 flex flex-wrap justify-center gap-2">
          <button
            onClick={() => {
              router.invalidate();
              reset();
            }}
            className="inline-flex items-center justify-center rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
          >
            Try again
          </button>
          <a
            href="/"
            className="inline-flex items-center justify-center rounded-md border border-input bg-background px-4 py-2 text-sm font-medium text-foreground transition-colors hover:bg-accent"
          >
            Go home
          </a>
        </div>
      </div>
    </div>
  );
}

export const Route = createRootRouteWithContext<{ queryClient: QueryClient }>()({
  loader: () => loadStorefront(),
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      {
        name: "viewport",
        content: "width=device-width, initial-scale=1, viewport-fit=cover",
      },
      { name: "author", content: "Sri Varahi Traders" },
      { name: "theme-color", content: "#173f2b" },
      { name: "mobile-web-app-capable", content: "yes" },
      { name: "apple-mobile-web-app-capable", content: "yes" },
      {
        name: "apple-mobile-web-app-status-bar-style",
        content: "black-translucent",
      },
      { name: "apple-mobile-web-app-title", content: "Sri Varahi Traders" },
    ],
    links: [
      {
        rel: "stylesheet",
        href: appCss,
      },
      { rel: "stylesheet", href: fixesCss },
      { rel: "stylesheet", href: portalFixCss },
      { rel: "stylesheet", href: commerceGrowthCss },
      { rel: "stylesheet", href: authGrowthCss },
      { rel: "stylesheet", href: uploadCss },
      { rel: "stylesheet", href: customerOperationsCss },
      { rel: "stylesheet", href: mobileCommerceCss },
      { rel: "stylesheet", href: analyticsConsentCss },
      { rel: "stylesheet", href: productDetailCss },
      { rel: "stylesheet", href: brandingCss },
      { rel: "stylesheet", href: homeDeliveryCss },
      { rel: "icon", href: import.meta.env.DEV ? "/favicon.svg" : "/api/v1/storefront/favicon" },
      { rel: "apple-touch-icon", href: import.meta.env.DEV ? "/favicon.svg" : "/api/v1/storefront/favicon" },
      { rel: "manifest", href: import.meta.env.DEV ? "/site.webmanifest" : "/api/v1/storefront/manifest" },
    ],
  }),
  shellComponent: RootShell,
  component: RootComponent,
  notFoundComponent: NotFoundComponent,
  errorComponent: ErrorComponent,
});

function RootShell({ children }: { children: ReactNode }) {
  return (
    <html lang="en-IN">
      <head>
        <HeadContent />
      </head>
      <body data-clarity-mask="true">
        {children}
        <Scripts />
      </body>
    </html>
  );
}

function RootComponent() {
  const { queryClient } = Route.useRouteContext();
  const initialConfig = Route.useLoaderData();

  return (
    <QueryClientProvider client={queryClient}>
      <StorefrontProvider initialConfig={initialConfig}>
        <PromotionsProvider>
          <Outlet />
          <MobileAppNav />
          <AnalyticsConsent />
        </PromotionsProvider>
      </StorefrontProvider>
    </QueryClientProvider>
  );
}
