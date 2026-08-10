import * as React from 'react';
import { fireEvent, render, waitFor } from '@testing-library/react-native';

import {
  loadShareTaxonomy,
  saveSharedDraft,
  type ShareDraft,
} from '@stxapps/expo-react/data/share-store';
import { DEFAULT_LIST_ID, MY_LIST_ID, rankBetween } from '@stxapps/shared';

import { apiClient } from '../../lib/api-client';
import { ShareScreen } from './share-screen';

// The store seam is mocked whole — the sheet's data exchange is share-store's
// concern (spec'd there); these specs cover the screen's behavior over it.
jest.mock('@stxapps/expo-react/data/share-store', () => ({
  loadShareTaxonomy: jest.fn(),
  saveSharedDraft: jest.fn(),
}));
// `minted-1` is always the sheet's LINK id: ShareScreen mints it once at mount
// (share-screen.tsx's `linkId`, so a retried Save can't file the page twice), so
// the ids the pickers mint start at `minted-2`.
let mockIdCounter = 0;
jest.mock('@stxapps/expo-crypto/lib/ids', () => ({
  newId: jest.fn(() => `minted-${++mockIdCounter}`),
}));
jest.mock('./share-host', () => ({ closeShareSheet: jest.fn() }));
// The app's api-client binding throws at import when EXPO_PUBLIC_API_URL is
// unset (as in jest); the sheet only threads it through to saveSharedDraft.
jest.mock('../../lib/api-client', () => ({ apiClient: { call: jest.fn() } }));

const loadShareTaxonomyMock = loadShareTaxonomy as jest.Mock;
const saveSharedDraftMock = saveSharedDraft as jest.Mock;

const TAXONOMY = {
  sessionPresent: true,
  lists: [
    { id: MY_LIST_ID, name: 'My List', depth: 0, rank: 'a0' },
    { id: 'list-a', name: 'Reading', depth: 0, rank: 'a1' },
  ],
  tags: [{ id: 'tag-a', name: 'alpha', rank: 'a0' }],
  linkCount: 3,
  maxLinks: null,
};

beforeEach(() => {
  mockIdCounter = 0;
  loadShareTaxonomyMock.mockReset().mockResolvedValue(TAXONOMY);
  saveSharedDraftMock.mockReset().mockResolvedValue('saved');
});

test('shows the signed-out notice when no session is present', async () => {
  loadShareTaxonomyMock.mockResolvedValue({
    sessionPresent: false,
    lists: [],
    tags: [],
    linkCount: 0,
    maxLinks: null,
  });
  const { findByTestId } = render(<ShareScreen url="https://example.com" />);
  expect(await findByTestId('share-signed-out')).toBeTruthy();
});

test('shows the no-url notice when nothing shareable arrived', async () => {
  const { findByTestId } = render(<ShareScreen url={null} />);
  expect(await findByTestId('share-no-url')).toBeTruthy();
});

// The cap gate refuses BEFORE the form, like every other create surface — so
// there is no Save button to press at all (docs/share-sheet.md, _the plan's
// link cap_).
test('replaces the form with the quota banner at the plan’s link cap', async () => {
  loadShareTaxonomyMock.mockResolvedValue({ ...TAXONOMY, linkCount: 200, maxLinks: 200 });
  const { findByTestId, queryByTestId } = render(<ShareScreen url="https://example.com" />);
  expect(await findByTestId('share-quota')).toBeTruthy();
  expect(queryByTestId('share-add')).toBeNull();
});

// An unknown cap fails OPEN — guessing `free` would tell a paying customer
// their library is full.
test('offers the form when the cap is unknown', async () => {
  loadShareTaxonomyMock.mockResolvedValue({ ...TAXONOMY, linkCount: 9999, maxLinks: null });
  const { findByTestId } = render(<ShareScreen url="https://example.com" />);
  expect(await findByTestId('share-add')).toBeTruthy();
});

test('saves a draft into the picked list and shows the saved state', async () => {
  const { findByTestId, getByTestId } = render(
    <ShareScreen url="https://example.com/a" title="Example" />,
  );

  fireEvent.press(await findByTestId('share-list-row'));
  // Picking closes the list screen and returns to compose.
  fireEvent.press(getByTestId('share-list-list-a'));

  fireEvent.press(getByTestId('share-tags-row'));
  fireEvent.press(getByTestId('share-tag-tag-a'));
  // Tags is multi-select, so it takes an explicit Done.
  fireEvent.press(getByTestId('share-back'));

  fireEvent.press(getByTestId('share-add'));

  await waitFor(() => expect(saveSharedDraftMock).toHaveBeenCalledTimes(1));
  expect(saveSharedDraftMock).toHaveBeenCalledWith(expect.anything(), apiClient);
  const draft = saveSharedDraftMock.mock.calls[0][0] as ShareDraft;
  expect(draft).toMatchObject({
    url: 'https://example.com/a',
    title: 'Example',
    listId: 'list-a',
    tagIds: ['tag-a'],
    newTags: [],
    newLists: [],
  });
  expect(draft.id).toMatch(/^minted-/);
  expect(await findByTestId('share-saved')).toBeTruthy();
});

