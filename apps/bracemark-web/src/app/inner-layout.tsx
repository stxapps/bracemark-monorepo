'use client';
import { Suspense, useEffect, useState } from 'react';
import { SerwistProvider } from '@serwist/next/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

import { ApiClientProvider, ExtractClientProvider } from '@stxapps/react';
import { AuthProvider } from '@stxapps/web-react';
import { ThemeProvider } from '@stxapps/web-ui/contexts/theme-provider';

import { apiClient } from '../lib/api-client';
import { extractClient } from '../lib/extract-client';

function Initializer() {
  useEffect(() => {
    if (!('serviceWorker' in navigator && window.serwist !== undefined)) return;

    const mediaQuery = window.matchMedia('(display-mode: standalone)');

    let didListenMedia = false,
      didRegister = false;
    const onWaiting = () => {
      //dispatch(showSWWUPopup());
    };
    const register = () => {
      if (didRegister) return;
      window.serwist.register();
      window.serwist.addEventListener('waiting', onWaiting);
      didRegister = true;
    };
    const onMediaChange = () => {
      if (mediaQuery.matches) register();
    };
    const check = async () => {
      if (mediaQuery.matches) {
        register();
        return;
      }

      const reg = await navigator.serviceWorker.getRegistration();
      if (reg) {
        register();
        return;
      }

      mediaQuery.addEventListener('change', onMediaChange);
      didListenMedia = true;
    };

    check();
    return () => {
      if (didListenMedia) mediaQuery.removeEventListener('change', onMediaChange);
      if (didRegister) window.serwist.removeEventListener('waiting', onWaiting);
    };
  }, []);

  return null;
}

export function InnerLayout({ children }: { children: React.ReactNode }) {
  // One QueryClient per browser session, created lazily so it isn't shared
  // across requests/renders. ApiClientProvider hands the shared hooks the
  // env-configured client (apiClient) so they don't hardcode a baseUrl.
  const [queryClient] = useState(() => new QueryClient());

  return (
    // SerwistProvider sets up `window.serwist` (which the plugin used to inject
    // automatically). We keep manual, conditional registration via Initializer
    // below, so register/cacheOnNavigation/reloadOnOnline are all off here to
    // preserve the previous behavior. Disabled in dev since `serwist build`
    // only runs as part of the production build.
    <SerwistProvider
      swUrl="/sw.js"
      register={false}
      cacheOnNavigation={false}
      reloadOnOnline={false}
      disable={process.env.NODE_ENV === 'development'}
    >
      <Suspense fallback={null}>
        <Initializer />
      </Suspense>
      <QueryClientProvider client={queryClient}>
        <ApiClientProvider client={apiClient}>
          <ExtractClientProvider client={extractClient}>
            <AuthProvider>
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
              <ThemeProvider>{children}</ThemeProvider>
            </AuthProvider>
          </ExtractClientProvider>
        </ApiClientProvider>
      </QueryClientProvider>
    </SerwistProvider>
  );
}
