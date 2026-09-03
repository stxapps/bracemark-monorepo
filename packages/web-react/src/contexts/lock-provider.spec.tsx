/**
 * @jest-environment jsdom
 */
// Specs for the lock provider — the owner of the one piece of lock state the store can't
// hold: whether each lock is currently UNLOCKED. Everything here is a rule about WHEN a
// gate is open, and a gate that is wrongly open shows a shoulder-surfer the links the
// user locked, with no error and nothing in the UI to suggest anything went wrong.
//
// Four behaviours have no cover anywhere else:
//
//   - `status: 'checking'` until the first read resolves. Rendering the gates before the
//     locks are known flashes the app OPEN — the same no-flash rule as InitialSyncGate,
//     and the flash is the whole failure.
//   - The TWO-CANDIDATE unlock ladder. A list can be gated by its own lock or by a
//     locked ancestor's, so `unlockList` tries the own row first and the covering lock
//     second — settings' per-row prompt opens the row it names, the main pane's prompt
//     opens the outer door. Try only one and a password that is objectively correct is
//     rejected from one of the two surfaces.
//   - "Lock" means LOCK NOW: `addListLock` drops any stale unlock for that id, while
//     `setAppLock` deliberately does the opposite and marks the app unlocked — enabling
//     the app lock from settings must not slam the gate on the user who just enabled it.
//   - The ORPHAN SWEEP's guard. List deletion SYNCS while locks are device-local, so a
//     lock can outlive its list — but the sweep must not run against a store that is
//     merely still loading, or it deletes every list lock on the device. Its guard is
//     "ready store AND a non-empty tree", and the empty-tree half is the one that only
//     ever fires during loading.
//
// The verifier is stubbed (jsdom has no `crypto.subtle`, and PBKDF2 is @stxapps/web-crypto's
// own subject) but kept HONEST: it still distinguishes right password from wrong, which is
// the only property this provider reads. The lock STORE is real Dexie.

import { act, render, screen, waitFor } from '@testing-library/react';

import { MY_LIST_ID, type TreeNode } from '@stxapps/shared';

import { db } from '../data/db';
import { APP_LOCK_ID, readLocks } from '../data/lock-store';
import type { ListItem } from '../data/queries';
import { LockProvider, useLockMutations, useLocks } from './lock-provider';

// fake-indexeddb needs a structuredClone, which jsdom doesn't provide (see the note in
// jest.config.cts). Lock rows are plain JSON, so a JSON round trip is a faithful clone
// for everything this spec stores.
if (typeof globalThis.structuredClone === 'undefined') {
  globalThis.structuredClone = <T,>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
}

// A verifier that is deterministic but still a real yes/no: the salt carries the password,
// so a wrong password fails exactly as PBKDF2 would. Anything weaker (always-true) would
// make every "wrong password" assertion below vacuous.
jest.mock('@stxapps/web-crypto', () => ({
  createLockVerifier: (password: string) =>
    Promise.resolve({ salt: `salt:${password}`, hash: `hash:${password}` }),
  verifyLockPassword: (password: string, row: { hash: string }) =>
    Promise.resolve(row.hash === `hash:${password}`),
}));

// A stand-in for Dexie's liveQuery: run the querier, re-run it on demand. The provider
// doesn't depend on Dexie's tracking-zone reactivity, only on the answer arriving.
const mockRefreshers = new Set<() => void>();
jest.mock('dexie-react-hooks', () => ({
  useLiveQuery: (querier: () => Promise<unknown>, deps: unknown[]) => {
    const react = require('react') as typeof import('react');
    const [value, setValue] = react.useState<unknown>(undefined);
    const run = react.useCallback(() => {
      void Promise.resolve(querier()).then(setValue);
    }, deps);
    react.useEffect(() => {
      run();
      mockRefreshers.add(run);
      return () => void mockRefreshers.delete(run);
    }, [run]);
    return value;
  },
}));

// Re-run every live query — what a Dexie write would do on its own.
async function refresh(): Promise<void> {
  await act(async () => {
    for (const run of mockRefreshers) run();
    await Promise.resolve();
  });
}

let mockStoreStatus = 'ready';
jest.mock('./sync-provider', () => ({ useSync: () => ({ storeStatus: mockStoreStatus }) }));

// The list tree the provider resolves coverage against. `readLists` always includes the
// system lists once resolved, so an EMPTY tree means "still loading" — which is precisely
// what the orphan sweep's guard keys on.
let mockLists: TreeNode<ListItem>[] = [];
jest.mock('../hooks/use-lists', () => ({ useLists: () => mockLists }));

