import * as React from 'react';
import { PortalHost } from '@rn-primitives/portal';
import { act, fireEvent, render, screen } from '@testing-library/react-native';

import type { LinkView } from '@stxapps/expo-react';

import { touchClaim } from '../../testing/scroll-claim';
import { BulkTagsDialog } from './bulk-tags-dialog';

const mockCloseRetag = jest.fn();
const mockExitBulkEdit = jest.fn();
const mockUpdateMany = jest.fn();
const mockFindOrCreate = jest.fn();
let mockRetagging: LinkView[] | null = null;

const TAGS = [
  { item: { id: 'only-a', name: 'Only A' }, depth: 0, children: [] },
  { item: { id: 'common', name: 'Common' }, depth: 0, children: [] },
  { item: { id: 'only-b', name: 'Only B' }, depth: 0, children: [] },
];
let mockTags = TAGS;

jest.mock('@stxapps/expo-react', () => ({
  useLinks: jest.fn(),
  useTags: () => mockTags,
  useLinkMutations: () => ({ updateMany: mockUpdateMany }),
  useTagMutations: () => ({ findOrCreate: mockFindOrCreate }),
}));

jest.mock('./view-state-provider', () => ({
  useLinksViewState: () => ({
    retagging: mockRetagging,
    closeRetag: mockCloseRetag,
    exitBulkEdit: mockExitBulkEdit,
  }),
}));

const link = (path: string, tagIds: string[]) => ({ path, tagIds }) as unknown as LinkView;
const A = link('a', ['only-a', 'common']);
const B = link('b', ['common', 'only-b']);

function mount() {
  return render(
    <>
      <BulkTagsDialog />
      <PortalHost />
    </>,
  );
}

beforeEach(() => {
  mockTags = TAGS;
  mockRetagging = [A, B];
  mockCloseRetag.mockClear();
  mockExitBulkEdit.mockClear();
  mockUpdateMany.mockReset().mockResolvedValue(undefined);
  mockFindOrCreate.mockReset();
});

// TagsCommand's scroller sits under DialogContent, which claims every touch its
// children leave; TagsCommand has to claim them first from inside, or a drag
// starting on the empty text does not scroll on iOS
// (components/ui/scroll-claim.tsx).
test('claims a touch on non-row content inside the picker scroller', () => {
  mockTags = [];
  mount();

  expect(touchClaim(screen.getByText('No tags found.'))).toBe('inside');
});

test('renders nothing when no bulk tag request is open', () => {
  mockRetagging = null;
  mount();

  expect(screen.queryByText('Edit tags')).toBeNull();
});

test('starts with only tags shared by every selected link checked', () => {
  mount();

  expect(screen.getByLabelText('Only A').props.accessibilityState.checked).toBe(false);
  expect(screen.getByLabelText('Common').props.accessibilityState.checked).toBe(true);
  expect(screen.getByLabelText('Only B').props.accessibilityState.checked).toBe(false);
});

test('applies the visible diff per link without stripping partial tags', async () => {
  mount();

  // Remove the shared tag and add a tag that only A carried before the edit.
  fireEvent.press(screen.getByLabelText('Common'));
  fireEvent.press(screen.getByLabelText('Only A'));
  await act(async () => {
    fireEvent.press(screen.getByText('Save'));
  });

  expect(mockUpdateMany).toHaveBeenCalledWith([
    { link: A, patch: { tagIds: ['only-a'] } },
    { link: B, patch: { tagIds: ['only-b', 'only-a'] } },
  ]);
  expect(mockCloseRetag).toHaveBeenCalledTimes(1);
  expect(mockExitBulkEdit).toHaveBeenCalledTimes(1);
});

test('waits for the batch write before closing the dialog and bulk mode', async () => {
  let finish!: () => void;
  mockUpdateMany.mockReturnValue(
    new Promise<void>((resolve) => {
      finish = resolve;
    }),
  );
  mount();

  fireEvent.press(screen.getByLabelText('Only B'));
  fireEvent.press(screen.getByText('Save'));

  expect(screen.getByText('Saving…')).toBeTruthy();
  expect(mockCloseRetag).not.toHaveBeenCalled();
  expect(mockExitBulkEdit).not.toHaveBeenCalled();

  await act(async () => finish());

  expect(mockCloseRetag).toHaveBeenCalledTimes(1);
  expect(mockExitBulkEdit).toHaveBeenCalledTimes(1);
});

test('does not write unchanged links when the diff already matches them', async () => {
  mockRetagging = [link('same-a', ['common']), link('same-b', ['common'])];
  mount();

  await act(async () => {
    fireEvent.press(screen.getByText('Save'));
  });

  expect(mockUpdateMany).toHaveBeenCalledWith([]);
});
