// Specs for the favicon cache's one piece of policy: `isFaviconStale`, the shared
// "is there nothing usable for this host right now?" verdict. The provider's fetch gate
// and the hook's request trigger both call it precisely so they cannot disagree — and if
// they ever did, the symptom is not an error but a fetch loop: the hook keeps asking, the
// gate keeps declining, and one host's icon never appears while the queue churns.
//
// The two asymmetries are the whole point, and both are decisions a refactor could
// plausibly "tidy" away:
//   - an `ok` row NEVER expires (a site that changes its icon is cosmetic staleness no
//     user would trade a re-fetch-per-host for), and
//   - a `none` row expires at FAVICON_RETRY_MS, so a site that later adds a favicon is
//     eventually picked up.
// The boundary is `>=`, tested from the constant rather than from a restated week.

import { db } from './db';
import {
  FAVICON_RETRY_MS,
  isFaviconStale,
  putFavicon,
  putFaviconNone,
  readFavicon,
} from './favicon-store';
import { AccountFencedError, seedNewAccount } from './sync-store';

const USER = 'alice';
const HOST = 'github.com';
const NOW = 1_700_000_000_000;

beforeEach(async () => {
  await db.favicons.clear();
  await db.syncMeta.clear();
  // Both writes are fenced on the account's ownership row.
  await seedNewAccount(USER);
});

describe('isFaviconStale', () => {
  // An unknown host is the fetchable case — this is what starts every first fetch.
  it('treats a host that was never resolved as stale', () => {
    expect(isFaviconStale(undefined, NOW)).toBe(true);
  });

  // `ok` never expires, however old. Written as an absurd age so a future TTL added to
  // the ok branch fails here rather than quietly re-fetching every icon in the library.
  it('never treats a stored icon as stale, at any age', () => {
    const record = { host: HOST, status: 'ok' as const, bytes: new Uint8Array([1]), fetchedAt: 0 };

    expect(isFaviconStale(record, NOW)).toBe(false);
    expect(isFaviconStale(record, NOW + FAVICON_RETRY_MS * 100)).toBe(false);
  });

  it('holds a `none` verdict for the retry window', () => {
    const record = { host: HOST, status: 'none' as const, fetchedAt: NOW };

    expect(isFaviconStale(record, NOW + FAVICON_RETRY_MS - 1)).toBe(false);
  });

  // `>=`, not `>`: the boundary itself is stale. Pinned because a `<`/`<=` slip here is
  // invisible — it just shifts one retry by a millisecond — but it's the kind of edit
  // that gets made while "simplifying" the comparison.
  it('releases a `none` verdict exactly at the retry window', () => {
    const record = { host: HOST, status: 'none' as const, fetchedAt: NOW };

    expect(isFaviconStale(record, NOW + FAVICON_RETRY_MS)).toBe(true);
  });
});

describe('putFavicon / putFaviconNone', () => {
  it('stores an icon’s bytes under its host', async () => {
    await putFavicon(USER, HOST, new Uint8Array([1, 2, 3]));

    const record = await readFavicon(HOST);
    expect(record?.status).toBe('ok');
    expect(record?.bytes).toEqual(new Uint8Array([1, 2, 3]));
  });

  // Recording the negative is what stops a reload from re-buying a fetch for every
  // iconless host in the library — a skipped write would look identical until you watch
  // the network tab.
  it('records a miss as a `none` row rather than leaving the host unknown', async () => {
    await putFaviconNone(USER, HOST);

    const record = await readFavicon(HOST);
    expect(record?.status).toBe('none');
    expect(record?.bytes).toBeUndefined();
    // Fresh at the moment it was written — the whole point of recording the miss.
    expect(isFaviconStale(record, record?.fetchedAt ?? 0)).toBe(false);
  });

  // A host that grows a favicon must be able to leave the `none` state, and the stale
  // icon bytes of a re-fetch must be replaced rather than accumulated.
  it('lets a host move between verdicts, one row per host', async () => {
    await putFaviconNone(USER, HOST);
    await putFavicon(USER, HOST, new Uint8Array([9]));

    expect((await readFavicon(HOST))?.status).toBe('ok');
    expect(await db.favicons.count()).toBe(1);
  });

  it('is undefined for a host nothing has resolved', async () => {
    expect(await readFavicon('never-seen.example')).toBeUndefined();
  });
});

// THE FENCE. The provider writes after a network round trip, so a sign-out can have wiped
// the store underneath it — and the table has no owner column to notice with. A browser
// tab never showed it (sign-out leaves the origin, and the document goes with the fetch);
// the INSTALLED app stays, and there the late write put the signed-out account's host back
// into the empty table after clearData had been and gone.
describe('the account fence', () => {
  it('refuses an icon that lands after the account signed out', async () => {
    await db.syncMeta.clear();

    await expect(putFavicon(USER, HOST, new Uint8Array([1]))).rejects.toBeInstanceOf(
      AccountFencedError,
    );

    expect(await db.favicons.count()).toBe(0);
  });

  it('refuses a `none` verdict the same way', async () => {
    await db.syncMeta.clear();

    await expect(putFaviconNone(USER, HOST)).rejects.toBeInstanceOf(AccountFencedError);

    expect(await db.favicons.count()).toBe(0);
  });

  // The store may not be empty: the next account can have signed in while the fetch was
  // out. The late answer is the PREVIOUS account's, so it is refused by name.
  it('refuses a write for an account that is no longer the one signed in', async () => {
    await db.syncMeta.clear();
    await seedNewAccount('bob');

    await expect(putFavicon(USER, HOST, new Uint8Array([1]))).rejects.toBeInstanceOf(
      AccountFencedError,
    );

    expect(await db.favicons.count()).toBe(0);
  });
});
