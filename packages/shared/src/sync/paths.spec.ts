import { syncPathSchema } from './endpoints';
import * as paths from './paths';
import {
  ENC_SUFFIX,
  EXTRACTIONS_PREFIX,
  ID_KEYED_PREFIXES,
  LINKS_PREFIX,
  PINS_PREFIX,
  rekey,
  SETTINGS_PREFIX,
} from './paths';

// Backstop for the easy-to-forget case (see paths.ts ID_KEYED_PREFIXES): add a
// `*_PREFIX` const but forget to wire it into validation, and this fails at test
// time instead of every client 400ing on the new namespace at runtime.
describe('syncPathSchema covers the whole path contract', () => {
  // Reflect over EVERY exported `*_PREFIX` — the trigger you can't forget is adding
  // the const itself — and assert each names an accepted sync path. 'general' is
  // lowercase alphanumerics, so one sample satisfies both the random-id charset
  // (id-keyed prefixes) and the lowercase concern charset (settings/).
  const allPrefixes = Object.entries(paths)
    .filter(([k, v]) => k.endsWith('_PREFIX') && typeof v === 'string')
    .map(([, v]) => v as string);

  it.each(allPrefixes)('accepts a path under the %s namespace', (prefix) => {
    expect(syncPathSchema.safeParse(`${prefix}general${ENC_SUFFIX}`).success).toBe(true);
  });

  it('accepts the id-keyed and settings shapes explicitly', () => {
    for (const prefix of ID_KEYED_PREFIXES) {
      expect(syncPathSchema.safeParse(`${prefix}aZ09_-${ENC_SUFFIX}`).success).toBe(true);
    }
    expect(syncPathSchema.safeParse(`${SETTINGS_PREFIX}general${ENC_SUFFIX}`).success).toBe(true);
  });

  it('rejects traversal, unknown namespaces, and wrong suffixes', () => {
    const bad = [
      '../links/x.enc', // traversal out of the user root
      'links/../files/x.enc', // embedded traversal
      'links/x.txt', // wrong suffix
      'links/.enc', // empty id segment
      'unknown/x.enc', // namespace not in the contract
      'settings/General.enc', // concern must be lowercase
      'links/x.enc/y.enc', // smuggled second segment
    ];
    for (const path of bad) {
      expect(syncPathSchema.safeParse(path).success).toBe(false);
    }
  });
});

describe('rekey maps a path to its co-keyed shadow', () => {
  it('swaps the prefix while preserving the {id}', () => {
    expect(rekey('links/abc.enc', LINKS_PREFIX, EXTRACTIONS_PREFIX)).toBe('extractions/abc.enc');
    expect(rekey('links/abc.enc', LINKS_PREFIX, PINS_PREFIX)).toBe('pins/abc.enc');
  });

  it('round-trips back to the original path', () => {
    const original = 'links/aZ09_-.enc';
    const shadow = rekey(original, LINKS_PREFIX, EXTRACTIONS_PREFIX);
    expect(rekey(shadow, EXTRACTIONS_PREFIX, LINKS_PREFIX)).toBe(original);
  });
});
