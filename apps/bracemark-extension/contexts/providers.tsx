import { type ReactNode, useCallback, useState } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

import { ApiClientProvider } from '@stxapps/react';
import { AuthProvider, ExternalSyncProvider } from '@stxapps/web-react';
import { ThemeProvider } from '@stxapps/web-ui/contexts/theme-provider';

import { useMirroredSyncState } from '@/hooks/use-mirrored-sync-state';
import { apiClient } from '@/utils/api-client';
import { sendMessage } from '@/utils/messages';

// The popup's provider tree — bracemark-web's inner-layout, minus Serwist and the sync
// ENGINE: QueryClient → ApiClient → Auth → (External)Sync → Theme.
//
// The sync engine runs in the background service worker (a separate JS context — see
// Phase 4), so the popup does NOT mount SyncProvider. Instead it mounts
// ExternalSyncProvider, whose `requestSync` just messages the background to run a
// cycle. This satisfies the editor hooks' `useSync()` (useLinkMutations &c. call
// requestSync after each local write) without the popup double-running the sync.
//
// The live sync status comes from the background's browser.storage.local mirror
// (useMirroredSyncState) and is fed into ExternalSyncProvider, so every consumer — the popup
// editor's check logic AND the options/status page — reads status through the same
// `useSync()` seam as bracemark-web, instead of subscribing to storage on its own. The
// popup is still usable immediately: nothing here gates render on storeStatus.
export function Providers({ children }: { children: ReactNode }) {
  // One QueryClient per popup session, created lazily so it isn't shared across
  // renders. ApiClientProvider hands the shared hooks the mode-configured client.
  const [queryClient] = useState(() => new QueryClient());
  const { storeStatus, bgSyncStatus, lastSyncAt, lastError, blockedCount } = useMirroredSyncState();

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
            requestSync={requestSync}
          >
            <ThemeProvider>{children}</ThemeProvider>
          </ExternalSyncProvider>
        </AuthProvider>
      </ApiClientProvider>
    </QueryClientProvider>
  );
}
