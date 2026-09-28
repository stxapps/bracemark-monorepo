'use client';

// The service worker's Cache Storage, as the sign-out teardown sees it
// (docs/offline-mode.md, _sign-out leaves the worker alone_).
//
// The worker caches the APP, never data: every cross-origin request is
// network-only (bracemark-web's sw.ts), so no response body in these caches holds
// account data, and sign-out keeps the worker and its caches — the next sign-in
// stays reachable offline. What a body-clean cache can still hold is an
// account-bearing KEY: the runtime page caches key on the full URL, and a URL like
// `/links?list=<id>&tag=<id>` names this account's lists and tags. So the teardown
// drops every runtime entry whose URL carries a query, and nothing else.
//
// The PRECACHE is never touched. Its keys carry serwist's own revision query on
// unhashed files, and deleting them would take offline support away until the
// worker reinstalls — the opposite of the point.
//
// Best-effort and silent: no Cache Storage (the browser extension's pages, tests,
// a browser without it) or a failure here must never block a sign-out.
export async function purgeAccountCacheKeys(): Promise<void> {
  if (typeof caches === 'undefined') return;
  try {
    for (const name of await caches.keys()) {
      if (name.includes('precache')) continue;
      const cache = await caches.open(name);
      for (const request of await cache.keys()) {
        if (new URL(request.url).search) await cache.delete(request);
      }
    }
  } catch {
    // Nothing in these caches is account data; a leftover key is the lesser harm.
  }
}
