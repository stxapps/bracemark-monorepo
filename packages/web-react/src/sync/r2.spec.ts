// The R2 transfers bypass the contract client, so they carry their own deadline
// (`blobTransferTimeoutMs`, @stxapps/shared sync/blob-transfer.ts), and a stalled
// one would otherwise hold the sync engine's single-flight cycle — every later
// sync — until the page reloads. What is pinned is how each transfer SIZES it,
// because a wrong size is silent in both directions: too short fails a large
// `files/` transfer that was still moving, every cycle, forever; missing leaves a
// stalled one hanging. The PUT can't see its progress, so its deadline is a total
// scaled by size; the GET can, so its deadline is an idle one.
//
// The global fetch is replaced per case with one that never settles and never
// looks at its signal — the hard case, since the deadline must settle the call on
// its own. Fake timers, so the deadline is reached by advancing the clock.

import { BLOB_BASE_TIMEOUT_MS, BLOB_IDLE_TIMEOUT_MS, blobTransferTimeoutMs } from '@stxapps/shared';

import { BlobTimeoutError, getBlob, putBlob } from './r2';

const URL_A = 'https://r2.test/users/u/files/f_a.enc';
const MB = 1024 * 1024;

const realFetch = globalThis.fetch;

beforeEach(() => {
  jest.useFakeTimers();
});
afterEach(() => {
  jest.useRealTimers();
  globalThis.fetch = realFetch;
});

const pending = async (outcome: Promise<unknown>) =>
  Promise.race([outcome, Promise.resolve('pending')]);

describe('putBlob', () => {
  it('gives a large upload the time its size needs, then fails it as a timeout', async () => {
    globalThis.fetch = jest.fn(() => new Promise<Response>(() => undefined));
    const body = new Uint8Array(4 * MB);
    const deadline = blobTransferTimeoutMs(body.byteLength);
    const outcome = putBlob(URL_A, body).catch((err: unknown) => err);

    // Well past a flat allowance, still moving — the case a size-blind deadline
    // would fail on every cycle.
    await jest.advanceTimersByTimeAsync(deadline - 1);
    await expect(pending(outcome)).resolves.toBe('pending');

    await jest.advanceTimersByTimeAsync(1);
    expect(await outcome).toMatchObject({ name: 'BlobTimeoutError', method: 'PUT' });
    expect(deadline).toBeGreaterThan(BLOB_BASE_TIMEOUT_MS);
  });
});

