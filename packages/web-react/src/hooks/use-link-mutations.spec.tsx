/**
 * @jest-environment jsdom
 */
// `update`'s custom-image reclaim. The editors used to delete the image id from
// their dialog snapshot after the write; when another device had set a different
// image while the dialog was open, the write replaced THAT one, which nothing then
// named and nothing deleted — a blob charged to the account on every device until
// the orphaned-file sweep found it a month later. `update` now takes the replaced
// id from the record it re-reads before merging. The writes are stubbed at the
// data module; the hook's own logic is what runs.

import { act, renderHook } from '@testing-library/react';

import type { LinkItem } from '../data/queries';
import { useLinkMutations } from './use-link-mutations';

let mockStored: LinkItem | undefined;
const mockWriteLink = jest.fn((_username: string, _link: LinkItem, _patch: object) =>
  Promise.resolve(),
);
const mockDeleteFile = jest.fn((_username: string, _fileId: string) => Promise.resolve());
const mockRequestSync = jest.fn();

jest.mock('@stxapps/web-crypto', () => ({ newId: () => 'new-id' }));
jest.mock('../lib/resize-image', () => ({ resizeImage: jest.fn() }));
jest.mock('../contexts/auth-provider', () => ({ useAuth: () => ({ username: 'alice' }) }));
jest.mock('../contexts/sync-provider', () => ({
  useSync: () => ({ requestSync: () => mockRequestSync() }),
}));
jest.mock('../data/mutations', () => ({
  writeLink: (username: string, link: LinkItem, patch: object) =>
    mockWriteLink(username, link, patch),
  deleteFile: (username: string, fileId: string) => mockDeleteFile(username, fileId),
}));
jest.mock('../data/queries', () => ({
  linkIdOf: (link: LinkItem) => link.path.slice('links/'.length, -'.enc'.length),
  readLinkById: () => Promise.resolve(mockStored),
}));

const link = (customImageId?: string): LinkItem => ({
  url: 'https://example.com/a',
  listId: 'l_list',
  tagIds: [],
  createdAt: 1,
  updatedAt: 1,
  path: 'links/l_a.enc',
  ...(customImageId ? { customImageId } : {}),
});

beforeEach(() => {
  mockWriteLink.mockClear();
  mockDeleteFile.mockClear();
  mockRequestSync.mockClear();
});

it('deletes the image the write replaced, read off the stored record, not the snapshot', async () => {
  mockStored = link('f_other_device');
  const { result } = renderHook(() => useLinkMutations());

  await act(() => result.current.update(link('f_snapshot'), { customImageId: 'f_new' }));

  expect(mockDeleteFile.mock.calls).toEqual([['alice', 'f_other_device']]);
});

it('deletes the image a clear removed', async () => {
  mockStored = link('f_old');
  const { result } = renderHook(() => useLinkMutations());

  await act(() => result.current.update(link('f_old'), { customImageId: undefined }));

  expect(mockDeleteFile.mock.calls).toEqual([['alice', 'f_old']]);
});

it('deletes nothing when the patch leaves the image alone, or names the one it has', async () => {
  mockStored = link('f_kept');
  const { result } = renderHook(() => useLinkMutations());

  await act(() => result.current.update(link('f_kept'), { note: 'hi' }));
  await act(() => result.current.update(link('f_kept'), { customImageId: 'f_kept' }));

  expect(mockWriteLink).toHaveBeenCalledTimes(2);
  expect(mockDeleteFile).not.toHaveBeenCalled();
});

// The link write has landed by the time the reclaim runs. A delete that throws
// still fails the call, but the edit must be pushed: before the reclaim moved into
// `update`, the sync was asked for ahead of the delete.
it('asks for a sync even when the reclaim throws', async () => {
  mockStored = link('f_old');
  mockDeleteFile.mockRejectedValueOnce(new Error('store closed'));
  const { result } = renderHook(() => useLinkMutations());

  // `rejects` inside `act`, not around it (docs/testing.md, _an `act()` that a
  // matcher can't await_).
  await act(async () => {
    await expect(result.current.update(link('f_old'), { customImageId: 'f_new' })).rejects.toThrow(
      'store closed',
    );
  });

  expect(mockWriteLink).toHaveBeenCalledTimes(1);
  expect(mockRequestSync).toHaveBeenCalledTimes(1);
});
