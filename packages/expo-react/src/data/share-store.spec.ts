// Specs for share-store: the taxonomy builders the snapshot/live paths share,
// the defensive parses guarding what crosses the App Group container, and the
// outbox drain's FILE handling — above all that a file the drain can't read is
// quarantined rather than deleted (an outbox draft is sometimes the only copy of
// a share) — and the one rule the post-Add kick carries: an EXPIRED session
// sends nothing. And the Android handoff: the marker a save leaves for the main
// app, which is the only thing that gets that share its page fetch. What the
// drain writes into sqlite, and the encrypt/upload itself, stay on-device
// (docs/share-sheet.md).
//
// The import graph reaches the native stores (db.ts → expo-sqlite, the App Group
// helpers → expo-file-system, session-store → expo-secure-store). The pure
// functions never call them, but the drain does — so expo-file-system gets an
// in-memory stand-in (the shape session-store.spec.ts established) and the
// stores behind applyShareDraft are stubbed to no-ops. This file asserts where
// FILES end up, nothing about the writes.
import { Platform } from 'react-native';

import {
  type ApiClient,
  ARCHIVE_ID,
  type AuthApiClient,
  type List,
  MY_LIST_ID,
  rankBetween,
  SYSTEM_LIST_DEFAULTS,
  type Tag,
  TRASH_ID,
} from '@stxapps/shared';

import { runIncrementalSync } from '../sync/engine';
import { writeLink } from './mutations';
import { countLinks } from './queries';
import { getSession, loadSharedSession } from './session-store';
import {
  buildShareLists,
  buildShareTags,
  clearShareData,
  drainShareOutbox,
  isAtLinkCap,
  parseShareDraft,
  parseShareTaxonomy,
  refreshShareTaxonomy,
  saveSharedDraft,
  type ShareDraft,
  type ShareTaxonomy,
  takeShareHandoffs,
} from './share-store';
import { uploadShareDraft } from './share-upload';
import { readCachedStatus } from './subscription-store';

// The in-memory filesystem behind the expo-file-system stand-in: uri → contents
// for files, a bare uri set for directories. Declared outside the factory
// (mock-prefixed so jest's hoisting allows the reference) so tests seed and
// inspect them directly; only the mock's METHOD BODIES read them, which is what
// keeps the hoisted factory clear of the TDZ.
const mockFiles = new Map<string, string>();
const mockDirs = new Set<string>();

// A stand-in for the app's api client. Nothing here reaches the network (the
// upload and the sync are mocked); `withSession` hands back a client of its own,
// so a spec can tell the session-bound one from the plain one.
function mockApi(): AuthApiClient & { bound: ApiClient } {
  const bound = { call: jest.fn() } as ApiClient;
  return { call: jest.fn(), withSession: jest.fn(() => bound), bound };
}

jest.mock('expo-sqlite', () => ({ openDatabaseSync: jest.fn() }));
// share-store's post-Add kicks reach the sync engine and the upload,
// whose import graphs end in native modules (react-native-quick-crypto via
// @stxapps/expo-crypto, expo-file-system/legacy via sync/r2) — inert them too.
jest.mock('@stxapps/expo-crypto', () => ({}));
jest.mock('expo-file-system/legacy', () => ({
  FileSystemUploadType: { BINARY_CONTENT: 'binaryContent' },
  uploadAsync: jest.fn(),
}));
jest.mock('expo-secure-store', () => ({
  AFTER_FIRST_UNLOCK: 'afterFirstUnlock',
  getItemAsync: jest.fn(async () => null),
  setItemAsync: jest.fn(),
  deleteItemAsync: jest.fn(),
}));
// A working File/Directory pair over the maps above — enough of the real API for
// the drain: exists / list / textSync / move / delete / create. Paths are joined
// scheme-less ('group/share/outbox/x.json') to keep the join trivial.
jest.mock('expo-file-system', () => {
  const join = (parts: unknown[]): string =>
    parts
      .map((part) => (typeof part === 'string' ? part : (part as { uri: string }).uri))
      .join('/')
      .replace(/\/+/g, '/')
      .replace(/\/$/, '');

  class MockFile {
    uri: string;
    constructor(...parts: unknown[]) {
      this.uri = join(parts);
    }
    get name(): string {
      return this.uri.slice(this.uri.lastIndexOf('/') + 1);
    }
    get exists(): boolean {
      return mockFiles.has(this.uri);
    }
    textSync(): string {
      const text = mockFiles.get(this.uri);
      // The real File throws on an unreadable path — the drain must survive it.
      if (text === undefined) throw new Error(`MockFile: no such file ${this.uri}`);
      return text;
    }
    write(text: string): void {
      mockFiles.set(this.uri, text);
    }
    create(): void {
      mockFiles.set(this.uri, '');
    }
    delete(): void {
      mockFiles.delete(this.uri);
    }
    move(destination: { uri: string }): void {
      const name = this.name;
      const text = mockFiles.get(this.uri) ?? '';
      mockFiles.delete(this.uri);
      this.uri = `${destination.uri}/${name}`;
      mockFiles.set(this.uri, text);
    }
  }

  class MockDirectory {
    uri: string;
    constructor(...parts: unknown[]) {
      this.uri = join(parts);
    }
    get exists(): boolean {
      return mockDirs.has(this.uri);
    }
    create(): void {
      mockDirs.add(this.uri);
    }
    delete(): void {
      const prefix = `${this.uri}/`;
      mockDirs.delete(this.uri);
      for (const uri of [...mockDirs]) if (uri.startsWith(prefix)) mockDirs.delete(uri);
      for (const uri of [...mockFiles.keys()]) if (uri.startsWith(prefix)) mockFiles.delete(uri);
    }
    // Direct children only, files and subdirectories alike — the drain relies on
    // telling them apart via `instanceof File`.
    list(): unknown[] {
      const prefix = `${this.uri}/`;
      const isChild = (uri: string) =>
        uri.startsWith(prefix) && !uri.slice(prefix.length).includes('/');
      return [
        ...[...mockFiles.keys()].filter(isChild).map((uri) => new MockFile(uri)),
        ...[...mockDirs].filter(isChild).map((uri) => new MockDirectory(uri)),
      ];
    }
  }

  return {
    Paths: { document: 'file:///documents/', cache: 'file:///cache/', appleSharedContainers: {} },
    File: MockFile,
    Directory: MockDirectory,
  };
});

