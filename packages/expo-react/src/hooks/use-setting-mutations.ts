// Edit operations for app settings — the expo sibling of web-react's
// hooks/use-setting-mutations.ts, verbatim in contract (see there for the
// source-routing rationale): the device-local setters go to the sqlite
// `local_settings` row (local-settings-store), the synced setters write
// `settings/general.enc` via writeSettingsGeneral, then kick a sync.

import { useCallback, useMemo } from 'react';

import type {
  DeviceExtractionMode,
  LinksLayout,
  LinkSortOn,
  LinkSortOrder,
  ThemeState,
} from '@stxapps/shared';

import { useAuth } from '../contexts/auth-provider';
import { useSync } from '../contexts/sync-provider';
import { setLocalSettings } from '../data/local-settings-store';
import { writeSettingsGeneral } from '../data/mutations';
import type { LinksLayoutSource, ThemeSource } from './use-settings';

export interface SettingMutations {
  // Switch which source the app renders (Sync vs Device) — device-local.
  setLinksLayoutSource: (source: LinksLayoutSource) => Promise<void>;
  // Set the SYNCED links layout (the Sync tab); writes settings/general.enc + syncs.
  setSyncLinksLayout: (layout: LinksLayout) => Promise<void>;
  // Set THIS device's links layout (the Device tab) — device-local, never synced.
  setLocalLinksLayout: (layout: LinksLayout) => Promise<void>;
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
  // Set the SYNCED links sort field / direction; writes settings/general.enc + syncs.
  // Global-only (no device variant), so no "Sync"/"Local" split like layout/theme.
  setSortOn: (sortOn: LinkSortOn) => Promise<void>;
  setSortOrder: (sortOrder: LinkSortOrder) => Promise<void>;
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
      await writeSettingsGeneral(username, { linksLayout: layout });
      requestSync();
    },
    [username, requestSync],
  );

  const setLocalLinksLayout = useCallback(
    (layout: LinksLayout) => setLocalSettings({ linksLayout: layout }),
    [],
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

  const setSortOn = useCallback(
    async (sortOn: LinkSortOn) => {
      if (!username) throw new Error('useSettingMutations: no active account');
      await writeSettingsGeneral(username, { sortOn });
      requestSync();
    },
    [username, requestSync],
  );

  const setSortOrder = useCallback(
    async (sortOrder: LinkSortOrder) => {
      if (!username) throw new Error('useSettingMutations: no active account');
      await writeSettingsGeneral(username, { sortOrder });
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
      setServerExtraction,
      setDeviceExtractionMode,
      setSortOn,
      setSortOrder,
      setThemeSource,
      setSyncTheme,
      setLocalTheme,
      dismissPreviewsPrompt,
    }),
    [
      setLinksLayoutSource,
      setSyncLinksLayout,
      setLocalLinksLayout,
      setServerExtraction,
      setDeviceExtractionMode,
      setSortOn,
      setSortOrder,
      setThemeSource,
      setSyncTheme,
      setLocalTheme,
      dismissPreviewsPrompt,
    ],
  );
}
