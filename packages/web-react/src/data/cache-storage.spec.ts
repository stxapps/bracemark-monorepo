// The sign-out's reach into the service worker's Cache Storage
// (docs/offline-mode.md, _sign-out leaves the worker alone_). Two rules, both silent
// when broken: account-bearing KEYS go (a runtime entry for `/links?list=<id>` names
// this account's lists), and the PRECACHE stays — deleting its revision-keyed entries
// would take offline support away from the next sign-in until the worker reinstalls.
//
// Node has no Cache Storage, so a small in-memory one stands in: the function only
// ever calls keys/open/keys/delete.

import { purgeAccountCacheKeys } from './cache-storage';

type FakeCaches = Map<string, Map<string, Request>>;

function installCaches(entries: Record<string, string[]>): FakeCaches {
  const store: FakeCaches = new Map(
    Object.entries(entries).map(([name, urls]) => [
      name,
      new Map(urls.map((url) => [url, new Request(url)])),
    ]),
  );
  const fake = {
    keys: async () => [...store.keys()],
    open: async (name: string) => {
      const cache = store.get(name) ?? new Map<string, Request>();
      store.set(name, cache);
      return {
        keys: async () => [...cache.values()],
        delete: async (request: Request) => cache.delete(request.url),
      };
    },
  };
  Object.defineProperty(globalThis, 'caches', { configurable: true, value: fake });
  return store;
}

const urls = (store: FakeCaches, name: string) => [...(store.get(name)?.keys() ?? [])].sort();

afterEach(() => {
  delete (globalThis as { caches?: unknown }).caches;
});

describe('purgeAccountCacheKeys', () => {
  it('drops query-keyed runtime entries and keeps everything else', async () => {
    const store = installCaches({
      pages: ['https://app.test/links', 'https://app.test/links?list=l_secret&tag=t_secret'],
      'pages-rsc': ['https://app.test/settings/data.txt?_rsc=abc', 'https://app.test/links.txt'],
      'static-js-assets': ['https://app.test/_next/static/chunks/a.js'],
    });

    await purgeAccountCacheKeys();

    expect(urls(store, 'pages')).toEqual(['https://app.test/links']);
    expect(urls(store, 'pages-rsc')).toEqual(['https://app.test/links.txt']);
    expect(urls(store, 'static-js-assets')).toEqual(['https://app.test/_next/static/chunks/a.js']);
  });

  it('never touches the precache, revision queries and all', async () => {
    const store = installCaches({
      'serwist-precache-v2-https://app.test/': [
        'https://app.test/manifest.json?__WB_REVISION__=abc',
        'https://app.test/links',
      ],
    });

    await purgeAccountCacheKeys();

    expect(urls(store, 'serwist-precache-v2-https://app.test/')).toHaveLength(2);
  });

  it('is a no-op without Cache Storage', async () => {
    await expect(purgeAccountCacheKeys()).resolves.toBeUndefined();
  });
});