// The App Group container root — the drain's `group`.
jest.mock('./app-group', () => ({
  appGroupDir: () => {
    const { Directory } = jest.requireMock<typeof import('expo-file-system')>('expo-file-system');
    return new Directory('group');
  },
}));

// A signed-in session, so the drain gets past its guard.
jest.mock('./session-store', () => ({
  getSession: jest.fn(() => ({ username: 'alice', encryptionKey: new Uint8Array(32) })),
  loadSession: jest.fn(async () => undefined),
  loadSharedSession: jest.fn(async () => null),
}));

// applyShareDraft's store edge. The drain's sqlite writes are on-device
// territory; these exist so a VALID draft can reach the end of the loop and have
// its file deleted, which is the half of the quarantine invariant that says
// "still delete what you did apply". The taxonomy now comes off the read edge
// (queries.ts), so that — not a hand-rolled drizzle stub — is what's stubbed;
// readLists' own system-default merge is spec'd in queries.spec.ts.
jest.mock('./queries', () => ({
  readLists: jest.fn(async () => []),
  readTags: jest.fn(async () => []),
  // readTaxonomyFromDb carries this onto the snapshot for the iOS cap gate, and
  // Android's isAtLinkCap counts through it live.
  countLinks: jest.fn(async () => 0),
}));
jest.mock('./item-store', () => ({
  getItem: jest.fn(async () => null),
}));
jest.mock('./subscription-store', () => ({ readCachedStatus: jest.fn(() => null) }));
jest.mock('./review-prompt-store', () => ({ countReviewPromptSave: jest.fn() }));
jest.mock('./mutations', () => ({
  writeLink: jest.fn(async () => undefined),
  writeList: jest.fn(async () => undefined),
  writeTag: jest.fn(async () => undefined),
  writeExtraction: jest.fn(async () => undefined),
}));
// The post-Add kicks — iOS's encrypt + PUT, Android's sync cycle — as bare
// spies: saveSharedDraft's only job toward them is whether to call at all.
jest.mock('./share-upload', () => ({ uploadShareDraft: jest.fn(async () => undefined) }));
jest.mock('./store-read-mode', () => ({ storeReadModeCopy: jest.fn(async () => true) }));
jest.mock('../sync/engine', () => ({ runIncrementalSync: jest.fn(async () => undefined) }));

const trashDefault = SYSTEM_LIST_DEFAULTS.find((def) => def.id === TRASH_ID);
if (!trashDefault) throw new Error('SYSTEM_LIST_DEFAULTS is missing Trash');
const trashRank = trashDefault.rank;
const archiveDefault = SYSTEM_LIST_DEFAULTS.find((def) => def.id === ARCHIVE_ID);
if (!archiveDefault) throw new Error('SYSTEM_LIST_DEFAULTS is missing Archive');

function makeList(id: string, name: string, parentId: string | null, rank: string): List {
  return { id, name, parentId, rank, createdAt: 1, updatedAt: 1 };
}

function makeTag(id: string, name: string, rank: string): Tag {
  return { id, name, parentId: null, rank, createdAt: 1, updatedAt: 1 };
}

// The iOS snapshot as refreshShareTaxonomy leaves it for `owner` — what an iOS
// Save re-reads to check the draft is still the signed-in account's.
function seedSnapshot(owner: string, fields: Partial<ShareTaxonomy> = {}): void {
  mockDirs.add('group/share');
  mockFiles.set(
    'group/share/taxonomy.json',
    JSON.stringify({ owner, lists: [], tags: [], linkCount: 0, maxLinks: null, ...fields }),
  );
}

describe('buildShareLists', () => {
  it('orders the tree and annotates depth + rank', () => {
    const rankA = rankBetween(trashRank, null);
    const rankB = rankBetween(null, null);
    // The ALREADY-MERGED logical set, as readLists() hands it over — a renamed
    // My List (the stored override, not the default name), the untouched system
    // defaults, then the user's lists. The merge itself is queries.spec.ts's.
    const lists = [
      makeList(MY_LIST_ID, 'Inbox', null, SYSTEM_LIST_DEFAULTS[0].rank),
      makeList(ARCHIVE_ID, archiveDefault.name, null, archiveDefault.rank),
      makeList(TRASH_ID, trashDefault.name, null, trashRank),
      makeList('list-a', 'Reading', null, rankA),
      makeList('list-b', 'Papers', 'list-a', rankB),
    ];

    const rows = buildShareLists(lists);

    // Ranks ride along so the sheet can mint neighbour ranks for its creates.
    expect(rows).toEqual([
      { id: MY_LIST_ID, name: 'Inbox', depth: 0, rank: SYSTEM_LIST_DEFAULTS[0].rank },
      { id: ARCHIVE_ID, name: 'Archive', depth: 0, rank: archiveDefault.rank },
      { id: 'list-a', name: 'Reading', depth: 0, rank: rankA },
      { id: 'list-b', name: 'Papers', depth: 1, rank: rankB },
    ]);
    // Trash never shows — saving into the deletion staging area is incoherent.
    // And ONLY Trash: hidden/locked lists stay pickable, like every editor
    // picker (docs/editors.md) — there is deliberately no lock filter here.
    expect(rows.some((row) => row.id === TRASH_ID)).toBe(false);
  });
});

