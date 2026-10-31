import * as React from 'react';
import { Dimensions, type ScrollViewProps } from 'react-native';
import { cleanup, render, screen } from '@testing-library/react-native';

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
// The rail-toggle cases at the foot of the file: the layout, whether the rail is
// docked, and every `extraData` the list was handed, in order.
let mockLayout = 'list';
let mockDocked = false;
let mockRailWidth = 280;
const mockExtraData: unknown[] = [];
let mockViewId = 0;
let mockKeyExtractor: ((item: LinkView) => string) | undefined;

jest.mock('@shopify/flash-list', () => {
  const { ScrollView } = jest.requireActual('react-native');
  return {
    FlashList: ({
      testID,
      keyboardShouldPersistTaps,
      keyboardDismissMode,
      extraData,
      keyExtractor,
    }: ScrollViewProps & { extraData: unknown; keyExtractor: (item: LinkView) => string }) => {
      mockExtraData.push(extraData);
      mockKeyExtractor = keyExtractor;
      return (
        <ScrollView
          testID={testID}
          keyboardShouldPersistTaps={keyboardShouldPersistTaps}
          keyboardDismissMode={keyboardDismissMode}
        />
      );
    },
  };
});
jest.mock('@stxapps/expo-react', () => {
  // One tree for every render, as the live read holds one: a fresh array would
  // rebuild the tag map, and with it the list's `extraData`, on every render.
  const tags: never[] = [];
  return {
    useExtraction: () => ({ reportDisplayedLinkPaths: jest.fn() }),
    useLocks: () => ({
      isListLocked: (id: string) => mockLocked.has(id),
      isListLockedByHand: (id: string) => mockLockedByHand.has(id),
      unlockList: jest.fn(),
      biometricForList: () => false,
      biometricLabel: '',
      unlockListWithBiometric: jest.fn(),
    }),
    useSettings: () => ({ linksLayout: mockLayout }),
    useSync: () => ({ bgSyncStatus: 'idle', requestSync: jest.fn() }),
    useTags: () => tags,
  };
});
jest.mock('./page-provider', () => ({
  useLinksPage: () => ({ selection: mockSelection, query: { sortOn: 'createdAt' } }),
}));
// A phone-width window by default: the rail is a drawer, so the pane keeps the
// window. The rail-toggle cases dock it.
jest.mock('./sidebar-rail', () => ({
  useSidebarRail: () => ({ docked: mockDocked, width: mockRailWidth }),
}));
// Stable across renders, as the real provider's values are: a fresh map or
// setter per render would hand the list a new `extraData` every time, and the
// rail-toggle cases below could never see one held.
jest.mock('./view-state-provider', () => {
  const state = { bulkEditing: false, selectedLinks: new Map() };
  const actions = { setScrolled: jest.fn(), toggleSelected: jest.fn() };
  return { useLinksViewState: () => state, useLinksViewActions: () => actions };
});
jest.mock('./use-links', () => ({
  useLinks: () => ({
    links: mockLinks,
    viewId: mockViewId,
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
  mockLayout = 'list';
  mockDocked = false;
  mockRailWidth = 280;
  mockExtraData.length = 0;
  mockViewId = 0;
  mockKeyExtractor = undefined;
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

// --- the row key: what FlashList anchors on --------------------------------------
//
// A row that keeps its key across two views is the anchor FlashList holds still,
// so a drawer pick jumps to wherever that link sits in the new order (the note
// above `keyExtractor`; docs/client-queries.md). The same key across two renders
// of ONE view is what the refresh pill and a local save rely on, hence both ways.
describe('the row key', () => {
  const keyInView = (viewId: number) => {
    mockViewId = viewId;
    mockLinks = [link];
    mockSelection = { kind: 'none' };
    render(<Main />);
    cleanup();
    return mockKeyExtractor?.(link);
  };

  it('differs for the same link in another view, so nothing anchors across the change', () => {
    expect(keyInView(1)).not.toBe(keyInView(2));
  });

  it('holds within a view, so a re-read keeps its anchor', () => {
    expect(keyInView(1)).toBe(keyInView(1));
  });
});

// --- the rail toggle: what reaches the mounted items ---------------------------
//
// Docking or putting away the rail changes the pane's width by the rail's width on
// one tap, and everything the list's `extraData` carries is a memo'd prop of every
// mounted item — so a new one there re-renders every row on screen at once,
// which is what the toggle used to cost (docs/e2e.md, _the render leg_). A row
// draws nothing from its width but which side of the date breakpoint it is on
// (link-row.tsx, bucketRowWidth), so across a toggle that leaves it on the same
// side the list must be handed the SAME object. The card's banner is sized off
// its width, so for the card it must not be — the control that the first case
// isn't passing merely because nothing reaches `extraData` at all.
describe('a rail toggle on a wide window', () => {
  const tablet = { width: 1180, height: 820, scale: 2, fontScale: 1 };
  const phone = Dimensions.get('window');
  beforeEach(() => Dimensions.set({ window: tablet, screen: tablet }));
  // Unmount first: RNTL's own cleanup is a top-level afterEach, which jest runs
  // after this one, so the pane would still be subscribed to the window and
  // re-render outside act (docs/testing.md, _an update that lands after act()_).
  afterEach(() => {
    cleanup();
    Dimensions.set({ window: phone, screen: phone });
  });

  const toggled = (layout: string) => {
    mockLayout = layout;
    mockLinks = [link];
    mockSelection = { kind: 'none' };
    mockDocked = true;
    const view = render(<Main />);
    const docked = mockExtraData.at(-1);
    mockDocked = false;
    view.rerender(<Main />);
    return { docked, away: mockExtraData.at(-1) };
  };

  test('re-renders no list row whose date column stays put', () => {
    const { docked, away } = toggled('list');
    expect(docked).toBeDefined();
    expect(away).toBe(docked);
  });

  // Wider undocked, and so a column more: each cell narrower, every banner new.
  test('re-renders the cards, whose banners follow the width', () => {
    const { docked, away } = toggled('card');
    expect(away).not.toBe(docked);
    expect((away as { itemWidth: number }).itemWidth).not.toBe(
      (docked as { itemWidth: number }).itemWidth,
    );
  });
  // The pane is the window less the rail's RESOLVED width, not a constant: at
  // 1180 a Wide rail leaves 1180 − 360 − 16 = 804 for two columns of 402, a
  // Narrow one 924 for two of 462. Subtract a fixed 280 and both get 442.
  test("lays the cards out against the rail's stepped width", () => {
    mockLayout = 'card';
    mockLinks = [link];
    mockSelection = { kind: 'none' };
    mockDocked = true;
    mockRailWidth = 360;
    const view = render(<Main />);
    const wide = mockExtraData.at(-1) as { itemWidth: number };
    mockRailWidth = 240;
    view.rerender(<Main />);
    const narrow = mockExtraData.at(-1) as { itemWidth: number };

    expect(wide.itemWidth).toBe(402);
    expect(narrow.itemWidth).toBe(462);
  });
});
