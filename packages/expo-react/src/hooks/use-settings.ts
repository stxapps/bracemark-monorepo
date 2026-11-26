// Reactive read of the user's app settings — the expo sibling of web-react's
// use-settings (that file is the canonical doc: the sync/device source split
// per field, why the persisted `string`-typed values are passed through
// UNCOERCED for forward compat, the theme memoization). Divergences only here:
// the device-local source is the sqlite `local_settings` row
// (local-settings-store) instead of a Dexie table, and reactivity is
// useLiveRead over `items` (the synced blobs) + `local_settings`. The layout
// pack (layout, sort, options) resolves through the same shared helpers as web's
// (syncLayoutPack / localLayoutPack, @stxapps/shared).

import { useMemo } from 'react';

import {
  coerceDeviceExtractionMode,
  coerceThemeState,
  DEFAULT_THEME,
  type DeviceExtractionMode,
  type KeepOnSave,
  keepOnSaveOf,
  type LayoutOptions,
  localLayoutPack,
  syncLayoutPack,
  type ThemeState,
} from '@stxapps/shared';

import { getLocalSettings } from '../data/local-settings-store';
import { readSettingsGeneral, readSettingsLayout } from '../data/queries';
import { useLiveRead } from './use-live-read';

export type LinksLayoutSource = 'sync' | 'local';
export type ThemeSource = 'sync' | 'local';

// Field semantics: web-react use-settings `Settings`, verbatim — including the
// deliberate `string` (not `LinksLayout`) width on the persisted values.
export interface Settings {
  linksLayout: string;
  linksLayoutSource: LinksLayoutSource;
  syncLinksLayout: string;
  localLinksLayout: string;
  serverExtraction: boolean;
  // Already NARROWED, unlike the persisted `string` fields above: every consumer of
  // this one is a gate, and a gate that has to coerce is a gate that can forget to.
  deviceExtractionMode: DeviceExtractionMode;
  sortOn: string;
  sortOrder: string;
  syncSortOn: string;
  syncSortOrder: string;
  localSortOn: string;
  localSortOrder: string;
  layoutOptions: LayoutOptions;
  syncLayoutOptions: LayoutOptions;
  localLayoutOptions: LayoutOptions;
  theme: ThemeState;
  themeSource: ThemeSource;
  syncTheme: ThemeState;
  localTheme: ThemeState;
  // Device-local: has the first-run link-previews offer been dismissed here?
  previewsPromptDismissed: boolean;
  // The synced kept-copies setting, RESOLVED (`keepOnSaveOf`: read mode on, its images
  // on, screenshot off) — web-react's twin. A RENDER's copy: it answers the defaults
  // until the blob's read lands, so a capture reads the store at the ask instead
  // (docs/link-extraction-keep.md, _when a copy is taken_). For switches only.
  keepOnSave: KeepOnSave;
}

export function useSettings(): Settings {
  // `undefined` on the very first render — defaulted below so consumers always
  // get a concrete value.
  const general = useLiveRead(() => readSettingsGeneral(), [], ['items']);
  const layout = useLiveRead(() => readSettingsLayout(), [], ['items']);
  const local = useLiveRead(() => getLocalSettings(), [], ['local_settings']);

  // The pack, per source — web's use-settings has the fallback rules and why it's
  // memoized.
  const syncPack = useMemo(() => syncLayoutPack(layout, general), [layout, general]);
  const localPack = useMemo(() => localLayoutPack(local, syncPack), [local, syncPack]);
  const linksLayoutSource = local?.linksLayoutSource ?? 'sync';
  const pack = linksLayoutSource === 'local' ? localPack : syncPack;
  // `serverExtraction` is off by default and round-tripped for the web clients — never
  // acted on here (expo never calls bracemark-extractor). `deviceExtractionMode` is expo's
  // own, and a three-position ladder rather than an opt-in boolean: absent (never
  // touched) coerces to `saves`, which extracts links saved ON THIS DEVICE and nothing
  // else. See docs/link-extraction.md — _expo drains in the foreground_.
  const serverExtraction = general?.serverExtraction ?? false;
  const deviceExtractionMode = coerceDeviceExtractionMode(general?.deviceExtractionMode);

  // Memoized for identity stability (consumers dep on `theme`) — web's
  // rationale, verbatim: coerceThemeState allocates a fresh object every call.
  const syncTheme = useMemo(
    () => coerceThemeState(general?.theme ?? DEFAULT_THEME),
    [general?.theme],
  );
  const themeSource = local?.themeSource ?? 'sync';
  const localTheme = useMemo(() => coerceThemeState(local?.theme ?? DEFAULT_THEME), [local?.theme]);
  const theme = themeSource === 'local' ? localTheme : syncTheme;

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

  return {
    linksLayout: pack.linksLayout,
    linksLayoutSource,
    syncLinksLayout: syncPack.linksLayout,
    localLinksLayout: localPack.linksLayout,
    serverExtraction,
    deviceExtractionMode,
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
    keepOnSave,
  };
}
