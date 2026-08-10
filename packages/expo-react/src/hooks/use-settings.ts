// Reactive read of the user's app settings — the expo sibling of web-react's
// use-settings (that file is the canonical doc: the sync/device source split
// per field, why the persisted `string`-typed values are passed through
// UNCOERCED for forward compat, the theme memoization). Divergences only here:
// the device-local source is the sqlite `local_settings` row
// (local-settings-store) instead of a Dexie table, and reactivity is
// useLiveRead over `items` (the synced blob) + `local_settings`.

import { useMemo } from 'react';

import {
  coerceDeviceExtractionMode,
  coerceThemeState,
  DEFAULT_THEME,
  type DeviceExtractionMode,
  type LinksLayout,
  type ThemeState,
} from '@stxapps/shared';

import { getLocalSettings } from '../data/local-settings-store';
import { readSettingsGeneral } from '../data/queries';
import { useLiveRead } from './use-live-read';

// The fallback layout before any choice is made (and while a live read is still
// resolving on first render) — the dense default, matching web.
const DEFAULT_LINKS_LAYOUT: LinksLayout = 'list';

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
  theme: ThemeState;
  themeSource: ThemeSource;
  syncTheme: ThemeState;
  localTheme: ThemeState;
  // Device-local: has the first-run link-previews offer been dismissed here?
  previewsPromptDismissed: boolean;
}

export function useSettings(): Settings {
  // `undefined` on the very first render — defaulted below so consumers always
  // get a concrete value.
  const general = useLiveRead(() => readSettingsGeneral(), [], ['items']);
  const local = useLiveRead(() => getLocalSettings(), [], ['local_settings']);

  const syncLinksLayout = general?.linksLayout ?? DEFAULT_LINKS_LAYOUT;
  const linksLayoutSource = local?.linksLayoutSource ?? 'sync';
  const localLinksLayout = local?.linksLayout ?? DEFAULT_LINKS_LAYOUT;
  const linksLayout = linksLayoutSource === 'local' ? localLinksLayout : syncLinksLayout;
  // `serverExtraction` is off by default and round-tripped for the web clients — never
  // acted on here (expo never calls bracemark-extractor). `deviceExtractionMode` is expo's
  // own, and a three-position ladder rather than an opt-in boolean: absent (never
  // touched) coerces to `saves`, which extracts links saved ON THIS DEVICE and nothing
  // else. See docs/link-extraction.md — _expo drains in the foreground_.
  const serverExtraction = general?.serverExtraction ?? false;
  const deviceExtractionMode = coerceDeviceExtractionMode(general?.deviceExtractionMode);

  // Global-only: the synced value is the applied one. The defaults
  // ('updatedAt'/'desc') match `emptyQuery`; use-links coerces before ordering.
  const sortOn = general?.sortOn ?? 'updatedAt';
  const sortOrder = general?.sortOrder ?? 'desc';

  // Memoized for identity stability (consumers dep on `theme`) — web's
  // rationale, verbatim: coerceThemeState allocates a fresh object every call.
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
    deviceExtractionMode,
    sortOn,
    sortOrder,
    theme,
    themeSource,
    syncTheme,
    localTheme,
    previewsPromptDismissed: local?.previewsPromptDismissed ?? false,
  };
}
