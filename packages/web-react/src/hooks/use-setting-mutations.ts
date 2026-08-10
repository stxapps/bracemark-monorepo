'use client';

// Edit operations for app settings — the write side of use-settings.ts. The setters
// mirror the read hook's values, and each routes to the right store:
//
//   - setLinksLayoutSource / setLocalLinksLayout / setThemeSource / setLocalTheme /
//     dismissPreviewsPrompt → the DEVICE-LOCAL `localSettings` store (no account, no
//     sync — see local-settings-store.ts);
//   - setSyncLinksLayout / setServerExtraction / setSyncTheme → the SYNCED
//     `settings/general.enc` blob via writeSettingsGeneral, then a sync kick, exactly
//     like useListMutations writes a list and requests sync.
//
// Keeping the source choice + device layout off-sync is deliberate: "use this
// device's own layout" is a per-device decision that must not propagate (db.ts).

import { useCallback, useMemo } from 'react';

import type { LinksLayout, LinkSortOn, LinkSortOrder, ThemeState } from '@stxapps/shared';

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
  // Toggle the SYNCED server-extraction opt-in (the second, explicit opt-in); writes
  // settings/general.enc + syncs, so every device honors the same choice.
  setServerExtraction: (enabled: boolean) => Promise<void>;
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
  // Retire the first-run link-previews banner on THIS device — device-local, never
  // synced (db.ts). One-way: the Settings extraction section is the durable surface.
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
      setSortOn,
      setSortOrder,
      setThemeSource,
      setSyncTheme,
      setLocalTheme,
      dismissPreviewsPrompt,
    ],
  );
}
