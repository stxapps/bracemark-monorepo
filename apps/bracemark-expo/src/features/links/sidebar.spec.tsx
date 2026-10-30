import * as React from 'react';
import { StyleSheet, View } from 'react-native';
import { PortalHost } from '@rn-primitives/portal';
import { act, fireEvent, render, screen, within } from '@testing-library/react-native';

import {
  readSidebarCollapsedIds,
  useLists,
  useLocks,
  useTagsOrUndefined,
  writeSidebarCollapsedIds,
} from '@stxapps/expo-react';
import {
  buildTree,
  LIST_NO_CHILDREN_IDS,
  type ListItem,
  type TagItem,
  TREE_INDENT_MAX_LEVELS_NARROW,
} from '@stxapps/shared';

import { useProgressiveCount } from '../../lib/use-progressive-count';
import type { Selection } from './page-provider';
import { Sidebar } from './sidebar';

// The drawer's two trees, and the twin of bracemark-web's `_panes/sidebar.spec.tsx`
// — read that header for the long form. In short: the rows are rendered FLAT off
// `flattenToRows`, where they used to be a component that rendered itself once
// per level, because a React tree as deep as the list tree overflows the stack
// in commit, and the list tree is as deep as a `parentId` chain a restored
// backup or another device decides. Nested, the semantics came from the
// nesting; flat, every one of them — which rows, what order, what indent, which
// chevron — is a rule the flattening restates, and a wrong one still renders.
//
// `@stxapps/expo-react` is mocked at the barrel (the real hooks are live reads
// over expo-sqlite and a lock provider above the app); the trees are built with
// the real `buildTree`.

jest.mock('@stxapps/expo-react', () => ({
  useLists: jest.fn(),
  useTagsOrUndefined: jest.fn(),
  useLocks: jest.fn(),
  readSidebarCollapsedIds: jest.fn(),
  writeSidebarCollapsedIds: jest.fn(),
}));

const mockSetSimpleQuery = jest.fn();
let mockSelection: Selection = { kind: 'all' };
jest.mock('./page-provider', () => ({
  useLinksPage: () => ({ selection: mockSelection, setSimpleQuery: mockSetSimpleQuery }),
}));
// Navigator plumbing, not the subject: the drawer's status only drives a
// keyboard dismissal, and the router only the footer links.
jest.mock('@react-navigation/drawer', () => ({ useDrawerStatus: () => 'open' }));
jest.mock('expo-router', () => ({ useRouter: () => ({ push: jest.fn() }) }));
// Every row at once, so the cases below read whole trees: the frame-by-frame
// fill is the hook's own spec (lib/use-progressive-count.spec.ts). One case
// caps it, which is what pins the trees reading it at all.
jest.mock('../../lib/use-progressive-count', () => ({
  useProgressiveCount: jest.fn((total: number) => total),
}));

let clock = 0;
const rank = () => `a${(clock++).toString().padStart(4, '0')}`;
const list = (id: string, name: string, parentId: string | null = null): ListItem => ({
  id,
  name,
  parentId,
  rank: rank(),
  createdAt: 0,
  updatedAt: 0,
  path: `lists/${id}.enc`,
});
const tag = (id: string, name: string, parentId: string | null = null): TagItem => ({
  id,
  name,
  parentId,
  rank: rank(),
  createdAt: 0,
  updatedAt: 0,
  path: `tags/${id}.enc`,
});

/** Work › Cooking › Recipes, Work › Travel, and Home beside Work. */
const NESTED = () => [
  list('work', 'Work'),
  list('cooking', 'Cooking', 'work'),
  list('recipes', 'Recipes', 'cooking'),
  list('travel', 'Travel', 'work'),
  list('home', 'Home'),
];

const setLists = (items: ListItem[]) =>
  jest.mocked(useLists).mockReturnValue(buildTree(items, { noChildrenIds: LIST_NO_CHILDREN_IDS }));
const setTags = (items: TagItem[]) =>
  jest.mocked(useTagsOrUndefined).mockReturnValue(buildTree(items));
