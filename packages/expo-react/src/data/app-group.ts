// The iOS App Group — the one identifier both share-sheet processes rendezvous
// on (docs/share-sheet.md). Two things live under it, so two stores need it:
//   - the shared CONTAINER (share-store's taxonomy snapshot + outbox files),
//     reached via expo-file-system's Paths.appleSharedContainers;
//   - the shared KEYCHAIN access group (session-store's session mirror) — iOS
//     accepts App Group ids as keychain access groups, so the same entitlement
//     covers both.
// Hoisted here (not in share-store) so session-store can import it without a
// share-store → session-store → share-store cycle.

import { Directory, Paths } from 'expo-file-system';

// expo-share-extension's default group id: `group.` + the bundle identifier
// (app.config.ts `ios.bundleIdentifier`).
export const APP_GROUP_ID = 'group.com.bracemark.app';

// The App Group container directory, or null off-iOS / before entitlements
// land. Falls back to the first container so a future explicit AppGroup
// override doesn't strand this lookup.
export function appGroupDir(): Directory | null {
  const containers = Paths.appleSharedContainers;
  const dir = containers[APP_GROUP_ID] ?? Object.values(containers)[0];
  return dir ?? null;
}
