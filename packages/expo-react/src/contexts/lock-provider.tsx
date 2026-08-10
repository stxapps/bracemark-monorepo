import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { AppState } from 'react-native';

import { createLockVerifier, verifyLockPassword } from '@stxapps/expo-crypto';
import { computeCoverage, type ListItem, type TreeNode } from '@stxapps/shared';

import { APP_LOCK_ID, deleteLock, type LockRecord, putLock, readLocks } from '../data/lock-store';
import { useLists } from '../hooks/use-lists';
import { useLiveRead } from '../hooks/use-live-read';
import {
  authenticateBiometric,
  type BiometricCapability,
  getBiometricCapability,
} from '../lib/biometric';
import { useSync } from './sync-provider';

// Device-local app/list locks — the expo sibling of web-react's
// contexts/lock-provider.tsx, verbatim in contract (see there for the threat
// model, the coverage walk, and the two enforcement edges: lockedListIds → the
// link query's exclusion, hiddenListIds → sidebar pruning). This provider owns
// the one piece of lock state the store can't: whether each lock is currently
// UNLOCKED — plain in-memory React state, never persisted, so every lock
// re-engages on relaunch by construction. Platform divergences only here:
// reactivity is useLiveRead over the `locks` table (expo-sqlite change
// listener) instead of Dexie's liveQuery, and the PBKDF2 verifier pair comes
// from expo-crypto (react-native-quick-crypto) instead of web-crypto.
//
// One expo-ONLY behavior with no web counterpart: AUTO-RELOCK on return from a
// prolonged background (see the effect below). Web relies on tab-close to
// re-engage locks; a mobile process keeps `unlockedIds` in memory across
// backgrounding, so an unlocked, backgrounded phone handed to someone would stay
// open. This is a deliberate, justified divergence — see docs/locks.md.

// A list lock's row state, for settings/sidebar chrome (does this list have its
// own lock, is it currently engaged, does it hide, may it use biometry) —
// distinct from COVERAGE, which is about whose links are gated (lockedListIds
// includes descendants).
export interface ListLockInfo {
  locked: boolean;
  hideList: boolean;
  // The row's own biometric opt-in (docs/locks.md — expo-only). Drives the
  // settings toggle; the LockPane's decision uses biometricForList (covering).
  biometric: boolean;
}

export interface Locks {
  // 'checking' while the first locks read is in flight — gates render null (the
  // same no-flash rule as web's InitialSyncGate) instead of flashing the app open.
  status: 'checking' | 'ready';
  appLock: { exists: boolean; unlocked: boolean; biometric: boolean };
  // Device biometry (Face ID / Touch ID) — hardware present + enrolled — and a
  // user-facing label for it. Gates every biometric affordance; expo-only.
  biometricAvailable: boolean;
  biometricLabel: string;
  // Every list whose links are currently gated (covered by a locked lock,
  // descendants included). use-links merges these into the query exclusion.
  lockedListIds: ReadonlySet<string>;
  // The covered lists that should also disappear from the sidebar/pickers.
  hiddenListIds: ReadonlySet<string>;
  // Per-list lock ROW state (own lock only, no coverage) for settings/sidebar
  // chrome. Absent key = no lock on that list.
  listLocks: ReadonlyMap<string, ListLockInfo>;
  isListLocked: (listId: string) => boolean;
  // Verify against the app lock / the list's covering lock; true opens it.
  unlockApp: (password: string) => Promise<boolean>;
  unlockList: (listId: string, password: string) => Promise<boolean>;
  // Re-engage an already-configured lock RIGHT NOW — drops this session's
  // in-memory unlock so the gate closes without a relaunch. No password
  // (relocking is free) and no store write; a no-op if the lock doesn't exist or
  // is already engaged. Powers the "Lock now" affordances (sidebar list rows,
  // topbar's overflow "Lock app"). The inverse of unlockApp/unlockList — so it
  // sits here beside them (session interaction), not in LockMutations (persisted
  // writes). Web parity: web-react's lock-provider.
  lockApp: () => void;
  lockList: (listId: string) => void;
  // Whether biometry can open the lock currently GATING this list — the covering
  // lock (own or a locked ancestor's) has its biometric opt-in AND the device
  // supports it. The LockPane uses this to decide whether to offer/auto-prompt.
  biometricForList: (listId: string) => boolean;
  // Biometric unlock — runs the OS prompt and, on success, opens the lock the
  // same in-memory way a password does (the list variant resolves the covering
  // lock, like unlockList). false = not enabled/available, cancelled, or failed.
  // No password is stored behind the biometry (docs/locks.md — boolean gate).
  unlockAppWithBiometric: () => Promise<boolean>;
  unlockListWithBiometric: (listId: string) => Promise<boolean>;
}

