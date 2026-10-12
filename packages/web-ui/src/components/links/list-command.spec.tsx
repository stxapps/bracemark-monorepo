import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';

import {
  buildTree,
  LIST_NO_CHILDREN_IDS,
  type ListItem,
  TREE_PATH_CUT,
  TREE_ROW_MAX_LEVELS,
} from '@stxapps/shared';
import { useLists } from '@stxapps/web-react';

import { installJsdomStubs } from '../../testing/jsdom-stubs';
import { ListCommand } from './list-command';

// The one list picker behind every "pick a list" surface: the editors' ListSelect
// wraps it in a popover, both row menus embed it in a submenu, the Lists settings
// menu embeds it to pick a PARENT, and MoveToSurface puts it in a sheet or a
// dialog. Six surfaces, one implementation — so the rules it encodes are rules
// nobody can see from any single call site, and each of the opt-ins below is a
// prop one of those surfaces deliberately does NOT pass.
//
// `@stxapps/web-react` is mocked at the barrel: the real `useLists` is a Dexie
// liveQuery over an encrypted local store, and none of what is asserted here is
// about that. The tree itself is built with the real `buildTree`, so the rows are
// shaped exactly as the app's are.

jest.mock('@stxapps/web-react', () => ({ useLists: jest.fn(() => []) }));

// cmdk observes its list and scrolls the selected row into view; jsdom has
// neither API.
beforeAll(installJsdomStubs);

let clock = 0;
const list = (id: string, name: string, parentId: string | null = null): ListItem => ({
  id,
  name,
  parentId,
  rank: `a${(clock++).toString().padStart(3, '0')}`,
  createdAt: 0,
  updatedAt: 0,
  path: `lists/${id}.enc`,
});

const setLists = (items: ListItem[]) => {
  clock = 0;
  (useLists as jest.Mock).mockReturnValue(
    buildTree(items, { noChildrenIds: LIST_NO_CHILDREN_IDS }),
  );
};

/** Work › Cooking › Recipes, plus a sibling and Trash — a real nested shape. */
const NESTED = () => {
  const work = list('work', 'Work');
  const cooking = list('cooking', 'Cooking', 'work');
  const recipes = list('recipes', 'Recipes', 'cooking');
  const personal = list('personal', 'Personal');
  const trash = list('trash', 'Trash');
  return [work, cooking, recipes, personal, trash];
};

const rowNames = () => screen.getAllByRole('option').map((el) => el.textContent);
/** Rows minus the Create row, for assertions about which LISTS are shown. */
const listRows = () => rowNames().filter((name) => !name?.startsWith('Create '));
const filterBox = () => screen.queryByRole('combobox');
const type = (value: string) =>
  fireEvent.change(screen.getByRole('combobox'), { target: { value } });

beforeEach(() => jest.clearAllMocks());

describe('ListCommand — when there is a filter box', () => {
  // Below the threshold, scrolling beats a filter box, so a small account gets a
  // plain list of rows.
  it('renders no filter box for a handful of lists', () => {
    setLists(NESTED());
    render(<ListCommand onSelect={jest.fn()} />);

    expect(filterBox()).toBeNull();
  });

  it('renders one past the threshold', () => {
    setLists(Array.from({ length: 11 }, (_, i) => list(`l${i}`, `List ${i}`)));
    render(<ListCommand onSelect={jest.fn()} />);

    expect(filterBox()?.getAttribute('placeholder')).toBe('Search lists…');
  });

  // THE COUNT GATE IS NOT THE ONLY REASON FOR THE INPUT. Where this instance can
  // create, the input is ALSO the Create row's name field — so it has to earn its
  // keep at any count. Gate it on the count alone and a small account (which is
  // most accounts) opens an editor's or a Move-to picker with nothing to type into
  // and no way to reach the Create row at all.
  it('renders one at any count when the surface can create', () => {
    setLists(NESTED());
    render(<ListCommand onSelect={jest.fn()} onCreate={jest.fn()} />);

    expect(filterBox()?.getAttribute('placeholder')).toBe('Search or create lists…');
  });
});

