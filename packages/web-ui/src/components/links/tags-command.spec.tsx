import { act, fireEvent, render, screen } from '@testing-library/react';

import { buildTree, type TagItem } from '@stxapps/shared';
import { useTags } from '@stxapps/web-react';

import { installJsdomStubs } from '../../testing/jsdom-stubs';
import { TagsCommand } from './tags-command';

// The tag sibling of ListCommand, shared by every "add tags" surface (web
// quick-add, the edit dialog, BulkTagsDialog, the browser extension's popup). Two
// things tags need that lists don't, and both are what this pins:
//
//   MULTI-SELECT — a click toggles membership and the surface stays open, so the
//   picker must report a toggle rather than a choice.
//   MINTING — the Create row runs `useTagMutations.findOrCreate`, which is
//   reuse-or-mint by name. This list also DOUBLES as the "pick an existing tag"
//   affordance that used to be an always-on hint section, which is why an exact
//   existing name has to suppress the Create row: minting it would fork a
//   duplicate of the row sitting directly above.

jest.mock('@stxapps/web-react', () => ({ useTags: jest.fn(() => []) }));

beforeAll(installJsdomStubs);

let clock = 0;
const tag = (id: string, name: string): TagItem => ({
  id,
  name,
  parentId: null,
  rank: `a${(clock++).toString().padStart(3, '0')}`,
  createdAt: 0,
  updatedAt: 0,
  path: `tags/${id}.enc`,
});

const setTags = (items: TagItem[]) => {
  clock = 0;
  (useTags as jest.Mock).mockReturnValue(buildTree(items));
};

const rows = () => screen.getAllByRole('option').map((el) => el.textContent);
const type = (value: string) =>
  act(() => void fireEvent.change(screen.getByRole('combobox'), { target: { value } }));

beforeEach(() => {
  jest.clearAllMocks();
  setTags([tag('reading', 'reading'), tag('recipes', 'recipes'), tag('work', 'work')]);
});

describe('TagsCommand', () => {
  it('lists the existing tags as the pick-an-existing-tag affordance', () => {
    render(<TagsCommand value={[]} onToggle={jest.fn()} onCreate={jest.fn()} />);

    expect(rows()).toEqual(['reading', 'recipes', 'work']);
  });

  it('filters case-insensitively', () => {
    render(<TagsCommand value={[]} onToggle={jest.fn()} onCreate={jest.fn()} />);

    type('REC');

    expect(rows().filter((r) => !r?.startsWith('Create '))).toEqual(['recipes']);
  });

  // Multi-select: the caller owns the id list and this only reports the toggle,
  // which is why clicking a row that is ALREADY chosen still reports it — the
  // caller turns that into a removal.
  it('reports a toggle for a chosen row as readily as an unchosen one', () => {
    const onToggle = jest.fn();
    render(<TagsCommand value={['reading']} onToggle={onToggle} onCreate={jest.fn()} />);

    fireEvent.click(screen.getByRole('option', { name: 'reading' }));
    expect(onToggle).toHaveBeenLastCalledWith('reading');

    fireEvent.click(screen.getByRole('option', { name: 'work' }));
    expect(onToggle).toHaveBeenLastCalledWith('work');
  });

  // The check mark is how a multi-select list shows what is already on. Nothing
  // else on the row distinguishes a chosen tag from an unchosen one.
  it('marks the chosen rows', () => {
    render(<TagsCommand value={['recipes']} onToggle={jest.fn()} onCreate={jest.fn()} />);

    expect(screen.getByRole('listbox').getAttribute('aria-multiselectable')).toBe('true');
    const recipes = screen.getByRole('option', { name: 'recipes' });
    const work = screen.getByRole('option', { name: 'work' });
    expect(recipes.getAttribute('data-checked')).toBe('true');
    expect(recipes.getAttribute('aria-checked')).toBe('true');
    expect(work.getAttribute('data-checked')).toBe('false');
    expect(work.getAttribute('aria-checked')).toBe('false');
  });

  describe('the Create row', () => {
    it('mints a tag by the typed name, trimmed', async () => {
      const onCreate = jest.fn();
      render(<TagsCommand value={[]} onToggle={jest.fn()} onCreate={onCreate} />);

      type('  photography  ');
      await act(async () => {
        fireEvent.click(screen.getByRole('option', { name: /Create/ }));
      });

      expect(onCreate).toHaveBeenCalledWith('photography');
    });

    // An exact existing name is CHOSEN from the list, not re-minted. `findOrCreate`
    // would reuse it anyway, so the harm is not a duplicate row in the data — it is
    // a picker offering to create something that is visibly already there.
    it.each(['recipes', 'Recipes', 'RECIPES'])('suppresses the create for %s', (query) => {
      render(<TagsCommand value={[]} onToggle={jest.fn()} onCreate={jest.fn()} />);

      type(query);

      expect(screen.queryByRole('option', { name: /Create/ })).toBeNull();
    });

    it('offers nothing to create from a blank query', () => {
      render(<TagsCommand value={[]} onToggle={jest.fn()} onCreate={jest.fn()} />);

      type('   ');

      expect(screen.queryByRole('option', { name: /Create/ })).toBeNull();
    });

    // The empty state and the Create row are alternatives, not a stack: "No tags
    // found." above an offer to create the thing you just named reads as a
    // contradiction. Two mechanisms hold it — the `!canCreate` guard, and cmdk's
    // own empty state, which counts the Create row as an item — so this asserts
    // the outcome rather than either of them.
    it('never shows the empty state alongside a Create row', () => {
      render(<TagsCommand value={[]} onToggle={jest.fn()} onCreate={jest.fn()} />);
      type('photography');

      expect(screen.queryByText('No tags found.')).toBeNull();
      expect(screen.getByRole('option', { name: /Create/ })).not.toBeNull();
    });

    it('shows the empty state when there is nothing to pick and nothing to create', () => {
      setTags([]);
      render(<TagsCommand value={[]} onToggle={jest.fn()} onCreate={jest.fn()} />);

      expect(screen.getByText('No tags found.')).not.toBeNull();
    });

    // `findOrCreate` is awaited, and a second click before it lands would mint the
    // same tag twice — reuse-or-mint only dedupes against tags that already exist.
    it('refuses a second create while the first is still landing', async () => {
      let release!: () => void;
      const onCreate = jest.fn(() => new Promise<void>((resolve) => (release = resolve)));
      render(<TagsCommand value={[]} onToggle={jest.fn()} onCreate={onCreate} />);

      type('photography');
      const createRow = screen.getByRole('option', { name: /Create/ });
      fireEvent.click(createRow);
      fireEvent.click(createRow);

      expect(onCreate).toHaveBeenCalledTimes(1);
      expect(screen.getByRole('option', { name: /Create/ }).getAttribute('aria-disabled')).toBe(
        'true',
      );

      await act(async () => release());
    });

    // The name has been consumed, and the surface stays open for the next pick —
    // so leaving the query behind would hide every other tag behind a filter for
    // the one just added.
    it('clears the query once the create lands', async () => {
      render(
        <TagsCommand value={[]} onToggle={jest.fn()} onCreate={jest.fn(async () => undefined)} />,
      );

      type('photography');
      await act(async () => {
        fireEvent.click(screen.getByRole('option', { name: /Create/ }));
      });

      expect((screen.getByRole('combobox') as HTMLInputElement).value).toBe('');
      expect(rows()).toEqual(['reading', 'recipes', 'work']);
    });
  });
});
