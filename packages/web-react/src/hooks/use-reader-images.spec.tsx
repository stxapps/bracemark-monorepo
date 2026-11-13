/**
 * @jest-environment jsdom
 */
import { renderHook, waitFor } from '@testing-library/react';

import { useReaderImages } from './use-reader-images';

// The reader's object URLs. The pack codec has its own spec (@stxapps/shared), so what is left is
// what only this hook decides: one address per key, and every address it minted revoked when the
// bytes it came from go. A pack is an outside file once restored from a backup, and can repeat a key.

const mockDecode = jest.fn();
const mockBytes = new Uint8Array([1, 2, 3]);

jest.mock('dexie-react-hooks', () => ({ useLiveQuery: () => mockBytes }));
jest.mock('../contexts/file-content-provider', () => ({
  useFileContent: () => ({ requestFileContent: jest.fn() }),
}));
jest.mock('../data/queries', () => ({ readFileBytes: jest.fn() }));
jest.mock('@stxapps/shared', () => ({
  ...jest.requireActual('@stxapps/shared'),
  decodeReaderImages: (bytes: Uint8Array) => mockDecode(bytes),
}));

const entry = (key: string, tag: number) => ({
  key,
  type: 'image/jpeg',
  width: 640,
  height: 320,
  bytes: new Uint8Array([tag]),
});

let minted = 0;
const created = jest.fn((blob: Blob) => `blob:test/${minted++}-${blob.size}`);
const revoked = jest.fn();

beforeEach(() => {
  minted = 0;
  created.mockClear();
  revoked.mockClear();
  mockDecode.mockReset();
  URL.createObjectURL = created as unknown as typeof URL.createObjectURL;
  URL.revokeObjectURL = revoked;
});

test('a repeated key keeps the first image and mints no address for the rest', async () => {
  mockDecode.mockReturnValue([entry('i0', 1), entry('i0', 2), entry('i1', 3)]);

  const { result, unmount } = renderHook(() => useReaderImages('f1'));

  await waitFor(() => expect(result.current.settled).toBe(true));
  expect(result.current.images.size).toBe(2);
  // Specs mount under StrictMode (mount, cleanup, mount), so the effect runs more than once: what
  // matters is two addresses per run for two keys, not three, and every one of them revoked.
  expect(created).toHaveBeenCalledTimes(2 * mockDecode.mock.calls.length);

  unmount();
  expect(revoked.mock.calls.map((call) => call[0]).sort()).toEqual(
    created.mock.results.map((r) => r.value).sort(),
  );
});
