// WHO ENGAGED THE LOCK — the one thing this provider knows that its web twin
// does not need to.
//
// Everything else here is a port of web-react's provider, and the rules the two
// share are pinned by its contexts/lock-provider.spec.tsx; they are not
// repeated. This file is about the expo-only set beside `unlockedIds`: the locks
// the user re-engaged BY HAND. The LockPane's hosts read it to decide whether a
// pane that just went up may ask for the unlock straight back — a keyboard, the
// biometric prompt — and it is wrong in two directions, both silent:
//
//   - A mark that is MISSING, and "Lock now" on the list being shown raises a
//     keyboard under the open drawer, or prompts Face ID to reopen the lock the
//     press just closed. Nothing fails; the lock just doesn't seem to take.
//   - A mark that LINGERS, and a lock the user is arriving at — after an unlock
//     and a fresh lock, or after the auto-relock — goes up mute. The prompt on
//     return is what makes a 60-second relock bearable (docs/locks.md), and its
//     absence looks like biometry quietly breaking.
//
// So the cases are the writers and the erasers: only lockApp/lockList write it;
// an unlock, the auto-relock and a fresh addListLock erase it.
//
// The verifier is stubbed but HONEST (right password vs wrong), as in the web
// spec. The store is a Map and the live read a re-runnable stand-in: this file
// is about in-memory session state, which never touches sqlite.

import { AppState, Text } from 'react-native';
import { act, render, screen, waitFor } from '@testing-library/react-native';

import { type ListItem, MY_LIST_ID, type TreeNode } from '@stxapps/shared';

import type { LockRecord } from '../data/lock-store';
import { LockProvider, useLockMutations, useLocks } from './lock-provider';

jest.mock('@stxapps/expo-crypto', () => ({
  createLockVerifier: (password: string) =>
    Promise.resolve({ salt: `salt:${password}`, hash: `hash:${password}` }),
  verifyLockPassword: (password: string, row: { hash: string }) =>
    Promise.resolve(row.hash === `hash:${password}`),
}));

const mockRows = new Map<string, LockRecord>();
jest.mock('../data/lock-store', () => ({
  APP_LOCK_ID: 'app',
  readLocks: () => Promise.resolve([...mockRows.values()]),
  putLock: (row: LockRecord) => Promise.resolve(void mockRows.set(row.id, row)),
  deleteLock: (id: string) => Promise.resolve(void mockRows.delete(id)),
}));

// A stand-in for the sqlite change listener: run the read, re-run it on demand.
const mockRefreshers = new Set<() => void>();
jest.mock('../hooks/use-live-read', () => ({
  useLiveRead: (read: () => Promise<unknown>) => {
    const react = require('react') as typeof import('react');
    const [value, setValue] = react.useState<unknown>(undefined);
    react.useEffect(() => {
      const run = () => void read().then(setValue);
      run();
      mockRefreshers.add(run);
      return () => void mockRefreshers.delete(run);
    }, []);
    return value;
  },
}));

// Re-run the live read — what a write to the `locks` table does on its own.
async function refresh(): Promise<void> {
  await act(async () => {
    for (const run of mockRefreshers) run();
    await Promise.resolve();
  });
}

jest.mock('./sync-provider', () => ({ useSync: () => ({ storeStatus: 'ready' }) }));
jest.mock('../lib/biometric', () => ({
  getBiometricCapability: () => Promise.resolve({ available: false, label: '' }),
  authenticateBiometric: () => Promise.resolve(false),
}));

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

const PARENT = 'li_parent';
const CHILD = 'li_child';
const PASSWORD = 'hunter2';

let locks: ReturnType<typeof useLocks>;
let mutations: ReturnType<typeof useLockMutations>;

function Probe() {
  locks = useLocks();
  mutations = useLockMutations();
  return <Text testID="status">{locks.status}</Text>;
}

// The app's foreground/background transitions, driven by hand.
let appStateListeners: ((next: string) => void)[] = [];
const appState = (next: string) => act(() => appStateListeners.forEach((l) => l(next)));

async function mount(): Promise<void> {
  render(
    <LockProvider>
      <Probe />
    </LockProvider>,
  );
  await waitFor(() => expect(screen.getByTestId('status').props.children).toBe('ready'));
}

// A list lock that exists and is OPEN — the only state "Lock now" is offered in.
async function openListLock(listId: string): Promise<void> {
  await act(async () => void (await mutations.addListLock(listId, PASSWORD, { hideList: false })));
  await refresh();
  await act(async () => void (await locks.unlockList(listId, PASSWORD)));
}

