import { fireEvent, render, screen, within } from '@testing-library/react';

import {
  buildTree,
  LIST_NO_CHILDREN_IDS,
  type TagItem,
  TREE_INDENT_MAX_LEVELS_NARROW,
} from '@stxapps/shared';
import {
  type ListItem,
  readSidebarCollapsedIds,
  useLists,
  useLocks,
  useTagsOrUndefined,
  writeSidebarCollapsedIds,
} from '@stxapps/web-react';

import type { Selection } from '../_contexts/page-provider';
import { SidebarBody } from './sidebar';

// The rail's two trees. They are rendered as FLAT rows off `flattenToRows` — a
// row is indented by padding and never nested in its parent's element — where
// they used to be a component that rendered itself once per level. That made
// the React tree as deep as the list tree, and the list tree is as deep as a
// `parentId` chain a restored backup or another device decides, so a long chain
// overflowed the stack in React's commit: on this rail, which every session
// opens, on every launch.
//
// Nothing structural holds the flat version to the old one's behaviour. The
// nesting used to BE the semantics — a collapsed parent simply did not render
// the component that held its subtree — and now each of those is a rule the
// flattening has to restate: which rows exist, in what order, at what indent,
// with which chevron. Get one wrong and the rail still renders, still typechecks,
// and shows a tree that is not the user's. Those rules are what is pinned here;
// the walk itself is `tree.spec.ts`'s.
//
// `@stxapps/web-react` is mocked at the barrel: the real hooks are Dexie
// liveQueries over an encrypted store and a lock provider above the app. The
// trees are built with the real `buildTree`, so the rows are shaped as the app's.

jest.mock('@stxapps/web-react', () => ({
  useLists: jest.fn(),
  useTagsOrUndefined: jest.fn(),
  useLocks: jest.fn(),
  readSidebarCollapsedIds: jest.fn(),
  writeSidebarCollapsedIds: jest.fn(),
}));

const mockSetSimpleQuery = jest.fn();
let mockSelection: Selection = { kind: 'all' };
jest.mock('../_contexts/page-provider', () => ({
  useLinksPage: () => ({ selection: mockSelection, setSimpleQuery: mockSetSimpleQuery }),
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

// A section is its disclosure header plus its rows, in one wrapper. A ROW is the
// button that selects — neither a chevron (`aria-expanded`) nor a labelled
// trailing control — and its indent is on the element around it.
const section = (label: 'Lists' | 'Tags') =>
  screen.getByRole('button', { name: label }).parentElement as HTMLElement;
const rowButtons = (label: 'Lists' | 'Tags' = 'Lists') =>
  Array.from(
    section(label).querySelectorAll<HTMLElement>('button:not([aria-expanded]):not([aria-label])'),
  );
const rows = (label: 'Lists' | 'Tags' = 'Lists') =>
  rowButtons(label).map((button) => ({
    name: button.textContent,
    indent: (button.parentElement as HTMLElement).style.paddingLeft,
  }));
const names = (label: 'Lists' | 'Tags' = 'Lists') => rows(label).map((row) => row.name);
const row = (name: string) => {
  const found = rowButtons().find((button) => button.textContent === name);
  if (found === undefined) throw new Error(`no row named ${name}`);
  return found;
};
/** The chevron beside a row, or null when the row has none. */
const chevron = (name: string) =>
  within(row(name).parentElement as HTMLElement).queryByRole('button', {
    name: /^(Collapse|Expand)$/,
  });

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
    render(<SidebarBody />);

    expect(rows()).toEqual([
      { name: 'Work', indent: '' },
      { name: 'Cooking', indent: '16px' },
      { name: 'Recipes', indent: '32px' },
      { name: 'Travel', indent: '16px' },
      { name: 'Home', indent: '' },
    ]);
  });

  // The chevron used to follow from the recursion — a node with children was
  // the node that rendered a subtree. Flat, it is a field on the row.
  it('gives a chevron to the rows with children, and to no others', () => {
    render(<SidebarBody />);

    expect(chevron('Work')?.getAttribute('aria-expanded')).toBe('true');
    expect(chevron('Cooking')?.getAttribute('aria-expanded')).toBe('true');
    expect(chevron('Recipes')).toBeNull();
    expect(chevron('Travel')).toBeNull();
    expect(chevron('Home')).toBeNull();
  });

  it('selects by the row’s own id, at any depth', () => {
    render(<SidebarBody />);

    fireEvent.click(row('Recipes'));

    expect(mockSetSimpleQuery).toHaveBeenCalledWith({ kind: 'list', id: 'recipes' });
  });

  it('renders the tags tree by the same rules', () => {
    setTags([tag('t1', 'reading'), tag('t2', 'papers', 't1'), tag('t3', 'later')]);
    render(<SidebarBody />);

    expect(rows('Tags')).toEqual([
      { name: 'reading', indent: '' },
      { name: 'papers', indent: '16px' },
      { name: 'later', indent: '' },
    ]);
  });
});