test('defaults to the inbox list and reuses an existing tag by name', async () => {
  const { findByTestId, getByTestId } = render(<ShareScreen url="https://example.com/b" />);

  fireEvent.press(await findByTestId('share-tags-row'));
  const input = getByTestId('share-tag-input');
  // Case-insensitive reuse — must select tag-a, not mint a duplicate.
  fireEvent.changeText(input, 'ALPHA');
  fireEvent(input, 'submitEditing');
  // A genuinely new name mints a new tag, ranked before the first existing one
  // (web findOrCreate's create-at-index-0).
  fireEvent.changeText(input, 'fresh');
  fireEvent(input, 'submitEditing');
  fireEvent.press(getByTestId('share-back'));
  fireEvent.press(getByTestId('share-add'));

  await waitFor(() => expect(saveSharedDraftMock).toHaveBeenCalledTimes(1));
  const draft = saveSharedDraftMock.mock.calls[0][0] as ShareDraft;
  expect(draft.listId).toBe(DEFAULT_LIST_ID);
  expect(draft.newTags).toEqual([{ id: 'minted-2', name: 'fresh', rank: rankBetween(null, 'a0') }]);
  expect(draft.tagIds).toEqual(['tag-a', 'minted-2']);
});

test('creates a new list — minted, selected, ranked before the first root list', async () => {
  const { findByTestId, getByTestId } = render(<ShareScreen url="https://example.com/c" />);

  fireEvent.press(await findByTestId('share-list-row'));
  const input = getByTestId('share-list-input');
  fireEvent.changeText(input, 'Cooking');
  fireEvent(input, 'submitEditing');
  fireEvent.press(getByTestId('share-add'));

  await waitFor(() => expect(saveSharedDraftMock).toHaveBeenCalledTimes(1));
  const draft = saveSharedDraftMock.mock.calls[0][0] as ShareDraft;
  // Created = selected; the rank prepends (web ListSelect's create-at-index-0).
  expect(draft.newLists).toEqual([
    { id: 'minted-2', name: 'Cooking', rank: rankBetween(null, 'a0') },
  ]);
  expect(draft.listId).toBe('minted-2');
});

// The Create row is the same affordance as submitting the field — and it is
// suppressed on an exact case-insensitive match (below).
test('creates a new list from the Create row', async () => {
  const { findByTestId, getByTestId } = render(<ShareScreen url="https://example.com/c2" />);

  fireEvent.press(await findByTestId('share-list-row'));
  fireEvent.changeText(getByTestId('share-list-input'), 'Cooking');
  fireEvent.press(getByTestId('share-list-create'));
  fireEvent.press(getByTestId('share-add'));

  await waitFor(() => expect(saveSharedDraftMock).toHaveBeenCalledTimes(1));
  const draft = saveSharedDraftMock.mock.calls[0][0] as ShareDraft;
  expect(draft.listId).toBe('minted-2');
});

test('reuses an existing list on an exact case-insensitive name match', async () => {
  const { findByTestId, getByTestId, queryByTestId } = render(
    <ShareScreen url="https://example.com/d" />,
  );

  fireEvent.press(await findByTestId('share-list-row'));
  const input = getByTestId('share-list-input');
  fireEvent.changeText(input, 'reading');
  // No Create row competing with the identical row right above it.
  expect(queryByTestId('share-list-create')).toBeNull();
  fireEvent(input, 'submitEditing');
  fireEvent.press(getByTestId('share-add'));

  await waitFor(() => expect(saveSharedDraftMock).toHaveBeenCalledTimes(1));
  const draft = saveSharedDraftMock.mock.calls[0][0] as ShareDraft;
  expect(draft.listId).toBe('list-a');
  expect(draft.newLists).toEqual([]);
});

test('discards the pending new list when another list is selected', async () => {
  const { findByTestId, getByTestId, queryByTestId } = render(
    <ShareScreen url="https://example.com/e" />,
  );

  fireEvent.press(await findByTestId('share-list-row'));
  const input = getByTestId('share-list-input');
  fireEvent.changeText(input, 'Cooking');
  fireEvent(input, 'submitEditing');
  // Selecting away discards the pending create — an unselected new list must
  // never be created.
  fireEvent.press(getByTestId('share-list-row'));
  fireEvent.press(getByTestId('share-list-list-a'));
  fireEvent.press(getByTestId('share-list-row'));
  expect(queryByTestId('share-new-list')).toBeNull();
  fireEvent.press(getByTestId('share-back'));
  fireEvent.press(getByTestId('share-add'));

  await waitFor(() => expect(saveSharedDraftMock).toHaveBeenCalledTimes(1));
  const draft = saveSharedDraftMock.mock.calls[0][0] as ShareDraft;
  expect(draft.listId).toBe('list-a');
  expect(draft.newLists).toEqual([]);
});

// The link id is minted ONCE per sheet, not once per Save attempt — the sheet's
// own retry is a retry like any other, and "idempotent by construction"
// (share-store's header) only holds if the id survives it. Android's apply
// writes the link row before the extraction title, so a throw between them plus
// a re-minted id would file the page twice.
test('reuses the same link id when a failed save is retried', async () => {
  saveSharedDraftMock.mockRejectedValueOnce(new Error('write failed'));
  const { findByTestId, getByTestId } = render(<ShareScreen url="https://example.com/f" />);

  fireEvent.press(await findByTestId('share-add'));
  expect(await findByTestId('share-error')).toBeTruthy();
  fireEvent.press(getByTestId('share-add'));

  await waitFor(() => expect(saveSharedDraftMock).toHaveBeenCalledTimes(2));
  const first = saveSharedDraftMock.mock.calls[0][0] as ShareDraft;
  const retried = saveSharedDraftMock.mock.calls[1][0] as ShareDraft;
  expect(retried.id).toBe(first.id);
});