// Two hosts put this picker in a dropdown SUBMENU, and Radix closes a submenu on
// ArrowLeft from anywhere inside it. The filter box doubles as the Create row's
// name field, so that key is also how a typo in a new list's name gets fixed —
// and without the guard it closed the menu and took the name with it. The host
// is stood in for by a parent keydown listener, which is all Radix's is.
//
// The guard itself lives in CommandInput (ui/command.tsx), so TagsCommand has it
// too; it is pinned here in full because this is the picker whose hosts need it,
// and in tags-command.spec.tsx only as far as "the shared field still has it".
describe('ListCommand — the filter box keeps its caret keys', () => {
  const renderInHost = () => {
    const onHostKeyDown = jest.fn();
    setLists(NESTED());
    render(
      <div onKeyDown={onHostKeyDown}>
        <ListCommand onSelect={jest.fn()} onCreate={jest.fn()} />
      </div>,
    );
    const input = screen.getByRole('combobox') as HTMLInputElement;
    act(() => void type('Groceries'));
    return { input, onHostKeyDown };
  };

  it('keeps ArrowLeft from the host while there is a caret to move', () => {
    const { input, onHostKeyDown } = renderInHost();
    input.setSelectionRange(9, 9);

    fireEvent.keyDown(input, { key: 'ArrowLeft' });

    expect(onHostKeyDown).not.toHaveBeenCalled();
  });

  // The other half, and the positive control for the case above: with nothing
  // left to do in the field the key is the keyboard's way back to the parent
  // menu, and swallowing it there would trap focus in the submenu.
  it('lets ArrowLeft through once the caret is at the start', () => {
    const { input, onHostKeyDown } = renderInHost();
    input.setSelectionRange(0, 0);

    fireEvent.keyDown(input, { key: 'ArrowLeft' });

    expect(onHostKeyDown).toHaveBeenCalledTimes(1);
  });

  // Select-all, then ArrowLeft: the selection starts at 0, but the key still has
  // work to do in the field — it collapses the selection — so it is the field's.
  // A guard that reads only where the selection STARTS lets this one through,
  // and the menu closes on a fully selected name.
  it('keeps ArrowLeft from the host while a selection reaches back to the start', () => {
    const { input, onHostKeyDown } = renderInHost();
    input.setSelectionRange(0, 9);

    fireEvent.keyDown(input, { key: 'ArrowLeft' });

    expect(onHostKeyDown).not.toHaveBeenCalled();
  });

  it('leaves every other key alone', () => {
    const { input, onHostKeyDown } = renderInHost();
    input.setSelectionRange(9, 9);

    fireEvent.keyDown(input, { key: 'ArrowRight' });

    expect(onHostKeyDown).toHaveBeenCalledTimes(1);
  });
});

