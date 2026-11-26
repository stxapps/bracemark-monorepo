// Edit operations for app settings — the expo sibling of web-react's
// hooks/use-setting-mutations.ts, verbatim in contract (see there for the
// source-routing rationale): the device-local setters go to the sqlite
// `local_settings` row (local-settings-store), the synced setters write
// `settings/layout.enc` (the layout pack, via writeSettingsLayout) or
// `settings/general.enc` (via writeSettingsGeneral), then kick a sync; the
// unprefixed pack setters go to whichever source is active.

import { useCallback, useMemo } from 'react';

import {
  type DeviceExtractionMode,
  type LayoutOptionsPatch,
  type LinksLayout,
  type LinkSortOn,
  type LinkSortOrder,
  storedOptionsOf,
  type ThemeState,
} from '@stxapps/shared';

import { useAuth } from '../contexts/auth-provider';
import { useSync } from '../contexts/sync-provider';
import {
  getLocalSettings,
  patchLocalLayoutOptions,
  setLocalSettings,
} from '../data/local-settings-store';
import { writeSettingsGeneral, writeSettingsLayout } from '../data/mutations';
import { readSettingsLayout } from '../data/queries';
import type { LinksLayoutSource, ThemeSource } from './use-settings';

export interface SettingMutations {
  // Switch which source the app renders (Sync vs Device) — device-local.
  setLinksLayoutSource: (source: LinksLayoutSource) => Promise<void>;
  // Set the SYNCED links layout (the Sync tab); writes settings/layout.enc + syncs.
  setSyncLinksLayout: (layout: LinksLayout) => Promise<void>;
  // Set THIS device's links layout (the Device tab) — device-local, never synced.
  setLocalLinksLayout: (layout: LinksLayout) => Promise<void>;
  // The rest of the pack, per source and on the active one — web's twin.
  setLinksLayout: (layout: LinksLayout) => Promise<void>;
  setSyncSort: (patch: SortPatch) => Promise<void>;
  setLocalSort: (patch: SortPatch) => Promise<void>;
  setSort: (patch: SortPatch) => Promise<void>;
  setSyncLayoutOptions: (patch: LayoutOptionsPatch) => Promise<void>;
  setLocalLayoutOptions: (patch: LayoutOptionsPatch) => Promise<void>;
  setLayoutOptions: (patch: LayoutOptionsPatch) => Promise<void>;
  // Toggle the SYNCED server-extraction opt-in; writes settings/general.enc +
  // syncs, so every device honors the same choice. Expo ROUND-TRIPS this setting
  // for the web clients and never reads it — it never calls bracemark-extractor
  // (docs/link-extraction.md — _expo drains in the foreground_) — so it renders
  // no toggle for it either; the write edge just stays symmetric.
  setServerExtraction: (enabled: boolean) => Promise<void>;
  // Set the SYNCED on-device extraction MODE — expo's own gate, and the one the Link
  // previews section renders as three radios. Not a toggle: `off` fetches nothing at
  // all, `saves` (the default) extracts only links saved on this device, `all` adds the
  // un-gestured residual plus the per-host favicon cache. Synced, so a second phone
  // inherits the account-level trust decision rather than re-asking.
  setDeviceExtractionMode: (mode: DeviceExtractionMode) => Promise<void>;
  // The SYNCED kept-copies setting — any of its halves (web-react's twin, verbatim).
  // Synced, so a switch here changes what the browser extension keeps too.
  setKeepOnSave: (patch: {
    readMode?: boolean;
    readModeOnShare?: boolean;
    readModeImages?: boolean;
    screenshot?: boolean;
  }) => Promise<void>;
  // Switch which theme source the app renders (Sync vs Device) — device-local.
  setThemeSource: (source: ThemeSource) => Promise<void>;
  // Set the SYNCED theme (the theme "Sync" tab); writes settings/general.enc + syncs.
  setSyncTheme: (theme: ThemeState) => Promise<void>;
  // Set THIS device's theme (the theme "Device" tab) — device-local, never synced.
  setLocalTheme: (theme: ThemeState) => Promise<void>;
  // Put away the first-run link-previews offer on THIS device — device-local, so
  // the offer isn't spent for a second phone that never saw it.
  dismissPreviewsPrompt: () => Promise<void>;
}

export interface SortPatch {
  sortOn?: LinkSortOn;
  sortOrder?: LinkSortOrder;
}

// Read at CALL time — web's use-setting-mutations says why.
async function packSourceIsLocal(): Promise<boolean> {
  return (await getLocalSettings())?.linksLayoutSource === 'local';
}

