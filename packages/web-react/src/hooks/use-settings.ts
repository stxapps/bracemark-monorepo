'use client';

// Reactive read of the user's app settings — the links layout and the theme. Two
// sources feed each (see docs/local-first-sync.md "data model — settings" and the
// Misc settings section):
//
//   - the SYNCED value in `settings/general.enc` (`readSettingsGeneral`), shared
//     across the user's devices; and
//   - the DEVICE-LOCAL value in the `localSettings` store (`getLocalSettings`),
//     which never syncs and is wiped on sign-out.
//
// `linksLayoutSource` (device-local) decides which one the app actually renders, so
// a device can opt out of the synced layout and keep its own. `linksLayout` is that
// resolved value — the single field topbar/main consumed before, now sourced here
// instead of localStorage. ("local" is the internal name for the off-sync source;
// the Misc UI labels its tab "Device".) Both reads are `useLiveQuery`, so a change
// on either source (a local edit, or a sync landing a new `settings/general.enc`)
// re-renders every consumer.

import { useMemo } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';

import {
  coerceThemeState,
  DEFAULT_THEME,
  type LinksLayout,
  type ThemeState,
} from '@stxapps/shared';

import { getLocalSettings } from '../data/local-settings-store';
import { readSettingsGeneral } from '../data/queries';

// The fallback layout before any choice is made (and while a liveQuery is still
// resolving on first render) — the dense default, matching the old localStorage
// seed.
const DEFAULT_LINKS_LAYOUT: LinksLayout = 'list';

export type LinksLayoutSource = 'sync' | 'local';
export type ThemeSource = 'sync' | 'local';

// The three `*LinksLayout` values below are typed `string`, NOT `LinksLayout`, and
// that width is the POINT: they're persisted values, and `linksLayout` can be SYNCED,
// so a device running a newer client can legitimately store a layout this build has
// never heard of (a future `table` — see LINKS_LAYOUTS in entities.ts). The schema
// deliberately doesn't validate reads against the writer's enum, so neither can this
// hook lie about the result. Unknown values reach consumers INTACT rather than being
// silently rewritten to the default, which is what keeps them round-tripping back to
// the newer device untouched — the cost is that every consumer must handle a value
// outside its own union (bracemark-web's `Main` falls back to `ListLayout`; the Settings
// radios show no selection). Writers are still strict: `setSyncLinksLayout` /
// `setLocalLinksLayout` take a `LinksLayout`.
export interface Settings {
  // The links layout the app should render right now — `localLinksLayout` when the
  // active source is `local`, else the synced `syncLinksLayout`.
  linksLayout: string;
  // Which source is active on THIS device (device-local; never synced).
  linksLayoutSource: LinksLayoutSource;
  // The synced links layout (the Sync tab's radio value).
  syncLinksLayout: string;
  // This device's own links layout (the Device tab's radio value).
  localLinksLayout: string;
  // The synced server-extraction opt-in (Settings → the second, explicit opt-in).
  // OFF BY DEFAULT — `false` until the user turns it on; gates whether a web client
  // sends a saved URL to `bracemark-extractor` (see docs/link-extraction.md).
  serverExtraction: boolean;
  // The SYNCED links sort — global-only (no device split), so the synced value IS
  // the applied one. Typed `string` for the same forward-compat reason as
  // `linksLayout`: a newer client's value round-trips and reaches the Settings UI
  // intact (showing no selection when unknown). use-links coerces these to a known
  // `LinkSortOn`/`LinkSortOrder` before ordering the read (coerceLinkSort*).
  sortOn: string;
  sortOrder: string;
  // The theme the app should apply right now — `localTheme` when the active source is
  // `local`, else the synced `syncTheme`. The ThemeProvider consumes this (the way
  // main.tsx consumes `linksLayout`) to resolve/apply light-vs-dark and to keep the
  // localStorage FOUC mirror warm.
  theme: ThemeState;
  // Which theme source is active on THIS device (device-local; never synced).
  themeSource: ThemeSource;
  // The synced theme (the theme "Sync" tab's value).
  syncTheme: ThemeState;
  // This device's own theme (the theme "Device" tab's value).
  localTheme: ThemeState;
  // Device-local: has the first-run link-previews offer been dismissed here? (db.ts
  // — the banner is chrome, so it doesn't ride the synced blob.)
  previewsPromptDismissed: boolean;
}

export function useSettings(): Settings {
  // `undefined` on the very first render (and a stale value for one render after a
  // dep change) — defaulted below so consumers always get a concrete layout.
  const general = useLiveQuery(() => readSettingsGeneral(), []);
  const local = useLiveQuery(() => getLocalSettings(), []);

  const syncLinksLayout = general?.linksLayout ?? DEFAULT_LINKS_LAYOUT;
  const linksLayoutSource = local?.linksLayoutSource ?? 'sync';
  const localLinksLayout = local?.linksLayout ?? DEFAULT_LINKS_LAYOUT;
  const linksLayout = linksLayoutSource === 'local' ? localLinksLayout : syncLinksLayout;
  // Off by default: absent (older client / never toggled) reads as opted-out.
  const serverExtraction = general?.serverExtraction ?? false;

  // Global-only: the synced value is the applied one (no source resolution like
  // layout/theme). Passed through raw (`string`) so an unknown future value reaches
  // the Settings UI and round-trips; the defaults ('updatedAt'/'desc') match
  // `emptyQuery`, and use-links coerces before ordering the read.
  const sortOn = general?.sortOn ?? 'updatedAt';
  const sortOrder = general?.sortOrder ?? 'desc';

  // Coerce both sources through `coerceThemeState`: the synced value is permissively
  // typed (entities.ts) so an odd persisted value never drops the settings blob, and
  // the device value can predate this feature (older `localSettings` row) — both
  // normalize to a real `ThemeState`, falling back to `DEFAULT_THEME` when absent.
  //
  // Memoized because `coerceThemeState` allocates a FRESH object every call, so an
  // unmemoized `theme` would have a new identity on every render even when unchanged.
  // Consumers use `theme` as a dependency (ThemeProvider's apply effect keys on it),
  // where a per-render identity churns the effect needlessly — and is a latent render
  // loop for any consumer that both deps on it and sets state from it. Keyed on the
  // raw liveQuery values, so identity only changes when a source actually re-emits.
  const syncTheme = useMemo(
    () => coerceThemeState(general?.theme ?? DEFAULT_THEME),
    [general?.theme],
  );
  const themeSource = local?.themeSource ?? 'sync';
  const localTheme = useMemo(() => coerceThemeState(local?.theme ?? DEFAULT_THEME), [local?.theme]);
  const theme = themeSource === 'local' ? localTheme : syncTheme;

  return {
    linksLayout,
    linksLayoutSource,
    syncLinksLayout,
    localLinksLayout,
    serverExtraction,
    sortOn,
    sortOrder,
    theme,
    themeSource,
    syncTheme,
    localTheme,
    previewsPromptDismissed: local?.previewsPromptDismissed ?? false,
  };
}
