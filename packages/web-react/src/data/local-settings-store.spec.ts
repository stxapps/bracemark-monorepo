// Specs for the device-local settings row. One rule, and it is the reason this store is
// a read-merge-`put` rather than a bare `update`: a PARTIAL patch must keep every field
// it didn't name, and a FIRST write must produce a complete record whose unnamed fields
// take the same defaults the read side (use-settings.ts) applies.
//
// The failure is quiet and user-visible only much later: write one field on a device
// that has never written this row, and every other field is pinned to whatever the put
// happened to contain — a user who flips the theme source first would find their layout
// silently frozen to a value they never chose, with no error and nothing to notice it by
// until they wonder why the synced layout stopped arriving.
//
// The defaults are asserted against the SHARED constants they mirror rather than
// restated, so a change to DEFAULT_THEME moves this spec with it.

import { DEFAULT_THEME } from '@stxapps/shared';

import { db } from './db';
import {
  getLocalSettings,
  LOCAL_SETTINGS_ID,
  patchLocalLayoutOptions,
  setLocalSettings,
} from './local-settings-store';

beforeEach(async () => {
  await db.localSettings.clear();
});

describe('getLocalSettings', () => {
  // The hooks layer supplies the read defaults; this layer stays shape-only, so a device
  // that has never written must report exactly that rather than a synthesized row.
  it('is undefined before this device has written anything', async () => {
    expect(await getLocalSettings()).toBeUndefined();
  });
});

describe('setLocalSettings', () => {
  // "sync" sources, "list" layout, DEFAULT_THEME, prompt not dismissed — the same
  // defaults use-settings.ts reads with, so a first write of one field can't silently
  // opt this device out of the synced values.
  it('fills the unnamed fields with the read side’s defaults on a first write', async () => {
    await setLocalSettings({ previewsPromptDismissed: true });

    expect(await getLocalSettings()).toEqual({
      id: LOCAL_SETTINGS_ID,
      linksLayoutSource: 'sync',
      linksLayout: 'list',
      themeSource: 'sync',
      theme: DEFAULT_THEME,
      previewsPromptDismissed: true,
    });
  });

  // A `put` that took only the patch would drop the other fields here — the read-merge
  // is what makes a one-field write safe.
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

  // One row per device, keyed by the constant — a second write must never accumulate.
  it('keeps the table to a single row however many writes land', async () => {
    await setLocalSettings({ linksLayout: 'card' });
    await setLocalSettings({ themeSource: 'local' });

    expect(await db.localSettings.count()).toBe(1);
  });
});

// The rest of the layout pack on the Device source. A row from before the pack has no
// sort and no options; the pack fields are optional and must SURVIVE every other write
// (the put rebuilds the record field by field, so a field it doesn't carry forward is a
// field the next theme flip deletes).
describe('the pack fields', () => {
  it('keeps the device sort and options across an unrelated write', async () => {
    await setLocalSettings({ sortOn: 'createdAt', layoutOptions: { card: { titleLines: 3 } } });
    await setLocalSettings({ themeSource: 'local' });

    expect(await getLocalSettings()).toMatchObject({
      sortOn: 'createdAt',
      layoutOptions: { card: { titleLines: 3 } },
    });
  });

  // The first device edit of an option starts from the SYNCED options this device was
  // showing, so it changes one option rather than resetting the rest to defaults.
  it('seeds the first options write from the synced options', async () => {
    await patchLocalLayoutOptions(
      { card: { size: 'small' } },
      { card: { titleLines: 3, fields: { tags: false } }, list: { titleLines: 1 } },
    );

    expect((await getLocalSettings())?.layoutOptions).toEqual({
      card: { titleLines: 3, size: 'small', fields: { tags: false } },
      list: { titleLines: 1 },
    });
  });

  it('patches its own options once it has them, ignoring the seed', async () => {
    await setLocalSettings({ layoutOptions: { card: { titleLines: 1, future: 'x' } } });

    await patchLocalLayoutOptions({ card: { tagLines: 2 } }, { card: { titleLines: 3 } });

    expect((await getLocalSettings())?.layoutOptions).toEqual({
      card: { titleLines: 1, future: 'x', tagLines: 2 },
    });
  });
});
