/**
 * @jest-environment jsdom
 */
import { renderHook, waitFor } from '@testing-library/react';

import { useReaderDoc } from './use-reader-doc';

// The reader's state machine over one blob. The store and the codec are seams
// here — each has its own spec (data/, lib/reader-doc-bytes.spec.ts) — so what is
// left is what only this hook decides: that a missing blob is ASKED FOR (the
// reader is a deliberate open, so no settle delay), that bytes which aren't a copy
// settle as `unreadable` instead of throwing, and that `none` means no copy at all.

const mockRequest = jest.fn();
const mockReadFileBytes = jest.fn<Promise<Uint8Array | undefined>, [string]>();
const mockDecode = jest.fn<Promise<unknown>, [Uint8Array]>();

jest.mock('../contexts/file-content-provider', () => ({
  useFileContent: () => ({ requestFileContent: mockRequest }),
}));
jest.mock('../data/queries', () => ({
  readFileBytes: (id: string) => mockReadFileBytes(id),
}));
jest.mock('../lib/reader-doc-bytes', () => ({
  decodeReaderDoc: (bytes: Uint8Array) => mockDecode(bytes),
}));

const DOC = { version: 1, capturedAt: 0, blocks: [] };

beforeEach(() => {
  mockRequest.mockReset();
  mockReadFileBytes.mockReset();
  mockDecode.mockReset();
});

test('no file id is no copy, and asks for nothing', () => {
  const { result } = renderHook(() => useReaderDoc(undefined));
  expect(result.current).toEqual({ status: 'none' });
  expect(mockRequest).not.toHaveBeenCalled();
});

test('a blob that is not local is requested at once, and the hook waits', async () => {
  mockReadFileBytes.mockResolvedValue(undefined);

  const { result } = renderHook(() => useReaderDoc('f1'));

  await waitFor(() => expect(mockRequest).toHaveBeenCalledWith('f1'));
  expect(result.current).toEqual({ status: 'loading' });
});

test('local bytes are decoded into the copy', async () => {
  mockReadFileBytes.mockResolvedValue(new Uint8Array([1]));
  mockDecode.mockResolvedValue(DOC);

  const { result } = renderHook(() => useReaderDoc('f1'));

  await waitFor(() => expect(result.current).toEqual({ status: 'ready', doc: DOC }));
  expect(mockRequest).not.toHaveBeenCalled();
});

test('bytes that are not a copy settle as unreadable, never a throw', async () => {
  mockReadFileBytes.mockResolvedValue(new Uint8Array([1]));
  mockDecode.mockResolvedValue(undefined);

  const { result } = renderHook(() => useReaderDoc('f1'));

  await waitFor(() => expect(result.current).toEqual({ status: 'unreadable' }));
});
