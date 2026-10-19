// Specs for the links-drawer collapse state. This store's whole contract is that it
// must never be able to break the sidebar: it is read during a render of the nav, it is
// written on every collapse toggle, and its backing store is localStorage — which can be
// absent (private mode, SSR), full, or holding a value some other build wrote.
//
// So both halves degrade rather than throw, and the read is defensive about a shape it
// does not control: a non-array, or an array with a stray non-string, becomes a clean
// string list. A bad id costs nothing — it simply matches no section and stays inert —
// whereas a throw takes the whole drawer down, and a `string[]` that actually contains a
// number reaches the consumers' `Set` lookups as a silent never-match.
//
// Storage is stubbed rather than jsdom-provided: this package's jest environment is
// 'node' (jest.config.cts), and the ABSENT-storage branch is a real production path that
// no test could reach if a DOM were always present.

import {
  clearSidebarCollapsedIds,
  clearSidebarRail,
  DEFAULT_SIDEBAR_RAIL,
  getSidebarRail,
  readSidebarCollapsedIds,
  subscribeSidebarRail,
  writeSidebarCollapsedIds,
  writeSidebarRail,
} from './sidebar-view-store';

const STORAGE_KEY = 'bracemark:sidebar-collapsed';

function installStorage(seed: Record<string, string> = {}): void {
  const store = new Map(Object.entries(seed));
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => void store.set(key, value),
      removeItem: (key: string) => void store.delete(key),
    },
  });
}

function removeStorage(): void {
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: undefined });
}

afterEach(() => {
  // The rail's in-memory fallback outlives a storage swap by design (that is its
  // job), so each case starts from a wiped rail rather than inheriting one.
  clearSidebarRail();
  removeStorage();
});

describe('readSidebarCollapsedIds', () => {
  // "Everything expanded" is the safe default for every failure below — the user sees
  // their nav, just not collapsed the way they left it.
  it('is empty when nothing has been stored', () => {
    installStorage();

    expect(readSidebarCollapsedIds()).toEqual([]);
  });

  it('is empty when there is no storage at all, rather than throwing', () => {
    removeStorage();

    expect(readSidebarCollapsedIds()).toEqual([]);
  });

  it('round-trips a written set', () => {
    installStorage();
    writeSidebarCollapsedIds(['lists', 'li_1']);

    expect(readSidebarCollapsedIds()).toEqual(['lists', 'li_1']);
  });

  it('is empty for a value that is not JSON', () => {
    installStorage({ [STORAGE_KEY]: 'not json at all' });

    expect(readSidebarCollapsedIds()).toEqual([]);
  });

  // Valid JSON of the wrong shape — the case a bare `JSON.parse` would hand straight to
  // a consumer expecting to iterate it.
  it('is empty for JSON that is not an array', () => {
    installStorage({ [STORAGE_KEY]: JSON.stringify({ lists: true }) });

    expect(readSidebarCollapsedIds()).toEqual([]);
  });

  // The narrowing that makes the declared `string[]` honest: a stray non-string is
  // dropped, not passed through to fail a `Set<string>` lookup forever.
  it('drops non-string entries rather than passing them through', () => {
    installStorage({ [STORAGE_KEY]: JSON.stringify(['lists', 42, null, 'tags']) });

    expect(readSidebarCollapsedIds()).toEqual(['lists', 'tags']);
  });
});

describe('writeSidebarCollapsedIds', () => {
  // The in-memory set still drives this session's UI — a failed persist must never
  // surface at a collapse toggle.
  it('is a no-op when storage is unavailable', () => {
    removeStorage();

    expect(() => writeSidebarCollapsedIds(['lists'])).not.toThrow();
  });

  it('is a no-op when storage throws', () => {
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      value: {
        getItem: () => null,
        setItem: () => {
          throw new DOMException('QuotaExceededError');
        },
        removeItem: () => undefined,
      },
    });

    expect(() => writeSidebarCollapsedIds(['lists'])).not.toThrow();
  });

  // The hook passes the WHOLE set each toggle, so a write replaces rather than merges —
  // otherwise nothing could ever be expanded again.
  it('replaces the stored set rather than merging into it', () => {
    installStorage();
    writeSidebarCollapsedIds(['lists', 'tags']);
    writeSidebarCollapsedIds(['tags']);

    expect(readSidebarCollapsedIds()).toEqual(['tags']);
  });
});

