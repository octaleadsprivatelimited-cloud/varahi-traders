import assert from 'node:assert/strict';

// Read-only production checks: never creates orders, users or transactions.
const origin = new URL(process.argv[2] || 'https://srivarahitraders.example').origin;
let checks = 0;
async function read(path, expected) {
  const response = await fetch(origin + path, { redirect: 'manual', signal: AbortSignal.timeout(20000) });
  assert.ok((Array.isArray(expected) ? expected : [expected]).includes(response.status), `${path}: unexpected HTTP ${response.status}`);
  checks++;
  return response;
}
for (const path of ['/ready', '/api/v1/storefront/config', '/api/v1/storefront/analytics', '/api/v1/auth/providers', '/api/v1/postal-codes/500081'])
  await read(path, 200);

const nonces = new Set();
for (const path of ['/', '/shop', '/login', '/account', '/admin/settings', '/track', '/transaction/security-check']) {
  const response = await read(path, 200), html = await response.text();
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(response.headers.get('x-frame-options'), 'DENY');
  assert.equal(response.headers.get('referrer-policy'), 'no-referrer');
  const policy = response.headers.get('content-security-policy') || '';
  const nonce = policy.match(/'nonce-([A-Za-z0-9_-]{43})'/)?.[1];
  assert.ok(nonce && !nonces.has(nonce), `${path}: missing or reused CSP nonce`); nonces.add(nonce);
  assert.ok(!policy.split(';').find(value => value.trim().startsWith('script-src ')).includes('unsafe-inline'));
  for (const script of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) {
    if (!script[2].trim() || /type="application\/ld\+json"/.test(script[1])) continue;
    assert.ok(script[1].includes(`nonce="${nonce}"`), `${path}: bootstrap nonce mismatch`);
  }
  if (/^\/(account|admin|login|track|transaction)/.test(path)) {
    assert.equal(response.headers.get('cache-control'), 'private, no-store');
    assert.ok(response.headers.get('x-robots-tag')?.includes('noindex'));
  }
}
for (const path of ['/api/v1/auth/me', '/api/v1/account/orders', '/api/v1/account/payments', '/api/v1/account/addresses', '/api/v1/account/returns', '/api/v1/account/support', '/api/v1/wishlist',
  '/api/v1/admin/orders', '/api/v1/admin/customers', '/api/v1/admin/integrations', '/api/v1/admin/storefront-config']) {
  const response = await read(path, 401);
  assert.ok(response.headers.get('cache-control')?.includes('no-store'));
  const body = await response.json();
  assert.equal(body.success, false); assert.ok(!body.data);
}
for (const path of ['/.env', '/.git/config', '/package.json', '/commerce-api/src/app.ts'])
  await read(path, [403, 404]);
await read('/this-page-does-not-exist', 404);
await read('/api/v1/orders/security-check/track', 410);
console.log(`Production security smoke passed: ${checks} checks on ${origin}; private APIs deny anonymous access, private files are inaccessible, and storefront security headers/nonces are active.`);
