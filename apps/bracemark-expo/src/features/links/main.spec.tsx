import * as React from 'react';
import type { ScrollViewProps } from 'react-native';
import { render, screen } from '@testing-library/react-native';

import type { LinkView } from '@stxapps/expo-react';

import { Main } from './main';

// What this pane gets WRONG if nothing pins it: it swaps its scroller for the
// empty state and the keyboard's exits go with the scroller. The search box
// above the pane is `autoFocus` and commits on return, so the only ways to put
// its keyboard down WITHOUT submitting or leaving the search are the two the
// pane's scroller carries — `"handled"` (a tap on anything that isn't a
// control) and `on-drag` (docs/soft-keyboard.md, _dismissal_). They sat on the
// FlashList alone, and a search that matched nothing rendered a plain View in
// its place: keyboard up, nothing under it that could take it down.
//
// Nothing else can catch that. A View is a valid child, both props are
// optional, and the symptom needs a keyboard — which jest does not render, so
// what is pinned here is the PROPS, and the gestures themselves are the device
// case's (VIEWPORT-KEYBOARD-001). The first read's skeleton is deliberately not
// in the table: it is on screen for the length of one local read.
//
// The store seam and the two providers are mocked whole, as this file's peers
// do. FlashList is stood in for by the ScrollView it forwards these props to.
let mockLinks: LinkView[] = [];
let mockSelection: { kind: string; id?: string } = { kind: 'none' };

jest.mock('@shopify/flash-list', () => {
  const { ScrollView } = jest.requireActual('react-native');
  return {
    FlashList: ({ testID, keyboardShouldPersistTaps, keyboardDismissMode }: ScrollViewProps) => (
      <ScrollView
        testID={testID}
        keyboardShouldPersistTaps={keyboardShouldPersistTaps}
        keyboardDismissMode={keyboardDismissMode}
      />
    ),
  };
});
jest.mock('@stxapps/expo-react', () => ({
  useExtraction: () => ({ reportDisplayedLinkPaths: jest.fn() }),
  useLocks: () => ({ isListLocked: () => false }),
  useSettings: () => ({ linksLayout: 'list' }),
  useSync: () => ({ bgSyncStatus: 'idle', requestSync: jest.fn() }),
  useTags: () => [],
}));
jest.mock('./page-provider', () => ({
  useLinksPage: () => ({ selection: mockSelection, query: { sortOn: 'createdAt' } }),
}));
jest.mock('./view-state-provider', () => ({
  useLinksViewState: () => ({ bulkEditing: false, selectedLinks: new Map() }),
  useLinksViewActions: () => ({ setScrolled: jest.fn(), toggleSelected: jest.fn() }),
}));
jest.mock('./use-links', () => ({
  useLinks: () => ({
    links: mockLinks,
    pinnedCount: 0,
    hasMore: false,
    showMore: jest.fn(),
    isLoading: false,
    hasPending: false,
    applyPending: jest.fn(),
  }),
}));
// Neither is under test, and each drags in a tree of its own (the bulk
// toolbar's dialogs, the lock pane's keyboard-aware scroller).
jest.mock('./bulk-edit-bar', () => ({ BulkEditBar: () => null }));
jest.mock('../../components/lock-pane', () => ({ LockPane: () => null }));

const link = { path: 'links/a.enc', url: 'https://example.com', tagIds: [] } as unknown as LinkView;

// Every settled thing the pane can show under a focused search box, by the
// testID a device run finds it with (docs/e2e.md, _the testID contract_).
const PANES = [
  { state: 'rows', links: [link], selection: { kind: 'none' }, testID: 'links-list' },
  {
    state: 'a search with no match',
    links: [],
    selection: { kind: 'none' },
    testID: 'links-empty',
  },
  {
    state: 'an empty list',
    links: [],
    selection: { kind: 'list', id: 'some-list' },
    testID: 'links-empty',
  },
];

test.each(PANES)(
  'showing $state, the pane is still a scroller that can put the keyboard down',
  ({ links, selection, testID }) => {
    mockLinks = links;
    mockSelection = selection;

    render(<Main />);

    const pane = screen.getByTestId(testID);
    expect(pane.props.keyboardShouldPersistTaps).toBe('handled');
    expect(pane.props.keyboardDismissMode).toBe('on-drag');
  },
);

// The control for the table above: the empty rows of it must be reading the
// empty state, not a list that rendered with nothing in it.
test('an empty view shows its message rather than an empty list', () => {
  mockLinks = [];
  mockSelection = { kind: 'none' };

  render(<Main />);

  expect(screen.getByText('No links match')).toBeTruthy();
  expect(screen.queryByTestId('links-list')).toBeNull();
});