function node(id: string, children: TreeNode<ListItem>[] = [], depth = 0): TreeNode<ListItem> {
  return {
    depth,
    item: {
      path: `lists/${id}.enc`,
      id,
      name: id,
      parentId: null,
      rank: 'a0',
      createdAt: 1,
      updatedAt: 1,
    },
    children,
  };
}

let locks: ReturnType<typeof useLocks>;
let mutations: ReturnType<typeof useLockMutations>;

function Probe() {
  locks = useLocks();
  mutations = useLockMutations();
  return (
    <div>
      <span data-testid="status">{locks.status}</span>
      <span data-testid="app">{`${locks.appLock.exists}/${locks.appLock.unlocked}`}</span>
      <span data-testid="locked">{[...locks.lockedListIds].sort().join(',')}</span>
      <span data-testid="hidden">{[...locks.hiddenListIds].sort().join(',')}</span>
    </div>
  );
}

const renderProvider = () =>
  render(
    <LockProvider>
      <Probe />
    </LockProvider>,
  );

const statusText = () => screen.getByTestId('status').textContent;
const lockedText = () => screen.getByTestId('locked').textContent;

beforeEach(async () => {
  mockRefreshers.clear();
  mockStoreStatus = 'ready';
  mockLists = [node(MY_LIST_ID), node('li_parent', [node('li_child', [], 1)]), node('li_other')];
  await db.locks.clear();
});

describe('status', () => {
  // The no-flash rule: gates render null while this is 'checking'. Reporting 'ready' with
  // no answer yet would show the locked links for a frame — the exact thing a lock is for.
  it('is `checking` until the first locks read resolves', async () => {
    renderProvider();

    expect(statusText()).toBe('checking');
    await waitFor(() => expect(statusText()).toBe('ready'));
  });
});

describe('the app lock', () => {
  it('reports no app lock on a device that has none', async () => {
    renderProvider();
    await waitFor(() => expect(statusText()).toBe('ready'));

    expect(screen.getByTestId('app').textContent).toBe('false/true');
  });

  // Enabling from settings must NOT slam the gate shut on the person who just enabled it
  // — it engages on the next load, by construction (the unlocked set is in-memory only).
  it('leaves the app unlocked for the session that enabled it', async () => {
    renderProvider();
    await waitFor(() => expect(statusText()).toBe('ready'));

    await act(async () => void (await mutations.setAppLock('hunter2')));
    await refresh();

    expect(screen.getByTestId('app').textContent).toBe('true/true');
    expect((await readLocks()).map((row) => row.id)).toEqual([APP_LOCK_ID]);
  });

  // "Lock now" — no password, no store write, just drop the session unlock. The gate has
  // to close without a reload, which is the whole affordance.
  it('re-engages immediately on lockApp, with no password and no store write', async () => {
    renderProvider();
    await waitFor(() => expect(statusText()).toBe('ready'));
    await act(async () => void (await mutations.setAppLock('hunter2')));
    await refresh();

    act(() => locks.lockApp());

    expect(screen.getByTestId('app').textContent).toBe('true/false');
    expect(await db.locks.count()).toBe(1);
  });

  it('opens on the right password and stays shut on the wrong one', async () => {
    renderProvider();
    await waitFor(() => expect(statusText()).toBe('ready'));
    await act(async () => void (await mutations.setAppLock('hunter2')));
    await refresh();
    act(() => locks.lockApp());

    await act(async () => expect(await locks.unlockApp('wrong')).toBe(false));
    expect(screen.getByTestId('app').textContent).toBe('true/false');

    await act(async () => expect(await locks.unlockApp('hunter2')).toBe(true));
    expect(screen.getByTestId('app').textContent).toBe('true/true');
  });

  it('refuses to remove the app lock without the password', async () => {
    renderProvider();
    await waitFor(() => expect(statusText()).toBe('ready'));
    await act(async () => void (await mutations.setAppLock('hunter2')));

    await act(async () => expect(await mutations.removeAppLock('wrong')).toBe(false));
    expect(await db.locks.count()).toBe(1);

    await act(async () => expect(await mutations.removeAppLock('hunter2')).toBe(true));
    expect(await db.locks.count()).toBe(0);
  });

  // Idempotent teardown: removing a lock that isn't there is a success, not a wrong
  // password — otherwise a double-click on "Remove" reports a password failure.
  it('treats removing an absent app lock as already done', async () => {
    renderProvider();
    await waitFor(() => expect(statusText()).toBe('ready'));

    await act(async () => expect(await mutations.removeAppLock('anything')).toBe(true));
  });
});

