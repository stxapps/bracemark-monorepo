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
  readSidebarCollapsedIds,
  writeSidebarCollapsedIds,
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
