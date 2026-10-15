import type { TreeItem, TreeNode } from './tree';

// Pure lock-coverage resolution over the list tree, split out of the clients'
// lock providers so it can be unit tested without React or a store, and shared
// by every platform (web-react and expo-react keep their own device-local lock
// rows; the covering semantics must not drift between them). A lock on a list
// COVERS its whole subtree (otherwise Show All / tag views / search would leak
// the children's links and the lock would be decorative). This resolves, per
// list, the NEAREST locked self-or-ancestor lock — the covering lock a password
// prompt for the list verifies against, and unlocking which releases everything
// it covers.

// The constant primary key of the single app-lock row in each client's
// device-local `locks` table. List locks share that table, keyed by their list
// id, so no list may ever be stored at this id: a list lock on it would be a
// `put` over the app lock's row — the app lock gone, with nothing saying so —
// and removing that list's lock would delete it. The ids this app mints for
// lists never collide (a system-list constant or a random UUID); what keeps a
// list arriving from elsewhere off it is RESERVED_LIST_IDS (system-lists.ts),
// refused by the backup classifier and dropped by the read edge. Here, in
// `shared`, rather than in either lock store, so that rule can name it.
export const APP_LOCK_ID = 'app';

// The structural slice of a lock row coverage reads — each client's own
// LockRecord (web-react db.ts, expo-react db.ts) satisfies it.
export interface CoverageLock {
  id: string;
  // While locked, also hide the list (and its subtree) — not just gate its links.
  hideList?: boolean;
}

export interface Coverage {
  // Every list whose links are currently gated (covered by a locked lock,
  // descendants included).
  lockedListIds: ReadonlySet<string>;
  // The covered lists that should also disappear from the sidebar/pickers.
  hiddenListIds: ReadonlySet<string>;
  // Covered list id → the covering lock row's id (nearest locked self-or-ancestor).
  coveringLockIds: ReadonlyMap<string, string>;
}

export const EMPTY_COVERAGE: Coverage = {
  lockedListIds: new Set(),
  hiddenListIds: new Set(),
  coveringLockIds: new Map(),
};

// Walk the list forest resolving each list's covering lock. `ancestorLockId` is
// the nearest locked ancestor's lock row (it wins as the covering lock — you must
// open the outermost door first; an inner lock takes over on the recompute after
// that unlock). `ancestorHidden` propagates hide from any locked ancestor, and a
// list's OWN locked hide flag applies even under a non-hiding ancestor lock.
//
// On an explicit stack, each entry carrying what its ancestors decided, rather
// than recursing: the forest is as deep as the library's `parentId` chain
// (tree.ts), and this runs in the lock provider above every signed-in screen. It
// walks the SAME forest the screens render — never a flattened or depth-capped
// copy of it, which would detach a deep list from the lock that covers it.
function walkCoverage<T extends TreeItem>(
  nodes: TreeNode<T>[],
  lockRows: ReadonlyMap<string, CoverageLock>,
  unlockedIds: ReadonlySet<string>,
  out: { locked: Set<string>; hidden: Set<string>; covering: Map<string, string> },
): void {
  interface Entry {
    node: TreeNode<T>;
    ancestorLockId: string | null;
    ancestorHidden: boolean;
  }
  const pending: Entry[] = [];
  for (let i = nodes.length - 1; i >= 0; i--) {
    pending.push({ node: nodes[i], ancestorLockId: null, ancestorHidden: false });
  }
  for (let entry = pending.pop(); entry !== undefined; entry = pending.pop()) {
    const { node, ancestorLockId, ancestorHidden } = entry;
    const own = lockRows.get(node.item.id);
    const ownActive = own !== undefined && !unlockedIds.has(own.id) ? own : undefined;
    const lockId = ancestorLockId ?? ownActive?.id ?? null;
    const isHidden = ancestorHidden || (ownActive?.hideList ?? false);
    if (lockId !== null) {
      out.locked.add(node.item.id);
      out.covering.set(node.item.id, lockId);
      if (isHidden) out.hidden.add(node.item.id);
    }
    for (let i = node.children.length - 1; i >= 0; i--) {
      pending.push({ node: node.children[i], ancestorLockId: lockId, ancestorHidden: isHidden });
    }
  }
}

export function computeCoverage<T extends TreeItem>(
  lists: TreeNode<T>[],
  lockRows: ReadonlyMap<string, CoverageLock>,
  unlockedIds: ReadonlySet<string>,
): Coverage {
  if (lockRows.size === 0) return EMPTY_COVERAGE;
  const out = {
    locked: new Set<string>(),
    hidden: new Set<string>(),
    covering: new Map<string, string>(),
  };
  walkCoverage(lists, lockRows, unlockedIds, out);
  return { lockedListIds: out.locked, hiddenListIds: out.hidden, coveringLockIds: out.covering };
}
