import { defaultCache } from '@serwist/next/worker';
import type { PrecacheEntry, SerwistGlobalConfig } from 'serwist';
import { NetworkOnly, Serwist } from 'serwist';

// This declares the value of `injectionPoint` to TypeScript.
// `injectionPoint` is the string that will be replaced by the
// actual precache manifest. By default, this string is set to
// `"self.__SW_MANIFEST"`.
declare global {
  interface WorkerGlobalScope extends SerwistGlobalConfig {
    __SW_MANIFEST: (PrecacheEntry | string)[] | undefined;
  }
}

declare const self: ServiceWorkerGlobalScope;

const serwist = new Serwist({
  precacheEntries: self.__SW_MANIFEST,
  // IMMEDIATE TAKEOVER (docs/offline-mode.md, _update policy_). A waiting worker
  // activates only once no page uses the old one — and a reload doesn't count —
  // so an installed app that never closes every window would run an old build
  // indefinitely. The cost is an open tab running old code under the new worker:
  // it gets the "updated, reload" pill (components/update-pill.tsx), which waits
  // for local saves and never drops an unsaved editor silently; an old chunk the
  // new worker no longer holds is caught as a chunk-load failure and routed to
  // the same reload (lib/chunk-error.ts, app/error.tsx).
  skipWaiting: true,
  clientsClaim: true,
  navigationPreload: true,
  // Every route in the static export is ONE file whatever its query — the query
  // is client state (`?list=`, `?tag=`, the search grammar, docs/search.md) — so a
  // precache lookup ignores it entirely. Serwist tries the exact URL first and
  // then the URL minus these parameters; its default only drops `utm_*` and
  // `fbclid`, which left a cold offline load of a restored tab or a bookmark at
  // `/links?list=<id>` missing both the precache and the runtime page cache
  // (docs/offline-mode.md, _navigations with a query string_; PWA-006).
  precacheOptions: { ignoreURLParametersMatching: [/.*/] },
  runtimeCaching: [
    // ⚠ THE WORKER CACHES THE APP, NEVER DATA (docs/offline-mode.md). Every
    // cross-origin request goes to the network and nowhere else — the api's
    // authenticated reads (ops/list, files/list, iap/status), the pre-auth door
    // blobs, bracemark-extractor's image proxy (whose URL names a third-party
    // image from a page the user saved), and presigned R2 downloads. The data
    // path already has a per-account, wiped-on-sign-out home in IndexedDB; a
    // copy in Cache Storage keys on the URL rather than the Authorization header,
    // survives sign-out, and turns a failed request into a stale success.
    //
    // A route AHEAD of `defaultCache`, not a filtered copy of it: that list ends
    // in a cross-origin NetworkFirst catch-all today, and a route here doesn't
    // depend on what an upstream upgrade adds to it. It also covers the list's
    // two host-anchored Google Fonts rules — nothing this app loads comes from
    // there (fonts are self-hosted at build), and "never cache a cross-origin
    // response" has no exceptions to keep track of.
    {
      matcher: ({ sameOrigin }) => !sameOrigin,
      handler: new NetworkOnly(),
    },
    ...defaultCache,
  ],
});

serwist.addEventListeners();