describe('buildShareTags', () => {
  it('orders by rank regardless of input order', () => {
    const rA = rankBetween(null, null);
    const rB = rankBetween(rA, null);
    const rC = rankBetween(rB, null);
    const tags = [makeTag('c', 'gamma', rC), makeTag('a', 'alpha', rA), makeTag('b', 'beta', rB)];

    expect(buildShareTags(tags)).toEqual([
      { id: 'a', name: 'alpha', rank: rA },
      { id: 'b', name: 'beta', rank: rB },
      { id: 'c', name: 'gamma', rank: rC },
    ]);
  });
});

describe('parseShareDraft', () => {
  const draft: ShareDraft = {
    id: 'link-1',
    owner: 'alice',
    url: 'https://example.com/a',
    title: 'Example',
    listId: MY_LIST_ID,
    tagIds: ['tag-1', 'tag-2'],
    newTags: [{ id: 'tag-2', name: 'fresh', rank: 'a1' }],
    newLists: [{ id: 'list-new', name: 'Recipes', rank: 'Zz' }],
    sharedAt: 1_700_000_000_000,
  };

  it('round-trips a valid draft', () => {
    expect(parseShareDraft(JSON.stringify(draft))).toEqual(draft);
  });

  it('rejects a draft that names no account', () => {
    // No owner, no account to land it under — and landing it under whoever is
    // signed in is the bug the field exists to close.
    const { owner: _owner, ...ownerless } = draft;
    expect(parseShareDraft(JSON.stringify(ownerless))).toBeNull();
    expect(parseShareDraft(JSON.stringify({ ...draft, owner: '' }))).toBeNull();
  });

  it('rejects malformed payloads', () => {
    expect(parseShareDraft('not json')).toBeNull();
    expect(parseShareDraft(JSON.stringify({ ...draft, url: '' }))).toBeNull();
    expect(parseShareDraft(JSON.stringify({ ...draft, tagIds: 'nope' }))).toBeNull();
  });

  it('rejects a payload with a missing newLists or a rank-free new entry', () => {
    // No back-compat slack (see the header): the sheet always writes newLists
    // and always mints a rank, so either absence is corruption rather than an
    // older build — there is no older build.
    const { newLists: _newLists, ...noNewLists } = draft;
    expect(parseShareDraft(JSON.stringify(noNewLists))).toBeNull();
    expect(
      parseShareDraft(JSON.stringify({ ...draft, newTags: [{ id: 'tag-2', name: 'fresh' }] })),
    ).toBeNull();
    expect(
      parseShareDraft(
        JSON.stringify({ ...draft, newLists: [{ id: 'list-new', name: 'Recipes' }] }),
      ),
    ).toBeNull();
  });
});

describe('parseShareTaxonomy', () => {
  const taxonomy: ShareTaxonomy = {
    owner: 'alice',
    lists: [{ id: MY_LIST_ID, name: 'My List', depth: 0, rank: 'a0' }],
    tags: [{ id: 'tag-1', name: 'alpha', rank: 'a1' }],
    linkCount: 3,
    maxLinks: 200,
  };

  it('round-trips a valid snapshot', () => {
    expect(parseShareTaxonomy(JSON.stringify(taxonomy))).toEqual(taxonomy);
  });

  it('rejects a rank-free snapshot', () => {
    // refreshShareTaxonomy always writes ranks, so a rank-free row means a
    // corrupt file. Reading it as signed-out is the right answer: it points the
    // user at the app, which rewrites the snapshot.
    const old = {
      owner: 'alice',
      lists: [{ id: MY_LIST_ID, name: 'My List', depth: 0 }],
      tags: [{ id: 'tag-1', name: 'alpha' }],
    };
    expect(parseShareTaxonomy(JSON.stringify(old))).toBeNull();
  });

  it('rejects a snapshot that says a session is present but not whose', () => {
    // The shape before `owner`: a sheet rendered from it could not stamp its
    // drafts, so it reads as signed-out and the app rewrites it.
    const { owner: _owner, ...ownerless } = taxonomy;
    expect(parseShareTaxonomy(JSON.stringify({ ...ownerless, sessionPresent: true }))).toBeNull();
  });

  it('rejects a snapshot predating the cap fields', () => {
    // Same pre-release tightening as `rank` above: the cap fields are REQUIRED rather
    // than defaulted, so a snapshot without them reads as signed-out and the app
    // rewrites it — which is strictly safer than defaulting `maxLinks` to null
    // and letting a stale file silently disable the gate.
    const { linkCount: _c, maxLinks: _m, ...preCap } = taxonomy;
    expect(parseShareTaxonomy(JSON.stringify(preCap))).toBeNull();
  });

  it('rejects malformed payloads', () => {
    expect(parseShareTaxonomy('42')).toBeNull();
    expect(parseShareTaxonomy(JSON.stringify({ owner: 'alice' }))).toBeNull();
  });
});

