// The forward-compat contract of `settings/general.enc`. These aren't tests of zod;
// they're the reason the schema is shaped the way it is, and they're here because the
// failure they guard against is invisible until it's a user's whole settings file:
// tighten one field (the obvious `z.enum(LINKS_LAYOUTS)` for `linksLayout`, a time
// regex for the theme) and a value written by a NEWER client stops parsing — which,
// because zod fails the object when a field fails, silently drops the user's theme
// and extraction opt-in too, on every client that predates the value.
//
// The rule: no SETTING can fail the parse; the FRAME (an object with LWW timestamps)
// still must, or `classifyBundleLine` (import-all-data.ts) would accept any JSON
// object as a settings blob.

import {
  cleanName,
  coerceDeviceExtractionMode,
  coerceLinkSortOn,
  coerceLinkSortOrder,
  cutToLength,
  DEFAULT_DEVICE_EXTRACTION_MODE,
  DEVICE_EXTRACTION_MODES,
  extractionSchema,
  LINK_SORT_ONS,
  LINK_SORT_ORDERS,
  linkSchema,
  listSchema,
  pinSchema,
  settingsGeneralSchema,
  tagSchema,
} from './entities';

const FRAME = { createdAt: 1, updatedAt: 2 };

describe('settingsGeneralSchema', () => {
  describe('no setting field can fail the parse', () => {
    // The case this whole design exists for: `table` is a real planned layout
    // that this build doesn't implement. It must survive the
    // round trip untouched, so the device that chose it keeps its choice.
    it('round-trips a layout this build does not know', () => {
      const parsed = settingsGeneralSchema.parse({ ...FRAME, linksLayout: 'table' });
      expect(parsed.linksLayout).toBe('table');
    });

    it('round-trips an unknown sibling setting a newer client wrote', () => {
      const parsed = settingsGeneralSchema.parse({ ...FRAME, futureSetting: { on: true } });
      expect(parsed).toMatchObject({ futureSetting: { on: true } });
    });

    it.each([
      ['linksLayout', { linksLayout: 5 }],
      ['serverExtraction', { serverExtraction: 'yes' }],
      ['deviceExtractionMode', { deviceExtractionMode: 5 }],
      ['theme (not an object)', { theme: 'lol' }],
      [
        'every field at once',
        { linksLayout: [], serverExtraction: 1, deviceExtractionMode: [], theme: 3 },
      ],
    ])('degrades a corrupt %s to absent instead of failing', (_name, bad) => {
      const parsed = settingsGeneralSchema.parse({ ...FRAME, ...bad });
      expect(parsed).toEqual(FRAME);
    });

    // The same growth path `linksLayout` has, and the one that matters most: an
    // extraction mode a newer client added must survive untouched here, so this
    // device can't silently rewrite the user's choice to something more permissive
    // on its next settings write. `coerceDeviceExtractionMode` is what keeps the
    // RENDER honest meanwhile (it falls back to `saves`, never up to `all`).
    it('round-trips an extraction mode this build does not know', () => {
      const parsed = settingsGeneralSchema.parse({ ...FRAME, deviceExtractionMode: 'wifi-only' });
      expect(parsed.deviceExtractionMode).toBe('wifi-only');
    });

    // Per-FIELD tolerance inside the theme, not just per-object: a half-written theme
    // keeps the half that's good. `coerceThemeState` turns the '' back into a default.
    it('keeps the good fields of a partial theme', () => {
      const parsed = settingsGeneralSchema.parse({ ...FRAME, theme: { mode: 'dark' } });
      expect(parsed.theme).toEqual({ mode: 'dark', lightStart: '', darkStart: '' });
    });

    it('keeps the good fields of a theme with one corrupt field', () => {
      const parsed = settingsGeneralSchema.parse({
        ...FRAME,
        theme: { mode: 5, lightStart: '06:00', darkStart: '18:00' },
      });
      expect(parsed.theme).toEqual({ mode: '', lightStart: '06:00', darkStart: '18:00' });
    });
  });

  // The other half. Tolerance stops at the frame: these must FAIL, or the import edge
  // loses the only thing telling a settings blob apart from arbitrary JSON.
  describe('the LWW frame is still strict', () => {
    it.each([
      ['missing timestamps', { linksLayout: 'list' }],
      ['non-integer timestamps', { createdAt: 1.5, updatedAt: 2.5 }],
      ['not an object', 'nope'],
      ['null', null],
    ])('rejects %s', (_name, bad) => {
      expect(settingsGeneralSchema.safeParse(bad).success).toBe(false);
    });
  });
});

// The read-edge half of the tolerant parse above. Unlike the other coercers this one
// is a PRIVACY gate, so its fallback has a direction: an absent, unknown, or corrupt
// value must land no higher than `saves`. Falling to `all` would turn a settings blob
// written by a newer client — or a half-written one — into un-gestured network
// activity the user never agreed to.
describe('coerceDeviceExtractionMode', () => {
  it.each(DEVICE_EXTRACTION_MODES)('passes through the known mode %s', (mode) => {
    expect(coerceDeviceExtractionMode(mode)).toBe(mode);
  });

  it.each([undefined, '', 'wifi-only', 'ALL', 'true'])(
    'falls back to the default for %p — never up to `all`',
    (value) => {
      expect(coerceDeviceExtractionMode(value)).toBe('saves');
    },
  );

  it('defaults to `saves`, the position that matches the old boolean-off behavior', () => {
    expect(DEFAULT_DEVICE_EXTRACTION_MODE).toBe('saves');
  });
});

