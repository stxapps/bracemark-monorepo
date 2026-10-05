import { defaultCache } from '@serwist/next/worker';
import type { PrecacheEntry, SerwistGlobalConfig } from 'serwist';
import { NetworkOnly, Serwist } from 'serwist';

import { answerNavigation } from './lib/navigation-response';

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
  // Starts a page load's network request alongside the worker itself, so the
  // navigation listener below does not pay the worker's start-up before it can ask
  // the network. Serwist's own use of the preload response (its precache strategy
  // returns it ahead of the cache, with no timeout) never runs for a page load:
  // the listener below answers every one of them first.
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

// ⚠ PAGE LOADS ARE ANSWERED HERE, not by Serwist's routes — and this decides
// which build a page load gets (docs/offline-mode.md, _what answers a
// navigation_). The network first, for `NAVIGATION_TIMEOUT_MS`; then this worker's
// precached copy of the page (lib/navigation-response.ts). So a reachable origin
// hands every page load the LATEST deploy, whatever worker is installed — which
// is what lets a deploy replace a page without the installed worker updating
// first — and an origin that is unreachable, wedged or erroring opens the app the
// device holds instead of a blank window.
//
// Registered BEFORE `serwist.addEventListeners()` and stopping propagation: two
// listeners answering one request is an error, and Serwist's would answer this
// one with its precache route, whose strategy waits on the preload response with
// no timeout at all — the stall this exists to end.
//
// The precache lookup drops the query, as the precache route does (above): every
// route is one file whatever its query.
self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.mode !== 'navigate' || request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  event.stopImmediatePropagation();
  event.respondWith(
    answerNavigation({
      network: (async () =>
        ((await event.preloadResponse) as Response | undefined) ?? fetch(request))(),
      precached: () => serwist.matchPrecache(url.origin + url.pathname),
    }),
  );
});

serwist.addEventListeners();