describe('drainShareOutbox', () => {
  const OUTBOX = 'group/share/outbox';
  const FAILED = 'group/share/failed';

  const draft: ShareDraft = {
    id: 'link-1',
    owner: 'alice',
    url: 'https://example.com/a',
    title: 'Example',
    listId: MY_LIST_ID,
    tagIds: ['tag-1'],
    newTags: [{ id: 'tag-1', name: 'fresh', rank: 'a1' }],
    newLists: [],
    sharedAt: 1_700_000_000_000,
  };

  beforeEach(() => {
    mockFiles.clear();
    mockDirs.clear();
    mockDirs.add(OUTBOX);
  });

  // The read-mode copy a Safari draft carries is stored only when the caller says the
  // account keeps it (ShareBridge: the plan and the synced setting) — and either way
  // the draft lands and its file goes.
  it('stores a draft’s read-mode copy only when the caller keeps it', async () => {
    const { storeReadModeCopy } =
      jest.requireMock<typeof import('./store-read-mode')>('./store-read-mode');
    const withCopy = { ...draft, readMode: { version: 1, capturedAt: 1, blocks: [] } };

    jest.mocked(storeReadModeCopy).mockClear();
    mockFiles.set(`${OUTBOX}/link-1.json`, JSON.stringify(withCopy));
    await expect(drainShareOutbox()).resolves.toEqual(['links/link-1.enc']);
    expect(storeReadModeCopy).not.toHaveBeenCalled();

    mockFiles.set(`${OUTBOX}/link-1.json`, JSON.stringify(withCopy));
    await expect(drainShareOutbox({ keepReadMode: true })).resolves.toEqual(['links/link-1.enc']);
    expect(storeReadModeCopy).toHaveBeenCalledWith('alice', 'link-1', withCopy.readMode);
    expect([...mockFiles.keys()]).toEqual([]);
  });

  it('applies a valid draft and deletes its file', async () => {
    mockFiles.set(`${OUTBOX}/link-1.json`, JSON.stringify(draft));

    // The landed link's path comes back, so the caller can sync + extract it.
    await expect(drainShareOutbox()).resolves.toEqual(['links/link-1.enc']);
    // Applied means gone — and NOT quarantined.
    expect([...mockFiles.keys()]).toEqual([]);
  });

  // A share is a save: it counts toward the app-store review prompt, and only a
  // draft that landed does — a quarantined one never became a link.
  it('counts each landed draft toward the review prompt, and nothing it quarantined', async () => {
    const { countReviewPromptSave } =
      jest.requireMock<typeof import('./review-prompt-store')>('./review-prompt-store');
    jest.mocked(countReviewPromptSave).mockClear();
    mockFiles.set(`${OUTBOX}/bad.json`, 'not json');
    mockFiles.set(`${OUTBOX}/good.json`, JSON.stringify(draft));

    await drainShareOutbox();

    expect(countReviewPromptSave).toHaveBeenCalledTimes(1);
  });

  it('quarantines an unparseable file instead of deleting it', async () => {
    mockFiles.set(`${OUTBOX}/broken.json`, 'not json');

    await expect(drainShareOutbox()).resolves.toEqual([]);
    // Out of the drain's path, so it can't be retried forever...
    expect(mockFiles.has(`${OUTBOX}/broken.json`)).toBe(false);
    // ...but not destroyed: an outbox draft can be the only copy of a share.
    expect(mockFiles.get(`${FAILED}/broken.json`)).toBe('not json');
  });

  it('quarantines a draft the schema rejects — the post-ship skew case', async () => {
    // The scenario the tight schema buys: a draft parked by an older build (here,
    // one predating sheet-minted ranks), drained by a newer one. It must survive
    // as a recoverable file rather than vanish.
    const { rank: _rank, ...rankFree } = draft.newTags[0];
    const parked = JSON.stringify({ ...draft, newTags: [rankFree] });
    mockFiles.set(`${OUTBOX}/old-build.json`, parked);

    await expect(drainShareOutbox()).resolves.toEqual([]);
    expect(mockFiles.get(`${FAILED}/old-build.json`)).toBe(parked);
  });

  it('keeps draining the rest of the outbox past a bad file', async () => {
    mockFiles.set(`${OUTBOX}/bad.json`, 'not json');
    mockFiles.set(`${OUTBOX}/good.json`, JSON.stringify(draft));

    await expect(drainShareOutbox()).resolves.toEqual(['links/link-1.enc']);
    expect(mockFiles.get(`${FAILED}/bad.json`)).toBe('not json');
    expect(mockFiles.has(`${OUTBOX}/good.json`)).toBe(false);
  });

  // The file the sign-out wipe missed: written under the account that signed out,
  // after the wipe ran (an iOS share extension still saving), and found by the
  // next account's drain. Applying it would put one account's link in another's
  // library; quarantining it would keep it on a device now signed in to someone
  // else (docs/share-sheet.md, _a draft belongs to the account that opened the
  // sheet_).
  it('deletes a draft another account owns, and lands nothing from it', async () => {
    const {
      writeLink: write,
      writeList,
      writeTag,
    } = jest.requireMock<typeof import('./mutations')>('./mutations');
    jest.mocked(write).mockClear();
    jest.mocked(writeList).mockClear();
    jest.mocked(writeTag).mockClear();
    mockFiles.set(`${OUTBOX}/link-1.json`, JSON.stringify({ ...draft, owner: 'bob' }));

    await expect(drainShareOutbox()).resolves.toEqual([]);
    expect([...mockFiles.keys()]).toEqual([]);
    expect(write).not.toHaveBeenCalled();
    expect(writeList).not.toHaveBeenCalled();
    expect(writeTag).not.toHaveBeenCalled();
  });

  it('still lands this account’s drafts beside another account’s', async () => {
    mockFiles.set(
      `${OUTBOX}/theirs.json`,
      JSON.stringify({ ...draft, id: 'link-2', owner: 'bob' }),
    );
    mockFiles.set(`${OUTBOX}/mine.json`, JSON.stringify(draft));

    await expect(drainShareOutbox()).resolves.toEqual(['links/link-1.enc']);
    expect([...mockFiles.keys()]).toEqual([]);
  });

  it('clears the quarantine on sign-out along with everything else', () => {
    // The parked files hold plaintext URLs — they must not outlive the session
    // or leak to the next account.
    mockDirs.add(FAILED);
    mockDirs.add('group/share');
    mockFiles.set(`${FAILED}/broken.json`, 'not json');
    mockFiles.set('group/share/taxonomy.json', '{}');

    clearShareData();

    expect([...mockFiles.keys()]).toEqual([]);
    expect([...mockDirs]).toEqual([]);
  });
});

