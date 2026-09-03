// The `browser` namespace, faked for jest.
//
// WXT auto-imports `browser` into every module that says the word, so under jest it
// has to exist as a real global (testing/setup.ts installs one of these before each
// test). Everything the extension actually calls is here and nothing else — an
// unimplemented API should fail loudly rather than resolve to undefined.
//
// `storage.local` is a REAL in-memory store rather than a pair of `jest.fn()`s, and
// it fires `storage.onChanged` on every write. That is the whole contract between
// the background worker and the two React surfaces (docs/browser-extension.md,
// _storage across extension contexts_): the worker writes the sync mirror, the popup
// reads it or subscribes. Stubbing get/set independently would let a spec pass while
// the two halves disagreed about the key.

export interface StorageChange {
  oldValue?: unknown;
  newValue?: unknown;
}

export type StorageChangedListener = (
  changes: Record<string, StorageChange>,
  areaName: string,
) => void;

export type AlarmListener = (alarm: { name: string }) => void;

export type MessageListener = (
  message: unknown,
  sender: unknown,
  sendResponse: (response: unknown) => void,
) => boolean | void;

export interface FakeTab {
  id?: number;
  windowId?: number;
  url?: string;
  title?: string;
  favIconUrl?: string;
}

export interface FakeBrowser {
  runtime: {
    sendMessage: jest.Mock;
    openOptionsPage: jest.Mock;
    getManifest: jest.Mock<{ version: string }, []>;
    onMessage: {
      addListener: jest.Mock<void, [MessageListener]>;
      /** The listener background.ts registered, for a spec to drive directly. */
      listener: MessageListener | null;
    };
  };
  tabs: {
    query: jest.Mock<Promise<FakeTab[]>, [unknown]>;
    create: jest.Mock;
    captureVisibleTab: jest.Mock<Promise<string>, [number, unknown]>;
  };
  scripting: {
    executeScript: jest.Mock;
  };
  alarms: {
    create: jest.Mock;
    onAlarm: {
      addListener: jest.Mock<void, [AlarmListener]>;
      /** Fire every registered alarm listener, as the browser would. */
      dispatch: (name: string) => void;
    };
  };
  storage: {
    local: {
      get: (key?: string | string[] | null) => Promise<Record<string, unknown>>;
      set: (items: Record<string, unknown>) => Promise<void>;
      /** Read a key synchronously, for assertions. */
      peek: (key: string) => unknown;
    };
    onChanged: {
      addListener: jest.Mock<void, [StorageChangedListener]>;
      removeListener: jest.Mock<void, [StorageChangedListener]>;
      /** Emit a change from an area a spec chooses (e.g. 'sync', to prove it's ignored). */
      emit: (changes: Record<string, StorageChange>, areaName: string) => void;
    };
  };
}

export function createFakeBrowser(): FakeBrowser {
  const store = new Map<string, unknown>();
  const storageListeners = new Set<StorageChangedListener>();
  const alarmListeners = new Set<AlarmListener>();

  const onChanged: FakeBrowser['storage']['onChanged'] = {
    addListener: jest.fn((l: StorageChangedListener) => {
      storageListeners.add(l);
    }),
    removeListener: jest.fn((l: StorageChangedListener) => {
      storageListeners.delete(l);
    }),
    emit: (changes, areaName) => {
      for (const l of [...storageListeners]) l(changes, areaName);
    },
  };

  const fake: FakeBrowser = {
    runtime: {
      sendMessage: jest.fn(async () => ({ ok: true })),
      openOptionsPage: jest.fn(),
      getManifest: jest.fn(() => ({ version: '0.0.1' })),
      onMessage: {
        addListener: jest.fn((l: MessageListener) => {
          fake.runtime.onMessage.listener = l;
        }),
        listener: null,
      },
    },
    tabs: {
      query: jest.fn(async (_query: unknown) => [] as FakeTab[]),
      create: jest.fn(async () => ({})),
      captureVisibleTab: jest.fn(async (_windowId: number, _options: unknown) => ''),
    },
    scripting: {
      executeScript: jest.fn(async () => [{ result: undefined }]),
    },
    alarms: {
      create: jest.fn(),
      onAlarm: {
        addListener: jest.fn((l: AlarmListener) => {
          alarmListeners.add(l);
        }),
        dispatch: (name: string) => {
          for (const l of [...alarmListeners]) l({ name });
        },
      },
    },
    storage: {
      local: {
        get: async (key) => {
          if (key == null) return Object.fromEntries(store);
          const keys = Array.isArray(key) ? key : [key];
          const out: Record<string, unknown> = {};
          for (const k of keys) if (store.has(k)) out[k] = store.get(k);
          return out;
        },
        set: async (items) => {
          const changes: Record<string, StorageChange> = {};
          for (const [k, v] of Object.entries(items)) {
            changes[k] = { oldValue: store.get(k), newValue: v };
            store.set(k, v);
          }
          onChanged.emit(changes, 'local');
        },
        peek: (key) => store.get(key),
      },
      onChanged,
    },
  };

  return fake;
}

/** Install a fresh fake as the `browser` global and return it. */
export function installFakeBrowser(): FakeBrowser {
  const fake = createFakeBrowser();
  (globalThis as { browser?: unknown }).browser = fake;
  return fake;
}
