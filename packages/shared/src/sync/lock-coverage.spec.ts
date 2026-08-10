import { computeCoverage, type CoverageLock } from './lock-coverage';
import type { TreeItem, TreeNode } from './tree';

// walkCoverage only reads `item.id` and `children`, so a minimal node is enough.
const node = (id: string, children: TreeNode<TreeItem>[] = []): TreeNode<TreeItem> => ({
  item: { id, parentId: null, rank: '' },
  depth: 0,
  children,
});

const listLock = (id: string, hideList = false): CoverageLock => ({ id, hideList });

const rows = (...locks: CoverageLock[]) => new Map(locks.map((l) => [l.id, l]));

describe('computeCoverage', () => {
  // Case 4: a list whose PARENT is locked must gate when visited directly (e.g.
  // from a URL query). The gate reads `lockedListIds.has(id)`, so coverage must
  // expand the lock down every descendant — not just the list that owns the lock.
  describe('a locked parent covers its descendants (direct-visit gating)', () => {
    // parent (locked) → child → grandchild, none of the descendants own a lock.
    const lists = [node('parent', [node('child', [node('grandchild')])])];
    const coverage = computeCoverage(lists, rows(listLock('parent')), new Set());

    it('gates the parent and EVERY descendant, not just the lock owner', () => {
      expect(coverage.lockedListIds).toEqual(new Set(['parent', 'child', 'grandchild']));
    });

    it('points each covered descendant at the ancestor lock as its covering lock', () => {
      // This is what lets `unlockList(childId, pw)` fall through to the parent's
      // lock row — the child has no own row to verify against.
      expect(coverage.coveringLockIds.get('child')).toBe('parent');
      expect(coverage.coveringLockIds.get('grandchild')).toBe('parent');
    });

    it('releases the whole subtree once the covering lock is unlocked', () => {
      const unlocked = computeCoverage(lists, rows(listLock('parent')), new Set(['parent']));
      expect(unlocked.lockedListIds.size).toBe(0);
    });
  });

  // Hide propagates to the subtree (a hidden parent hides its children too), and
  // is a property of the ENGAGED lock — unlocking reveals the subtree again.
  describe('hide propagation', () => {
    const lists = [node('parent', [node('child')])];

    it('hides descendants when the parent lock hides', () => {
      const coverage = computeCoverage(lists, rows(listLock('parent', true)), new Set());
      expect(coverage.hiddenListIds).toEqual(new Set(['parent', 'child']));
    });

    it('locks but does NOT hide the subtree when the parent lock does not hide', () => {
      // "locked, not hidden" = visible in the sidebar but links gated. Hide and
      // lock are orthogonal; a non-hiding lock never force-hides its children.
      const coverage = computeCoverage(lists, rows(listLock('parent', false)), new Set());
      expect(coverage.lockedListIds).toEqual(new Set(['parent', 'child']));
      expect(coverage.hiddenListIds.size).toBe(0);
    });

    it('un-hides the subtree once the lock is unlocked', () => {
      const coverage = computeCoverage(lists, rows(listLock('parent', true)), new Set(['parent']));
      expect(coverage.hiddenListIds.size).toBe(0);
    });

    it("applies a child's own hide even under a non-hiding ancestor lock", () => {
      const coverage = computeCoverage(
        lists,
        rows(listLock('parent', false), listLock('child', true)),
        new Set(),
      );
      expect(coverage.hiddenListIds).toEqual(new Set(['child']));
    });
  });

  // The outermost locked ancestor wins as the covering lock; an inner lock only
  // takes over on the recompute after the outer one is unlocked.
  describe('nested locks: outer lock covers, inner takes over after unlock', () => {
    const lists = [node('parent', [node('child')])];
    const both = rows(listLock('parent'), listLock('child'));

    it('the outer lock covers the inner locked list while both are engaged', () => {
      const coverage = computeCoverage(lists, both, new Set());
      expect(coverage.coveringLockIds.get('child')).toBe('parent');
    });

    it("the child's own lock takes over once the parent is unlocked", () => {
      const coverage = computeCoverage(lists, both, new Set(['parent']));
      expect(coverage.lockedListIds).toEqual(new Set(['child']));
      expect(coverage.coveringLockIds.get('child')).toBe('child');
    });
  });

  it('returns the empty coverage when there are no list locks', () => {
    const lists = [node('parent', [node('child')])];
    expect(computeCoverage(lists, rows(), new Set()).lockedListIds.size).toBe(0);
  });
});
