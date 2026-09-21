import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';

import { buildTree, LIST_NO_CHILDREN_IDS, type ListItem } from '@stxapps/shared';
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
  // most accounts) opens the editors' picker with nothing to type into and no way
  // to reach the Create row at all.
  it('renders one at any count when the surface can create', () => {
    setLists(NESTED());
    render(<ListCommand onSelect={jest.fn()} onCreate={jest.fn()} />);

    expect(filterBox()?.getAttribute('placeholder')).toBe('Search or create lists…');
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

    // A destination picker must not mint a list: creating one is a different
    // intent wearing the same clothes (docs/editors.md), and in the Lists settings
    // menu — which picks a PARENT — it is incoherent.
    expect(screen.queryByRole('option', { name: /Create/ })).toBeNull();
    expect(screen.getByText('No lists found.')).not.toBeNull();
  });

  it('offers a create for a name no list has, and passes it back trimmed', () => {
    const onCreate = jest.fn();
    setLists(NESTED());
    render(<ListCommand onSelect={jest.fn()} onCreate={onCreate} />);

    act(() => void type('  Groceries  '));
    fireEvent.click(screen.getByRole('option', { name: /Create/ }));

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