describe('ListCommand — the two render modes', () => {
  // Indentation only means something while the whole tree is on screen: a depth-3
  // match floating on its own indent has no visible parent to be indented under.
  // So a filtered row swaps the indent for its ancestor path.
  it('shows plain names while unfiltered and ancestor paths while filtering', () => {
    setLists(NESTED());
    render(<ListCommand onSelect={jest.fn()} onCreate={jest.fn()} />);

    expect(rowNames()).toEqual(['Work', 'Cooking', 'Recipes', 'Personal', 'Trash']);

    act(() => void type('recip'));

    expect(listRows()).toEqual(['Work / Cooking / Recipes']);
  });

  it('matches case-insensitively on the name', () => {
    setLists(NESTED());
    render(<ListCommand onSelect={jest.fn()} onCreate={jest.fn()} />);

    act(() => void type('COOK'));

    expect(listRows()).toEqual(['Work / Cooking']);
  });

  // The `root` entry ("Top level" in the Lists settings reparent menu) has no name
  // to match, and the filtered view is name-matches only — leaving it in would put
  // an unmatched row at the top of a list of matches.
  it('hides the root entry while filtering', () => {
    setLists(NESTED());
    render(
      <ListCommand
        onSelect={jest.fn()}
        onCreate={jest.fn()}
        root={{ label: 'Top level', selected: false, onSelect: jest.fn() }}
      />,
    );
    expect(rowNames()[0]).toBe('Top level');

    act(() => void type('recip'));

    expect(listRows()).toEqual(['Work / Cooking / Recipes']);
  });

  // Already at the root, so moving there is a no-op — the same treatment the
  // current list's own row gets via `disabledIds`.
  it('disables the root entry when it is already selected', () => {
    setLists(NESTED());
    render(
      <ListCommand
        onSelect={jest.fn()}
        root={{ label: 'Top level', selected: true, onSelect: jest.fn() }}
      />,
    );

    expect(screen.getByRole('option', { name: 'Top level' }).getAttribute('aria-disabled')).toBe(
      'true',
    );
  });
});

describe('ListCommand — selecting', () => {
  // "Visible but not selectable" — the link's current list in the row menu's Move
  // to. The tree's shape (and the user's bearings) stays intact while a no-op move
  // is ruled out.
  it('keeps a disabled row visible and refuses to select it', () => {
    const onSelect = jest.fn();
    setLists(NESTED());
    render(<ListCommand onSelect={onSelect} disabledIds={['personal']} />);

    const row = screen.getByRole('option', { name: 'Personal' });
    expect(row.getAttribute('aria-disabled')).toBe('true');

    fireEvent.click(row);
    expect(onSelect).not.toHaveBeenCalled();
  });

  // `excludeIds` is the other one — Trash in the editors, where trashing is its
  // own explicit action and never a "move". Excluded rows are gone, not disabled.
  it('drops an excluded row entirely', () => {
    setLists(NESTED());
    render(<ListCommand onSelect={jest.fn()} excludeIds={['trash']} />);

    expect(rowNames()).toEqual(['Work', 'Cooking', 'Recipes', 'Personal']);
  });
});