// The share sheet's copy of the create-surface link-cap gate — and, since the
// free tier's 200-link wall went client-side, the
// ENFORCEMENT rather than a pre-check: nothing behind it counts links any more.
// The two platforms answer from different sources because of the process split,
// so both branches are pinned here, along with the fail-open rule that governs
// every case where the answer is unknowable.
describe('isAtLinkCap', () => {
  const TAXONOMY = 'group/share/taxonomy.json';
  const count = countLinks as jest.Mock;
  const cached = readCachedStatus as jest.Mock;

  const freeStatus = {
    plan: 'free',
    status: 'none',
    source: null,
    expiresAt: null,
    willRenew: false,
  };

  beforeEach(() => {
    mockFiles.clear();
    mockDirs.clear();
    count.mockReset().mockResolvedValue(0);
    cached.mockReset().mockReturnValue(null);
  });

  // jest-expo runs this suite as iOS (jest.config.cts pins the babel caller's
  // platform), which is the branch that reads the snapshot.
  describe('iOS — off the App Group snapshot', () => {
    function snapshot(fields: Partial<ShareTaxonomy>) {
      mockDirs.add('group/share');
      mockFiles.set(
        TAXONOMY,
        JSON.stringify({
          owner: 'alice',
          lists: [],
          tags: [],
          linkCount: 0,
          maxLinks: null,
          ...fields,
        }),
      );
    }

    it('refuses a free account at its cap', async () => {
      snapshot({ linkCount: 200, maxLinks: 200 });
      expect(await isAtLinkCap()).toBe(true);
    });

    it('allows a free account under its cap', async () => {
      snapshot({ linkCount: 199, maxLinks: 200 });
      expect(await isAtLinkCap()).toBe(false);
    });

    it('never refuses a paid account (maxLinks is unlimited)', async () => {
      snapshot({ linkCount: 5000, maxLinks: null });
      expect(await isAtLinkCap()).toBe(false);
    });

    it('fails OPEN with no snapshot at all', async () => {
      // A share taken before the main app has ever written one. Refusing here
      // would break the sheet for an account we know nothing about.
      expect(await isAtLinkCap()).toBe(false);
    });

    it('fails OPEN on a snapshot too old to carry the cap fields', async () => {
      mockDirs.add('group/share');
      mockFiles.set(TAXONOMY, JSON.stringify({ owner: 'alice', lists: [], tags: [] }));
      expect(await isAtLinkCap()).toBe(false);
    });

    it('reads the snapshot, never the store', async () => {
      // The whole reason the fields ride on the snapshot: this process must not
      // open sqlite (a shared-container file lock invites the 0xdead10cc kill),
      // so neither the count nor the cached-plan read may be reached.
      snapshot({ linkCount: 200, maxLinks: 200 });
      await isAtLinkCap();
      expect(count).not.toHaveBeenCalled();
      expect(cached).not.toHaveBeenCalled();
    });
  });

  describe('Android — live off the store', () => {
    // Platform.OS is a plain writable field on RN's Platform object, so the
    // branch is reachable without mocking the module (which would mean spreading
    // react-native's getter-heavy barrel).
    const platform = Platform as { OS: string };
    let original: string;

    beforeEach(() => {
      original = platform.OS;
      platform.OS = 'android';
    });
    afterEach(() => {
      platform.OS = original;
    });

    function atCount(n: number) {
      count.mockResolvedValue(n);
    }

    it('refuses a free account at its cap', async () => {
      cached.mockReturnValue(freeStatus);
      atCount(200);
      expect(await isAtLinkCap()).toBe(true);
    });

    it('allows a free account under its cap', async () => {
      cached.mockReturnValue(freeStatus);
      atCount(199);
      expect(await isAtLinkCap()).toBe(false);
    });

    it('never refuses a paid account (maxLinks is unlimited)', async () => {
      cached.mockReturnValue({
        plan: 'plus',
        status: 'active',
        source: 'paddle',
        expiresAt: Date.now() + 1000,
        willRenew: true,
      });
      atCount(5000);
      expect(await isAtLinkCap()).toBe(false);
    });

    it('fails OPEN with no cached status, rather than assuming free', async () => {
      // A fresh install that has not fetched `iap/status` yet. Guessing 'free'
      // here would tell a PAYING customer their library is full.
      cached.mockReturnValue(null);
      atCount(5000);
      expect(await isAtLinkCap()).toBe(false);
    });
  });
});

