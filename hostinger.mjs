import { fileURLToPath } from "node:url";
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { join } from 'node:path';
const requireApi = createRequire(new URL('./commerce-api/package.json', import.meta.url));
const serveStatic = requireApi('express').static(fileURLToPath(new URL('./.output/public/', import.meta.url)));
import { prepareHostingerDatabase } from './commerce-api/dist/src/hostinger-startup.js';
import { createApp } from './commerce-api/dist/src/app.js';
import { storefrontProductDto } from './commerce-api/dist/src/admin-products.js';
import { buildMerchantFeed, buildRobots, buildSitemap } from './commerce-api/dist/src/catalog-discovery.js';
import { startNotificationWorker } from './commerce-api/dist/src/notification-worker.js';
import { baseSecurityHeaders } from './commerce-api/dist/src/http-security.js';
import { middleware } from './.output/server/index.mjs';

const origin = new URL(process.env.APP_URL || 'http://localhost:5180').origin;
process.env.CORS_ORIGINS ||= origin;
process.env.PUBLIC_UPLOAD_BASE_URL ||= `${origin}/uploads`;
// Hostinger replaces release directories on deployment. Keep uploaded catalog
// images in an application-specific directory outside the checkout.
process.env.UPLOAD_DIR ||= process.env.NODE_ENV === 'production'
  ? join(homedir(), '.local', 'share', 'sri-varahi-traders', new URL(origin).hostname, 'uploads')
  : 'uploads';
process.env.USE_DATABASE ||= 'true';
let ready = false;
let markReady;
const initialized = new Promise(resolve => { markReady = resolve; });
const privatePath = /^\/(admin|account|cart|checkout|login|track|transaction|api|webhooks)(\/|$)/;
const server = createServer(async (req, res) => {
  for (const [name, value] of Object.entries(baseSecurityHeaders(process.env.NODE_ENV === 'production'))) res.setHeader(name, value);
  const path = new URL(req.url || '/', origin).pathname;
  if (!ready && path !== '/ready' && path !== '/health') {
    // New Hostinger workers can receive traffic during initialization. Hold the
    // first customer request briefly instead of showing a cold-start error page.
    await new Promise(resolve => {
      const timeout = setTimeout(resolve, 10_000);
      initialized.then(() => { clearTimeout(timeout); resolve(); });
    });
  }
  if (!ready) {
    res.writeHead(503, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'Retry-After': '1',
    });
    res.end(JSON.stringify({ success: false, error: { code: 'SERVICE_STARTING', message: 'The store is starting. Please retry shortly.' } }));
    return;
  }
  if (path === '/robots.txt') {
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.end(buildRobots(origin));
    return;
  }
  if (/^\/sitemap(?:-\d+)?\.xml$/.test(path)) {
    const sitemap = buildSitemap(store.products.values(), origin, path);
    res.setHeader('Content-Type', 'application/xml; charset=utf-8');
    res.setHeader('Cache-Control', 'public, max-age=300');
    if (!sitemap) { res.statusCode = 404; res.end('Sitemap not found'); return; }
    res.end(sitemap);
    return;
  }
  if (path === '/merchant-feed.xml') {
    res.setHeader('Content-Type', 'application/xml; charset=utf-8');
    res.setHeader('Cache-Control', 'public, max-age=300');
    res.setHeader('X-Robots-Tag', 'noindex');
    res.end(buildMerchantFeed(store.products.values(), origin).xml);
    return;
  }
  if (privatePath.test(path)) {
    res.setHeader('X-Robots-Tag', 'noindex, nofollow');
    res.setHeader('Cache-Control', 'private, no-store');
  }
  if (/^\/(api|webhooks|uploads)(\/|$)/.test(path) || ['/health', '/ready'].includes(path)) app(req, res);
  else serveStatic(req, res, () => Promise.resolve(middleware(req, res)).catch(error => {
    console.error('Storefront request failed', error);
    if (!res.headersSent) { res.statusCode = 500; res.end('The store is temporarily unavailable.'); }
    else res.destroy();
  }));
});
// Hostinger expects listen() within three seconds. Bind before migrations, but
// keep every route unavailable until persistent storage and the app are ready.
const port = Number(process.env.PORT || '4010');
server.listen(port, '0.0.0.0', () => console.log(`Storefront and API listening on port ${port}; initializing database.`));
await prepareHostingerDatabase();
const { app, config, store, persistence, readStorefront } = await createApp();
globalThis[Symbol.for('varahi.publicStorefrontReader')] = readStorefront;
globalThis[Symbol.for('varahi.publicCatalogReader')] = () => store.listProducts()
  .filter(product => product.status === 'ACTIVE')
  .map(storefrontProductDto);
const stopNotifications = persistence && config.NODE_ENV === 'production'
  ? startNotificationWorker({ db: persistence.db, config }) : async () => {};
ready = true;
markReady();
console.log('Storefront and API are ready.');
let stopping = false;
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => {
  if (stopping) return;
  stopping = true;
  server.close(async () => { await stopNotifications(); await persistence?.disconnect(); process.exit(0); });
  setTimeout(() => process.exit(1), 10000).unref();
});
