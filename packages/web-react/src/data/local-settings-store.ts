'use client';

// Read/write helpers over the device-local settings row (see LocalSettingsRecord
// in db.ts) — the off-sync counterpart to sync-store.ts. These settings stay on
// THIS device: they never become an `items` blob, never enqueue a pending op, and
// never reach R2. The sole owner of the table's single-row shape, so callers don't
// repeat the constant key or the read-merge-write. Deliberately tiny and
// side-effect-light — no network, no React (the hooks layer adds reactivity via
// useLiveQuery and the defaults).

import {
  DEFAULT_THEME,
  type LayoutOptionsPatch,
  layoutOptionsSchema,
  mergeLayoutOptions,
  type StoredLayoutOptions,
} from '@stxapps/shared';

import { db, type LocalSettingsRecord } from './db';

// The constant primary key — one settings blob per device (db.ts).
export const LOCAL_SETTINGS_ID = 'singleton' as const;

// The stored row, or undefined if this device hasn't written one yet. Callers
// (use-settings.ts) supply the field defaults — this layer stays shape-only.
export function getLocalSettings(): Promise<LocalSettingsRecord | undefined> {
  return db.localSettings.get(LOCAL_SETTINGS_ID);
}

// Merge a partial update into the device-local settings row, creating it on first
// write. Read-merge-`put` (not a bare `update`) so a partial patch keeps the other
// field, and a missing row still produces a complete record — the column defaults
// here mirror use-settings.ts's read defaults (`sync` sources, `list` layout,
// `DEFAULT_THEME`), so a first write of one field doesn't silently pin the others to
// a surprising value.
export async function setLocalSettings(
  patch:
    | Partial<Omit<LocalSettingsRecord, 'id'>>
    | ((existing: LocalSettingsRecord | undefined) => Partial<Omit<LocalSettingsRecord, 'id'>>),
): Promise<void> {
  await db.transaction('rw', db.localSettings, async () => {
    const existing = await db.localSettings.get(LOCAL_SETTINGS_ID);
    const fields = typeof patch === 'function' ? patch(existing) : patch;
    await db.localSettings.put({
      id: LOCAL_SETTINGS_ID,
      linksLayoutSource: existing?.linksLayoutSource ?? 'sync',
      linksLayout: existing?.linksLayout ?? 'list',
      themeSource: existing?.themeSource ?? 'sync',
      theme: existing?.theme ?? DEFAULT_THEME,
      previewsPromptDismissed: existing?.previewsPromptDismissed ?? false,
      ...(existing?.sortOn !== undefined ? { sortOn: existing.sortOn } : {}),
      ...(existing?.sortOrder !== undefined ? { sortOrder: existing.sortOrder } : {}),
      ...(existing?.layoutOptions !== undefined ? { layoutOptions: existing.layoutOptions } : {}),
      ...fields,
    });
  });
}

// Patch this device's layout options (the Device source of the pack), inside the
// same read-merge-write as setLocalSettings. A row with no options yet starts from
// `seed` — the SYNCED options this device was showing until now — so the first
// device edit changes one option instead of resetting the rest to defaults. The
// stored value is untrusted (another build may have written it), so a corrupt one
// also starts from the seed. Unknown ids are kept (mergeLayoutOptions).
export function patchLocalLayoutOptions(
  patch: LayoutOptionsPatch,
  seed: StoredLayoutOptions,
): Promise<void> {
  return setLocalSettings((existing) => {
    const stored =
      existing?.layoutOptions === undefined
        ? undefined
        : layoutOptionsSchema.safeParse(existing.layoutOptions).data;
    return { layoutOptions: mergeLayoutOptions(stored ?? seed, patch) };
  });
}
