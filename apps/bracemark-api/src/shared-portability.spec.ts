// Does @stxapps/shared actually RUN on workerd?
//
// `shared` is platform:agnostic: one compilation, three engines (browsers,
// workerd here, Hermes in bracemark-expo). Its portability rests on two static
// guards — the `webworker` ambient surface in packages/shared/tsconfig.lib.json
// and the deny list in tools/eslint/agnostic-globals.mjs (docs/architecture.md,
// _the globals a `platform:agnostic` package may assume_). Both reason about
// what the source *says*. This file is the only place in the workspace where
// that source is executed by a non-Node engine at test time, because
// bracemark-api's suite runs INSIDE workerd via @cloudflare/vitest-pool-workers
// (see vitest.config.ts). It lives in this app for that reason alone — it tests
// the dependency, not the api.
//
// It exists because the create-account crash on Hermes passed every other check:
// `crypto.getRandomValues` typechecked, and jest ran it on node, where `crypto`
// exists. A missing global is only a fact about an engine.
//
// The Hermes half of this contract has no equivalent — jest-expo runs on node,
// not Hermes — so it is enforced at runtime instead, by the __DEV__ audit in
// apps/bracemark-expo/src/polyfills.ts that every launch (and so every maestro
// run) executes. See docs/testing.md, _the portability suites_.
import { describe, expect, it } from 'vitest';

import {
  base64ToBytes,
  bytesToBase64,
  bytesToUtf8,
  canonicalUrlKey,
  generatePassphrase,
  generateRecoveryCode,
  isSvgBytes,
  normalizeUrl,
  PASSPHRASE_DEFAULT_WORDS,
  utf8,
} from '@stxapps/shared';

// The globals `shared` is allowed to assume, as workerd provides them. Keep this
// list in step with the __DEV__ audit in apps/bracemark-expo/src/polyfills.ts:
// together they are the same contract checked on the two engines we can't take
// for granted. (`atob`/`btoa` need no polyfill here — workerd has them; on Hermes
// they're ours.)
const CONTRACT = [
  'atob',
  'btoa',
  'TextEncoder',
  'TextDecoder',
  'URL',
  'URLSearchParams',
  'structuredClone',
  'fetch',
  'Response',
  'AbortController',
  'setTimeout',
  'queueMicrotask',
];

describe('@stxapps/shared on workerd', () => {
  // Note what the imports at the top of this file have already proven by the
  // time any test below runs: every module in the barrel evaluated without
  // throwing. That is not a formality — @noble/hashes reads `globalThis.crypto`
  // ONCE at module init and captures the result, so a module-scope global reach
  // fails at import, not at call. Importing the barrel covers all of `shared`.
  it('imports its whole surface without touching a global that workerd lacks', () => {
    expect(typeof generatePassphrase).toBe('function');
  });

  it.each(CONTRACT)('provides %s', (name) => {
    expect(typeof (globalThis as Record<string, unknown>)[name]).not.toBe('undefined');
  });

  // Checked by member, not by name: bracemark-expo's shim is deliberately partial
  // (no `subtle`, no `randomUUID`), so `typeof crypto` would agree across engines
  // while the one method the contract promises differed.
  it('provides crypto.getRandomValues', () => {
    expect(typeof globalThis.crypto?.getRandomValues).toBe('function');
  });

  // Below: the functions that reach a global at CALL time, so an engine that has
  // the name but not the behaviour still fails here.
  it('generatePassphrase draws from the CSPRNG', () => {
    const passphrase = generatePassphrase();

    expect(passphrase.split('-')).toHaveLength(PASSPHRASE_DEFAULT_WORDS);
    // Two draws colliding would mean a stubbed or constant RNG, not bad luck:
    // at 77 bits the odds are ~1 in 1.5e23.
    expect(generatePassphrase()).not.toBe(passphrase);
  });

  it('generateRecoveryCode draws from the CSPRNG', () => {
    const code = generateRecoveryCode();

    expect(code).toMatch(/^[0-9A-HJKMNP-TV-Z-]+$/);
    expect(generateRecoveryCode()).not.toBe(code);
  });

  it('round-trips base64 through atob/btoa', () => {
    // Non-ASCII on purpose: base64ToBytes/bytesToBase64 go through the latin1
    // 1-byte-per-char mapping, which is where a lenient atob diverges.
    const bytes = new Uint8Array([0x00, 0x7f, 0x80, 0xff, 0xfe]);

    expect(base64ToBytes(bytesToBase64(bytes))).toEqual(bytes);
  });

  it('round-trips utf8 through TextEncoder/TextDecoder', () => {
    const text = 'bracemark — é 🔖';

    expect(bytesToUtf8(utf8(text))).toBe(text);
    expect(isSvgBytes(utf8('<svg xmlns="http://www.w3.org/2000/svg" />'))).toBe(true);
  });

  it('parses URLs with the engine URL and URLSearchParams', () => {
    expect(normalizeUrl('example.com/a?b=1')).toBe('https://example.com/a?b=1');
    // canonicalUrlKey sorts the query by iterating `searchParams.entries()` —
    // the one member that isn't in the plain `webworker` lib (it's in
    // `webworker.iterable`), and the reason that lib is listed in
    // packages/shared/tsconfig.lib.json. Asserting the sorted output exercises it.
    expect(canonicalUrlKey('https://www.Example.com/a/?b=2&a=1')).toBe('example.com/a?a=1&b=2');
  });
});