const setHidden = (ids: string[]) =>
  jest.mocked(useLocks).mockReturnValue({
    hiddenListIds: new Set(ids),
    listLocks: new Map(),
    lockList: jest.fn(),
  } as unknown as ReturnType<typeof useLocks>);

// A rendered element, typed off RNTL's own root (react-test-renderer ships no
// declarations here — components/ui/dropdown-menu.spec.tsx does the same).
type Rendered = ReturnType<typeof render>['UNSAFE_root'];

// A row is the Pressable carrying the nav testID; the view around it holds the
// indent, the chevron and any trailing control.
const rowBox = (rowEl: Rendered): Rendered => {
  let box = rowEl.parent;
  while (box !== null && typeof box.type !== 'string') box = box.parent;
  if (box === null) throw new Error('row has no host parent');
  return box;
};
const rows = (kind: 'list' | 'tag' = 'list') =>
  screen.getAllByTestId(new RegExp(`^links-nav-${kind}-`)).map((rowEl) => ({
    id: String(rowEl.props.testID).replace(`links-nav-${kind}-`, ''),
    indent: StyleSheet.flatten(rowBox(rowEl).props.style)?.paddingLeft ?? 0,
  }));
const ids = () => rows().map((row) => row.id);
/** 'Collapse' | 'Expand' for the chevron beside a row, or null when it has none. */
const chevron = (id: string) =>
  within(rowBox(screen.getByTestId(`links-nav-list-${id}`))).queryByLabelText(
    /^(Collapse|Expand)$/,
  );
const chevronLabel = (id: string) => chevron(id)?.props.accessibilityLabel ?? null;

const mount = () => render(<Sidebar closeDrawer={jest.fn()} />);

beforeEach(() => {
  jest.clearAllMocks();
  clock = 0;
  mockSelection = { kind: 'all' };
  // clearAllMocks keeps implementations; the one case that caps the count
  // must not cap every case after it.
  jest.mocked(useProgressiveCount).mockImplementation((total) => total);
  jest.mocked(readSidebarCollapsedIds).mockReturnValue([]);
  setLists(NESTED());
  setTags([]);
  setHidden([]);
});

describe('Sidebar — the tree as flat rows', () => {
  it('lists parents before their children, one indent step per level', () => {
    mount();

    expect(rows()).toEqual([
      { id: 'work', indent: 0 },
      { id: 'cooking', indent: 16 },
      { id: 'recipes', indent: 32 },
      { id: 'travel', indent: 16 },
      { id: 'home', indent: 0 },
    ]);
    expect(screen.getByText('Recipes')).toBeTruthy();
  });

  // The chevron used to follow from the recursion — a node with children was
  // the node that rendered a subtree. Flat, it is a field on the row.
  it('gives a chevron to the rows with children, and to no others', () => {
    mount();

    expect(chevronLabel('work')).toBe('Collapse');
    expect(chevronLabel('cooking')).toBe('Collapse');
    expect(chevron('recipes')).toBeNull();
    expect(chevron('travel')).toBeNull();
    expect(chevron('home')).toBeNull();
  });

  it('selects by the row’s own id, at any depth, and closes the drawer', () => {
    const closeDrawer = jest.fn();
    render(<Sidebar closeDrawer={closeDrawer} />);

    fireEvent.press(screen.getByTestId('links-nav-list-recipes'));

    expect(mockSetSimpleQuery).toHaveBeenCalledWith({ kind: 'list', id: 'recipes' });
    expect(closeDrawer).toHaveBeenCalled();
  });

  it('renders the tags tree by the same rules', () => {
    setTags([tag('t1', 'reading'), tag('t2', 'papers', 't1'), tag('t3', 'later')]);
    mount();

    expect(rows('tag')).toEqual([
      { id: 't1', indent: 0 },
      { id: 't2', indent: 16 },
      { id: 't3', indent: 0 },
    ]);
  });
});