export interface LockMutations {
  // Enable the app lock. Marks it unlocked for this session — enabling from
  // settings must not slam the gate shut on the spot; it engages on next load.
  setAppLock: (password: string) => Promise<void>;
  // Disable the app lock; false = wrong password.
  removeAppLock: (password: string) => Promise<boolean>;
  // Lock a list. Engages IMMEDIATELY (any stale unlock for the id is dropped) —
  // "Lock" means lock now, matching web.
  addListLock: (listId: string, password: string, opts: { hideList: boolean }) => Promise<void>;
  // Remove a list's own lock; false = wrong password.
  removeListLock: (listId: string, password: string) => Promise<boolean>;
  // Opt a lock into (or out of) biometric unlock. ENABLING runs one OS auth to
  // confirm biometry works before persisting, so a lock never promises Face ID on
  // a device where it fails (false = unavailable, or the confirm was
  // cancelled/failed, or there's no such lock). DISABLING just clears the flag —
  // the password lock stays and never unlocks (docs/locks.md — biometric is a
  // convenience layer over the password, not a replacement).
  setAppBiometric: (enabled: boolean) => Promise<boolean>;
  setListBiometric: (listId: string, enabled: boolean) => Promise<boolean>;
}

// How long the app may sit in the background before a return to the foreground
// re-engages every lock. A grace window, not zero, so quick app-switches (copy a
// 2FA code, take a call, the OS biometric/permission sheet) don't force a
// re-unlock; long enough away and the device is assumed out of the user's hands.
// A fixed default for now — a device-local "auto-lock after…" setting can tune it
// later.
const AUTO_RELOCK_AFTER_MS = 60_000;

const LockContext = createContext<(Locks & LockMutations) | null>(null);

