import { PortalHost } from '@rn-primitives/portal';

// The PortalHosts a portaled overlay can land in. The root layout's DEFAULT host
// (src/app/_layout.tsx) sits above every signed-in provider, so content portaled
// there renders without SyncProvider, FileContentProvider or the app lock's
// cover — which the kit's pickers never need (their bodies read the store
// directly) and a whole editor does: `useLinkMutations` calls `useSync()`.
// `APP_PORTAL_HOST` is mounted INSIDE the (app) group's providers
// (`(app)/_layout.tsx`), for content that has to run there — the wide link
// editor (features/links/link-edit-screen.tsx). On iOS the kit still draws it in
// a FullWindowOverlay, so where the host sits changes its context, not its
// reach.
export const APP_PORTAL_HOST = 'app';

// The host itself, from the kit because @rn-primitives is fenced to it
// (eslint.config.mjs — overlays come from src/components/ui so they answer to
// useAppCovered; a host is not an overlay, but the fence is by import).
export function AppPortalHost() {
  return <PortalHost name={APP_PORTAL_HOST} />;
}
