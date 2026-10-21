import { type ReactNode, useCallback, useMemo, useState } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

import { ApiClientProvider } from '@stxapps/react';
import { AuthProvider, ExternalSyncProvider } from '@stxapps/web-react';
import { ThemeProvider } from '@stxapps/web-ui/contexts/theme-provider';

import { useMirroredSyncProgress, useMirroredSyncState } from '@/hooks/use-mirrored-sync';
import { apiClient } from '@/utils/api-client';
import { sendMessage } from '@/utils/messages';

// The provider tree of the browser extension's two pages — the popup and the options
// page each mount it from their own main.tsx. It is bracemark-web's root tree
// (inner-layout.tsx) without Serwist and ExtractClientProvider — nothing here is
// precached, and extraction runs in bracemark-web — plus the sync seam web mounts one
// level down, in its (app) layout: QueryClient → ApiClient → Auth → (External)Sync →
// Theme.
//
// The sync ENGINE runs in the background service worker (a separate JS context —
// entrypoints/background.ts), so neither page mounts SyncProvider. Instead they mount
// ExternalSyncProvider, whose `requestSync` just messages the background to run a
// cycle. This satisfies the editor hooks' `useSync()` (useLinkMutations &c. call
// requestSync after each local write) without a page double-running the sync.
//
// The live sync status comes from the background's browser.storage.local mirror
// (useMirroredSyncState) and is fed into ExternalSyncProvider, so every consumer — the popup
// editor's check logic AND the options/status page — reads status through the same
// `useSync()` seam as bracemark-web, instead of subscribing to storage on its own. The
// popup is still usable immediately: nothing here gates render on storeStatus. The
// progress numbers ride their own mirror (storage.session, useMirroredSyncProgress —
// ten writes a second, which the status mirror must not carry) and are split back
// into the two context fields the apps' providers fill.
export function Providers({ children }: { children: ReactNode }) {
  // One QueryClient per page load (a popup opening, an options tab), created lazily
  // so it isn't shared across renders. ApiClientProvider hands the shared hooks the
  // mode-configured client.
  const [queryClient] = useState(() => new QueryClient());
  const { storeStatus, bgSyncStatus, lastSyncAt, lastError, blockedCount } = useMirroredSyncState();
  const progress = useMirroredSyncProgress();
  // Memoized on the mirror's value so a status-only write hands consumers the
  // same objects; each progress tick is a new value anyway.
  const { initialSyncProgress, syncProgress } = useMemo(() => {
    if (!progress) return { initialSyncProgress: null, syncProgress: null };
    const { step, done, total } = progress;
    return step === 'initial'
      ? { initialSyncProgress: { done, total }, syncProgress: null }
      : { initialSyncProgress: null, syncProgress: { step, done, total } };
  }, [progress]);

  // Stable identity: `sendMessage` is a module import, so this closes over nothing
  // that changes. Providers re-renders whenever the mirrored sync state updates
  // (every cycle toggles bgSyncStatus), so an inline arrow here would hand every
  // `useSync()` consumer a fresh `requestSync` each cycle. Harmless for the editor
  // hooks that only call it from event handlers, but a popup-open effect that
  // depends on `requestSync` (App.tsx's AuthedApp mount kick) would re-fire on
  // every cycle and drive an endless syncing⇄synced loop. useCallback breaks it.
  const requestSync = useCallback(() => {
    void sendMessage({ type: 'KICK_SYNC' });
  }, []);
  // The same message, waited on: the background answers KICK_SYNC only once its
  // cycle has settled (background.ts), which is what the options page's sign-out
  // flow needs before it re-reads the pending queue. A cycle that failed and a
  // worker that could not be reached both just settle — the queue is the answer.
  const syncAndWait = useCallback(
    () =>
      sendMessage({ type: 'KICK_SYNC' }).then(
        () => undefined,
        () => undefined,
      ),
    [],
  );

  return (
    <QueryClientProvider client={queryClient}>
      <ApiClientProvider client={apiClient}>
        <AuthProvider>
          <ExternalSyncProvider
            storeStatus={storeStatus}
            bgSyncStatus={bgSyncStatus}
            lastSyncAt={lastSyncAt}
            lastError={lastError}
            blockedCount={blockedCount}
            initialSyncProgress={initialSyncProgress}
            syncProgress={syncProgress}
            requestSync={requestSync}
            syncAndWait={syncAndWait}
          >
            <ThemeProvider>{children}</ThemeProvider>
          </ExternalSyncProvider>
        </AuthProvider>
      </ApiClientProvider>
    </QueryClientProvider>
  );
}
