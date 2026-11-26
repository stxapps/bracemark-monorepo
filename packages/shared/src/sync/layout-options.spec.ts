// The contract of `settings/layout.enc` and the pack it carries. The failures these
// guard against are silent: a too-strict schema drops a user's whole layout file
// the day a newer client writes a value this build doesn't know; a writer that
// rebuilds the options from the coerced view deletes the ids a newer client added;
// and a read that forgets the `general.enc` fallback resets every existing user's
// layout and sort the day the move ships (docs/link-layouts.md).

import { layoutOptionsSchema, settingsLayoutSchema } from './entities';
import {
  coerceLayoutOptions,
  coerceTableOptions,
  DEFAULT_CARD_OPTIONS,
  DEFAULT_LAYOUT_OPTIONS,
  DEFAULT_LIST_OPTIONS,
  DEFAULT_TABLE_COLUMNS,
  fitTableColumns,
  localLayoutPack,
  mergeLayoutOptions,
  syncLayoutPack,
  TABLE_COLUMNS,
  TABLE_TITLE_MIN_WIDTH,
} from './layout-options';

const FRAME = { createdAt: 1, updatedAt: 2 };

describe('settingsLayoutSchema', () => {
  it('no option of any shape fails the parse', () => {
    const parsed = settingsLayoutSchema.parse({
      ...FRAME,
      linksLayout: 42,
      card: { titleLines: 'two', size: ['l'], fields: { image: 'yes', address: 7 } },
      list: 'not an object',
      table: { columns: 'nope' },
    });
    expect(parsed.linksLayout).toBeUndefined();
    expect(parsed.card?.titleLines).toBeUndefined();
    expect(parsed.card?.fields?.image).toBeUndefined();
    expect(parsed.list).toBeUndefined();
    expect(parsed.table?.columns).toBeUndefined();
  });

  it('round-trips options, fields and layouts this build does not know', () => {
    const parsed = settingsLayoutSchema.parse({
      ...FRAME,
      linksLayout: 'timeline',
      card: { titleLines: 3, density: 'tight', fields: { image: false, rating: true } },
      timeline: { zoom: 2 },
    });
    expect(parsed).toMatchObject({
      linksLayout: 'timeline',
      card: { titleLines: 3, density: 'tight', fields: { image: false, rating: true } },
      timeline: { zoom: 2 },
    });
  });

  it('still refuses an object without the LWW frame', () => {
    expect(settingsLayoutSchema.safeParse({ linksLayout: 'card' }).success).toBe(false);
  });
});

describe('coerceLayoutOptions', () => {
  // The defaults ARE the look from before the options existed — so an absent file
  // must render exactly as the app always did.
  it('an absent file gives the defaults', () => {
    expect(coerceLayoutOptions(undefined)).toEqual(DEFAULT_LAYOUT_OPTIONS);
    expect(coerceLayoutOptions({})).toEqual(DEFAULT_LAYOUT_OPTIONS);
  });

  it('the defaults match the layouts before the options', () => {
    expect(DEFAULT_CARD_OPTIONS).toMatchObject({
      titleLines: 2,
      tagLines: 1,
      size: 'medium',
      imageHeight: 'tall',
      fields: { image: true, address: 'host', tags: true, date: 'none', note: true },
    });
    expect(DEFAULT_LIST_OPTIONS.fields).toMatchObject({ date: 'sorted', listName: false });
  });

  it('bad values fall back per option, keeping the good ones', () => {
    const options = coerceLayoutOptions({
      card: { titleLines: 7, tagLines: 3, size: 'huge', fields: { address: 'url', date: 'x' } },
      list: { titleLines: 1 },
    });
    expect(options.card.titleLines).toBe(2);
    expect(options.card.tagLines).toBe(3);
    expect(options.card.size).toBe('medium');
    expect(options.card.fields.address).toBe('url');
    expect(options.card.fields.date).toBe('none');
    expect(options.list.titleLines).toBe(1);
    expect(options.list.fields).toEqual(DEFAULT_LIST_OPTIONS.fields);
  });

  it('each layout keeps its own values', () => {
    const options = coerceLayoutOptions({ card: { titleLines: 3 } });
    expect(options.card.titleLines).toBe(3);
    expect(options.list.titleLines).toBe(2);
  });
});

describe('mergeLayoutOptions', () => {
  it('keeps what the patch does not name, unknown ids included', () => {
    const stored = layoutOptionsSchema.parse({
      card: { titleLines: 3, density: 'tight', fields: { tags: false, rating: true } },
      list: { titleLines: 1 },
      timeline: { zoom: 2 },
    });
    const next = mergeLayoutOptions(stored, { card: { size: 'small', fields: { image: false } } });
    expect(next).toEqual({
      card: {
        titleLines: 3,
        density: 'tight',
        size: 'small',
        fields: { tags: false, rating: true, image: false },
      },
      list: { titleLines: 1 },
      timeline: { zoom: 2 },
    });
  });

  it('creates a layout object that was absent', () => {
    expect(mergeLayoutOptions({}, { list: { fields: { date: 'none' } } })).toEqual({
      list: { fields: { date: 'none' } },
    });
  });
});