// "No tags yet" is a claim about the library, so it waits for the read: the
// pending `undefined` used to arrive as `[]` and the line opened every mount,
// tagged library or not, until the read landed.
describe('Sidebar — tags not read yet', () => {
  it('says nothing about tags until the read lands', () => {
    jest.mocked(useTagsOrUndefined).mockReturnValue(undefined);
    const { rerender } = mount();

    expect(screen.queryByText('No tags yet')).toBeNull();

    setTags([]);
    rerender(<Sidebar closeDrawer={jest.fn()} />);

    expect(screen.getByText('No tags yet')).toBeTruthy();
  });
});

describe('Sidebar — collapsing', () => {
  // The whole subtree, not the children: a flattening that skipped only the
  // direct children of a collapsed row would leave Recipes in the drawer,
  // indented under a parent that is no longer there.
  it('hides everything under a collapsed row and brings it back', () => {
    mount();

    fireEvent.press(chevron('work') as Rendered);

    expect(ids()).toEqual(['work', 'home']);
    expect(chevronLabel('work')).toBe('Expand');
    expect(writeSidebarCollapsedIds).toHaveBeenLastCalledWith(['work']);

    fireEvent.press(chevron('work') as Rendered);

    expect(ids()).toEqual(['work', 'cooking', 'recipes', 'travel', 'home']);
  });

  // Collapse is per row and survives its parent's: the nested version got this
  // for free, since an unrendered subtree kept no state to lose.
  it('keeps an inner row collapsed across its parent’s collapse', () => {
    mount();

    fireEvent.press(chevron('cooking') as Rendered);
    fireEvent.press(chevron('work') as Rendered);
    fireEvent.press(chevron('work') as Rendered);

    expect(ids()).toEqual(['work', 'cooking', 'travel', 'home']);
    expect(chevronLabel('cooking')).toBe('Expand');
  });

  // The stored set says both ancestors are collapsed; the selection is under
  // them. A row the user is LOOKING AT must not be hidden by an old collapse.
  it('opens the collapsed ancestors of the selected list', () => {
    jest.mocked(readSidebarCollapsedIds).mockReturnValue(['work', 'cooking']);
    mockSelection = { kind: 'list', id: 'recipes' };
    mount();

    expect(ids()).toEqual(['work', 'cooking', 'recipes', 'travel', 'home']);
    expect(screen.getByTestId('links-nav-list-recipes').props.accessibilityState).toEqual({
      selected: true,
    });
  });

  // The rows are memoized and handed `active` by the sidebar rather than reading
  // the page themselves, so a selection that moves after mount is the case a
  // stale row would show: the old row still lit, the new one not.
  it('moves the highlight when the selection changes after mount', () => {
    mockSelection = { kind: 'list', id: 'home' };
    const view = mount();
    const selected = (id: string) =>
      screen.getByTestId(`links-nav-list-${id}`).props.accessibilityState?.selected;
    expect(selected('home')).toBe(true);

    mockSelection = { kind: 'list', id: 'recipes' };
    view.rerender(<Sidebar closeDrawer={jest.fn()} />);

    expect(selected('recipes')).toBe(true);
    expect(selected('home')).toBe(false);
  });

  // The control for the case above: with the selection elsewhere, the stored
  // collapse stands — otherwise "everything is always expanded" passes it.
  it('leaves a stored collapse alone when the selection is not under it', () => {
    jest.mocked(readSidebarCollapsedIds).mockReturnValue(['work']);
    mockSelection = { kind: 'list', id: 'home' };
    mount();

    expect(ids()).toEqual(['work', 'home']);
  });
});

describe('Sidebar — hidden lists', () => {
  // A locked list with "hide" on is dropped from the drawer WITH its subtree
  // (docs/locks.md): a child left behind names the list meant not to be seen.
  it('drops a hidden list and everything under it', () => {
    setHidden(['cooking']);
    mount();

    expect(ids()).toEqual(['work', 'travel', 'home']);
    // Work kept one child, so it keeps its chevron.
    expect(chevron('work')).not.toBeNull();
  });

  it('drops the chevron of a row whose only children are hidden', () => {
    setLists([list('work', 'Work'), list('cooking', 'Cooking', 'work')]);
    setHidden(['cooking']);
    mount();

    expect(ids()).toEqual(['work']);
    expect(chevron('work')).toBeNull();
  });
});