export function LockProvider({ children }: { children: ReactNode }) {
  const { storeStatus } = useSync();
  const lists = useLists();

  // undefined on the very first render → status 'checking'.
  const locks = useLiveRead(() => readLocks(), [], ['locks']);

  // Lock row ids opened this session (APP_LOCK_ID and/or list ids). In-memory
  // only — the whole point; see the header.
  const [unlockedIds, setUnlockedIds] = useState<ReadonlySet<string>>(new Set());

  // When the app last went to the background (null while foregrounded). Drives
  // the auto-relock effect below; a ref, not state, since only the effect reads
  // it and it must never trigger a render.
  const backgroundedAt = useRef<number | null>(null);

  // Device biometric capability, probed once (unavailable until it resolves — so
  // affordances only appear once we know biometry is usable).
  const [biometricCap, setBiometricCap] = useState<BiometricCapability>({
    available: false,
    label: '',
  });
  useEffect(() => {
    let alive = true;
    void getBiometricCapability().then((cap) => {
      if (alive) setBiometricCap(cap);
    });
    return () => {
      alive = false;
    };
  }, []);

  const listLockRows = useMemo(() => {
    const rows = new Map<string, LockRecord>();
    for (const lock of locks ?? []) if (lock.kind === 'list') rows.set(lock.id, lock);
    return rows;
  }, [locks]);

  // Orphan sweep: list deletion SYNCS from other devices while locks are
  // device-local, so a lock can outlive its list. Guarded to a ready store with
  // a resolved, non-empty tree — readLists always includes the system lists
  // once resolved, so an empty tree means "still loading", and sweeping then
  // would wrongly drop every list lock.
  useEffect(() => {
    if (storeStatus !== 'ready' || locks === undefined || lists.length === 0) return;
    const listIds = new Set<string>();
    const collect = (nodes: TreeNode<ListItem>[]) => {
      for (const node of nodes) {
        listIds.add(node.item.id);
        collect(node.children);
      }
    };
    collect(lists);
    const orphans = (locks ?? []).filter((l) => l.kind === 'list' && !listIds.has(l.id));
    if (orphans.length === 0) return;
    void Promise.all(orphans.map((l) => deleteLock(l.id))).catch(() => {
      // Best-effort; the rows are invisible in the UI either way and the next
      // lists change retries.
    });
  }, [storeStatus, locks, lists]);

  // Auto-relock on return from a prolonged background — the "time-based +
  // app-state" rule as ONE mechanism: stamp the time on `background`, and on the
  // next `active` drop EVERY session unlock if the app was away longer than the
  // grace window. Deliberately keyed off the `background` transition (not the
  // transient iOS `inactive`) and gated on elapsed time, so Control Center, the
  // biometric/permission sheet, a call, or a 2-second app-switch never re-prompt;
  // a genuinely-away device relocks. Clearing to an empty set re-engages the app
  // lock and every unlocked list at once — if the device left the user's hands,
  // trust nothing still open. See the header (and docs/locks.md) for why this is
  // expo-only.
  useEffect(() => {
    const sub = AppState.addEventListener('change', (next) => {
      if (next === 'background') {
        backgroundedAt.current = Date.now();
        return;
      }
      if (next === 'active') {
        const at = backgroundedAt.current;
        backgroundedAt.current = null;
        if (at !== null && Date.now() - at > AUTO_RELOCK_AFTER_MS) {
          // Stable identity when nothing is unlocked, so this is a true no-op then.
          setUnlockedIds((prev) => (prev.size === 0 ? prev : new Set()));
        }
      }
    });
    return () => sub.remove();
  }, []);

  const coverage = useMemo(
    () => computeCoverage(lists, listLockRows, unlockedIds),
    [lists, listLockRows, unlockedIds],
  );

  const listLocks = useMemo(() => {
    const infos = new Map<string, ListLockInfo>();
    for (const [id, row] of listLockRows) {
      infos.set(id, {
        locked: !unlockedIds.has(id),
        hideList: row.hideList ?? false,
        biometric: row.biometric ?? false,
      });
    }
    return infos;
  }, [listLockRows, unlockedIds]);

  const appLockRow = locks?.find((l) => l.kind === 'app');
  const appLockExists = appLockRow !== undefined;
  const appLockUnlocked = appLockRow === undefined || unlockedIds.has(appLockRow.id);
  const appLockBiometric = appLockRow?.biometric ?? false;

  const markUnlocked = useCallback((id: string) => {
    setUnlockedIds((prev) => {
      const next = new Set(prev);
      next.add(id);
      return next;
    });
  }, []);

  const markLocked = useCallback((id: string) => {
    setUnlockedIds((prev) => {
      if (!prev.has(id)) return prev;
      const next = new Set(prev);
      next.delete(id);
      return next;
    });
  }, []);

  // Verify a password against one lock row and open it on a match. Reads the row
  // fresh from the store (not the live snapshot) so a just-written lock is
  // always verifiable.
  const unlock = useCallback(
    async (lockId: string, password: string): Promise<boolean> => {
      const row = (await readLocks()).find((l) => l.id === lockId);
      if (row === undefined) return false;
      const ok = await verifyLockPassword(password, row);
      if (ok) markUnlocked(lockId);
      return ok;
    },
    [markUnlocked],
  );

  const unlockApp = useCallback((password: string) => unlock(APP_LOCK_ID, password), [unlock]);

  const unlockList = useCallback(
    async (listId: string, password: string) => {
      // Two locks can gate one list — its OWN row and a locked ancestor's (the
      // covering lock). Try the own row first, then the covering one, so the
      // password opens whichever it belongs to (web's rationale, verbatim).
      const candidates = [listId];
      const covering = coverage.coveringLockIds.get(listId);
      if (covering !== undefined && covering !== listId) candidates.push(covering);
      for (const lockId of candidates) {
        if (await unlock(lockId, password)) return true;
      }
      return false;
    },
    [coverage, unlock],
  );

  const isListLocked = useCallback(
    (listId: string) => coverage.lockedListIds.has(listId),
    [coverage],
  );

  const setAppLock = useCallback(
    async (password: string) => {
      const verifier = await createLockVerifier(password);
      await putLock({ id: APP_LOCK_ID, kind: 'app', ...verifier });
      markUnlocked(APP_LOCK_ID);
    },
    [markUnlocked],
  );

  const removeAppLock = useCallback(
    async (password: string): Promise<boolean> => {
      const row = (await readLocks()).find((l) => l.id === APP_LOCK_ID);
      if (row === undefined) return true; // already gone
      if (!(await verifyLockPassword(password, row))) return false;
      await deleteLock(APP_LOCK_ID);
      markLocked(APP_LOCK_ID);
      return true;
    },
    [markLocked],
  );

  const addListLock = useCallback(
    async (listId: string, password: string, opts: { hideList: boolean }) => {
      const verifier = await createLockVerifier(password);
      await putLock({ id: listId, kind: 'list', ...verifier, hideList: opts.hideList });
      // Drop any stale unlock from an earlier lock on the same list this
      // session — a fresh lock engages immediately.
      markLocked(listId);
    },
    [markLocked],
  );

  const removeListLock = useCallback(
    async (listId: string, password: string): Promise<boolean> => {
      const row = (await readLocks()).find((l) => l.id === listId && l.kind === 'list');
      if (row === undefined) return true; // already gone
      if (!(await verifyLockPassword(password, row))) return false;
      await deleteLock(listId);
      markLocked(listId);
      return true;
    },
    [markLocked],
  );

  // Re-lock without a password: just drop the session unlock (markLocked no-ops
  // when the id isn't currently unlocked, so these are safe to call any time).
  const lockApp = useCallback(() => markLocked(APP_LOCK_ID), [markLocked]);
  const lockList = useCallback((listId: string) => markLocked(listId), [markLocked]);

  const biometricForList = useCallback(
    (listId: string): boolean => {
      if (!biometricCap.available) return false;
      const covering = coverage.coveringLockIds.get(listId) ?? listId;
      return listLockRows.get(covering)?.biometric ?? false;
    },
    [biometricCap.available, coverage, listLockRows],
  );

  // Biometric unlock: the OS boolean gate opens the same in-memory unlock a
  // password would. Re-reads the row fresh and re-checks the opt-in, so a flag
  // just toggled off can't be bypassed by a stale snapshot.
  const unlockAppWithBiometric = useCallback(async (): Promise<boolean> => {
    if (!biometricCap.available) return false;
    const row = (await readLocks()).find((l) => l.id === APP_LOCK_ID);
    if (row === undefined || !row.biometric) return false;
    const ok = await authenticateBiometric('Unlock Bracemark');
    if (ok) markUnlocked(APP_LOCK_ID);
    return ok;
  }, [biometricCap.available, markUnlocked]);

  const unlockListWithBiometric = useCallback(
    async (listId: string): Promise<boolean> => {
      if (!biometricCap.available) return false;
      // Open the lock actually gating the list — its covering lock (own row or a
      // locked ancestor's), the same target unlockList would verify against.
      const covering = coverage.coveringLockIds.get(listId) ?? listId;
      const row = (await readLocks()).find((l) => l.id === covering);
      if (row === undefined || !row.biometric) return false;
      const ok = await authenticateBiometric('Unlock this list');
      if (ok) markUnlocked(covering);
      return ok;
    },
    [biometricCap.available, coverage, markUnlocked],
  );

  // Enable/disable biometric on an existing lock. Enabling confirms biometry
  // works first (never persist a promise the device can't keep); disabling is a
  // free flag clear — the password lock is untouched. Writes back the whole row
  // (verifier + flags) via putLock's upsert.
  const setBiometricFlag = useCallback(
    async (lockId: string, kind: 'app' | 'list', enabled: boolean): Promise<boolean> => {
      const row = (await readLocks()).find((l) => l.id === lockId && l.kind === kind);
      if (row === undefined) return false;
      if (enabled) {
        if (!biometricCap.available) return false;
        if (!(await authenticateBiometric('Enable biometric unlock'))) return false;
      }
      await putLock({ ...row, biometric: enabled });
      return true;
    },
    [biometricCap.available],
  );

  const setAppBiometric = useCallback(
    (enabled: boolean) => setBiometricFlag(APP_LOCK_ID, 'app', enabled),
    [setBiometricFlag],
  );
  const setListBiometric = useCallback(
    (listId: string, enabled: boolean) => setBiometricFlag(listId, 'list', enabled),
    [setBiometricFlag],
  );

  const value = useMemo<Locks & LockMutations>(
    () => ({
      status: locks === undefined ? 'checking' : 'ready',
      appLock: { exists: appLockExists, unlocked: appLockUnlocked, biometric: appLockBiometric },
      biometricAvailable: biometricCap.available,
      biometricLabel: biometricCap.label,
      lockedListIds: coverage.lockedListIds,
      hiddenListIds: coverage.hiddenListIds,
      listLocks,
      isListLocked,
      unlockApp,
      unlockList,
      lockApp,
      lockList,
      biometricForList,
      unlockAppWithBiometric,
      unlockListWithBiometric,
      setAppLock,
      removeAppLock,
      addListLock,
      removeListLock,
      setAppBiometric,
      setListBiometric,
    }),
    [
      locks,
      appLockExists,
      appLockUnlocked,
      appLockBiometric,
      biometricCap,
      coverage,
      listLocks,
      isListLocked,
      unlockApp,
      unlockList,
      lockApp,
      lockList,
      biometricForList,
      unlockAppWithBiometric,
      unlockListWithBiometric,
      setAppLock,
      removeAppLock,
      addListLock,
      removeListLock,
      setAppBiometric,
      setListBiometric,
    ],
  );

  return <LockContext.Provider value={value}>{children}</LockContext.Provider>;
}

function useLockContext(): Locks & LockMutations {
  const value = useContext(LockContext);
  if (!value) throw new Error('useLocks must be used within a LockProvider');
  return value;
}

export function useLocks(): Locks {
  return useLockContext();
}

export function useLockMutations(): LockMutations {
  return useLockContext();
}