describe('ListCommand — the Create row', () => {
  it('is absent on surfaces that did not opt in', () => {
    setLists(Array.from({ length: 11 }, (_, i) => list(`l${i}`, `List ${i}`)));
    render(<ListCommand onSelect={jest.fn()} />);

    act(() => void type('Groceries'));

    // The Lists settings reparent menu picks a PARENT for a list, and minting a
    // sibling from inside that picker is incoherent (docs/editors.md) — so the
    // row is something a surface asks for, never something it gets.
    expect(screen.queryByRole('option', { name: /Create/ })).toBeNull();
    expect(screen.getByText('No lists found.')).not.toBeNull();
  });

  it('offers a create for a name no list has, and passes it back trimmed', async () => {
    const onCreate = jest.fn();
    setLists(NESTED());
    render(<ListCommand onSelect={jest.fn()} onCreate={onCreate} />);

    act(() => void type('  Groceries  '));
    await act(async () => {
      fireEvent.click(screen.getByRole('option', { name: /Create/ }));
    });

    expect(onCreate).toHaveBeenCalledWith('Groceries');
  });

  // Stricter than it strictly has to be: unlike a tag, a list is not identified by
  // its name, so a second "Recipes" under a different parent is legitimate. But a
  // Create row sitting directly under an identical row reads as a mistake far more
  // often than as intent, and the deliberate-duplicate case still has Settings →
  // Lists.
  it.each(['Recipes', 'recipes', 'RECIPES'])('suppresses the create for %s', (query) => {
    setLists(NESTED());
    render(<ListCommand onSelect={jest.fn()} onCreate={jest.fn()} />);

    act(() => void type(query));

    expect(screen.queryByRole('option', { name: /Create/ })).toBeNull();
    expect(listRows()).toEqual(['Work / Cooking / Recipes']);
  });

  // The same rule, for a list the picker does not SHOW. Every creating picker
  // hides Trash, so a check against the visible rows offered Create “Trash” to
  // someone who typed it looking for the real one — and on a Move to surface,
  // where confirming the name is the whole move, that is a second Trash with the
  // link already filed in it. The empty state is what is left, and it is
  // accepted: nothing here can be picked.
  it.each(['Trash', 'trash'])('suppresses the create for %s, a list this picker hides', (query) => {
    setLists(NESTED());
    render(<ListCommand onSelect={jest.fn()} onCreate={jest.fn()} excludeIds={['trash']} />);

    act(() => void type(query));

    expect(screen.queryAllByRole('option')).toEqual([]);
    expect(screen.getByText('No lists found.')).not.toBeNull();
  });

  // The name is read off the list, never the literal: Trash can be renamed like
  // any other list. Renamed to "Bin", it is "Bin" that is taken — and "Trash" is
  // an ordinary free name again, which is also the control for the case above.
  it('follows a hidden list’s current name, not the word Trash', () => {
    setLists(NESTED().map((item) => (item.id === 'trash' ? { ...item, name: 'Bin' } : item)));
    render(<ListCommand onSelect={jest.fn()} onCreate={jest.fn()} excludeIds={['trash']} />);

    act(() => void type('bin'));
    expect(screen.queryByRole('option', { name: /Create/ })).toBeNull();

    act(() => void type('Trash'));
    expect(screen.getByRole('option', { name: 'Create “Trash”' })).not.toBeNull();
  });

  it('offers nothing to create from a blank query', () => {
    setLists(NESTED());
    render(<ListCommand onSelect={jest.fn()} onCreate={jest.fn()} />);

    act(() => void type('   '));

    expect(screen.queryByRole('option', { name: /Create/ })).toBeNull();
  });

  // "No lists found." above a Create row would be noise: that row IS the next
  // step, and the two together read as a contradiction. TWO mechanisms hold this
  // today — the `!canCreate` guard here, and cmdk's own empty state, which counts
  // the Create row as an item and so renders nothing while it exists — which is
  // why this asserts the OUTCOME rather than either of them.
  it('never shows the empty state alongside a Create row', () => {
    setLists(NESTED());
    render(<ListCommand onSelect={jest.fn()} onCreate={jest.fn()} />);

    act(() => void type('Groceries'));

    expect(screen.queryByText('No lists found.')).toBeNull();
    expect(screen.getByRole('option', { name: /Create/ })).not.toBeNull();
  });

  // The write is awaited, so a double-click (or a slow store) can't fire two
  // creates — which on a list tree means two identically-named siblings the user
  // then has to tell apart and delete one of.
  it('refuses a second create while the first is still landing', async () => {
    let release!: () => void;
    const onCreate = jest.fn(() => new Promise<void>((resolve) => (release = resolve)));
    setLists(NESTED());
    render(<ListCommand onSelect={jest.fn()} onCreate={onCreate} />);

    act(() => void type('Groceries'));
    const createRow = screen.getByRole('option', { name: /Create/ });
    fireEvent.click(createRow);
    fireEvent.click(createRow);

    expect(onCreate).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('option', { name: /Create/ }).getAttribute('aria-disabled')).toBe(
      'true',
    );

    // Let the create land before the test ends: `create()` resumes a few microtasks
    // after `release()`, and its state updates (clearing the query, which removes
    // the Create row) would otherwise land after the test, outside act.
    release();
    await waitFor(() => expect((filterBox() as HTMLInputElement).value).toBe(''));
  });

  // Every host that creates goes on to act on the new list — select it, or move
  // a link into it — so a pick let through meanwhile runs first and the create's
  // own follow-up lands after it: the link moved twice, or an editor whose list
  // flips after the user chose another. A name that is a PREFIX of an existing
  // list's is how the two rows end up on screen together. The hosts cannot see
  // `creating`, so the picker is the only place that can refuse.
  it('refuses a row while a create is still landing, and takes it again after', async () => {
    let release!: () => void;
    const onCreate = jest.fn(() => new Promise<void>((resolve) => (release = resolve)));
    const onSelect = jest.fn();
    setLists(NESTED());
    render(<ListCommand onSelect={onSelect} onCreate={onCreate} />);

    act(() => void type('Person'));
    fireEvent.click(screen.getByRole('option', { name: /Create/ }));
    fireEvent.click(screen.getByRole('option', { name: 'Personal' }));

    expect(onCreate).toHaveBeenCalledTimes(1);
    expect(onSelect).not.toHaveBeenCalled();

    release();
    await waitFor(() => expect((filterBox() as HTMLInputElement).value).toBe(''));

    // The control: the refusal ends with the create, so the row is not dead.
    fireEvent.click(screen.getByRole('option', { name: 'Personal' }));
    expect(onSelect).toHaveBeenCalledWith('personal');
  });

  // The typed name has been consumed; leaving it in the box would leave the list
  // filtered to a query the user is done with, hiding the row that was just
  // created along with everything else.
  it('clears the query once the create lands', async () => {
    setLists(NESTED());
    render(<ListCommand onSelect={jest.fn()} onCreate={jest.fn(async () => undefined)} />);

    act(() => void type('Groceries'));
    await act(async () => {
      fireEvent.click(screen.getByRole('option', { name: /Create/ }));
    });

    expect((filterBox() as HTMLInputElement).value).toBe('');
    expect(listRows()).toEqual(['Work', 'Cooking', 'Recipes', 'Personal', 'Trash']);
  });
});