// The post-Add kick reads the session's STATE and nothing else (docs/sessions.md,
// _the expired state on the client_; docs/share-sheet.md): while the main app
// holds a `session_expired` / `session_unknown` verdict, a share saves and queues
// like any offline edit and sends nothing — the request would only earn the same
// verdict again, and the share sheet's process could not act on it anyway. Each
// platform gets a positive control, or "never called" would pass just as well
// for a kick that was never reachable.
describe('saveSharedDraft — an expired session sends nothing', () => {
  const upload = uploadShareDraft as jest.Mock;
  const sync = runIncrementalSync as jest.Mock;
  const sharedSession = loadSharedSession as jest.Mock;
  const currentSession = getSession as jest.Mock;
  const write = writeLink as jest.Mock;
  const api = mockApi();
  const OUTBOX_FILE = 'group/share/outbox/link-1.json';

  const draft: ShareDraft = {
    id: 'link-1',
    owner: 'alice',
    url: 'https://example.com/a',
    title: 'Example',
    listId: MY_LIST_ID,
    tagIds: [],
    newTags: [],
    newLists: [],
    sharedAt: 1_700_000_000_000,
  };

  function session(state: 'active' | 'expired') {
    return { username: 'alice', encryptionKey: new Uint8Array(32), state, generation: 'g1' };
  }

  // Neither kick is awaited — Add resolves on the durable write — so the spec
  // lets the fire-and-forget chain run before it looks.
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

  beforeEach(() => {
    mockFiles.clear();
    mockDirs.clear();
    upload.mockClear();
    sync.mockClear();
    write.mockClear();
    sharedSession.mockReset();
  });

  // jest-expo runs this suite as iOS: the share extension, a separate process
  // reading the session from the shared-Keychain mirror.
  describe('iOS — the share extension', () => {
    beforeEach(() => {
      seedSnapshot('alice');
    });
    afterEach(() => {
      sharedSession.mockResolvedValue(null);
    });

    it('queues the draft and uploads nothing while the mirrored session is expired', async () => {
      sharedSession.mockResolvedValue(session('expired'));
      expect(await saveSharedDraft(draft, api)).toBe('queued');
      await settle();
      expect(sharedSession).toHaveBeenCalled();
      expect(mockFiles.has(OUTBOX_FILE)).toBe(true);
      expect(upload).not.toHaveBeenCalled();
    });

    it('uploads the draft when the mirrored session is active', async () => {
      const mirrored = session('active');
      sharedSession.mockResolvedValue(mirrored);
      expect(await saveSharedDraft(draft, api)).toBe('queued');
      await settle();
      expect(mockFiles.has(OUTBOX_FILE)).toBe(true);
      // Key and token from the one record the owner check passed: the upload
      // gets the client bound to it, never the plain one that reads whatever
      // session this process holds by the time each request leaves.
      expect(api.withSession).toHaveBeenCalledWith(mirrored);
      expect(upload).toHaveBeenCalledWith(
        { encryptionKey: mirrored.encryptionKey, api: api.bound },
        draft,
      );
    });
  });

  // The share activity runs in the app's process and saves through the real
  // write edge, then kicks a sync cycle.
  describe('Android — the share activity', () => {
    const platform = Platform as { OS: string };
    let original: string;

    beforeEach(() => {
      original = platform.OS;
      platform.OS = 'android';
    });
    afterEach(() => {
      platform.OS = original;
      currentSession.mockReset();
      currentSession.mockImplementation(() => ({
        username: 'alice',
        encryptionKey: new Uint8Array(32),
      }));
    });

    it('saves the link and runs no sync cycle while the session is expired', async () => {
      currentSession.mockReturnValue(session('expired'));
      expect(await saveSharedDraft(draft, api)).toBe('saved');
      await settle();
      expect(write).toHaveBeenCalledTimes(1);
      expect(sync).not.toHaveBeenCalled();
    });

    it('runs a sync cycle after the save when the session is active', async () => {
      currentSession.mockReturnValue(session('active'));
      expect(await saveSharedDraft(draft, api)).toBe('saved');
      await settle();
      expect(write).toHaveBeenCalledTimes(1);
      expect(sync).toHaveBeenCalledWith(expect.objectContaining({ username: 'alice', api }));
    });
  });
});

// A draft is landed only under the account that owns it — the one whose lists
// and tags the sheet rendered (share-store's header, _a draft belongs to an
// account_). Save is the first place that is checked: the account can change
// while the sheet is open, and both platforms then write nothing. The iOS
// upload is the second, because it reads the mirrored session AFTER the outbox
// write and that mirror can already be the next account's. Each refusal has a
// positive control above (an Add under the same account saves and uploads).
describe('saveSharedDraft — the draft’s account', () => {
  const upload = uploadShareDraft as jest.Mock;
  const sync = runIncrementalSync as jest.Mock;
  const sharedSession = loadSharedSession as jest.Mock;
  const currentSession = getSession as jest.Mock;
  const write = writeLink as jest.Mock;
  const count = countLinks as jest.Mock;
  const cached = readCachedStatus as jest.Mock;
  const api = mockApi();

  const draft: ShareDraft = {
    id: 'link-1',
    owner: 'alice',
    url: 'https://example.com/a',
    listId: MY_LIST_ID,
    tagIds: [],
    newTags: [],
    newLists: [],
    sharedAt: 1_700_000_000_000,
  };

  function session(username: string) {
    return { username, encryptionKey: new Uint8Array(32), state: 'active', generation: 'g1' };
  }

  const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

  beforeEach(() => {
    mockFiles.clear();
    mockDirs.clear();
    upload.mockClear();
    sync.mockClear();
    write.mockReset().mockResolvedValue(undefined);
    count.mockReset().mockResolvedValue(0);
    cached.mockReset().mockReturnValue(null);
    sharedSession.mockReset().mockResolvedValue(null);
  });

  describe('iOS — the share extension', () => {
    it('writes nothing when the snapshot now names another account', async () => {
      // Sign-out deleted the snapshot the sheet opened on, and the next
      // account's first refresh wrote its own.
      seedSnapshot('bob');
      sharedSession.mockResolvedValue(session('bob'));

      expect(await saveSharedDraft(draft, api)).toBe('account-changed');
      await settle();
      expect(mockFiles.has('group/share/outbox/link-1.json')).toBe(false);
      expect(upload).not.toHaveBeenCalled();
    });

    it('writes nothing when there is no snapshot — signed out since the sheet opened', async () => {
      expect(await saveSharedDraft(draft, api)).toBe('account-changed');
      expect([...mockFiles.keys()]).toEqual([]);
    });

    it('answers for the account before the cap', async () => {
      // Another account's full library is no reason to refuse this draft as
      // 'quota' — the user would be told to free up room in the wrong place.
      seedSnapshot('bob', { linkCount: 200, maxLinks: 200 });
      expect(await saveSharedDraft(draft, api)).toBe('account-changed');
    });

    it('keeps the outbox file but uploads nothing when the mirror is already another account', async () => {
      // The snapshot check passed; the switch landed between it and the upload's
      // mirror read. The file stays — the drain applies the same rule to it.
      seedSnapshot('alice');
      sharedSession.mockResolvedValue(session('bob'));

      expect(await saveSharedDraft(draft, api)).toBe('queued');
      await settle();
      expect(sharedSession).toHaveBeenCalled();
      expect(mockFiles.has('group/share/outbox/link-1.json')).toBe(true);
      expect(upload).not.toHaveBeenCalled();
    });
  });

  describe('Android — the share activity', () => {
    const platform = Platform as { OS: string };
    let original: string;

    beforeEach(() => {
      original = platform.OS;
      platform.OS = 'android';
    });
    afterEach(() => {
      platform.OS = original;
      currentSession.mockReset();
      currentSession.mockImplementation(() => ({
        username: 'alice',
        encryptionKey: new Uint8Array(32),
      }));
    });

    it('writes nothing when another account is signed in', async () => {
      currentSession.mockReturnValue(session('bob'));

      expect(await saveSharedDraft(draft, api)).toBe('account-changed');
      await settle();
      expect(write).not.toHaveBeenCalled();
      expect(sync).not.toHaveBeenCalled();
      expect(takeShareHandoffs()).toEqual([]);
    });

    it('writes nothing when signed out since the sheet opened', async () => {
      currentSession.mockReturnValue(null);

      expect(await saveSharedDraft(draft, api)).toBe('account-changed');
      expect(write).not.toHaveBeenCalled();
    });
  });
});