describe('Sidebar — a tree that changes under it', () => {
  // The rows are siblings in ONE list now, so their keys have to stay unique
  // across the whole tree and a moved row has to land once, at its new depth.
  // React reports a key collision as a console.error and renders anyway.
  it('follows a list to its new parent without doubling or losing a row', () => {
    const errors = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    const view = mount();

    clock = 0;
    setLists([
      list('work', 'Work'),
      list('cooking', 'Cooking', 'work'),
      list('travel', 'Travel', 'work'),
      list('home', 'Home'),
      list('recipes', 'Recipes', 'home'),
    ]);
    view.rerender(<Sidebar closeDrawer={jest.fn()} />);

    expect(rows()).toEqual([
      { id: 'work', indent: 0 },
      { id: 'cooking', indent: 16 },
      { id: 'travel', indent: 16 },
      { id: 'home', indent: 0 },
      { id: 'recipes', indent: 16 },
    ]);
    expect(chevron('cooking')).toBeNull();
    expect(chevron('home')).not.toBeNull();
    expect(errors).not.toHaveBeenCalled();
    errors.mockRestore();
  });
});

// The reason the rows are flat. Every case above passes against the old
// self-rendering component too — they are the behaviour the two share — and
// this is the one that tells them apart: nested, React's tree was as deep as
// the chain and rendering it overflowed the stack (a RangeError, in the drawer
// every signed-in screen mounts). 3,000 is past where that version fell over
// under jest; the list tree itself is built without recursion and is not what
// is being tested (@stxapps/shared sync/tree.spec.ts goes far deeper).
describe('Sidebar — a big tree mounts in slices', () => {
  // A tree rendered whole in one commit is what froze the links screen's first
  // load at `plus-worst` size (docs/e2e.md, _the render leg_). The tree renders
  // the count the hook gives it, not the tree's length.
  it('renders only the rows the progressive count has reached', () => {
    jest.mocked(useProgressiveCount).mockImplementation((total) => Math.min(total, 2));
    mount();

    expect(ids()).toEqual(['work', 'cooking']);
  });
});

describe('Sidebar — a chain deeper than React can nest', () => {
  it('renders every row, indented by its depth up to the cap', () => {
    const DEPTH = 3000;
    setLists(
      Array.from({ length: DEPTH }, (_, i) => list(`l${i}`, `L${i}`, i === 0 ? null : `l${i - 1}`)),
    );
    const view = mount();

    // Straight off the rendered tree, not through `rows()`: a testID query
    // re-walks the tree per matcher and takes tens of seconds at this size.
    const all = view.UNSAFE_root.findAll(
      (el: Rendered) =>
        typeof el.type === 'string' && /^links-nav-list-/.test(String(el.props.testID)),
    );
    expect(all).toHaveLength(DEPTH);
    const last = all[DEPTH - 1];
    expect(last.props.testID).toBe(`links-nav-list-l${DEPTH - 1}`);
    // Each row is indented by its own depth, 16 a level — then no further than
    // TREE_INDENT_MAX_LEVELS_NARROW, or a deep chain's labels have no width left.
    const indent = (row: Rendered) => StyleSheet.flatten(rowBox(row).props.style)?.paddingLeft;
    expect(indent(all[3])).toBe(48);
    expect(indent(all[TREE_INDENT_MAX_LEVELS_NARROW])).toBe(TREE_INDENT_MAX_LEVELS_NARROW * 16);
    expect(indent(last)).toBe(TREE_INDENT_MAX_LEVELS_NARROW * 16);
    // Past the cap the rows share one indent, so each says its level instead —
    // counted from 1, and absent on the row the cap still indents truly.
    const level = (row: Rendered, n: number) =>
      within(rowBox(row)).queryByText(String(n), { includeHiddenElements: true });
    expect(level(all[TREE_INDENT_MAX_LEVELS_NARROW], TREE_INDENT_MAX_LEVELS_NARROW + 1)).toBeNull();
    expect(
      level(all[TREE_INDENT_MAX_LEVELS_NARROW + 1], TREE_INDENT_MAX_LEVELS_NARROW + 2),
    ).not.toBeNull();
    expect(level(last, DEPTH)).not.toBeNull();
  });
});

