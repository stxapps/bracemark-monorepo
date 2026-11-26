'use client';

// Reactive read of the user's app settings — the links layout PACK (the layout, its
// sort and every layout's display options) and the theme. Two sources feed each (see
// docs/link-layouts.md, _the settings model_, and the Appearance settings section):
//
//   - the SYNCED value — `settings/layout.enc` for the pack (`readSettingsLayout`,
//     falling back to the older copies in `settings/general.enc`), and
//     `settings/general.enc` for the theme (`readSettingsGeneral`) — shared across
//     the user's devices; and
//   - the DEVICE-LOCAL value in the `localSettings` store (`getLocalSettings`),
//     which never syncs and is wiped on sign-out.
//
// `linksLayoutSource` (device-local) decides which one the app renders for the
// whole pack, so a device can opt out of the synced layout, options and sort
// together and keep its own; `themeSource` does the same for the theme. ("local" is
// the internal name for the off-sync source; the UI labels its tab "Device".) All
// reads are `useLiveQuery`, so a change on any source re-renders every consumer.

import { useMemo } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';

import {
  coerceThemeState,
  DEFAULT_THEME,
  type KeepOnSave,
  keepOnSaveOf,
  type LayoutOptions,
  localLayoutPack,
  syncLayoutPack,
  type ThemeState,
} from '@stxapps/shared';

import { getLocalSettings } from '../data/local-settings-store';
import { readSettingsGeneral, readSettingsLayout } from '../data/queries';

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
  // The synced server-read-mode opt-in — its own field, beside `serverExtraction`
  // rather than inside it (entities.ts says why). OFF BY DEFAULT; gates the reader's
  // per-link _Keep a read-mode copy_ through `bracemark-extractor` (useServerReadMode).
  serverReadMode: boolean;
  // The synced kept-copies save setting, RESOLVED (`keepOnSaveOf`: read mode on,
  // screenshot off by default). For DISPLAY: a capture decided at a save reads the
  // store at that moment instead (the browser extension's Editor), because this is a
  // render's copy and answers the defaults until the blob's read lands.
  keepOnSave: KeepOnSave;
  // The links sort the app should use right now — part of the pack, so it follows
  // `linksLayoutSource` like the layout. Typed `string` for the same forward-compat
  // reason as `linksLayout`: a newer client's value round-trips and reaches the
  // Settings UI intact (showing no selection when unknown). use-links coerces these
  // to a known `LinkSortOn`/`LinkSortOrder` before ordering the read.
  sortOn: string;
  sortOrder: string;
  // Each source's own sort (the Sync and Device tabs' values).
  syncSortOn: string;
  syncSortOrder: string;
  localSortOn: string;
  localSortOrder: string;
  // Every layout's display options the app should render right now, coerced (an
  // absent file gives the defaults, which reproduce the look from before the options
  // existed), plus each source's own.
  layoutOptions: LayoutOptions;
  syncLayoutOptions: LayoutOptions;
  localLayoutOptions: LayoutOptions;
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
  const layout = useLiveQuery(() => readSettingsLayout(), []);
  const local = useLiveQuery(() => getLocalSettings(), []);

  // The pack, per source (syncLayoutPack / localLayoutPack carry the fallback
  // rules). Memoized on the raw liveQuery values: both allocate fresh option
  // objects, and consumers dep on `layoutOptions`.
  const syncPack = useMemo(() => syncLayoutPack(layout, general), [layout, general]);
  const localPack = useMemo(() => localLayoutPack(local, syncPack), [local, syncPack]);
  const linksLayoutSource = local?.linksLayoutSource ?? 'sync';
  const pack = linksLayoutSource === 'local' ? localPack : syncPack;
  // Off by default: absent (older client / never toggled) reads as opted-out.
  const serverExtraction = general?.serverExtraction ?? false;
  const serverReadMode = general?.serverReadMode ?? false;
  const keepReadModeOnSave = general?.keepReadModeOnSave;
  const keepReadModeOnShare = general?.keepReadModeOnShare;
  const keepReadModeImages = general?.keepReadModeImages;
  const keepScreenshotOnSave = general?.keepScreenshotOnSave;
  const keepOnSave = useMemo(
    () =>
      keepOnSaveOf({
        keepReadModeOnSave,
        keepReadModeOnShare,
        keepReadModeImages,
        keepScreenshotOnSave,
      }),
    [keepReadModeOnSave, keepReadModeOnShare, keepReadModeImages, keepScreenshotOnSave],
  );

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
    linksLayout: pack.linksLayout,
    linksLayoutSource,
    syncLinksLayout: syncPack.linksLayout,
    localLinksLayout: localPack.linksLayout,
    serverExtraction,
    serverReadMode,
    keepOnSave,
    sortOn: pack.sortOn,
    sortOrder: pack.sortOrder,
    syncSortOn: syncPack.sortOn,
    syncSortOrder: syncPack.sortOrder,
    localSortOn: localPack.sortOn,
    localSortOrder: localPack.sortOrder,
    layoutOptions: pack.options,
    syncLayoutOptions: syncPack.options,
    localLayoutOptions: localPack.options,
    theme,
    themeSource,
    syncTheme,
    localTheme,
    previewsPromptDismissed: local?.previewsPromptDismissed ?? false,
  };
}
