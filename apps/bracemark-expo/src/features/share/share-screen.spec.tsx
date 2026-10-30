import * as React from 'react';
import { fireEvent, render, waitFor } from '@testing-library/react-native';

import {
  loadShareTaxonomy,
  saveSharedDraft,
  type ShareDraft,
} from '@stxapps/expo-react/data/share-store';
import {
  DEFAULT_LIST_ID,
  MY_LIST_ID,
  rankBetween,
  TREE_PATH_CUT,
  TREE_ROW_MAX_LEVELS,
} from '@stxapps/shared';

import { apiClient } from '../../lib/api-client';
import { touchClaim } from '../../testing/scroll-claim';
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
// The real guard renders nothing (it only calls an optional iOS module while
// mounted — share-swipe-guard.spec.tsx), so a marker stands in for "mounted".
jest.mock('./share-swipe-guard', () => {
  const { View } = jest.requireActual<typeof import('react-native')>('react-native');
  return { ShareSwipeGuard: () => <View testID="share-swipe-guard" /> };
});
// The app's api-client binding throws at import when EXPO_PUBLIC_API_URL is
// unset (as in jest); the sheet only threads it through to saveSharedDraft.
jest.mock('../../lib/api-client', () => ({ apiClient: { call: jest.fn() } }));

const loadShareTaxonomyMock = loadShareTaxonomy as jest.Mock;
const saveSharedDraftMock = saveSharedDraft as jest.Mock;