// The snapshot names the account it was built for, and a pass that began
// before a sign-out must not write the old account's snapshot back after the
// wipe deleted it — the sheet would offer that account's lists again, and every
// draft saved from it would be refused.
describe('refreshShareTaxonomy', () => {
  const currentSession = getSession as jest.Mock;
  const { readLists } = jest.requireMock<typeof import('./queries')>('./queries');
  const lists = jest.mocked(readLists);
  const TAXONOMY = 'group/share/taxonomy.json';

  beforeEach(() => {
    mockFiles.clear();
    mockDirs.clear();
  });
  afterEach(() => {
    lists.mockReset().mockResolvedValue([]);
    currentSession.mockReset();
    currentSession.mockImplementation(() => ({
      username: 'alice',
      encryptionKey: new Uint8Array(32),
    }));
  });

  it('writes the signed-in account as the snapshot’s owner', async () => {
    await refreshShareTaxonomy();

    const written = parseShareTaxonomy(mockFiles.get(TAXONOMY) ?? '');
    expect(written?.owner).toBe('alice');
  });

  it('writes nothing when the account was signed out during its reads', async () => {
    lists.mockImplementationOnce(async () => {
      currentSession.mockReturnValue(null);
      return [];
    });

    await refreshShareTaxonomy();

    expect(mockFiles.has(TAXONOMY)).toBe(false);
  });

  it('writes nothing when another account was signed in during its reads', async () => {
    lists.mockImplementationOnce(async () => {
      currentSession.mockReturnValue({ username: 'bob', encryptionKey: new Uint8Array(32) });
      return [];
    });

    await refreshShareTaxonomy();

    expect(mockFiles.has(TAXONOMY)).toBe(false);
  });
});

// WHERE a share is counted toward the app-store review prompt, which is a
// process rule before it is a bookkeeping one (docs/share-sheet.md): the count
// is a row in sqlite, and the iOS share extension must never open that database
// (the shared-container lock is the 0xdead10cc kill). So the count rides
// applyShareDraft — the app's own process on both platforms — and never
// saveSharedDraft itself. Counting "at Add" instead reads as the simpler
// spelling, lints, typechecks, and is correct on Android; the drain case above
// would still pass. Android's Save is the positive control for the iOS
// extension's "never".
describe('saveSharedDraft — the review-prompt count', () => {
  const { countReviewPromptSave } =
    jest.requireMock<typeof import('./review-prompt-store')>('./review-prompt-store');
  const counted = jest.mocked(countReviewPromptSave);
  const count = countLinks as jest.Mock;
  const cached = readCachedStatus as jest.Mock;
  const api = mockApi();

  const draft: ShareDraft = {
    id: 'link-1',
    owner: 'alice',
    url: 'https://example.com/a',
    listId: MY_LIST_ID,
    tagIds: [],
    newTags: [],
    newLists: [],
    sharedAt: 1_700_000_000_000,
  };

  beforeEach(() => {
    mockFiles.clear();
    mockDirs.clear();
    counted.mockClear();
    count.mockReset().mockResolvedValue(0);
    cached.mockReset().mockReturnValue(null);
  });

  // jest-expo runs this suite as iOS: the share extension's process.
  it('counts nothing in the iOS share extension, which only queues', async () => {
    seedSnapshot('alice');
    expect(await saveSharedDraft(draft, api)).toBe('queued');

    expect(counted).not.toHaveBeenCalled();
  });

  describe('Android — the share activity', () => {
    const platform = Platform as { OS: string };
    let original: string;

    beforeEach(() => {
      original = platform.OS;
      platform.OS = 'android';
    });
    afterEach(() => {
      platform.OS = original;
    });

    it('counts a share as it is saved', async () => {
      expect(await saveSharedDraft(draft, api)).toBe('saved');

      expect(counted).toHaveBeenCalledTimes(1);
    });

    // Never after a refusal: a share turned away at the cap is not a save.
    it('counts nothing for a share refused at the link cap', async () => {
      cached.mockReturnValue({
        plan: 'free',
        status: 'none',
        source: null,
        expiresAt: null,
        willRenew: false,
      });
      count.mockResolvedValue(Number.MAX_SAFE_INTEGER);

      expect(await saveSharedDraft(draft, api)).toBe('quota');

      expect(counted).not.toHaveBeenCalled();
    });
  });
});