// "No tags yet" is a claim about the library, so it waits for the read: the
// pending `undefined` used to arrive as `[]` and the line opened every page load,
// tagged library or not, until IndexedDB answered.
describe('Sidebar — tags not read yet', () => {
  it('says nothing about tags until the read lands', () => {
    jest.mocked(useTagsOrUndefined).mockReturnValue(undefined);
    const { rerender } = render(<SidebarBody />);

    expect(screen.queryByText('No tags yet')).toBeNull();

    setTags([]);
    rerender(<SidebarBody />);

    expect(screen.getByText('No tags yet')).toBeTruthy();
  });
});

describe('Sidebar — collapsing', () => {
  // The whole subtree, not the children: a flattening that skipped only the
  // direct children of a collapsed row would leave Recipes on the rail,
  // indented under a parent that is no longer there.
  it('hides everything under a collapsed row and brings it back', () => {
    render(<SidebarBody />);

    fireEvent.click(chevron('Work') as HTMLElement);

    expect(names()).toEqual(['Work', 'Home']);
    expect(chevron('Work')?.getAttribute('aria-expanded')).toBe('false');
    expect(writeSidebarCollapsedIds).toHaveBeenLastCalledWith(['work']);

    fireEvent.click(chevron('Work') as HTMLElement);

    expect(names()).toEqual(['Work', 'Cooking', 'Recipes', 'Travel', 'Home']);
  });

  // Collapse is per row and survives its parent's: the nested version got this
  // for free, since an unrendered subtree kept no state to lose.
  it('keeps an inner row collapsed across its parent’s collapse', () => {
    render(<SidebarBody />);

    fireEvent.click(chevron('Cooking') as HTMLElement);
    fireEvent.click(chevron('Work') as HTMLElement);
    fireEvent.click(chevron('Work') as HTMLElement);

    expect(names()).toEqual(['Work', 'Cooking', 'Travel', 'Home']);
    expect(chevron('Cooking')?.getAttribute('aria-expanded')).toBe('false');
  });

  // The stored set says both ancestors are collapsed; the selection is under
  // them. A row the user is LOOKING AT must not be hidden by an old collapse.
  it('opens the collapsed ancestors of the selected list', () => {
    jest.mocked(readSidebarCollapsedIds).mockReturnValue(['work', 'cooking']);
    mockSelection = { kind: 'list', id: 'recipes' };
    render(<SidebarBody />);

    expect(names()).toEqual(['Work', 'Cooking', 'Recipes', 'Travel', 'Home']);
    expect(row('Recipes').getAttribute('aria-current')).toBe('true');
  });

  // The control for the case above: with the selection elsewhere, the stored
  // collapse stands — otherwise "everything is always expanded" passes it.
  it('leaves a stored collapse alone when the selection is not under it', () => {
    jest.mocked(readSidebarCollapsedIds).mockReturnValue(['work']);
    mockSelection = { kind: 'list', id: 'home' };
    render(<SidebarBody />);

    expect(names()).toEqual(['Work', 'Home']);
  });
});

describe('Sidebar — hidden lists', () => {
  // A locked list with "hide" on is dropped from the rail WITH its subtree
  // (docs/locks.md): the rail is the navigation half of hiding, and a child left
  // behind names the list that was meant not to be seen.
  it('drops a hidden list and everything under it', () => {
    setHidden(['cooking']);
    render(<SidebarBody />);

    expect(names()).toEqual(['Work', 'Travel', 'Home']);
    // Work kept one child, so it keeps its chevron.
    expect(chevron('Work')).not.toBeNull();
  });

  it('drops the chevron of a row whose only children are hidden', () => {
    setLists([list('work', 'Work'), list('cooking', 'Cooking', 'work')]);
    setHidden(['cooking']);
    render(<SidebarBody />);

    expect(names()).toEqual(['Work']);
    expect(chevron('Work')).toBeNull();
  });
});