describe('clearSidebarCollapsedIds', () => {
  // Called from the sign-out teardown: these ids are the previous account's list/tag
  // ids, so the next account must not inherit them.
  it('drops the stored set so the next account cannot inherit it', () => {
    installStorage();
    writeSidebarCollapsedIds(['li_1']);

    clearSidebarCollapsedIds();

    expect(readSidebarCollapsedIds()).toEqual([]);
  });

  it('is a no-op when storage is unavailable', () => {
    removeStorage();

    expect(() => clearSidebarCollapsedIds()).not.toThrow();
  });
});

// The desktop rail's dock state. Two things are pinned beyond the ids' contract above:
// it is read through `useSyncExternalStore`, which re-renders forever on a snapshot that
// is a new object for an unchanged store; and it is the ONLY copy of the rail's state —
// so a storage that refuses the write must still leave the toggle working for the tab.
describe('the rail', () => {
  it('is docked at the default width when nothing has been stored', () => {
    installStorage();

    expect(getSidebarRail()).toEqual(DEFAULT_SIDEBAR_RAIL);
  });

  it('merges a write into what is stored, and the next read returns it', () => {
    installStorage();
    writeSidebarRail({ width: 300 });
    writeSidebarRail({ collapsed: true });

    expect(getSidebarRail()).toEqual({ collapsed: true, width: 300 });
  });

  // The loop guard: `useSyncExternalStore` compares snapshots by identity.
  it('returns the same object until the stored value changes', () => {
    installStorage();
    writeSidebarRail({ width: 300 });
    const first = getSidebarRail();

    expect(getSidebarRail()).toBe(first);
    writeSidebarRail({ width: 320 });
    expect(getSidebarRail()).not.toBe(first);
  });

  it.each([
    ['not JSON', 'nope'],
    ['not an object', JSON.stringify(['collapsed'])],
    ['a truthy non-boolean collapse', JSON.stringify({ collapsed: 'yes', width: 300 })],
    ['a non-numeric width', JSON.stringify({ collapsed: false, width: '300px' })],
    ['a non-finite width', '{"collapsed":false,"width":1e999}'],
    ['a negative width', JSON.stringify({ collapsed: false, width: -5 })],
  ])('reads %s as docked and/or default-width, never hidden', (_label, raw) => {
    installStorage({ 'bracemark:sidebar-rail': raw });
    const rail = getSidebarRail();

    expect(rail.collapsed).toBe(false);
    expect(rail.width === null || rail.width === 300).toBe(true);
  });

  it('notifies subscribers on a write and on the wipe, and not after unsubscribing', () => {
    installStorage();
    const listener = jest.fn();
    const unsubscribe = subscribeSidebarRail(listener);

    writeSidebarRail({ collapsed: true });
    clearSidebarRail();
    expect(listener).toHaveBeenCalledTimes(2);

    unsubscribe();
    writeSidebarRail({ collapsed: false });
    expect(listener).toHaveBeenCalledTimes(2);
  });

  // Storage refusing the write would otherwise leave the snapshot — which IS the stored
  // value — unchanged, and Hide sidebar would do nothing at all.
  it.each([
    ['absent', () => removeStorage()],
    [
      'throwing',
      () =>
        Object.defineProperty(globalThis, 'localStorage', {
          configurable: true,
          value: {
            getItem: () => null,
            setItem: () => {
              throw new DOMException('QuotaExceededError');
            },
            removeItem: () => undefined,
          },
        }),
    ],
  ])('still collapses for this tab when storage is %s', (_label, install) => {
    install();

    writeSidebarRail({ collapsed: true });

    expect(getSidebarRail().collapsed).toBe(true);
    clearSidebarRail();
    expect(getSidebarRail()).toEqual(DEFAULT_SIDEBAR_RAIL);
  });

  // The sign-out teardown — the next account on this device starts from the default.
  it('is back at the default after the wipe', () => {
    installStorage();
    writeSidebarRail({ collapsed: true, width: 320 });

    clearSidebarRail();

    expect(getSidebarRail()).toEqual(DEFAULT_SIDEBAR_RAIL);
  });
});