describe('list locks', () => {
  // "Lock" means lock NOW, unlike the app lock — matching the affordance's own label.
  it('engages a new list lock immediately', async () => {
    renderProvider();
    await waitFor(() => expect(statusText()).toBe('ready'));

    await act(
      async () => void (await mutations.addListLock('li_other', 'pw', { hideList: false })),
    );
    await refresh();

    expect(locks.isListLocked('li_other')).toBe(true);
    expect(lockedText()).toBe('li_other');
  });

  // A lock COVERS its subtree — otherwise Show All, the tag views and search would leak
  // the children's links and the lock would be decorative.
  it('gates the whole subtree under a locked list', async () => {
    renderProvider();
    await waitFor(() => expect(statusText()).toBe('ready'));

    await act(
      async () => void (await mutations.addListLock('li_parent', 'pw', { hideList: false })),
    );
    await refresh();

    expect(lockedText()).toBe('li_child,li_parent');
  });

  // Hiding is a NAVIGATION declutter layered on top of the gate, not a second gate: a
  // hidden list is always also locked, so the hidden set can only ever be a subset.
  it('hides only what it also gates', async () => {
    renderProvider();
    await waitFor(() => expect(statusText()).toBe('ready'));

    await act(
      async () => void (await mutations.addListLock('li_parent', 'pw', { hideList: true })),
    );
    await refresh();

    const hidden = (screen.getByTestId('hidden').textContent ?? '').split(',').filter(Boolean);
    expect(hidden.length).toBeGreaterThan(0);
    for (const id of hidden) expect(locks.lockedListIds.has(id)).toBe(true);
  });

  // THE TWO-CANDIDATE LADDER, half one: the list's OWN password. Settings' per-row
  // "Unlock…" names this row, so it must be what the password is checked against.
  it('opens a list with its own password', async () => {
    renderProvider();
    await waitFor(() => expect(statusText()).toBe('ready'));
    await act(
      async () => void (await mutations.addListLock('li_other', 'pw', { hideList: false })),
    );
    await refresh();

    await act(async () => expect(await locks.unlockList('li_other', 'pw')).toBe(true));
    await refresh();

    expect(locks.isListLocked('li_other')).toBe(false);
  });

  // …half two: a CHILD, which has no lock of its own, opened with the ancestor's password.
  // This is the main pane's prompt — it opens the outer door. Try only the own row and a
  // correct password is rejected here; try only the covering lock and the settings row
  // above breaks instead.
  it('opens a covered child with the covering lock’s password', async () => {
    renderProvider();
    await waitFor(() => expect(statusText()).toBe('ready'));
    await act(
      async () => void (await mutations.addListLock('li_parent', 'pw', { hideList: false })),
    );
    await refresh();
    expect(locks.isListLocked('li_child')).toBe(true);

    await act(async () => expect(await locks.unlockList('li_child', 'pw')).toBe(true));
    await refresh();

    expect(lockedText()).toBe('');
  });

  it('rejects a wrong password for a covered child', async () => {
    renderProvider();
    await waitFor(() => expect(statusText()).toBe('ready'));
    await act(
      async () => void (await mutations.addListLock('li_parent', 'pw', { hideList: false })),
    );
    await refresh();

    await act(async () => expect(await locks.unlockList('li_child', 'nope')).toBe(false));

    expect(locks.isListLocked('li_child')).toBe(true);
  });

  // Re-locking a list mid-session, no password required — locking is always free.
  it('re-engages a list lock on lockList', async () => {
    renderProvider();
    await waitFor(() => expect(statusText()).toBe('ready'));
    await act(
      async () => void (await mutations.addListLock('li_other', 'pw', { hideList: false })),
    );
    await refresh();
    await act(async () => void (await locks.unlockList('li_other', 'pw')));
    await refresh();
    expect(locks.isListLocked('li_other')).toBe(false);

    act(() => locks.lockList('li_other'));

    expect(locks.isListLocked('li_other')).toBe(true);
  });

  // Re-locking a list that was never unlocked must be inert — the setter returns the SAME
  // set when nothing changes, so a "Lock now" on an already-locked row can't churn a
  // render (and, through the coverage memo, every consumer of lockedListIds).
  it('is inert when asked to lock something already locked', async () => {
    renderProvider();
    await waitFor(() => expect(statusText()).toBe('ready'));
    await act(
      async () => void (await mutations.addListLock('li_other', 'pw', { hideList: false })),
    );
    await refresh();
    const before = locks.lockedListIds;

    act(() => locks.lockList('li_other'));

    expect(locks.lockedListIds).toBe(before);
  });

  // Re-locking a list is a fresh lock, so a stale unlock from an EARLIER lock on the same
  // id must not carry over — without that drop, "Lock" on a list the user unlocked
  // earlier this session leaves the gate open.
  it('drops a stale unlock when a list is re-locked with a new password', async () => {
    renderProvider();
    await waitFor(() => expect(statusText()).toBe('ready'));
    await act(
      async () => void (await mutations.addListLock('li_other', 'old', { hideList: false })),
    );
    await refresh();
    await act(async () => void (await locks.unlockList('li_other', 'old')));
    await refresh();
    expect(locks.isListLocked('li_other')).toBe(false);

    await act(
      async () => void (await mutations.addListLock('li_other', 'new', { hideList: false })),
    );
    await refresh();

    expect(locks.isListLocked('li_other')).toBe(true);
  });

  it('refuses to remove a list lock without the password', async () => {
    renderProvider();
    await waitFor(() => expect(statusText()).toBe('ready'));
    await act(
      async () => void (await mutations.addListLock('li_other', 'pw', { hideList: false })),
    );

    await act(async () => expect(await mutations.removeListLock('li_other', 'wrong')).toBe(false));
    expect(await db.locks.count()).toBe(1);

    await act(async () => expect(await mutations.removeListLock('li_other', 'pw')).toBe(true));
    expect(await db.locks.count()).toBe(0);
  });

  // Row state, not coverage: `listLocks` answers "does this list have its OWN lock", which
  // is what settings and the sidebar chrome render. A covered child appears in
  // lockedListIds but must NOT appear here, or the UI offers to remove a lock that
  // doesn't exist.
  it('reports own-lock rows only, never coverage', async () => {
    renderProvider();
    await waitFor(() => expect(statusText()).toBe('ready'));
    await act(
      async () => void (await mutations.addListLock('li_parent', 'pw', { hideList: true })),
    );
    await refresh();

    expect([...locks.listLocks.keys()]).toEqual(['li_parent']);
    expect(locks.listLocks.get('li_parent')).toEqual({ locked: true, hideList: true });
    expect(locks.lockedListIds.has('li_child')).toBe(true);
  });
});

