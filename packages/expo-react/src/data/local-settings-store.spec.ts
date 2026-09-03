// A drift guard for the expo device-settings bag. Same single rule as web's sibling — a
// PARTIAL patch keeps every field it didn't name, and a FIRST write produces a complete
// value whose unnamed fields take the read side's defaults — but a different mechanism:
// web merges into a Dexie row inside a `db.transaction`, this merges into a single JSON
// column inside drizzle's synchronous transaction callback with an `onConflictDoUpdate`.
// A spec passing on web's copy proves nothing about this one.
//
// The failure is quiet and only visible much later: write one field on a device that has
// never written this row, and every other field is pinned to whatever the write happened
// to contain — a user who flips the theme source first finds their layout silently frozen
// to a value they never chose. And on this side there is a second way to get it wrong that
// web doesn't have: the whole bag is ONE column, so an insert that doesn't merge doesn't
// leave the other fields alone, it replaces them.
//
// Real sqlite through the node:sqlite shim, so the upsert under test is the real
// statement. The defaults are asserted against the shared constants they mirror.

import { sql } from 'drizzle-orm';

import { DEFAULT_THEME } from '@stxapps/shared';

import { getDb, localSettings } from './db';
import { getLocalSettings, setLocalSettings } from './local-settings-store';

jest.mock('expo-sqlite', () => require('../testing/node-sqlite'));

beforeEach(() => {
  getDb().run(sql`DELETE FROM local_settings`);
});

describe('getLocalSettings', () => {
  // The read side supplies the field defaults and coerces the untrusted stored shape; this
  // layer stays shape-only, so a device that has never written must report exactly that.
  it('is undefined before this device has written anything', async () => {
    expect(await getLocalSettings()).toBeUndefined();
  });
});

describe('setLocalSettings', () => {
  it('fills the unnamed fields with the read side’s defaults on a first write', async () => {
    await setLocalSettings({ previewsPromptDismissed: true });

    expect(await getLocalSettings()).toEqual({
      linksLayoutSource: 'sync',
      linksLayout: 'list',
      themeSource: 'sync',
      theme: DEFAULT_THEME,
      previewsPromptDismissed: true,
    });
  });

  // The whole bag is one JSON column here, so a write that didn't read-merge would REPLACE
  // the other fields rather than leave them untouched — the same symptom as web's bare
  // `update`, arrived at by a different route.
  it('keeps fields the patch did not name', async () => {
    await setLocalSettings({ linksLayoutSource: 'local', linksLayout: 'card' });
    await setLocalSettings({ themeSource: 'local' });

    expect(await getLocalSettings()).toMatchObject({
      linksLayoutSource: 'local',
      linksLayout: 'card',
      themeSource: 'local',
    });
  });

  it('overwrites the fields the patch does name', async () => {
    await setLocalSettings({ linksLayout: 'card' });
    await setLocalSettings({ linksLayout: 'list' });

    expect((await getLocalSettings())?.linksLayout).toBe('list');
  });

  // One row per device, keyed by the constant — the conflict target has to hold, or a
  // second write inserts a second row and the read picks one of them arbitrarily.
  it('keeps the table to a single row however many writes land', async () => {
    await setLocalSettings({ linksLayout: 'card' });
    await setLocalSettings({ themeSource: 'local' });
    await setLocalSettings({ previewsPromptDismissed: true });

    expect(getDb().select().from(localSettings).all()).toHaveLength(1);
  });
});