describe('getBlob', () => {
  it('fails a GET whose response never starts at the base allowance', async () => {
    globalThis.fetch = jest.fn(() => new Promise<Response>(() => undefined));
    const outcome = getBlob(URL_A).catch((err: unknown) => err);

    await jest.advanceTimersByTimeAsync(BLOB_BASE_TIMEOUT_MS);

    expect(await outcome).toBeInstanceOf(BlobTimeoutError);
  });

  // A 200 whose body is read from `read` — the stream getBlob consumes chunk by
  // chunk. Headers arrive at once; when each chunk does is `read`'s to decide.
  function streamingFetch(read: () => Promise<ReadableStreamReadResult<Uint8Array>>) {
    let signal: AbortSignal | undefined;
    globalThis.fetch = jest.fn((_url: string, init: RequestInit) => {
      signal = init.signal ?? undefined;
      return Promise.resolve({
        ok: true,
        status: 200,
        body: { getReader: () => ({ read }) },
      } as unknown as Response);
    }) as unknown as typeof fetch;
    return { signal: () => signal };
  }

  const after = <T>(ms: number, value: T) =>
    new Promise<T>((resolve) => setTimeout(() => resolve(value), ms));

  it('never fails a download that keeps moving, however long the whole takes', async () => {
    // Ten chunks, each one tick inside the idle window — ten minutes in all, far
    // past any total a size-scaled deadline would give these bytes. The case a
    // slow link would otherwise fail on every cycle.
    const chunks = Array.from({ length: 10 }, (_, i) => new Uint8Array([i, i + 1]));
    let next = 0;
    streamingFetch(() =>
      next < chunks.length
        ? after(BLOB_IDLE_TIMEOUT_MS - 1, { done: false as const, value: chunks[next++] })
        : Promise.resolve({ done: true as const, value: undefined }),
    );
    const outcome = getBlob(URL_A).catch((err: unknown) => err);

    await jest.advanceTimersByTimeAsync(chunks.length * (BLOB_IDLE_TIMEOUT_MS - 1));

    expect(Array.from((await outcome) as Uint8Array)).toEqual(
      chunks.flatMap((chunk) => Array.from(chunk)),
    );
    expect(chunks.length * BLOB_IDLE_TIMEOUT_MS).toBeGreaterThan(blobTransferTimeoutMs(20));
    expect(jest.getTimerCount()).toBe(0);
  });

  it('fails a body that stops arriving after the idle window, and aborts it', async () => {
    let reads = 0;
    const f = streamingFetch(() =>
      reads++ === 0
        ? after(1000, { done: false as const, value: new Uint8Array([1]) })
        : new Promise<never>(() => undefined),
    );
    const outcome = getBlob(URL_A).catch((err: unknown) => err);

    // One chunk at t = 1000 restarts the clock; then silence. One tick short of
    // the idle window after that chunk, still waiting.
    await jest.advanceTimersByTimeAsync(1000 + BLOB_IDLE_TIMEOUT_MS - 1);
    await expect(pending(outcome)).resolves.toBe('pending');
    expect(f.signal()?.aborted).toBe(false);

    await jest.advanceTimersByTimeAsync(1);
    expect(await outcome).toMatchObject({
      name: 'BlobTimeoutError',
      method: 'GET',
      timeoutMs: BLOB_IDLE_TIMEOUT_MS,
    });
    expect(f.signal()?.aborted).toBe(true);
  });
});

// The blob route's credential is a header and a presign's is its URL, and which
// one a transfer gets is whatever files/sign answered. A header sent to R2 would
// be ignored; one dropped on the way to the blob route is a 403 on every transfer.
describe('the authorization a URL was signed with', () => {
  const ok = () => jest.fn(async () => new Response(new Uint8Array([1]), { status: 200 }));
  const init = (fetch: jest.Mock) => (fetch.mock.calls[0] as unknown[])[1] as RequestInit;

  it('goes on a PUT as the Authorization header, and is absent for a presign', async () => {
    const fetch = ok();
    globalThis.fetch = fetch;

    await putBlob(URL_A, new Uint8Array([1]), 'Blob v1.token');
    await putBlob(URL_A, new Uint8Array([1]));

    expect(init(fetch).headers).toEqual({ authorization: 'Blob v1.token' });
    expect(((fetch.mock.calls[1] as unknown[])[1] as RequestInit).headers).toBeUndefined();
  });

  // Every blob-route read is the same URL. A GET with the header is preflighted,
  // and one with `cache: 'no-store'` (which the one URL needs) skips the preflight
  // cache: a preflight per read. A POST with a string body and no header of its
  // own is a CORS-simple request, and no cache stores it.
  it('reads the blob route as a POST carrying the token as its body, with no header', async () => {
    const fetch = ok();
    globalThis.fetch = fetch;

    await getBlob(URL_A, 'Blob v1.token');
    await getBlob(URL_A);

    expect(init(fetch)).toMatchObject({ method: 'POST', body: 'Blob v1.token' });
    expect(init(fetch).headers).toBeUndefined();
    // A presign is read as it always was: a GET, nothing added.
    expect((fetch.mock.calls[1] as unknown[])[1]).toMatchObject({ method: 'GET' });
    expect(((fetch.mock.calls[1] as unknown[])[1] as RequestInit).body).toBeUndefined();
  });
});
