// Read/write helpers over the device-local settings row — the expo sibling of
// web-react's data/local-settings-store.ts (see there for why these settings
// stay on THIS device: never an `items` blob, never a pending op, never R2).
// The sole owner of the table's single-row JSON shape (LocalSettingsValue in
// db.ts), so callers don't repeat the constant key or the read-merge-write.
// Deliberately tiny and side-effect-light — no network, no React (the hooks
// layer adds reactivity via useLiveQuery and the defaults).

import { eq } from 'drizzle-orm';

import {
  DEFAULT_THEME,
  type LayoutOptionsPatch,
  layoutOptionsSchema,
  mergeLayoutOptions,
  type StoredLayoutOptions,
} from '@stxapps/shared';

import { getDb, localSettings, type LocalSettingsValue } from './db';

// The constant primary key — one settings bag per device (db.ts).
export const LOCAL_SETTINGS_ID = 'singleton' as const;

// The stored bag, or undefined if this device hasn't written one yet. Callers
// (the use-settings port) supply the field defaults and coerce the untrusted
// stored shape (db.ts LocalSettingsValue) — this layer stays shape-only.
export async function getLocalSettings(): Promise<LocalSettingsValue | undefined> {
  const row = getDb()
    .select()
    .from(localSettings)
    .where(eq(localSettings.id, LOCAL_SETTINGS_ID))
    .get();
  return row?.value;
}

// Merge a partial update into the device-local settings bag, creating it on
// first write. Read-merge-write in one transaction so a partial patch keeps the
// other fields, and a missing row still produces a complete value — the
// defaults here mirror the read side's (`sync` sources, `list` layout,
// DEFAULT_THEME), so a first write of one field doesn't silently pin the others
// to a surprising value.
export async function setLocalSettings(
  patch:
    | Partial<LocalSettingsValue>
    | ((existing: LocalSettingsValue | undefined) => Partial<LocalSettingsValue>),
): Promise<void> {
  getDb().transaction((tx) => {
    const existing = tx
      .select()
      .from(localSettings)
      .where(eq(localSettings.id, LOCAL_SETTINGS_ID))
      .get()?.value;
    const fields = typeof patch === 'function' ? patch(existing) : patch;
    const value: LocalSettingsValue = {
      linksLayoutSource: existing?.linksLayoutSource ?? 'sync',
      linksLayout: existing?.linksLayout ?? 'list',
      themeSource: existing?.themeSource ?? 'sync',
      theme: existing?.theme ?? DEFAULT_THEME,
      previewsPromptDismissed: existing?.previewsPromptDismissed ?? false,
      ...(existing?.sortOn !== undefined ? { sortOn: existing.sortOn } : {}),
      ...(existing?.sortOrder !== undefined ? { sortOrder: existing.sortOrder } : {}),
      ...(existing?.layoutOptions !== undefined ? { layoutOptions: existing.layoutOptions } : {}),
      ...fields,
    };
    tx.insert(localSettings)
      .values({ id: LOCAL_SETTINGS_ID, value })
      .onConflictDoUpdate({ target: localSettings.id, set: { value } })
      .run();
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
