import { Stack } from 'expo-router';

import {
  ExtractionProvider,
  FaviconProvider,
  FileContentProvider,
  LockProvider,
  ShareBridge,
  SyncProvider,
} from '@stxapps/expo-react';

import { AppLockGate } from '../../components/app-lock-gate';
import { AuthGuard } from '../../components/auth-guard';
import { InitialSyncGate } from '../../components/initial-sync-gate';
import { PaywallProvider } from '../../contexts/paywall-provider';

// The signed-in app group — `/links`, `/settings`. Mirrors bracemark-web's
// `src/app/(app)`. A plain Stack for now; this is where a Tabs/Drawer navigator
// would go if the mobile app wants bottom tabs for links/settings.
//
// Gate stack, in the SAME order as bracemark-web's `(app)/layout.tsx`, whose header
// carries the matching list — keep the two in step. Nesting depth tracks
// dependency strength: session-only providers sit shallow, ready-store ones
// deeper, gates last. The only deliberate differences from web are the
// platform-specific render-null triggers: ShareBridge here,
// DanglingExtractionSweep there.
//   AuthGuard    — "do you have a session?" It redirects to `/sign-in` (or `/`
//                  on a deliberate sign-out) when there's no session —
//                  client-side, since the local-first session lives on-device
//                  (secure-store), so there's no server to gate. Reads the
//                  AuthProvider mounted in the root `_layout`.
//   SyncProvider — "is the local store ready?" It runs initial/incremental sync
//                  and exposes storeStatus/requestSync to the app. Never
//                  redirects.
//   FileContentProvider — on-demand `files/` blobs for the link preview
//                  images. Only needs the session + api client, so it sits with
//                  the sync-layer providers, above the gates (web's placement).
//   FaviconProvider — the per-host icon cache, beside it for the same reason
//                  (web's placement); it needs only the extraction opt-in and
//                  its rows are device-local.
//   ExtractionProvider — the on-device extraction drain (title + preview image
//                  per link). Needs the session AND a ready store, so it sits
//                  inside SyncProvider — and it must sit inside FaviconProvider
//                  too: `extractNow` fires the gestured favicon guess through
//                  `useFavicon`, which THROWS outside its provider. (FileContent
//                  above is not a dependency; it's shallower only because it
//                  depends on less.) The links screen consumes it (viewable-row
//                  reporting) and so does the settings section. Locked lists get NO
//                  special-casing here: locks are a display deterrent over
//                  already-decrypted data (docs/locks.md), and fetching a page
//                  shows a shoulder-surfer nothing.
//   LockProvider — the device-local app/list locks state. Needs SyncProvider
//                  (its orphan sweep waits for a ready store) and serves both
//                  AppLockGate here and the links/settings lock surfaces.
//   AppLockGate  — the device-local app lock (Settings → Misc). A content
//                  swap, never a redirect; sync keeps running behind the lock
//                  screen since the sync providers sit above it. Sits ABOVE
//                  InitialSyncGate so the lock screen is the first thing shown
//                  (it covers even the decrypting screen).
//   InitialSyncGate — "is the local store ready?" Renders a decrypting screen
//                  on first sync, then the app. Never redirects (sync-provider).
//   PaywallProvider — the hoisted upgrade dialog behind the entitlement gates
//                  (locks, nested lists).
//
// ShareBridge is the share sheet's app-side half (docs/share-sheet.md): it
// drains the iOS extension's outbox through the write edge on launch/foreground
// and keeps the App Group taxonomy snapshot fresh after syncs and local edits.
// It reads useSync AND useExtraction (a drained share is a gestured save, so it
// gets the same immediate page fetch the add screen's does), so it sits inside
// both — hence its place under ExtractionProvider rather than directly under
// SyncProvider. (The Android share activity's inline sync kick lives in
// saveSharedDraft itself, not here.)
export default function AppLayout() {
  return (
    <AuthGuard>
      <SyncProvider>
        <FileContentProvider>
          <FaviconProvider>
            <ExtractionProvider>
              <ShareBridge />
              <LockProvider>
                <AppLockGate>
                  <InitialSyncGate>
                    <PaywallProvider>
                      <Stack screenOptions={{ headerShown: false }}>
                        {/* The link editors present modally (iOS pageSheet; Android
                          slides up) — router screens, not RN Modals, so keyboard-
                          controller and portals work inside them (see
                          features/links/link-add-screen.tsx). */}
                        <Stack.Screen
                          name="add-link"
                          options={{ presentation: 'modal', animation: 'slide_from_bottom' }}
                        />
                        <Stack.Screen
                          name="edit-link"
                          options={{ presentation: 'modal', animation: 'slide_from_bottom' }}
                        />
                      </Stack>
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
