import * as React from 'react';
import { StyleSheet } from 'react-native';
import { fireEvent, render, screen, within } from '@testing-library/react-native';

import {
  readSidebarCollapsedIds,
  useLists,
  useLocks,
  useTags,
  writeSidebarCollapsedIds,
} from '@stxapps/expo-react';
import { buildTree, LIST_NO_CHILDREN_IDS, type ListItem, type TagItem } from '@stxapps/shared';

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
  useTags: jest.fn(),
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
const setTags = (items: TagItem[]) => jest.mocked(useTags).mockReturnValue(buildTree(items));
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
describe('Sidebar — a chain deeper than React can nest', () => {
  it('renders every row, the last one at its own depth', () => {
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
    expect(StyleSheet.flatten(rowBox(last).props.style)?.paddingLeft).toBe((DEPTH - 1) * 16);
  });
});