// The file-wide rule the settings suite above tests one schema of: EVERY entity
// is a `looseObject`, so an unknown field written by a newer client survives an
// older client parsing, editing and re-uploading the same file.
//
// Asserted per schema rather than trusted, because the failure is silent and
// permanent. Nothing here would throw: `z.object` — zod's own default, and what
// anyone tightening a schema would reach for — strips unknown keys quietly, so an
// old client's next edit to a link RE-UPLOADS it without the newer client's data
// and the sync layer treats that as an ordinary write. The user loses whatever
// the new field held, on a device that never showed it to them, with no error on
// either device.
describe('unknown fields round-trip through every entity schema', () => {
  const cases = [
    [
      'link',
      linkSchema,
      { url: 'https://example.com', listId: 'my-list', tagIds: [], createdAt: 1, updatedAt: 2 },
    ],
    [
      'list',
      listSchema,
      { id: 'a', name: 'Work', parentId: null, rank: 'a0', createdAt: 1, updatedAt: 2 },
    ],
    [
      'tag',
      tagSchema,
      { id: 'a', name: 'recipes', parentId: null, rank: 'a0', createdAt: 1, updatedAt: 2 },
    ],
    ['pin', pinSchema, { id: 'a', rank: 'a0', createdAt: 1, updatedAt: 2 }],
    ['extraction', extractionSchema, { id: 'a', facets: {}, createdAt: 1, updatedAt: 2 }],
  ] as const;

  it.each(cases)('%s keeps a field this build has never heard of', (_name, schema, base) => {
    const parsed = schema.parse({ ...base, futureField: { nested: ['value'] } });
    expect(parsed).toMatchObject({ futureField: { nested: ['value'] } });
  });

  it('keeps unknown fields inside a facet too', () => {
    // The nested case, and the live one: a tier attaches its own field to the
    // facet it writes (the extension's read-mode fileId). A strict facetSchema
    // would strip it on every other client's next extraction write.
    const parsed = extractionSchema.parse({
      id: 'a',
      facets: { titleImage: { status: 'done', attempts: 0, fileId: 'f1' } },
      createdAt: 1,
      updatedAt: 2,
    });
    expect(parsed.facets.titleImage).toMatchObject({ fileId: 'f1' });
  });

  // The other half, and the same shape as the settings frame above: tolerance is
  // about UNKNOWN fields, not absent KNOWN ones. `classifyBundleLine`
  // (shared/data/backup.ts) picks the schema by path prefix and then uses the
  // parse as its only gate, so a truncated or half-written line under a valid
  // path is admitted as a real entity the moment a required field stops being
  // required — and it lands in the store, not in an error.
  describe.each(cases)('%s rejects a blob missing a required field', (_name, schema, base) => {
    it.each(Object.keys(base))('without %s', (field) => {
      const missing: Record<string, unknown> = { ...base };
      delete missing[field];
      expect(schema.safeParse(missing).success).toBe(false);
    });
  });

  it('requires parentId to be an EXPLICIT null, not merely absent', () => {
    // "Top-level" has to be a value rather than an absence: two devices editing
    // the same list concurrently must not be able to disagree about whether an
    // omitted parent means root or means "unchanged".
    const list = { id: 'a', name: 'Work', rank: 'a0', createdAt: 1, updatedAt: 2 };
    expect(listSchema.safeParse({ ...list, parentId: null }).success).toBe(true);
    expect(listSchema.safeParse({ ...list, parentId: undefined }).success).toBe(false);
  });
});

// The read-edge narrowing for the two sort axes. Both persist as free strings so
// a value a newer client stores round-trips (the rule above); these are what keep
// the RENDER honest meanwhile. Without them an unknown value indexes the read
// layer's sort tables to `undefined` and crashes the query.
describe('coerceLinkSortOn / coerceLinkSortOrder', () => {
  it.each(LINK_SORT_ONS)('passes through the known sort field %s', (value) => {
    expect(coerceLinkSortOn(value)).toBe(value);
  });

  it.each(LINK_SORT_ORDERS)('passes through the known direction %s', (value) => {
    expect(coerceLinkSortOrder(value)).toBe(value);
  });

  it.each([undefined, '', 'title', 'updatedat', 'UPDATEDAT'])(
    'falls back to newest-modified-first for %p',
    (value) => {
      // The pair has to agree with `emptyQuery` (link-query.ts), which is what a
      // view without an explicit sort renders — otherwise a URL with no `?sort`
      // and a settings blob with an unknown one order differently.
      expect(coerceLinkSortOn(value)).toBe('updatedAt');
      expect(coerceLinkSortOrder(value)).toBe('desc');
    },
  );
});

describe('cutToLength', () => {
  // Every cap counts UTF-16 code units, and an emoji is two of them. A cut that
  // lands between the halves used to store the first half alone — a lone
  // surrogate, `�` on every device the value synced to.
  it('leaves a value at or under the cap alone', () => {
    expect(cutToLength('abc', 3)).toBe('abc');
    expect(cutToLength('', 3)).toBe('');
  });

  it('cuts at the cap when the cut falls between characters', () => {
    expect(cutToLength('abcdef', 4)).toBe('abcd');
    expect(cutToLength('ab😀cd', 4)).toBe('ab😀');
  });

  it('drops a surrogate pair the cut would split, staying under the cap', () => {
    // 'ab' + 😀 is 4 units; a cap of 3 lands between 😀's halves.
    const cut = cutToLength('ab😀cd', 3);
    expect(cut).toBe('ab');
    expect(cut).not.toMatch(/[\uD800-\uDBFF]$/);
  });

  it('is what cleanName cuts with', () => {
    expect(cleanName('  ab😀cd  ', 3)).toBe('ab');
  });
});
