import {
  clearDecodeCache,
  dropCachedExtraction,
  dropCachedLink,
  dropCachedPath,
  getCachedExtraction,
  getCachedLink,
  setCachedExtraction,
  setCachedLink,
} from './decode-cache';
import type { ExtractionItem, LinkItem } from './items';

// The memo that turns O(loaded) zod work per reactive tick into O(changed). Every
// assertion here is about SERVING A STALE DECODE, which is the only way this
// module can fail and is invisible at the call site: the reader gets a
// well-formed LinkItem for the right path — just the previous version of it — so
// the list renders the old title with no error anywhere, until some later write
// happens to move a version.
//
// The cache is module-level singleton state (both platforms' read layers point at
// the one instance), so each test starts from a cleared cache.

const link = (title: string): LinkItem =>
  ({ path: 'links/a.enc', customTitle: title }) as unknown as LinkItem;

const extraction = (title: string): ExtractionItem =>
  ({ path: 'extractions/a.enc', title }) as unknown as ExtractionItem;

beforeEach(clearDecodeCache);

describe('the version pair', () => {
  it('serves a hit when both axes are unchanged', () => {
    setCachedLink('links/a.enc', 10, 20, link('first'));
    expect(getCachedLink('links/a.enc', 10, 20)?.customTitle).toBe('first');
  });

  it('misses when updatedAt moved', () => {
    // The server axis (R2 LastModified): a download, a conflict merge or a
    // migration rewrote the bytes without the local write edge being involved.
    setCachedLink('links/a.enc', 10, 20, link('first'));
    expect(getCachedLink('links/a.enc', 11, 20)).toBeUndefined();
  });

  it('misses when itemUpdatedAt moved', () => {
    // The local axis, and the one a single field would miss: the write edge
    // FREEZES `updatedAt` at the pre-edit base so sync can reconcile against it,
    // so a local edit before its first sync moves only this half. Keyed on
    // `updatedAt` alone, every local edit would serve the pre-edit decode for
    // the whole window until sync restamped it.
    setCachedLink('links/a.enc', 10, 20, link('first'));
    expect(getCachedLink('links/a.enc', 10, 21)).toBeUndefined();
  });

  it('keys on the path — one link never serves another link decode', () => {
    // Populated with more than one entry on purpose: with a single resident
    // link, a cache that ignored the path entirely would still answer correctly.
    setCachedLink('links/a.enc', 1, 1, link('a'));
    setCachedLink('links/b.enc', 1, 1, link('b'));
    expect(getCachedLink('links/a.enc', 1, 1)?.customTitle).toBe('a');
    expect(getCachedLink('links/b.enc', 1, 1)?.customTitle).toBe('b');
  });

  it('misses a path it has never seen, even with the same versions resident', () => {
    setCachedLink('links/a.enc', 1, 1, link('a'));
    expect(getCachedLink('links/never.enc', 1, 1)).toBeUndefined();
  });

  it('overwrites rather than accumulating per version', () => {
    setCachedLink('links/a.enc', 10, 20, link('first'));
    setCachedLink('links/a.enc', 10, 21, link('second'));
    expect(getCachedLink('links/a.enc', 10, 21)?.customTitle).toBe('second');
    // The superseded version is gone, not retained beside the new one.
    expect(getCachedLink('links/a.enc', 10, 20)).toBeUndefined();
  });
});

describe('dropCachedPath — the write edge invalidation', () => {
  it('closes the version pair blind spot: two writes within one millisecond', () => {
    // The case the whole hook exists for. `itemUpdatedAt` is `Date.now()`, so two
    // local writes to one path inside a millisecond leave BOTH axes identical and
    // the cache would keep serving the first write's decode. It is not exotic —
    // the extension's titleImage capture writes the title and then the terminal
    // facet state back to back, and a settings picker fires one write per
    // keystroke.
    setCachedLink('links/a.enc', 10, 20, link('first'));
    dropCachedPath('links/a.enc');
    expect(getCachedLink('links/a.enc', 10, 20)).toBeUndefined();
  });

  it('covers BOTH caches, because the write edge is generic over paths', () => {
    // One `writeBytesWith` serves every namespace, so the writer does not know
    // which of the two caches a path could be in and must not have to.
    setCachedLink('links/a.enc', 1, 1, link('l'));
    setCachedExtraction('extractions/a.enc', 1, 1, extraction('e'));
    dropCachedPath('links/a.enc');
    dropCachedPath('extractions/a.enc');
    expect(getCachedLink('links/a.enc', 1, 1)).toBeUndefined();
    expect(getCachedExtraction('extractions/a.enc', 1, 1)).toBeUndefined();
  });

  it('drops only the path it was given', () => {
    setCachedLink('links/a.enc', 1, 1, link('a'));
    setCachedLink('links/b.enc', 1, 1, link('b'));
    dropCachedPath('links/a.enc');
    expect(getCachedLink('links/b.enc', 1, 1)?.customTitle).toBe('b');
  });

  it('is free on a path that was never cached', () => {
    expect(() => dropCachedPath('links/ghost.enc')).not.toThrow();
  });
});

describe('the per-namespace drops', () => {
  it('drop a decode so a re-appearance is not masked', () => {
    // Called when a record's bytes go absent or unparseable: without it, a path
    // that comes back later could still be served the pre-disappearance decode.
    setCachedLink('links/a.enc', 1, 1, link('l'));
    setCachedExtraction('extractions/a.enc', 1, 1, extraction('e'));

    dropCachedLink('links/a.enc');
    expect(getCachedLink('links/a.enc', 1, 1)).toBeUndefined();
    // The two caches are independent — dropping one namespace leaves the other.
    expect(getCachedExtraction('extractions/a.enc', 1, 1)?.title).toBe('e');

    dropCachedExtraction('extractions/a.enc');
    expect(getCachedExtraction('extractions/a.enc', 1, 1)).toBeUndefined();
  });
});

describe('clearDecodeCache — the sign-out wipe', () => {
  it('leaves nothing decoded in EITHER cache', () => {
    // This runs beside the `items` wipe on sign-out. A decoded link surviving it
    // is one user's plaintext readable by the next user of the device — the
    // `items` wipe alone does not reach it, because this cache holds already-
    // decrypted objects in memory keyed only by path.
    setCachedLink('links/a.enc', 1, 1, link('l'));
    setCachedExtraction('extractions/a.enc', 1, 1, extraction('e'));

    clearDecodeCache();

    expect(getCachedLink('links/a.enc', 1, 1)).toBeUndefined();
    expect(getCachedExtraction('extractions/a.enc', 1, 1)).toBeUndefined();
  });

  it('leaves the cache usable for the next account', () => {
    setCachedLink('links/a.enc', 1, 1, link('first user'));
    clearDecodeCache();
    setCachedLink('links/a.enc', 1, 1, link('second user'));
    expect(getCachedLink('links/a.enc', 1, 1)?.customTitle).toBe('second user');
  });
});