describe('Sidebar — a tree that changes under it', () => {
  // The rows are siblings in ONE list now, so their keys have to stay unique
  // across the whole tree and a moved row has to land once, at its new depth.
  // React reports a key collision as a console.error and renders anyway.
  it('follows a list to its new parent without doubling or losing a row', () => {
    const errors = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    const { rerender } = render(<SidebarBody />);

    clock = 0;
    setLists([
      list('work', 'Work'),
      list('cooking', 'Cooking', 'work'),
      list('travel', 'Travel', 'work'),
      list('home', 'Home'),
      list('recipes', 'Recipes', 'home'),
    ]);
    rerender(<SidebarBody />);

    expect(rows()).toEqual([
      { name: 'Work', indent: '' },
      { name: 'Cooking', indent: '16px' },
      { name: 'Travel', indent: '16px' },
      { name: 'Home', indent: '' },
      { name: 'Recipes', indent: '16px' },
    ]);
    expect(chevron('Cooking')).toBeNull();
    expect(chevron('Home')).not.toBeNull();
    expect(errors).not.toHaveBeenCalled();
    errors.mockRestore();
  });
});

// The reason the rows are flat. Every case above passes against the old
// self-rendering component too — they are the behaviour the two share — and
// this is the one that tells them apart: nested, React's tree was as deep as
// the chain and its commit overflowed the stack (a RangeError out of render,
// on the rail every session opens). 6,000 is past where that version fell over
// under jest; the list tree itself is built without recursion and is not what
// is being tested (@stxapps/shared sync/tree.spec.ts goes far deeper).
describe('Sidebar — a chain deeper than React can nest', () => {
  it('renders every row, indented by its depth up to the cap', () => {
    const DEPTH = 6000;
    setLists(
      Array.from({ length: DEPTH }, (_, i) => list(`l${i}`, `L${i}`, i === 0 ? null : `l${i - 1}`)),
    );
    const { container } = render(<SidebarBody />);

    // Straight off the DOM, not through `rows()`: a role query computes an
    // accessible name for each of 12,000 buttons, which takes minutes. The Lists
    // section is the nav's first child.
    const lists = container.querySelector('nav > div') as HTMLElement;
    const all = lists.querySelectorAll<HTMLElement>(
      'button:not([aria-expanded]):not([aria-label])',
    );
    expect(all).toHaveLength(DEPTH);
    expect(all[DEPTH - 1].textContent).toBe(`L${DEPTH - 1}`);
    // Each row is indented by its own depth, 16px a level — then no further
    // than TREE_INDENT_MAX_LEVELS_NARROW, or the rail runs sideways (a 100-deep chain
    // was 1,600px of it) and the label has no width left.
    const indent = (i: number) => (all[i].parentElement as HTMLElement).style.paddingLeft;
    expect(indent(3)).toBe('48px');
    expect(indent(TREE_INDENT_MAX_LEVELS_NARROW)).toBe(`${TREE_INDENT_MAX_LEVELS_NARROW * 16}px`);
    expect(indent(DEPTH - 1)).toBe(`${TREE_INDENT_MAX_LEVELS_NARROW * 16}px`);
    // Past the cap the rows share one indent, so each says its level instead —
    // counted from 1, and absent on the row the cap still indents truly.
    const level = (i: number) =>
      (all[i].parentElement as HTMLElement).querySelector('[title^="Level "]')?.textContent ?? null;
    expect(level(3)).toBeNull();
    expect(level(TREE_INDENT_MAX_LEVELS_NARROW)).toBeNull();
    expect(level(TREE_INDENT_MAX_LEVELS_NARROW + 1)).toBe(
      String(TREE_INDENT_MAX_LEVELS_NARROW + 2),
    );
    expect(level(DEPTH - 1)).toBe(String(DEPTH));
  });
});