const TAXONOMY = {
  owner: 'alice',
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
    owner: null,
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
  const tagRow = getByTestId('share-tag-tag-a');
  expect(tagRow.props.accessibilityState.checked).toBe(false);
  fireEvent.press(tagRow);
  expect(getByTestId('share-tag-tag-a').props.accessibilityState.checked).toBe(true);
  // Tags is multi-select, so it takes an explicit Done.
  fireEvent.press(getByTestId('share-back'));

  fireEvent.press(getByTestId('share-add'));

  await waitFor(() => expect(saveSharedDraftMock).toHaveBeenCalledTimes(1));
  expect(saveSharedDraftMock).toHaveBeenCalledWith(expect.anything(), apiClient);
  const draft = saveSharedDraftMock.mock.calls[0][0] as ShareDraft;
  expect(draft).toMatchObject({
    // The account whose lists the sheet rendered — share-store's header, _a
    // draft belongs to an account_.
    owner: 'alice',
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

// The picker draws pending tags where their ranks will land them — above the
// snapshot's, newest first — so the sheet and the app agree on the order.
test('lists new tags above the existing ones, newest first', async () => {
  const { findByTestId, getByTestId, getAllByRole } = render(
    <ShareScreen url="https://example.com/b" />,
  );

  fireEvent.press(await findByTestId('share-tags-row'));
  const input = getByTestId('share-tag-input');
  fireEvent.changeText(input, 'fresh');
  fireEvent(input, 'submitEditing');
  fireEvent.changeText(input, 'newer');
  fireEvent(input, 'submitEditing');

  expect(getAllByRole('checkbox').map((row) => row.props.accessibilityLabel)).toEqual([
    'newer',
    'fresh',
    'alpha',
  ]);
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

// The pending list is a row like any other: the top one, and still there once
// the field filters — typing its name again must find it, not read "No lists
// found." or offer to create a second one.
test('keeps the pending new list at the top, and in the filtered rows', async () => {
  const { findByTestId, getByTestId, getAllByRole, queryByTestId, queryByText } = render(
    <ShareScreen url="https://example.com/c3" />,
  );

  fireEvent.press(await findByTestId('share-list-row'));
  fireEvent.changeText(getByTestId('share-list-input'), 'Cooking');
  fireEvent(getByTestId('share-list-input'), 'submitEditing');
  fireEvent.press(getByTestId('share-list-row'));

  expect(getAllByRole('menuitem')[0].props.testID).toBe('share-new-list');

  fireEvent.changeText(getByTestId('share-list-input'), 'cooking');
  expect(getByTestId('share-new-list')).toBeTruthy();
  expect(queryByText('No lists found.')).toBeNull();
  expect(queryByTestId('share-list-create')).toBeNull();
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

// The account can change while the sheet is open — the user switches to the
// app, signs out or into another account, and comes back to tap Save. The
// store refuses (share-store saveSharedDraft); the sheet must say so in an
// announcing error rather than show the saved state, because nothing was saved.
test('refuses with an error when the account changed while the sheet was open', async () => {
  saveSharedDraftMock.mockResolvedValueOnce('account-changed');
  const { findByTestId, queryByTestId } = render(<ShareScreen url="https://example.com/g" />);

  fireEvent.press(await findByTestId('share-add'));

  const error = await findByTestId('share-error');
  expect(error.props.role).toBe('alert');
  expect(queryByTestId('share-saved')).toBeNull();
});

// The compose tags row is a SUMMARY, and it is also the only thing on that
// screen whose height has no ceiling unless it is capped (share-screen.tsx's
// MAX_TAG_CHIPS): the chips wrap, the compose screen has no scroller — it has
// no text field either, so the keyboard never reaches it — and a panel that
// outgrows the frame does not clip, it paints outside its own background. None
// of that is visible to jest, so what this pins is the arithmetic: six drawn,
// the rest counted. Plus the half that must NOT be capped — the row still
// announces every name, because the cap is a space constraint on a 375pt row
// and a screen reader has none.
test('summarises the compose tags row past six chips, but announces them all', async () => {
  const names = ['alpha', 'bravo', 'charlie', 'delta', 'echo', 'foxtrot', 'golf', 'hotel', 'india'];
  loadShareTaxonomyMock.mockResolvedValue({
    ...TAXONOMY,
    tags: names.map((name, index) => ({ id: `tag-${name}`, name, rank: `a${index}` })),
  });
  const { findByTestId, getByTestId, getByText, getByLabelText, queryByText } = render(
    <ShareScreen url="https://example.com/g" />,
  );

  fireEvent.press(await findByTestId('share-tags-row'));
  for (const name of names) fireEvent.press(getByTestId(`share-tag-tag-${name}`));
  fireEvent.press(getByTestId('share-back'));

  // Six chips in pick order, then a count of what is left.
  expect(getByText('foxtrot')).toBeTruthy();
  expect(queryByText('golf')).toBeNull();
  expect(getByText('+3')).toBeTruthy();
  expect(getByLabelText(`Tags: ${names.join(', ')}`)).toBeTruthy();
});

// On iOS the host's own sheet answers a downward pull that starts on a scroller
// at its top, and a long one dismisses the share sheet with the share unsaved
// (docs/share-sheet.md, _the pickers hold the system's swipe off_). The guard
// holds it off for as long as it is mounted — and it must be mounted
// on BOTH pickers, the only screens with a scroller, and on neither side of
// them: the compose screen keeps the system's gesture on purpose. Nothing else
// fails if a picker drops `holdSwipe`; the sheet just leaves under the finger.
test('holds the system swipe off on the pickers, and only on the pickers', async () => {
  const { findByTestId, getByTestId, queryByTestId } = render(
    <ShareScreen url="https://example.com/h" />,
  );

  fireEvent.press(await findByTestId('share-list-row'));
  expect(getByTestId('share-swipe-guard')).toBeTruthy();
  fireEvent.press(getByTestId('share-back'));
  expect(queryByTestId('share-swipe-guard')).toBeNull();

  fireEvent.press(getByTestId('share-tags-row'));
  expect(getByTestId('share-swipe-guard')).toBeTruthy();
  fireEvent.press(getByTestId('share-back'));
  expect(queryByTestId('share-swipe-guard')).toBeNull();
});

// The snapshot ships each list's depth and nothing else, so the picker rebuilds
// a row's ancestor path from the rows above it — and used to copy the whole
// chain into every row. A list tree is as deep as a restored backup or another
// device makes it, so one long chain cost the square of its length in names, in
// the one process with a memory ceiling and no warning before it (docs/
// share-sheet.md). The path is bounded like the in-app picker's now
// (@stxapps/shared sync/tree.ts): whole down to the bound, marked as cut past
// it, and the row is still there to pick.
test('labels a filtered list with its path, cut past the row bound', async () => {
  const depth = TREE_ROW_MAX_LEVELS + 3;
  loadShareTaxonomyMock.mockResolvedValue({
    ...TAXONOMY,
    lists: Array.from({ length: depth }, (_, i) => ({
      id: `deep-${i}`,
      name: `L${i}`,
      depth: i,
      rank: 'a0',
    })),
  });
  const names = Array.from({ length: TREE_ROW_MAX_LEVELS }, (_, i) => `L${i}`);
  const { findByTestId, getByTestId, getByText } = render(
    <ShareScreen url="https://example.com/i" />,
  );
  fireEvent.press(await findByTestId('share-list-row'));

  // The control, a row AT the bound: every ancestor named, nothing cut.
  fireEvent.changeText(getByTestId('share-list-input'), `L${TREE_ROW_MAX_LEVELS}`);
  expect(getByText(`${names.join(' / ')} / `)).toBeTruthy();

  fireEvent.changeText(getByTestId('share-list-input'), `L${depth - 1}`);
  expect(getByText(`${[...names, TREE_PATH_CUT].join(' / ')} / `)).toBeTruthy();
  expect(getByTestId(`share-list-deep-${depth - 1}`)).toBeTruthy();
});

// Both pickers' scrollers sit inside the share sheet's frame, which claims the
// touches its children leave — so each claims them first from inside, or on
// iOS a drag that starts on the empty text (or any gap between rows) does not
// scroll (components/ui/scroll-claim.tsx). jest cannot drag; this pins where
// the touch is claimed.
test('claims a touch on the list picker’s plain text inside its scroller', async () => {
  loadShareTaxonomyMock.mockResolvedValue({ ...TAXONOMY, lists: [] });
  const { findByTestId, getByText } = render(<ShareScreen url="https://example.com/s1" />);
  fireEvent.press(await findByTestId('share-list-row'));

  expect(touchClaim(getByText('No lists found.'))).toBe('inside');
});

test('claims a touch on the tag picker’s plain text inside its scroller', async () => {
  loadShareTaxonomyMock.mockResolvedValue({ ...TAXONOMY, tags: [] });
  const { findByTestId, getByText } = render(<ShareScreen url="https://example.com/s2" />);
  fireEvent.press(await findByTestId('share-tags-row'));

  expect(touchClaim(getByText('No tags yet. Type a name to make one.'))).toBe('inside');
});