export function useSettingMutations(): SettingMutations {
  const { username } = useAuth();
  const { requestSync } = useSync();

  const setLinksLayoutSource = useCallback(
    (source: LinksLayoutSource) => setLocalSettings({ linksLayoutSource: source }),
    [],
  );

  const setSyncLinksLayout = useCallback(
    async (layout: LinksLayout) => {
      if (!username) throw new Error('useSettingMutations: no active account');
      await writeSettingsLayout(username, { linksLayout: layout });
      requestSync();
    },
    [username, requestSync],
  );

  const setLocalLinksLayout = useCallback(
    (layout: LinksLayout) => setLocalSettings({ linksLayout: layout }),
    [],
  );

  const setLinksLayout = useCallback(
    async (layout: LinksLayout) =>
      (await packSourceIsLocal()) ? setLocalLinksLayout(layout) : setSyncLinksLayout(layout),
    [setLocalLinksLayout, setSyncLinksLayout],
  );

  const setSyncSort = useCallback(
    async (patch: SortPatch) => {
      if (!username) throw new Error('useSettingMutations: no active account');
      await writeSettingsLayout(username, patch);
      requestSync();
    },
    [username, requestSync],
  );

  const setLocalSort = useCallback((patch: SortPatch) => setLocalSettings(patch), []);

  const setSort = useCallback(
    async (patch: SortPatch) =>
      (await packSourceIsLocal()) ? setLocalSort(patch) : setSyncSort(patch),
    [setLocalSort, setSyncSort],
  );

  const setSyncLayoutOptions = useCallback(
    async (patch: LayoutOptionsPatch) => {
      if (!username) throw new Error('useSettingMutations: no active account');
      await writeSettingsLayout(username, { options: patch });
      requestSync();
    },
    [username, requestSync],
  );

  const setLocalLayoutOptions = useCallback(
    async (patch: LayoutOptionsPatch) =>
      patchLocalLayoutOptions(patch, storedOptionsOf(await readSettingsLayout())),
    [],
  );

  const setLayoutOptions = useCallback(
    async (patch: LayoutOptionsPatch) =>
      (await packSourceIsLocal()) ? setLocalLayoutOptions(patch) : setSyncLayoutOptions(patch),
    [setLocalLayoutOptions, setSyncLayoutOptions],
  );

  const setServerExtraction = useCallback(
    async (enabled: boolean) => {
      if (!username) throw new Error('useSettingMutations: no active account');
      await writeSettingsGeneral(username, { serverExtraction: enabled });
      requestSync();
    },
    [username, requestSync],
  );

  const setDeviceExtractionMode = useCallback(
    async (mode: DeviceExtractionMode) => {
      if (!username) throw new Error('useSettingMutations: no active account');
      await writeSettingsGeneral(username, { deviceExtractionMode: mode });
      requestSync();
    },
    [username, requestSync],
  );

  const setKeepOnSave = useCallback(
    async (patch: {
      readMode?: boolean;
      readModeOnShare?: boolean;
      readModeImages?: boolean;
      screenshot?: boolean;
    }) => {
      if (!username) throw new Error('useSettingMutations: no active account');
      await writeSettingsGeneral(username, {
        ...(patch.readMode !== undefined ? { keepReadModeOnSave: patch.readMode } : {}),
        ...(patch.readModeOnShare !== undefined
          ? { keepReadModeOnShare: patch.readModeOnShare }
          : {}),
        ...(patch.readModeImages !== undefined ? { keepReadModeImages: patch.readModeImages } : {}),
        ...(patch.screenshot !== undefined ? { keepScreenshotOnSave: patch.screenshot } : {}),
      });
      requestSync();
    },
    [username, requestSync],
  );

  const setThemeSource = useCallback(
    (source: ThemeSource) => setLocalSettings({ themeSource: source }),
    [],
  );

  const setSyncTheme = useCallback(
    async (theme: ThemeState) => {
      if (!username) throw new Error('useSettingMutations: no active account');
      await writeSettingsGeneral(username, { theme });
      requestSync();
    },
    [username, requestSync],
  );

  const setLocalTheme = useCallback((theme: ThemeState) => setLocalSettings({ theme }), []);

  const dismissPreviewsPrompt = useCallback(
    () => setLocalSettings({ previewsPromptDismissed: true }),
    [],
  );

  return useMemo<SettingMutations>(
    () => ({
      setLinksLayoutSource,
      setSyncLinksLayout,
      setLocalLinksLayout,
      setLinksLayout,
      setSyncSort,
      setLocalSort,
      setSort,
      setSyncLayoutOptions,
      setLocalLayoutOptions,
      setLayoutOptions,
      setServerExtraction,
      setDeviceExtractionMode,
      setKeepOnSave,
      setThemeSource,
      setSyncTheme,
      setLocalTheme,
      dismissPreviewsPrompt,
    }),
    [
      setLinksLayoutSource,
      setSyncLinksLayout,
      setLocalLinksLayout,
      setLinksLayout,
      setSyncSort,
      setLocalSort,
      setSort,
      setSyncLayoutOptions,
      setLocalLayoutOptions,
      setLayoutOptions,
      setServerExtraction,
      setDeviceExtractionMode,
      setKeepOnSave,
      setThemeSource,
      setSyncTheme,
      setLocalTheme,
      dismissPreviewsPrompt,
    ],
  );
}
