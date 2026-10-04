import { act, fireEvent, render, screen } from '@testing-library/react';

import { buildTree, LIST_NO_CHILDREN_IDS, type ListItem } from '@stxapps/shared';
import { useListMutations, useLists } from '@stxapps/web-react';

import { installJsdomStubs } from '../../testing/jsdom-stubs';
import { ListSelect } from './list-select';

// The list picker in the three link editors (web quick-add, the extension's save
// editor, the edit dialog). The picker BODY is ListCommand's, covered next door;
// what is this component's own is the trigger's label and the inline create — and
// the create is where the decisions worth pinning are.
//
// The editors create INLINE rather than linking out to Settings → Lists because
// every editor holds a draft and navigating away destroys it (the extension popup
// is killed outright by `tabs.create`, uninterceptably). And the create is
// TOP-LEVEL ONLY — `parentId: null`, index 0 — matching where the Lists settings
// CreateRow puts a new list, so "add a list" lands in the same place wherever it
// is invoked. Both are invisible from the markup: a create that quietly nested
// the new list under whatever was selected would look identical here and put the
// user's list somewhere they never asked for. The position itself is
// `createTopLevel`'s, pinned in web-react's use-list-mutations.spec.tsx; what is
// pinned here is that this picker goes through it, with the name and nothing else.

jest.mock('@stxapps/web-react', () => ({
  useLists: jest.fn(() => []),
  useListMutations: jest.fn(() => ({ createTopLevel: jest.fn() })),
}));

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

const ROOT_ITEMS = () => [list('work', 'Work'), list('personal', 'Personal')];

const setLists = (items: ListItem[]) => {
  clock = 0;
  (useLists as jest.Mock).mockReturnValue(
    buildTree(items, { noChildrenIds: LIST_NO_CHILDREN_IDS }),
  );
};

// The trigger, found the way `ui/label.tsx` finds it — by the `id` a consumer's
// `<label htmlFor>` points at.
const trigger = (): HTMLElement => {
  const el = document.getElementById('list');
  if (!el) throw new Error('the ListSelect trigger did not take the `id` prop');
  return el;
};
const open = () => act(() => void fireEvent.click(trigger()));

let createTopLevel: jest.Mock;

beforeEach(() => {
  jest.clearAllMocks();
  createTopLevel = jest.fn(async () => ({ id: 'groceries' }));
  (useListMutations as jest.Mock).mockReturnValue({ createTopLevel });
  setLists([
    list('work', 'Work'),
    list('cooking', 'Cooking', 'work'),
    list('personal', 'Personal'),
  ]);
});

describe('ListSelect — the trigger', () => {
  it('shows the selected list with its ancestor path', () => {
    render(<ListSelect id="list" value="cooking" onValueChange={jest.fn()} />);

    // The popup row's context shouldn't vanish once the popup closes — a bare
    // "Cooking" is ambiguous the moment a second one exists under another parent.
    expect(trigger().textContent).toContain('Work / Cooking');
  });

  // A value with no row is not an error state: a just-created list reaches the
  // trigger a beat after it is selected, when the live query catches up. Naming
  // the empty case is what keeps that beat from rendering blank.
  it('falls back to a prompt when the value names no visible row', () => {
    render(<ListSelect id="list" value="not-yet-here" onValueChange={jest.fn()} />);

    expect(trigger().textContent).toContain('Choose a list');
  });

  // Trash is excluded in the editors because trashing is its own explicit action,
  // never a "move" — and the trigger resolves through the same excluded set, so an
  // excluded value can't be shown as if it were selectable.
  it('honours excludeIds when resolving its own label', () => {
    setLists([...ROOT_ITEMS(), list('trash', 'Trash')]);
    render(<ListSelect id="list" value="trash" onValueChange={jest.fn()} excludeIds={['trash']} />);

    expect(trigger().textContent).toContain('Choose a list');
  });

  it('reports a pick and closes', () => {
    const onValueChange = jest.fn();
    render(<ListSelect id="list" value="work" onValueChange={onValueChange} />);
    open();

    act(() => void fireEvent.click(screen.getByRole('option', { name: 'Personal' })));

    expect(onValueChange).toHaveBeenCalledWith('personal');
    expect(trigger().getAttribute('aria-expanded')).toBe('false');
  });
});

describe('ListSelect — the inline create', () => {
  // A prop and not a default: a ListSelect that must only choose among existing
  // lists stays one line away.
  it('is absent unless the caller opts in', () => {
    render(<ListSelect id="list" value="work" onValueChange={jest.fn()} />);
    open();

    expect(screen.queryByPlaceholderText(/Search/)).toBeNull();
    expect(screen.queryByRole('option', { name: /Create/ })).toBeNull();
  });

  it('mints through the shared top-level create, whatever is selected', async () => {
    // A NESTED list is selected: the create takes the name alone, so there is no
    // way for the selection to become the new list's parent.
    render(<ListSelect id="list" value="cooking" onValueChange={jest.fn()} allowCreate />);
    open();

    act(
      () =>
        void fireEvent.change(screen.getByPlaceholderText('Search or create lists…'), {
          target: { value: 'Groceries' },
        }),
    );
    await act(async () => {
      fireEvent.click(screen.getByRole('option', { name: /Create/ }));
    });

    expect(createTopLevel).toHaveBeenCalledWith('Groceries');
  });

  it('selects the new list and closes', async () => {
    const onValueChange = jest.fn();
    render(<ListSelect id="list" value="work" onValueChange={onValueChange} allowCreate />);
    open();

    act(
      () =>
        void fireEvent.change(screen.getByPlaceholderText('Search or create lists…'), {
          target: { value: 'Groceries' },
        }),
    );
    await act(async () => {
      fireEvent.click(screen.getByRole('option', { name: /Create/ }));
    });

    expect(onValueChange).toHaveBeenCalledWith('groceries');
    expect(trigger().getAttribute('aria-expanded')).toBe('false');
  });

  // `createTopLevel` returns null when there is nothing to create. Selecting anyway would
  // set the editor's list to `undefined` and close over it — the draft then saves
  // into no list at all.
  it('changes nothing when the create comes back empty', async () => {
    const onValueChange = jest.fn();
    createTopLevel.mockResolvedValue(null);
    render(<ListSelect id="list" value="work" onValueChange={onValueChange} allowCreate />);
    open();

    act(
      () =>
        void fireEvent.change(screen.getByPlaceholderText('Search or create lists…'), {
          target: { value: 'Groceries' },
        }),
    );
    await act(async () => {
      fireEvent.click(screen.getByRole('option', { name: /Create/ }));
    });

    expect(onValueChange).not.toHaveBeenCalled();
    expect(trigger().getAttribute('aria-expanded')).toBe('true');
  });
});
