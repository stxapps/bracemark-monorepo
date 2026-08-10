import {
  ExtractionProvider,
  FaviconProvider,
  FileContentProvider,
  LockProvider,
  SyncProvider,
} from '@stxapps/web-react';

import { AppLockGate } from '@/components/app-lock-gate';
import { AuthGuard } from '@/components/auth-guard';
import { DanglingExtractionSweep } from '@/components/dangling-extraction-sweep';
import { InitialSyncGate } from '@/components/initial-sync-gate';
import { PaywallProvider } from '@/contexts/paywall-provider';

// Guard for the signed-in app (/links, /settings, …). The stack below, in
// order — kept in the SAME order as bracemark-expo's `(app)/_layout.tsx`, whose
// header carries the matching list. Nesting depth tracks dependency strength:
// session-only providers sit shallow, ready-store ones deeper, gates last.
//   AuthGuard       — "do you have a session?" (client-side: the session lives
//                     in IndexedDB, not a cookie, so the server can't gate).
//                     Redirects.
//   SyncProvider    — runs initial/incremental sync and exposes
//                     storeStatus/requestSync. Never redirects.
//   FileContentProvider — on-demand `files/` blobs for the link preview images.
//                     Needs only the session + api client, so it sits shallow,
//                     with the sync-layer providers and above the gates.
//   FaviconProvider — the per-host icon cache, beside it for the same reason:
//                     it needs only the extract client + the serverExtraction
//                     opt-in, and its rows are device-local.
//   ExtractionProvider — the extraction drain. Needs the session AND a ready
//                     store, so it sits inside SyncProvider. Nothing between it
//                     and FileContent/Favicon binds them — that pair is above it
//                     only because it depends on less.
//   LockProvider    — app + list locks state. Needs SyncProvider (its orphan
//                     sweep waits for a ready store) and serves both AppLockGate
//                     here and the links page's list-lock surfaces.
//   AppLockGate     — the device-local app lock (Settings → Misc). Sits BELOW
//                     the sync providers so sync keeps running behind the lock
//                     screen, and ABOVE InitialSyncGate so the lock screen is
//                     the first thing shown (it covers even the decrypting
//                     screen). Never redirects.
//   InitialSyncGate — "is the local store ready?" Renders a decrypting screen on
//                     first sync, then the app. Never redirects (sync-provider).
//   PaywallProvider — the hoisted upgrade dialog behind the entitlement gates.
// DanglingExtractionSweep is a render-null trigger, not a gate: it fires the
// once-per-session dangling-extraction janitor after the first completed sync
// cycle. It reads useAuth + useSync only (not useExtraction), so it sits
// directly under SyncProvider. Mounted HERE (bracemark-web only) on purpose — see
// its header for why a selective-sync client must never inherit it.
// This layout stays a server component and just composes the client wrappers.
export default function AppLayout({ children }: { children: React.ReactNode }) {
  return (
    <AuthGuard>
      <SyncProvider>
        <DanglingExtractionSweep />
        <FileContentProvider>
          <FaviconProvider>
            <ExtractionProvider>
              <LockProvider>
                <AppLockGate>
                  <InitialSyncGate>
                    <PaywallProvider>
                      {/* NO WRAPPER ELEMENT HERE, on purpose. Every screen under
                          this layout is already its own `h-dvh` frame carrying
                          its own `safe-area` (links/page.tsx,
                          settings/layout.tsx), so a box here is either dead
                          weight or actively harmful: a height would restate what
                          those frames set for themselves, and PADDING would ADD
                          to their `h-dvh` — separate elements, so border-box
                          can't absorb it — hanging their bottom edge past the
                          fold. That is the blanket bug from inner-layout.tsx one
                          level lower. A bare `min-h-dvh` div used to sit here; it
                          constrained nothing. docs/safe-area.md. */}
                      {children}
                    </PaywallProvider>
                  </InitialSyncGate>
                </AppLockGate>
              </LockProvider>
            </ExtractionProvider>
          </FaviconProvider>
        </FileContentProvider>
      </SyncProvider>
    </AuthGuard>
  );
}
