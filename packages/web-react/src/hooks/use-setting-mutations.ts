'use client';

// Edit operations for app settings — the write side of use-settings.ts. The setters
// mirror the read hook's values, and each routes to the right store:
//
//   - setLinksLayoutSource / setLocalLinksLayout / setLocalSort / setLocalLayoutOptions
//     / setThemeSource / setLocalTheme / dismissPreviewsPrompt → the DEVICE-LOCAL
//     `localSettings` store (no account, no sync — see local-settings-store.ts);
//   - setSyncLinksLayout / setSyncSort / setSyncLayoutOptions → the SYNCED
//     `settings/layout.enc` blob via writeSettingsLayout (the layout pack), then a
//     sync kick;
//   - setServerExtraction / setServerReadMode / setKeepOnSave / setSyncTheme → the
//     SYNCED `settings/general.enc` blob via writeSettingsGeneral, then a sync kick,
//     exactly like useListMutations writes a list and requests sync;
//   - setLinksLayout / setSort / setLayoutOptions → whichever pack source is ACTIVE on
//     this device right now, for the surfaces that edit "what I'm looking at" rather
//     than a named source (the View options popover, a table header's sort).
//
// Keeping the source choice + device pack off-sync is deliberate: "use this
// device's own layout" is a per-device decision that must not propagate (db.ts).

import { useCallback, useMemo } from 'react';

import {
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
  // The links layout on whichever pack source is active right now.
  setLinksLayout: (layout: LinksLayout) => Promise<void>;
  // The sort, per source and on the active one — part of the pack, so it follows
  // `linksLayoutSource` like the layout.
  setSyncSort: (patch: SortPatch) => Promise<void>;
  setLocalSort: (patch: SortPatch) => Promise<void>;
  setSort: (patch: SortPatch) => Promise<void>;
  // Every layout's display options, per source and on the active one. The first
  // device write seeds from the synced options (patchLocalLayoutOptions).
  setSyncLayoutOptions: (patch: LayoutOptionsPatch) => Promise<void>;
  setLocalLayoutOptions: (patch: LayoutOptionsPatch) => Promise<void>;
  setLayoutOptions: (patch: LayoutOptionsPatch) => Promise<void>;
  // Toggle the SYNCED server-extraction opt-in (the second, explicit opt-in); writes
  // settings/general.enc + syncs, so every device honors the same choice.
  setServerExtraction: (enabled: boolean) => Promise<void>;
  // Toggle the SYNCED server-read-mode opt-in — its own consent, separate from
  // server extraction (entities.ts); writes settings/general.enc + syncs.
  setServerReadMode: (enabled: boolean) => Promise<void>;
  // The synced kept-copies save setting — either half, or both.
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
  // Retire the first-run link-previews banner on THIS device — device-local, never
  // synced (db.ts). One-way: Settings → Link previews is the durable surface.
  dismissPreviewsPrompt: () => Promise<void>;
}

export interface SortPatch {
  sortOn?: LinkSortOn;
  sortOrder?: LinkSortOrder;
}

// Read at CALL time, not from a render's snapshot: a source switch and an edit can
// land in the same tick, and the edit must go where the switch just pointed.
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

  const setServerReadMode = useCallback(
    async (enabled: boolean) => {
      if (!username) throw new Error('useSettingMutations: no active account');
      await writeSettingsGeneral(username, { serverReadMode: enabled });
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
      setServerReadMode,
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
      setServerReadMode,
      setKeepOnSave,
      setThemeSource,
      setSyncTheme,
      setLocalTheme,
      dismissPreviewsPrompt,
    ],
  );
}
