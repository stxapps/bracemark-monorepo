/**
 * @jest-environment jsdom
 */
// The one sessionStorage key behind Settings' ✕, and the only thing worth
// asserting about it is what it REFUSES.
//
// The value goes straight into a `<Link href>`, and sessionStorage is
// user-writable from the console of the same origin, so the read is a validator
// and not a getter: `//evil.com` and `/\evil.com` are both live off-site
// destinations that `startsWith('/')` alone would wave through (the same class
// of hole guest-guard.ts rejects on `?next=`). Nothing else in the app looks at
// this key, so a validator that quietly loosened would be invisible — the ✕
// still works, it just also works for an attacker.
//
// The best-effort halves matter for a different reason: `recordLinksReturn` is
// called on EVERY links URL change and `readLinksReturn` from the Settings
// frame, so a storage hiccup (Safari private mode, a quota'd origin) that threw
// would take down the page rather than the feature.

import { readLinksReturn, recordLinksReturn } from './links-return';

// Replace the whole storage seam for one test. jsdom exposes `sessionStorage` as
// a prototype getter, so it can only be shadowed by an own property — which is
// also how the "no storage at all" case (`globalThis.sessionStorage?.`) is
// reached, since jsdom always supplies a real one.
function withSessionStorage(replacement: Storage | undefined, run: () => void): void {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'sessionStorage');
  Object.defineProperty(globalThis, 'sessionStorage', {
    value: replacement,
    configurable: true,
    writable: true,
  });
  try {
    run();
  } finally {
    if (original) Object.defineProperty(globalThis, 'sessionStorage', original);
    else delete (globalThis as { sessionStorage?: Storage }).sessionStorage;
  }
}

describe('links-return', () => {
  beforeEach(() => {
    sessionStorage.clear();
  });

  it('round-trips the links view it was given', () => {
    recordLinksReturn('/links?list=list-abc&tag=tag-xyz');
    expect(readLinksReturn()).toBe('/links?list=list-abc&tag=tag-xyz');
  });

  it('returns /links when this tab never visited the links page', () => {
    expect(readLinksReturn()).toBe('/links');
  });

  it('accepts the bare links home', () => {
    recordLinksReturn('/links');
    expect(readLinksReturn()).toBe('/links');
  });

  // The point of the whole module. Each of these is a value someone could type
  // into sessionStorage; none of them may come back out.
  it.each([
    ['a protocol-relative host', '//evil.com'],
    ['a backslash-disguised host', '/\\evil.com'],
    ['an absolute URL', 'https://evil.com/links'],
    ['a javascript: URL', 'javascript:alert(1)'],
    // `/linksomething` shares the prefix but is a different route — the check is
    // on the whole path, not on `startsWith('/links')`.
    ['a route that merely starts with /links', '/linkspam?x=1'],
    ['another app route', '/settings/account'],
    ['an empty string', ''],
  ])('discards %s', (_label, tampered) => {
    sessionStorage.setItem('bracemark:links-return', tampered);
    expect(readLinksReturn()).toBe('/links');
  });

  it('falls back to /links when reading throws', () => {
    const throwing = {
      getItem: () => {
        throw new Error('SecurityError');
      },
    } as unknown as Storage;
    withSessionStorage(throwing, () => {
      expect(readLinksReturn()).toBe('/links');
    });
  });

  it('falls back to /links when there is no storage at all', () => {
    withSessionStorage(undefined, () => {
      expect(readLinksReturn()).toBe('/links');
    });
  });

  // Recording happens on every URL change under the links page; throwing here
  // would take the page down over a storage quota.
  it('swallows a write failure instead of throwing at the call site', () => {
    const throwing = {
      setItem: () => {
        throw new Error('QuotaExceededError');
      },
    } as unknown as Storage;
    withSessionStorage(throwing, () => {
      expect(() => recordLinksReturn('/links?list=list-abc')).not.toThrow();
    });
  });
});
