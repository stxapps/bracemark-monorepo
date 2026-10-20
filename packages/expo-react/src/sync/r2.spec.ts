// The native entity transport has one platform-specific rule a Node test cannot
// reproduce: React Native's global fetch advertises binary BodyInit support but
// rejects a Uint8Array/ArrayBuffer PUT on Android before it reaches the network.
// Pin the seam chosen from that device result so a harmless-looking switch back
// to global fetch does not restore a permanent sync error for every local edit.

import { fetch as expoFetch } from 'expo/fetch';
import type { File } from 'expo-file-system';
import { uploadAsync } from 'expo-file-system/legacy';

import { blobTransferTimeoutMs } from '@stxapps/shared';

import {
  BlobNetworkError,
  BlobRequestError,
  BlobTimeoutError,
  getBlob,
  putBlob,
  putBlobFromFile,
} from './r2';

jest.mock('expo-file-system', () => ({ File: class File {} }));
jest.mock('expo-file-system/legacy', () => ({
  FileSystemUploadType: { BINARY_CONTENT: 'BINARY_CONTENT' },
  uploadAsync: jest.fn(),
}));
jest.mock('expo/fetch', () => ({ fetch: jest.fn() }));

const mockExpoFetch = expoFetch as jest.MockedFunction<typeof expoFetch>;
const mockUploadAsync = uploadAsync as jest.MockedFunction<typeof uploadAsync>;

beforeEach(() => {
  mockExpoFetch.mockReset();
  mockUploadAsync.mockReset();
});

// The route's answer is read too: the upload receipt in it is what lets the commit
// skip asking R2 whether the object landed (docs/local-first-sync.md, _upload
// receipts_), and a PUT that dropped it would quietly put every commit back on R2.
it('PUTs in-memory ciphertext through Expo native fetch as bytes', async () => {
  mockExpoFetch.mockResolvedValue({
    ok: true,
    status: 200,
    text: async () => JSON.stringify({ receipt: 'v1.receipt' }),
  } as unknown as Awaited<ReturnType<typeof expoFetch>>);
  const bytes = new Uint8Array([0x01, 0x00, 0xff]);

  const receipt = await putBlob('http://localhost:8787/v1/files/blob/users/u/links/a.enc', bytes);

  expect(mockExpoFetch).toHaveBeenCalledWith(
    'http://localhost:8787/v1/files/blob/users/u/links/a.enc',
    expect.objectContaining({ method: 'PUT', body: bytes }),
  );
  expect(receipt).toBe('v1.receipt');
});

// Neither JS transport has a deadline of its own (RN's OkHttp client sets every
// timeout to 0 on Android; `expo/fetch` sets `timeoutInterval` to 0 on iOS), so a
// stalled PUT would hold the sync cycle every later sync joins. Web's r2.spec.ts
// covers how the deadline is sized; this copy is duplicated source, so one guard
// that it is there at all.
it('fails a PUT that never answers as a timeout instead of hanging', async () => {
  jest.useFakeTimers();
  try {
    mockExpoFetch.mockImplementation(() => new Promise(() => undefined));
    const bytes = new Uint8Array(16);
    const outcome = putBlob('https://r2.test/a.enc', bytes).catch((err: unknown) => err);

    await jest.advanceTimersByTimeAsync(blobTransferTimeoutMs(bytes.byteLength));

    expect(await outcome).toBeInstanceOf(BlobTimeoutError);
  } finally {
    jest.useRealTimers();
  }
});

// A DROPPED CONNECTION IS TYPED HERE (sync/r2.ts): above this file it looks like
// any other Error, so the engine retried none — on staging a connection that
// dropped under a push canceled 35–63 PUTs at once, and on expo any one of them
// failed its cycle. Each transport fails its own way, so each has its case.
describe('a dropped connection', () => {
  it('is a network error when expo’s fetch fails before the host answers', async () => {
    // What `expo/fetch` throws: an unexported FetchError, named plain `Error`.
    mockExpoFetch.mockRejectedValue(new Error('fetch failed: The network connection was lost.'));

    await expect(putBlob('https://r2.test/a.enc', new Uint8Array(4))).rejects.toBeInstanceOf(
      BlobNetworkError,
    );
  });

  it('is a network error when React Native’s fetch fails', async () => {
    const fetchSpy = jest
      .spyOn(globalThis, 'fetch')
      .mockRejectedValue(new TypeError('Network request failed'));
    try {
      await expect(getBlob('https://r2.test/a.enc')).rejects.toBeInstanceOf(BlobNetworkError);
    } finally {
      fetchSpy.mockRestore();
    }
  });

  // The host answered: that is a status, never a network error — a 403 is an
  // expired token, which a retry in place would only send again.
  it('is not what a host’s refusal becomes', async () => {
    mockExpoFetch.mockResolvedValue({
      ok: false,
      status: 403,
      headers: new Headers(),
    } as unknown as Awaited<ReturnType<typeof expoFetch>>);

    await expect(putBlob('https://r2.test/a.enc', new Uint8Array(4))).rejects.toEqual(
      new BlobRequestError('PUT', 403),
    );
  });

  it('is a network error when a native upload fails with its file still there', async () => {
    mockUploadAsync.mockRejectedValue(new Error('The network connection was lost.'));
    const file = { uri: 'file:///cache/a.enc', exists: true } as unknown as File;

    await expect(putBlobFromFile('https://r2.test/a.enc', file)).rejects.toBeInstanceOf(
      BlobNetworkError,
    );
  });

  // A file that is gone failed locally, and would fail the same way however often
  // it was sent: it goes up as it is, and nothing retries it.
  it('is not what a native upload of a missing file becomes', async () => {
    const missing = new Error('File does not exist');
    mockUploadAsync.mockRejectedValue(missing);
    const file = { uri: 'file:///cache/a.enc', exists: false } as unknown as File;

    await expect(putBlobFromFile('https://r2.test/a.enc', file)).rejects.toBe(missing);
  });
});

it('carries a 429’s Retry-After, for the retry to wait out', async () => {
  mockExpoFetch.mockResolvedValue({
    ok: false,
    status: 429,
    headers: new Headers({ 'retry-after': '7' }),
  } as unknown as Awaited<ReturnType<typeof expoFetch>>);

  await expect(putBlob('https://r2.test/a.enc', new Uint8Array(4))).rejects.toMatchObject({
    status: 429,
    retryAfterSeconds: 7,
  });
});
