// The native entity transport has one platform-specific rule a Node test cannot
// reproduce: React Native's global fetch advertises binary BodyInit support but
// rejects a Uint8Array/ArrayBuffer PUT on Android before it reaches the network.
// Pin the seam chosen from that device result so a harmless-looking switch back
// to global fetch does not restore a permanent sync error for every local edit.

import { fetch as expoFetch } from 'expo/fetch';

import { putBlob } from './r2';

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

it('PUTs in-memory ciphertext through Expo native fetch as bytes', async () => {
  mockExpoFetch.mockResolvedValue({ ok: true, status: 200 } as unknown as Awaited<
    ReturnType<typeof expoFetch>
  >);
  const bytes = new Uint8Array([0x01, 0x00, 0xff]);

  await putBlob('http://localhost:8787/v1/files/blob/users/u/links/a.enc', bytes);

  expect(mockExpoFetch).toHaveBeenCalledWith(
    'http://localhost:8787/v1/files/blob/users/u/links/a.enc',
    { method: 'PUT', body: bytes },
  );
});
