/**
 * @jest-environment node
 *
 * `newId` is a one-line delegation, so this spec pins the only thing about it
 * that another file depends on: the FORM. Ids minted here end up in sync paths
 * and R2 object keys (docs/local-first-sync.md) alongside ids minted by
 * bracemark-api's own copy (apps/bracemark-api/src/lib/ids.ts) and by the expo
 * sibling — three implementations that must keep producing the same shape.
 * Swapping in a sortable/k-ordered scheme (the comment in ids.ts explicitly
 * decides against it) would be a silent change of that shape, and the id is
 * opaque everywhere it's consumed, so nothing else would notice.
 *
 * Node env: the real Web Crypto lives at globalThis.crypto there.
 */
import { newId } from './ids';

// 8-4-4-4-12 lowercase hex, version nibble 4, variant nibble 8|9|a|b.
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

it('mints a random (v4) UUID, not a sortable or sequential id', () => {
  expect(newId()).toMatch(UUID_V4);
});

it('does not repeat itself', () => {
  const ids = new Set(Array.from({ length: 1000 }, newId));
  expect(ids.size).toBe(1000);
});
