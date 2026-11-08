// The server tier's read-mode copy, through the real mutations into fake-indexeddb. What
// is pinned is what nothing else would notice going wrong:
//
//   - a copy is stored as a `files/` blob the extraction NAMES (`readModeId`), gzipped
//     like every other tier's, with the facet `done` at the `server` tier;
//   - a copy that already exists — or lands while the request runs — is never replaced
//     (it may be a live-page capture, a better tier; and highlights will anchor to it);
//   - a settled reason is recorded `permanent` with its `reason`, a passing one `failed`;
//     and a server `failed` never overwrites a better tier's settled answer;
//   - a transport failure records nothing.
import {
  type ExtractClient,
  type ExtractResult,
  FILES_PREFIX,
  type LinkItem,
  LINKS_PREFIX,
  MY_LIST_ID,
  pathFromId,
  type ReaderDoc,
} from '@stxapps/shared';

import { db } from '../data/db';
import { writeExtraction } from '../data/mutations';
import { readExtraction } from '../data/queries';
import { seedNewAccount } from '../data/sync-store';
import { decodeReaderDoc } from './reader-doc-bytes';
import { runServerReadMode } from './server-read-mode';

const USER = 'alice';
const URL_A = 'https://example.com/a';
const LINK: LinkItem = {
  path: pathFromId('l_1', LINKS_PREFIX),
  url: URL_A,
  listId: MY_LIST_ID,
  tagIds: [],
  createdAt: 1,
  updatedAt: 1,
};
const DOC: ReaderDoc = {
  version: 1,
  capturedAt: 5,
  sourceUrl: URL_A,
  blocks: [{ id: 'b0', kind: 'paragraph', runs: [{ text: 'Kept words.' }] }],
};

function client(result: Partial<ExtractResult> | (() => Promise<ExtractResult>)): ExtractClient {
  const extractReadMode = jest.fn(
    typeof result === 'function' ? result : async () => ({ url: URL_A, ok: true, ...result }),
  );
  return { extractReadMode } as unknown as ExtractClient;
}

const readFileBytes = async (id: string) =>
  (await db.items.get(pathFromId(id, FILES_PREFIX)))?.data as Uint8Array | undefined;

beforeEach(async () => {
  await db.syncMeta.clear();
  await seedNewAccount(USER);
  await Promise.all([db.items.clear(), db.pendingOps.clear()]);
});

it('stores the copy as a gzipped blob the extraction names, at the server tier', async () => {
  expect(await runServerReadMode(USER, LINK, client({ readMode: DOC }))).toEqual({ kind: 'kept' });

  const extraction = await readExtraction('l_1');
  expect(extraction?.readModeId).toEqual(expect.any(String));
  expect(extraction?.facets.readMode).toMatchObject({ status: 'done', extractedBy: 'server' });
  const bytes = await readFileBytes(extraction?.readModeId ?? '');
  expect(bytes).toBeDefined();
  expect(await decodeReaderDoc(bytes ?? new Uint8Array())).toEqual(DOC);
});

it('never replaces a copy that exists, and asks the server nothing for it', async () => {
  await writeExtraction(USER, 'l_1', { fields: { readModeId: 'mine' } });
  const extractor = client({ readMode: DOC });

  expect(await runServerReadMode(USER, LINK, extractor)).toEqual({ kind: 'exists' });
  expect(extractor.extractReadMode).not.toHaveBeenCalled();
  expect((await readExtraction('l_1'))?.readModeId).toBe('mine');
});

it('leaves a copy that landed while the request ran', async () => {
  const extractor = client(async () => {
    await writeExtraction(USER, 'l_1', { fields: { readModeId: 'extension' } });
    return { url: URL_A, ok: true, readMode: DOC };
  });

  expect(await runServerReadMode(USER, LINK, extractor)).toEqual({ kind: 'exists' });
  expect((await readExtraction('l_1'))?.readModeId).toBe('extension');
});

it.each([['not-an-article'], ['not-html'], ['robots-disallowed']])(
  'settles %s as permanent, with the reason on the facet',
  async (reason) => {
    const outcome = await runServerReadMode(USER, LINK, client({ readModeReason: reason }));
    expect(outcome).toEqual({ kind: 'none', status: 'permanent', reason });
    expect((await readExtraction('l_1'))?.facets.readMode).toMatchObject({
      status: 'permanent',
      extractedBy: 'server',
      reason,
    });
  },
);

it('records an unreadable robots.txt — or a reason it does not know — as failed', async () => {
  await runServerReadMode(USER, LINK, client({ readModeReason: 'robots-unavailable' }));
  expect((await readExtraction('l_1'))?.facets.readMode).toMatchObject({ status: 'failed' });

  const outcome = await runServerReadMode(
    USER,
    LINK,
    client({ readModeReason: 'from-the-future' }),
  );
  expect(outcome).toMatchObject({ kind: 'none', status: 'failed' });
});

it('settles a 404 the way the title does', async () => {
  const outcome = await runServerReadMode(
    USER,
    LINK,
    client(async () => ({ url: URL_A, ok: false, error: 'bad_status', status: 404 })),
  );
  expect(outcome).toMatchObject({ kind: 'none', status: 'permanent' });
});

it('never overwrites a better tier’s settled answer with a server failure', async () => {
  await writeExtraction(USER, 'l_1', {
    facet: 'readMode',
    state: {
      status: 'permanent',
      extractedBy: 'extension:fg',
      extractedAt: 1,
      attempts: 0,
      reason: 'not-an-article',
    },
  });

  await runServerReadMode(USER, LINK, client({ readModeReason: 'robots-unavailable' }));
  expect((await readExtraction('l_1'))?.facets.readMode).toMatchObject({
    status: 'permanent',
    extractedBy: 'extension:fg',
  });
});

it('records nothing on a transport failure — it throws instead', async () => {
  const extractor = client(async () => {
    throw new TypeError('network');
  });
  await expect(runServerReadMode(USER, LINK, extractor)).rejects.toThrow('network');
  expect(await readExtraction('l_1')).toBeUndefined();
});
