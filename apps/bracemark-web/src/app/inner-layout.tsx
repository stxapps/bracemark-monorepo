'use client';
import { useEffect, useState } from 'react';
import { SerwistProvider } from '@serwist/next/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

import { ApiClientProvider, ExtractClientProvider } from '@stxapps/react';
import { AuthProvider, useAuth } from '@stxapps/web-react';
import { ThemeProvider } from '@stxapps/web-ui/contexts/theme-provider';

import { UpdatePill } from '../components/update-pill';
import { UpdateRequiredBanner } from '../components/update-required-banner';
import { apiClient } from '../lib/api-client';
import { extractClient } from '../lib/extract-client';
import { watchForServiceWorkerUpdates } from '../lib/service-worker-update-check';

// Registers the service worker — and so makes the library reachable with the
// origin gone (docs/offline-mode.md, _when the worker registers_). The rule is
// "once signed in", in ANY display mode: a signed-in user has a library on this
// device worth keeping reachable, and a normal browser tab needs the worker
// exactly as much as an installed window. A visitor who never signs in never
// registers and never downloads the precache. A load that finds an existing
// registration re-registers too (signed in or not): the same script at the same
// scope, so the registration itself is unchanged.
//
// ⚠ UPDATES DO NOT RUN THROUGH THIS CALL. The browser re-fetches `/sw.js` by
// itself on every navigation in scope, past the worker and the HTTP cache, and no
// app code takes part — which is what lets a deploy replace a build whose pages
// no longer run at all (PWA-011). What can strand a browser on an old build is
// the script at that URL, never this effect (docs/offline-mode.md, _`/sw.js` is
// permanent_).
//
// Registration only STARTS the offline guarantee: it holds once the worker has
// installed (the precache downloaded), which the first online session does in
// the background.
//
// ⚠ This rides on the worker's cross-origin rule (sw.ts): registering after every
// sign-in widens who runs the worker, so it must never cache account data.
//
// Once per document, hence module scope: `window.serwist` is one Serwist instance
// per page load, and a second `register()` on it is refused in dev and silently
// redone in prod. An effect-local flag would reset on every `signedIn` flip —
// a reload that finds the registration before auth hydrates, or a sign-out then
// sign-in in the same tab, would each register again.
let didRegister = false;

function Initializer() {
  const { status } = useAuth();
  const signedIn = status === 'authenticated';

  useEffect(() => {
    if (!('serviceWorker' in navigator && window.serwist !== undefined)) return;

    // A new build's worker takes over at once (sw.ts, `skipWaiting: true`); the
    // tab it takes over from learns through UpdatePill, which watches
    // `controllerchange` itself.
    let cancelled = false;
    const register = () => {
      if (cancelled || didRegister) return;
      // Set before the call: `register()` is async (it awaits window `load`).
      didRegister = true;
      void window.serwist.register();
    };

    if (signedIn) {
      register();
    } else {
      void navigator.serviceWorker.getRegistration().then((reg) => {
        if (reg) register();
      });
    }

    return () => {
      cancelled = true;
    };
  }, [signedIn]);

  // A window that is never reloaded never navigates, so it would never check for
  // a new build; returning to it does (lib/service-worker-update-check.ts).
  useEffect(() => watchForServiceWorkerUpdates(), []);

  // Ask the browser not to evict this origin's storage under pressure — the
  // library, its keys and the worker's precache (docs/offline-mode.md, _storage
  // durability_). Chrome grants it on engagement or installation, Firefox asks
  // the user; either may say no, and a granted origin can still be cleared by the
  // user. Once per signed-in load; the answer is only information.
  useEffect(() => {
    if (!signedIn || !navigator.storage?.persist) return;
    void navigator.storage
      .persisted()
      .then((already) => (already ? true : navigator.storage.persist()))
      .catch(() => undefined);
  }, [signedIn]);

  return null;
}

export function InnerLayout({ children }: { children: React.ReactNode }) {
  // One QueryClient per browser session, created lazily so it isn't shared
  // across requests/renders. ApiClientProvider hands the shared hooks the
  // env-configured client (apiClient) so they don't hardcode a baseUrl.
  const [queryClient] = useState(() => new QueryClient());

  return (
    // SerwistProvider sets up `window.serwist` (which the plugin used to inject
    // automatically). Registration is manual, via Initializer below (after
    // sign-in), so register/cacheOnNavigation/reloadOnOnline are all off here.
    // Disabled in dev since `serwist build` only runs as part of the production
    // build.
    <SerwistProvider
      swUrl="/sw.js"
      register={false}
      cacheOnNavigation={false}
      reloadOnOnline={false}
      disable={process.env.NODE_ENV === 'development'}
    >
      <QueryClientProvider client={queryClient}>
        <ApiClientProvider client={apiClient}>
          <ExtractClientProvider client={extractClient}>
            <AuthProvider>
              <Initializer />
              {/* NO BLANKET `.safe-area` WRAPPER HERE — it used to sit around
                  `children`, and the bug was that it was a PARENT of the screens
                  rather than the screens themselves. Padding on a plain block box
                  ADDS to whatever its child claims, so a `h-dvh` frame (links,
                  settings) came out `100dvh + top + bottom` and hung its own
                  bottom edge — the list's last row — past the fold, on a frame
                  that is `overflow-hidden` and has no scroll of its own to bring
                  it back. Every full-height surface now carries `safe-area` on the
                  SAME element as its `h-dvh`/`min-h-dvh`, where `box-sizing:
                  border-box` takes the padding OUT of that height instead of
                  adding to it. docs/safe-area.md, _applying safe area_. */}
              <ThemeProvider>
                {children}
                <UpdatePill />
                <UpdateRequiredBanner />
              </ThemeProvider>
            </AuthProvider>
          </ExtractClientProvider>
        </ApiClientProvider>
      </QueryClientProvider>
    </SerwistProvider>
  );
}
