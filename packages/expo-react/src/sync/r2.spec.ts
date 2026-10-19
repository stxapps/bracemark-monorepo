// The native entity transport has one platform-specific rule a Node test cannot
// reproduce: React Native's global fetch advertises binary BodyInit support but
// rejects a Uint8Array/ArrayBuffer PUT on Android before it reaches the network.
// Pin the seam chosen from that device result so a harmless-looking switch back
// to global fetch does not restore a permanent sync error for every local edit.

import { fetch as expoFetch } from 'expo/fetch';

import { blobTransferTimeoutMs } from '@stxapps/shared';

import { BlobTimeoutError, putBlob } from './r2';

jest.mock('expo-file-system', () => ({ File: class File {} }));
jest.mock('expo-file-system/legacy', () => ({
  FileSystemUploadType: { BINARY_CONTENT: 'BINARY_CONTENT' },
  uploadAsync: jest.fn(),
}));
jest.mock('expo/fetch', () => ({ fetch: jest.fn() }));

const mockExpoFetch = expoFetch as jest.MockedFunction<typeof expoFetch>;

beforeEach(() => {
  mockExpoFetch.mockReset();
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
