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
  coerceDeviceExtractionMode,
  DEFAULT_DEVICE_EXTRACTION_MODE,
  DEVICE_EXTRACTION_MODES,
  settingsGeneralSchema,
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