beforeEach(() => {
  mockRows.clear();
  mockRefreshers.clear();
  mockLists = [node(MY_LIST_ID), node(PARENT, [node(CHILD, [], 1)])];
  appStateListeners = [];
  jest.spyOn(AppState, 'addEventListener').mockImplementation((_type, listener) => {
    appStateListeners.push(listener as (next: string) => void);
    return { remove: () => undefined } as ReturnType<typeof AppState.addEventListener>;
  });
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe('a lock engaged by hand', () => {
  it('is marked by lockList, and the mark goes when the lock is opened', async () => {
    await mount();
    await openListLock(PARENT);
    expect(locks.isListLockedByHand(PARENT)).toBe(false);

    act(() => locks.lockList(PARENT));
    expect(locks.isListLocked(PARENT)).toBe(true);
    expect(locks.isListLockedByHand(PARENT)).toBe(true);

    await act(async () => void (await locks.unlockList(PARENT, PASSWORD)));
    expect(locks.isListLockedByHand(PARENT)).toBe(false);
  });

  // "Lock now" sits on the row that OWNS the lock; the pane is asked about the
  // list being SHOWN, which may be a child that lock merely covers. Answer by
  // own id and locking a parent from the drawer while its child is on screen
  // raises the keyboard this set exists to withhold.
  it('answers for every list the lock covers, not just the one that owns it', async () => {
    await mount();
    await openListLock(PARENT);

    act(() => locks.lockList(PARENT));

    expect(locks.isListLocked(CHILD)).toBe(true);
    expect(locks.isListLockedByHand(CHILD)).toBe(true);
  });

  it('is marked by lockApp, and the mark goes when the app is opened', async () => {
    await mount();
    await act(async () => void (await mutations.setAppLock(PASSWORD)));
    await refresh();
    expect(locks.appLock).toMatchObject({ unlocked: true, lockedByHand: false });

    act(() => locks.lockApp());
    expect(locks.appLock).toMatchObject({ unlocked: false, lockedByHand: true });

    await act(async () => void (await locks.unlockApp(PASSWORD)));
    expect(locks.appLock).toMatchObject({ unlocked: true, lockedByHand: false });
  });
});

describe('a lock engaged any other way', () => {
  // A relaunch: the row is in the store and nothing has opened it this session.
  it('is not by hand when it was never opened', async () => {
    mockRows.set(PARENT, { id: PARENT, kind: 'list', salt: 's', hash: `hash:${PASSWORD}` });
    mockRows.set('app', { id: 'app', kind: 'app', salt: 's', hash: `hash:${PASSWORD}` });
    await mount();

    expect(locks.isListLocked(PARENT)).toBe(true);
    expect(locks.isListLockedByHand(PARENT)).toBe(false);
    expect(locks.appLock).toMatchObject({ unlocked: false, lockedByHand: false });
  });

  it('is not by hand when the auto-relock engaged it', async () => {
    const now = jest.spyOn(Date, 'now').mockReturnValue(0);
    await mount();
    await openListLock(PARENT);

    appState('background');
    now.mockReturnValue(61_000);
    appState('active');

    expect(locks.isListLocked(PARENT)).toBe(true);
    expect(locks.isListLockedByHand(PARENT)).toBe(false);
  });

  // Past the grace window every engaged lock is the auto-relock's, whoever
  // closed it first: the device is assumed to have left the user's hands, and
  // the next pane to go up meets someone coming back.
  it('stops being by hand once the auto-relock has run', async () => {
    const now = jest.spyOn(Date, 'now').mockReturnValue(0);
    await mount();
    await openListLock(PARENT);
    act(() => locks.lockList(PARENT));

    appState('background');
    now.mockReturnValue(61_000);
    appState('active');

    expect(locks.isListLocked(PARENT)).toBe(true);
    expect(locks.isListLockedByHand(PARENT)).toBe(false);
  });

  // ...and a quick app-switch is not that: inside the window nothing relocks,
  // so nothing about who locked what has changed either.
  it('stays by hand across a background shorter than the grace window', async () => {
    const now = jest.spyOn(Date, 'now').mockReturnValue(0);
    await mount();
    await openListLock(PARENT);
    act(() => locks.lockList(PARENT));

    appState('background');
    now.mockReturnValue(5_000);
    appState('active');

    expect(locks.isListLockedByHand(PARENT)).toBe(true);
  });

  // A lock SET UP in Settings engages at once, but it is not a relock: the mark
  // an earlier lock on the same list left behind must not ride along onto it.
  it('is not by hand when it is a fresh lock on a list relocked earlier', async () => {
    await mount();
    await openListLock(PARENT);
    act(() => locks.lockList(PARENT));
    await act(async () => void (await mutations.removeListLock(PARENT, PASSWORD)));
    await refresh();

    await act(
      async () => void (await mutations.addListLock(PARENT, PASSWORD, { hideList: false })),
    );
    await refresh();

    expect(locks.isListLocked(PARENT)).toBe(true);
    expect(locks.isListLockedByHand(PARENT)).toBe(false);
  });
});

// List locks share the table, keyed by list id, so a list lock at the app lock's
// id would be a put over the app lock's row. The read edge hands no list that id
// (RESERVED_LIST_IDS, @stxapps/shared); this pins the writer refusing it anyway.
describe('a list lock at the app lock’s id', () => {
  it('is refused, and the app lock stays', async () => {
    await mount();
    await act(async () => void (await mutations.setAppLock(PASSWORD)));

    await expect(mutations.addListLock('app', 'other', { hideList: false })).rejects.toThrow(
      /reserved/,
    );
    await refresh();

    expect([...mockRows.values()]).toEqual([expect.objectContaining({ id: 'app', kind: 'app' })]);
    expect(locks.appLock).toMatchObject({ exists: true, unlocked: true });
  });
});