// The Android share activity writes the store itself, so no drain ever returns
// its link — and the page fetch a share is owed at extraction mode `saves`
// belongs to the main app's ExtractionProvider, which the activity does not
// mount (docs/share-sheet.md, _the main app's half_). The marker is the whole
// of the link between them, and its absence is silent: the link is saved, it
// syncs, and it keeps a provisional title and no image for good.
describe('the Android handoff', () => {
  const currentSession = getSession as jest.Mock;
  const write = writeLink as jest.Mock;
  const count = countLinks as jest.Mock;
  const cached = readCachedStatus as jest.Mock;
  const platform = Platform as { OS: string };
  const api = mockApi();
  const HANDOFF = 'file:/documents/share/handoff';

  const draft: ShareDraft = {
    id: 'link-1',
    owner: 'alice',
    url: 'https://example.com/a',
    listId: MY_LIST_ID,
    tagIds: [],
    newTags: [],
    newLists: [],
    sharedAt: 1_700_000_000_000,
  };

  let original: string;

  beforeEach(() => {
    mockFiles.clear();
    mockDirs.clear();
    write.mockReset().mockResolvedValue(undefined);
    count.mockReset().mockResolvedValue(0);
    cached.mockReset().mockReturnValue(null);
    original = platform.OS;
    platform.OS = 'android';
  });
  afterEach(() => {
    platform.OS = original;
    currentSession.mockReset();
    currentSession.mockImplementation(() => ({
      username: 'alice',
      encryptionKey: new Uint8Array(32),
    }));
  });

  it('hands a saved link to the main app once, by its links/ path', async () => {
    expect(await saveSharedDraft(draft, api)).toBe('saved');

    // The drain's return shape, so the bridge treats both platforms' as one list.
    expect(takeShareHandoffs()).toEqual(['links/link-1.enc']);
    // Taken means gone: the next pass must not fetch the page a second time.
    expect(takeShareHandoffs()).toEqual([]);
    expect([...mockFiles.keys()]).toEqual([]);
  });

  // A paused session stops the sync kick, not the page fetch.
  it('leaves the marker while the session is expired', async () => {
    currentSession.mockReturnValue({
      username: 'alice',
      encryptionKey: new Uint8Array(32),
      state: 'expired',
      generation: 'g1',
    });
    expect(await saveSharedDraft(draft, api)).toBe('saved');

    expect(takeShareHandoffs()).toEqual(['links/link-1.enc']);
  });

  // A marker only ever names a link that is in the store. Left ahead of the
  // write, the main app's pass could collect it between two awaits of the save
  // and spend it on a path with nothing at it yet.
  it('leaves no marker for a save whose write failed', async () => {
    write.mockRejectedValueOnce(new Error('disk full'));
    await expect(saveSharedDraft(draft, api)).rejects.toThrow('disk full');

    expect(takeShareHandoffs()).toEqual([]);
  });

  // Best-effort in the one direction that matters: the marker is owed to the page
  // fetch, and the link is not hostage to it.
  it('saves the link even when the marker cannot be written', async () => {
    const { File } = jest.requireMock<typeof import('expo-file-system')>('expo-file-system');
    const fileWrite = jest.spyOn(File.prototype, 'write').mockImplementationOnce(() => {
      throw new Error('ENOSPC');
    });

    expect(await saveSharedDraft(draft, api)).toBe('saved');
    fileWrite.mockRestore();
    expect(takeShareHandoffs()).toEqual([]);
  });

  it('leaves no marker for a share refused at the link cap', async () => {
    cached.mockReturnValue({
      plan: 'free',
      status: 'none',
      source: null,
      expiresAt: null,
      willRenew: false,
    });
    count.mockResolvedValue(Number.MAX_SAFE_INTEGER);
    expect(await saveSharedDraft(draft, api)).toBe('quota');

    expect(takeShareHandoffs()).toEqual([]);
  });

  it('drops a marker it cannot use and still hands on the rest', async () => {
    expect(await saveSharedDraft(draft, api)).toBe('saved');
    // Cut off between create and write: a file with nothing in it.
    mockFiles.set(`${HANDOFF}/link-2`, '');

    expect(takeShareHandoffs()).toEqual(['links/link-1.enc']);
    // A marker is a hint, never the only copy of anything — so not quarantined.
    expect([...mockFiles.keys()]).toEqual([]);
  });

  it('hands on what it read when a marker cannot be removed', async () => {
    // Collected before it is deleted: the other order loses the link to a failed
    // delete, where this one only offers it twice — and a link that is no longer
    // pending is not fetched twice.
    expect(await saveSharedDraft(draft, api)).toBe('saved');
    const { File } = jest.requireMock<typeof import('expo-file-system')>('expo-file-system');
    const remove = jest.spyOn(File.prototype, 'delete').mockImplementationOnce(() => {
      throw new Error('EBUSY');
    });

    expect(takeShareHandoffs()).toEqual(['links/link-1.enc']);
    remove.mockRestore();
    expect(takeShareHandoffs()).toEqual(['links/link-1.enc']);
    expect([...mockFiles.keys()]).toEqual([]);
  });

  it('clears the markers on sign-out and leaves the theme mirror beside them', async () => {
    // The ids are this account's; the next one's ExtractionProvider must never
    // be handed them. The theme file is the app's to rewrite
    // (share-theme-store.ts), and carries no account data.
    expect(await saveSharedDraft(draft, api)).toBe('saved');
    mockFiles.set('file:/documents/share/theme.json', '{}');

    clearShareData();

    expect([...mockFiles.keys()]).toEqual(['file:/documents/share/theme.json']);
    expect(takeShareHandoffs()).toEqual([]);
  });

  // This call was a no-op on Android until the markers existed, and clearData
  // runs the cache sweep and the decode-cache clear after it.
  it('does not fail the sign-out when the markers cannot be removed', async () => {
    expect(await saveSharedDraft(draft, api)).toBe('saved');
    const { Directory } = jest.requireMock<typeof import('expo-file-system')>('expo-file-system');
    const remove = jest.spyOn(Directory.prototype, 'delete').mockImplementationOnce(() => {
      throw new Error('EBUSY');
    });

    expect(() => clearShareData()).not.toThrow();
    remove.mockRestore();
  });

  // jest-expo's own platform. The outbox file is the record there, and the
  // drain returns what it landed.
  it('is no part of the iOS path', async () => {
    platform.OS = 'ios';
    seedSnapshot('alice');
    expect(await saveSharedDraft(draft, api)).toBe('queued');

    expect([...mockFiles.keys()].filter((uri) => !uri.endsWith('taxonomy.json'))).toEqual([
      'group/share/outbox/link-1.json',
    ]);
    mockDirs.add(HANDOFF);
    mockFiles.set(`${HANDOFF}/link-9`, 'link-9');
    expect(takeShareHandoffs()).toEqual([]);
  });
});