// --- the long-press peek ------------------------------------------------------
//
// A row is one line, so a long name truncates and a nested one loses its place
// once the indent caps out; a hold shows both (components/ui/peek.tsx). What can
// go wrong unseen: a hold that ALSO selects (RN fires onPress on release unless a
// long-press handler is set), and a bubble that outlives the finger because the
// row's measurement came back after it lifted. The bubble is hidden from screen
// readers, so the queries here have to ask for hidden elements.
describe('holding a row', () => {
  const hidden = { includeHiddenElements: true };
  type Measured = (
    x: number,
    y: number,
    w: number,
    h: number,
    pageX: number,
    pageY: number,
  ) => void;
  let measured: Measured | undefined;

  beforeEach(() => {
    measured = undefined;
    jest.spyOn(View.prototype, 'measure').mockImplementation((callback) => {
      measured = callback;
    });
  });
  afterEach(() => jest.restoreAllMocks());

  const mountWithHost = () =>
    render(
      <>
        <Sidebar closeDrawer={jest.fn()} />
        <PortalHost />
      </>,
    );
  const hold = (id: string) => {
    fireEvent(screen.getByTestId(`links-nav-list-${id}`), 'longPress');
    act(() => measured?.(0, 0, 200, 36, 16, 300));
  };
  const release = (id: string) => fireEvent(screen.getByTestId(`links-nav-list-${id}`), 'pressOut');

  it("shows a nested row's whole name and its path while held, and selects nothing", () => {
    mountWithHost();
    hold('recipes');

    expect(screen.getAllByText('Recipes', hidden)).toHaveLength(2);
    expect(screen.getByText('Work › Cooking', hidden)).toBeTruthy();
    expect(mockSetSimpleQuery).not.toHaveBeenCalled();

    release('recipes');
    expect(screen.getAllByText('Recipes', hidden)).toHaveLength(1);
  });

  // Placed from the row's PAGE offsets — the root view's frame, which is the
  // portal's — and never the local x/y `measure` also hands back, nor
  // `measureInWindow`, which on Android starts below the status bar and stood the
  // bubble 24dp above its row on the tablet (components/ui/peek.tsx). The mocked
  // frame is 320×640: above a row at page y 300, the bubble's bottom sits at
  // 640 − 300 + 4.
  it("anchors the bubble to the row's page offsets", () => {
    mountWithHost();
    fireEvent(screen.getByTestId('links-nav-list-recipes'), 'longPress');
    act(() => measured?.(99, 99, 200, 36, 16, 300));

    // The bubble is the absolutely placed box around the text.
    let bubble: Rendered | null = screen.getByText('Work › Cooking', hidden);
    while (bubble && StyleSheet.flatten(bubble.props.style)?.position !== 'absolute') {
      bubble = bubble.parent;
    }
    expect(StyleSheet.flatten(bubble?.props.style)).toMatchObject({ left: 16, bottom: 344 });
  });

  it('names no path for a top-level row', () => {
    mountWithHost();
    hold('work');

    expect(screen.getAllByText('Work', hidden)).toHaveLength(2);
    expect(screen.queryByText(/›/, hidden)).toBeNull();
  });

  // The finger lifted before the row's box came back: nothing may open, since
  // nothing would ever close it.
  it('opens nothing for a measurement that lands after the release', () => {
    mountWithHost();
    fireEvent(screen.getByTestId('links-nav-list-recipes'), 'longPress');
    release('recipes');
    act(() => measured?.(0, 0, 200, 36, 16, 300));

    expect(screen.getAllByText('Recipes', hidden)).toHaveLength(1);
  });

  // The nearest ancestors place a row; a deep chain's far end is elided.
  it('elides the far end of a deep path', () => {
    setLists([
      list('a', 'A'),
      list('b', 'B', 'a'),
      list('c', 'C', 'b'),
      list('d', 'D', 'c'),
      list('e', 'E', 'd'),
    ]);
    mountWithHost();
    hold('e');

    expect(screen.getByText('… › B › C › D', hidden)).toBeTruthy();
  });
});
