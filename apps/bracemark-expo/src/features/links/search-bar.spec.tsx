import * as React from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react-native';

import { emptyQuery, type LinkQuery } from '@stxapps/shared';

import { SheetHost } from '../../components/ui/sheet';
import { touchClaim } from '../../testing/scroll-claim';
import { AdvancedSearchHost, SearchBar } from './search-bar';

// Advanced Search, opened from the search bar's trigger, in the links section's
// sheet. What is pinned:
//
//   - the include/exclude checklists' scroller claims its own blank touches.
//     It is a scroller nested in the sheet's body, whose content box is itself
//     a claimant (ui/sheet.tsx's ScrollClaim), so without one of its own a drag
//     starting on "No matching lists" or a gap between rows would not scroll on
//     iOS (components/ui/scroll-claim.tsx);
//   - Search is the paywall's moment for a free user, and commits nothing;
//   - a checklist row cycles include → exclude → off, and Search commits it.

const mockSetQuery = jest.fn<void, [LinkQuery]>();
let mockQuery: LinkQuery = emptyQuery();
jest.mock('./page-provider', () => ({
  useLinksPage: () => ({ query: mockQuery, setQuery: mockSetQuery }),
}));
jest.mock('./view-state-provider', () => ({
  useLinksViewState: () => ({
    searchVisible: true,
    bulkEditing: false,
    restorePreSearch: jest.fn(),
  }),
}));

type Node = {
  item: { id: string; name: string; parentId: string | null; rank: string };
  depth: number;
  children: Node[];
};
const node = (id: string, name: string): Node => ({
  item: { id, name, parentId: null, rank: 'a0' },
  depth: 0,
  children: [],
});
// Past the checklist's filter threshold (8), so the filter box shows.
const mockLists = Array.from({ length: 10 }, (_, i) => node(`list-${i}`, `List ${i}`));
const mockTags = [node('tag-a', 'alpha'), node('tag-b', 'beta')];

let mockSearchEditor = true;
jest.mock('@stxapps/expo-react', () => ({
  useLists: () => mockLists,
  useTags: () => mockTags,
  useEntitlements: () => ({ entitlements: { searchEditor: mockSearchEditor } }),
}));
const mockShowPaywall = jest.fn();
jest.mock('../../contexts/paywall-provider', () => ({
  usePaywall: () => ({ show: mockShowPaywall }),
}));
jest.mock('expo-router', () => ({ useRouter: () => ({ push: jest.fn() }) }));
// The sheet gates Android's back on its route being the focused one
// (components/ui/sheet.tsx); there is no navigator here.
jest.mock('@react-navigation/native', () => ({
  ...jest.requireActual('@react-navigation/native'),
  useIsFocused: () => true,
}));

beforeEach(() => {
  mockQuery = emptyQuery();
  mockSearchEditor = true;
  mockSetQuery.mockReset();
  mockShowPaywall.mockReset();
});

function openAdvancedSearch() {
  render(
    <SheetHost>
      <AdvancedSearchHost>
        <SearchBar />
      </AdvancedSearchHost>
    </SheetHost>,
  );
  fireEvent.press(screen.getByTestId('links-search-advanced'));
}

const submit = () =>
  act(async () => {
    fireEvent.press(screen.getByTestId('advanced-search-submit'));
  });

test('claims a touch on the checklist’s plain text inside its own scroller', () => {
  openAdvancedSearch();
  fireEvent.changeText(screen.getByLabelText('Filter lists'), 'nothing matches this');

  expect(touchClaim(screen.getByText('No matching lists'))).toBe('inside');
});

test('sends a free user to the paywall and commits nothing', async () => {
  mockSearchEditor = false;
  openAdvancedSearch();
  fireEvent.press(screen.getByLabelText('beta: not selected'));
  await submit();

  expect(mockShowPaywall).toHaveBeenCalledWith('searchEditor');
  expect(mockSetQuery).not.toHaveBeenCalled();
  // The sheet stays up behind the paywall, the draft as it was.
  expect(screen.getByLabelText('beta: included')).toBeTruthy();
});

test('cycles a row include → exclude → off, and commits what it shows', async () => {
  openAdvancedSearch();

  fireEvent.press(screen.getByLabelText('alpha: not selected'));
  fireEvent.press(screen.getByLabelText('alpha: included'));
  fireEvent.press(screen.getByLabelText('List 3: not selected'));
  fireEvent.press(screen.getByLabelText('beta: not selected'));
  fireEvent.press(screen.getByLabelText('beta: included'));
  fireEvent.press(screen.getByLabelText('beta: excluded'));
  expect(screen.getByLabelText('alpha: excluded')).toBeTruthy();
  expect(screen.getByLabelText('beta: not selected')).toBeTruthy();

  await submit();

  expect(mockSetQuery).toHaveBeenCalledTimes(1);
  const q = mockSetQuery.mock.calls[0][0];
  expect(q.lists.any).toEqual(['list-3']);
  expect(q.lists.none).toEqual([]);
  expect(q.tags.any).toEqual([]);
  expect(q.tags.none).toEqual(['tag-a']);
});
