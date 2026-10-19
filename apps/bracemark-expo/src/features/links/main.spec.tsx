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
// The lock provider's two answers about a list, for the pane-swap cases at the
// foot of the file. Both empty everywhere else: nothing is locked.
let mockLocked = new Set<string>();
let mockLockedByHand = new Set<string>();

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
  useLocks: () => ({
    isListLocked: (id: string) => mockLocked.has(id),
    isListLockedByHand: (id: string) => mockLockedByHand.has(id),
    unlockList: jest.fn(),
    biometricForList: () => false,
    biometricLabel: '',
    unlockListWithBiometric: jest.fn(),
  }),
  useSettings: () => ({ linksLayout: 'list' }),
  useSync: () => ({ bgSyncStatus: 'idle', requestSync: jest.fn() }),
  useTags: () => [],
}));
jest.mock('./page-provider', () => ({
  useLinksPage: () => ({ selection: mockSelection, query: { sortOn: 'createdAt' } }),
}));
// A phone-width window: the rail is a drawer, so the pane keeps the window.
jest.mock('./rail', () => ({ useLinksRail: () => ({ docked: false }) }));
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
// toolbar's dialogs, the lock pane's keyboard-aware scroller). The lock pane's
// stand-in reports the one prop this pane DECIDES — and latches it at mount, as
// the real one does, so a case reads what the pane was told on the way up.
jest.mock('./bulk-edit-bar', () => ({ BulkEditBar: () => null }));
jest.mock('../../components/lock-pane', () => {
  const { useState } = jest.requireActual('react');
  const { Text: MockText } = jest.requireActual('react-native');
  return {
    LockPane: ({ solicit = true }: { solicit?: boolean }) => {
      const [solicited] = useState(solicit);
      return <MockText testID="lock-pane">{solicited ? 'asks' : 'quiet'}</MockText>;
    },
  };
});

beforeEach(() => {
  mockLocked = new Set();
  mockLockedByHand = new Set();
});

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

// --- the locked-list swap: may the pane ask for the unlock as it goes up? -----
//
// The lock pane autofocuses its password field and auto-prompts biometrics on
// mount. Both are right on ARRIVAL at a locked list and wrong after the drawer's
// "Lock now" on the list being shown: the drawer is still open over this pane,
// so the keyboard came up for a field nobody could see, and a Face ID lock
// prompted to reopen itself (docs/locks.md, _a hand relock does not ask to be
// undone_). It takes BOTH facts to stay quiet — the pane went up in place, and
// the lock was engaged by hand — and each case below is one of the ways of
// having only one of them. Nothing else can see any of this: `solicit` is an
// optional boolean, and the symptom needs a keyboard or a sensor.
const X = { kind: 'list', id: 'list-x' };
const Y = { kind: 'list', id: 'list-y' };
const paneSays = () => screen.getByTestId('lock-pane').props.children as string;

test('"Lock now" on the list being shown puts the pane up without asking', () => {
  mockSelection = X;
  const view = render(<Main />);
  expect(screen.queryByTestId('lock-pane')).toBeNull();

  mockLocked = new Set([X.id]);
  mockLockedByHand = new Set([X.id]);
  view.rerender(<Main />);

  expect(paneSays()).toBe('quiet');
});

// The background auto-relock: same pane, same place, and the prompt on return is
// the point of it.
test('a list that relocks under the user, not by hand, still asks', () => {
  mockSelection = X;
  const view = render(<Main />);

  mockLocked = new Set([X.id]);
  view.rerender(<Main />);

  expect(paneSays()).toBe('asks');
});

// Locked from the drawer while ANOTHER list was showing, then visited: the mark
// is still on the lock, and it must not follow the user into an arrival.
test('a list locked by hand and arrived at later asks like any other', () => {
  mockSelection = Y;
  const view = render(<Main />);

  mockLocked = new Set([X.id]);
  mockLockedByHand = new Set([X.id]);
  view.rerender(<Main />);
  mockSelection = X;
  view.rerender(<Main />);

  expect(paneSays()).toBe('asks');
});

test('leaving a list locked in place and coming back is an arrival again', () => {
  mockSelection = X;
  const view = render(<Main />);
  mockLocked = new Set([X.id]);
  mockLockedByHand = new Set([X.id]);
  view.rerender(<Main />);
  expect(paneSays()).toBe('quiet');

  mockSelection = Y;
  view.rerender(<Main />);
  mockSelection = X;
  view.rerender(<Main />);

  expect(paneSays()).toBe('asks');
});

// One locked list straight to another: a different lock, so a different pane —
// not the first one's instance carrying its typed password across.
test('each locked list gets a pane of its own', () => {
  mockLocked = new Set([X.id, Y.id]);
  mockLockedByHand = new Set([X.id]);
  mockSelection = Y;
  const view = render(<Main />);
  mockLocked = new Set([Y.id]);
  mockSelection = X;
  view.rerender(<Main />);
  mockLocked = new Set([X.id, Y.id]);
  view.rerender(<Main />);
  expect(paneSays()).toBe('quiet');

  mockSelection = Y;
  view.rerender(<Main />);

  expect(paneSays()).toBe('asks');
});