describe('the orphan sweep', () => {
  // List deletion syncs; locks are device-local. So a lock can outlive its list, and
  // nothing else reclaims it — the row would sit invisible forever, still gating an id.
  it('deletes a lock whose list no longer exists', async () => {
    await db.locks.put({ id: 'li_deleted', kind: 'list', salt: 's', hash: 'hash:pw' });

    renderProvider();

    await waitFor(async () => expect(await db.locks.count()).toBe(0));
  });

  // THE GUARD. An empty tree means the lists are still loading (`readLists` always
  // includes the system lists once resolved), and sweeping then deletes EVERY list lock
  // on the device — silently, permanently, and on a perfectly healthy account.
  it('does not sweep while the list tree is still loading', async () => {
    mockLists = [];
    await db.locks.put({ id: 'li_other', kind: 'list', salt: 's', hash: 'hash:pw' });

    renderProvider();
    await waitFor(() => expect(statusText()).toBe('ready'));

    expect(await db.locks.count()).toBe(1);
  });

  // Same reasoning one layer out: a store that isn't ready hasn't finished pulling the
  // lists, so absence proves nothing yet.
  it('does not sweep while the store is not ready', async () => {
    mockStoreStatus = 'loading';
    await db.locks.put({ id: 'li_deleted', kind: 'list', salt: 's', hash: 'hash:pw' });

    renderProvider();
    await waitFor(() => expect(statusText()).toBe('ready'));

    expect(await db.locks.count()).toBe(1);
  });

  // The app lock is not a list lock — it has no list to be orphaned from, and sweeping it
  // would silently disable the app lock on every load.
  it('never sweeps the app lock', async () => {
    await db.locks.put({ id: APP_LOCK_ID, kind: 'app', salt: 's', hash: 'hash:pw' });

    renderProvider();
    await waitFor(() => expect(statusText()).toBe('ready'));

    expect(await db.locks.count()).toBe(1);
  });
});

describe('useLocks', () => {
  it('refuses to be used outside the provider', () => {
    const noise = jest.spyOn(console, 'error').mockImplementation(() => undefined);

    expect(() => render(<Probe />)).toThrow(/LockProvider/);

    noise.mockRestore();
  });
});