// How deep the tree is gets decided outside this device — a restored backup
// keeps `parentId` verbatim and another device can sync any chain — and every
// row here is mounted, so anything a row pays PER LEVEL is paid depth² times
// over. Two things did: the guide lines, and the ancestor names behind the path
// label. A long chain did not overflow a stack; it cost hundreds of megabytes
// the moment a picker opened. Both are bounded by TREE_ROW_MAX_LEVELS
// (@stxapps/shared sync/tree.ts) — a bound on what a row draws, with every row
// still present and still selectable.
describe('ListCommand — a row deeper than a row can show', () => {
  const DEPTH = TREE_ROW_MAX_LEVELS + 4;
  const chain = () =>
    Array.from({ length: DEPTH }, (_, i) => list(`l${i}`, `L${i}`, i === 0 ? null : `l${i - 1}`));
  const guideLines = (row: HTMLElement) => row.querySelectorAll('[aria-hidden] > span').length;

  it('draws a guide line per level up to the bound, and no more below it', () => {
    setLists(chain());
    render(<ListCommand onSelect={jest.fn()} />);

    const rows = screen.getAllByRole('option');
    expect(rows).toHaveLength(DEPTH);
    // The control: under the bound a line per level is still the rule.
    expect(guideLines(rows[3])).toBe(3);
    expect(guideLines(rows[TREE_ROW_MAX_LEVELS])).toBe(TREE_ROW_MAX_LEVELS);
    expect(guideLines(rows[DEPTH - 1])).toBe(TREE_ROW_MAX_LEVELS);
  });

  it('labels a filtered match with a cut path, and still moves into it', () => {
    const onSelect = jest.fn();
    setLists(chain());
    render(<ListCommand onSelect={onSelect} />);

    type(`L${DEPTH - 1}`);

    const [row] = screen.getAllByRole('option');
    expect(row.textContent).toBe(
      [...Array.from({ length: TREE_ROW_MAX_LEVELS }, (_, i) => `L${i}`), TREE_PATH_CUT].join(
        ' / ',
      ) + ` / L${DEPTH - 1}`,
    );
    fireEvent.click(row);
    expect(onSelect).toHaveBeenCalledWith(`l${DEPTH - 1}`);
  });
});