describe('syncLayoutPack', () => {
  const general = { ...FRAME, linksLayout: 'card', sortOn: 'createdAt', sortOrder: 'asc' };

  // The move: before `layout.enc` exists, every user's layout and sort are in
  // `general.enc`, and they must not reset.
  it('falls back to general.enc for the pack fields', () => {
    const pack = syncLayoutPack(undefined, general);
    expect(pack).toMatchObject({ linksLayout: 'card', sortOn: 'createdAt', sortOrder: 'asc' });
    expect(pack.options).toEqual(DEFAULT_LAYOUT_OPTIONS);
  });

  it('prefers layout.enc, field by field', () => {
    const pack = syncLayoutPack({ ...FRAME, sortOn: 'updatedAt' }, general);
    expect(pack).toMatchObject({ linksLayout: 'card', sortOn: 'updatedAt', sortOrder: 'asc' });
  });

  it('defaults with neither file', () => {
    expect(syncLayoutPack(undefined, undefined)).toMatchObject({
      linksLayout: 'list',
      sortOn: 'updatedAt',
      sortOrder: 'desc',
    });
  });

  it('passes an unknown layout through intact', () => {
    expect(syncLayoutPack({ ...FRAME, linksLayout: 'timeline' }, undefined).linksLayout).toBe(
      'timeline',
    );
  });
});

describe('localLayoutPack', () => {
  const sync = syncLayoutPack(
    { ...FRAME, linksLayout: 'card', sortOn: 'createdAt', card: { titleLines: 3 } },
    undefined,
  );

  // A user already on Device has a device layout and nothing else: the sort and
  // the options keep showing what they showed before the upgrade (the synced ones).
  it('a row from before the pack falls back to the synced sort and options', () => {
    const pack = localLayoutPack({ linksLayout: 'list' }, sync);
    expect(pack).toMatchObject({ linksLayout: 'list', sortOn: 'createdAt', sortOrder: 'desc' });
    expect(pack.options.card.titleLines).toBe(3);
    expect(pack.storedOptions).toEqual(sync.storedOptions);
  });

  it('keeps the old layout rule: an absent device layout is list', () => {
    expect(localLayoutPack(undefined, sync).linksLayout).toBe('list');
  });

  it('uses its own values once written', () => {
    const pack = localLayoutPack(
      { sortOn: 'updatedAt', sortOrder: 'asc', layoutOptions: { card: { titleLines: 1 } } },
      sync,
    );
    expect(pack).toMatchObject({ sortOn: 'updatedAt', sortOrder: 'asc' });
    expect(pack.options.card.titleLines).toBe(1);
  });

  it('a corrupt device value falls back to the synced options', () => {
    expect(localLayoutPack({ layoutOptions: 'garbage' }, sync).options.card.titleLines).toBe(3);
  });
});

describe('the table', () => {
  it('defaults its columns, and keeps only known ids in order', () => {
    expect(coerceTableOptions(undefined).columns).toEqual([...DEFAULT_TABLE_COLUMNS]);
    expect(
      coerceTableOptions({ columns: [{ id: 'tags' }, { id: 'rating' }, 'junk', { id: 'host' }] })
        .columns,
    ).toEqual(['tags', 'host']);
    // An empty choice is a choice: the title alone.
    expect(coerceTableOptions({ columns: [] }).columns).toEqual([]);
  });

  // The no-sideways-scroll rule: what doesn't fit drops, lowest priority first, and
  // what stays keeps the user's order.
  it('drops the lowest-priority columns until the rest fit beside the title', () => {
    const chosen = ['url', 'host', 'keptCopy', 'updatedAt'] as const;
    const all = chosen.reduce((sum, id) => sum + TABLE_COLUMNS[id].width, 0);
    expect(fitTableColumns(chosen, TABLE_TITLE_MIN_WIDTH + all)).toEqual({
      shown: [...chosen],
      hidden: [],
    });
    const fit = fitTableColumns(chosen, TABLE_TITLE_MIN_WIDTH + all - 1);
    expect(fit.hidden).toEqual(['keptCopy']);
    expect(fit.shown).toEqual(['url', 'host', 'updatedAt']);
    expect(fitTableColumns(chosen, 0).shown).toEqual([]);
  });

  it('writes a new column order but keeps a column this build does not know', () => {
    const next = mergeLayoutOptions(
      { table: { columns: [{ id: 'host', width: 222 }, { id: 'rating' }] } },
      { table: { columns: ['tags', 'host'] } },
    );
    expect(next.table?.columns).toEqual([
      { id: 'tags' },
      { id: 'host', width: 222 },
      { id: 'rating' },
    ]);
  });
});
