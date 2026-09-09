import { Platform } from 'react-native';
import { Stack } from 'expo-router';
import { useCSSVariable } from 'uniwind';

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
  // For the add-link form sheet below (iOS only): the colour of the strip the
  // sheet keeps for the home indicator. That strip belongs to the NAVIGATOR's screen
  // container rather than to the screen, so it paints react-navigation's own
  // default theme background (a light grey) unless `contentStyle` says
  // otherwise — a seam under the form that is only visible on the one screen
  // whose content does not fill its container. Read from the token rather than
  // spelled as a hex so it follows the theme (docs/theme.md): Uniwind resolves
  // `--color-background` for the rendered light/dark, and this re-renders when
  // ThemeProvider switches it.
  const background = useCSSVariable('--color-background');

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
                        {/* Add is the exception ON iOS: a `formSheet` sized to its
                          own content rather than a pageSheet. Its collapsed body is
                          one field and two buttons, and at pageSheet height that left
                          two thirds of the screen empty between the form and the
                          keyboard. `fitToContents` makes the SHEET the thing that
                          measures — react-native-screens reads the laid-out content
                          height and sets a custom detent from it, clamped to the
                          sheet's maximum (iOS 16+; the deployment target is 18, so
                          the "unsupported below 16" branch is unreachable here). The
                          screen has to leave the height alone for that to work, and
                          may hold no scroller: link-add-screen.tsx carries both rules
                          and what they cost. No `animation` — a form sheet brings its
                          own presentation.

                          ANDROID KEEPS THE PLAIN MODAL, and that is not symmetry left
                          undone. The same two props there produce a sheet that
                          VANISHES the moment the keyboard is up — driven on the
                          emulator, on both entry paths (the URL field's autoFocus,
                          and a later tap into it), leaving the dimmed list and a
                          keyboard with nothing between them. It is RNS's own code
                          path, not this tree: `SheetDelegate.kt`'s KeyboardVisible
                          branch never sizes a ONE-detent sheet, and its
                          KeyboardDidHide branch re-derives the height as
                          `detents.first() * containerHeight` — with `fitToContents`
                          that first entry is a sentinel, not a fraction. Pinned-version
                          behaviour: re-drive it after an RNS bump rather than assuming
                          it still holds. → docs/soft-keyboard.md, _the form sheet_.

                          `contentStyle` is for the sheet's own strip: iOS keeps ~31pt
                          below the content for the home indicator, that strip belongs
                          to the navigator's screen container rather than to the
                          screen, and unset it paints react-navigation's default light
                          grey — a seam under a white form, in the one place where the
                          screen's content does not fill its container. */}
                        <Stack.Screen
                          name="add-link"
                          options={
                            Platform.OS === 'ios'
                              ? {
                                  presentation: 'formSheet',
                                  sheetAllowedDetents: 'fitToContents',
                                  contentStyle:
                                    typeof background === 'string'
                                      ? { backgroundColor: background }
                                      : undefined,
                                }
                              : { presentation: 'modal', animation: 'slide_from_bottom' }
                          }
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
