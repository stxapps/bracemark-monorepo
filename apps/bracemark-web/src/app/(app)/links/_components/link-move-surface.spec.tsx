import { act, fireEvent, render, screen } from '@testing-library/react';

import { buildTree, type ListItem } from '@stxapps/shared';
import { type LinkView, useLists } from '@stxapps/web-react';

import { LinkMoveSurface } from './link-move-surface';

// The page-level "Move to" for links: web-ui's MoveToSurface plus the write. The
// container is `move-to-surface.spec.tsx`'s and the picker body is
// `list-command.spec.tsx`'s, both one layer down; what is only true HERE is that
// the destination can be a list that does not exist yet, and that creating it and
// moving into it are ONE gesture.
//
// That pairing is the whole feature and nothing else holds it together. Drop the
// move after the create and the surface still closes over a freshly made, empty
// list with every link where it was; let the two paths interleave and the links
// are moved twice. Both lint, both typecheck, and both look fine from the markup.
//
// `@stxapps/web-react` is mocked at the barrel — the real hooks are Dexie
// liveQueries and writes over an encrypted local store — and that one mock also
// feeds the real ListCommand this surface renders, so the rows are the app's rows.

const mockCloseMove = jest.fn();
const mockExitBulkEdit = jest.fn();
const mockUpdateMany = jest.fn();
const mockCreate = jest.fn();
let mockMoving: LinkView[] | null = null;

jest.mock('@stxapps/web-react', () => ({
  useLists: jest.fn(),
  useListMutations: () => ({ createTopLevel: mockCreate }),
  useLinkMutations: () => ({ updateMany: mockUpdateMany }),
}));

jest.mock('../_contexts/view-state-provider', () => ({
  useLinksViewState: () => ({
    moving: mockMoving,
    closeMove: mockCloseMove,
    exitBulkEdit: mockExitBulkEdit,
    wide: true,
  }),
}));

// cmdk observes its list and scrolls the active row into view, and Radix's
// dismiss layer reaches for pointer capture; jsdom implements none of it. Seams,
// not subjects — nothing below asserts on a measurement.
beforeAll(() => {
  (globalThis as { ResizeObserver?: unknown }).ResizeObserver ??= class {
    observe = () => undefined;
    unobserve = () => undefined;
    disconnect = () => undefined;
  };
  Element.prototype.scrollIntoView ??= () => undefined;
  Element.prototype.hasPointerCapture ??= () => false;
  Element.prototype.setPointerCapture ??= () => undefined;
  Element.prototype.releasePointerCapture ??= () => undefined;
});

const list = (id: string, name: string, rank: string): ListItem => ({
  id,
  name,
  parentId: null,
  rank,
  createdAt: 0,
  updatedAt: 0,
  path: `lists/${id}.enc`,
});
const WORK = list('work', 'Work', 'a0');
const PERSONAL = list('personal', 'Personal', 'a1');

const link = (path: string, listId: string) => ({ path, listId }) as unknown as LinkView;
const A = link('a', 'work');
const B = link('b', 'work');

const row = (name: string | RegExp) => screen.getByRole('option', { name });
const typeName = (value: string) =>
  fireEvent.change(screen.getByPlaceholderText('Search or create lists…'), { target: { value } });

beforeEach(() => {
  mockMoving = [A, B];
  mockCloseMove.mockClear();
  mockExitBulkEdit.mockClear();
  mockUpdateMany.mockReset().mockResolvedValue(undefined);
  mockCreate.mockReset().mockResolvedValue({ id: 'groceries' });
  (useLists as jest.Mock).mockReturnValue(buildTree([WORK, PERSONAL]));
});

test('moves the selection into a picked list', async () => {
  render(<LinkMoveSurface />);

  await act(async () => {
    fireEvent.click(row('Personal'));
  });

  expect(mockCreate).not.toHaveBeenCalled();
  expect(mockUpdateMany).toHaveBeenCalledWith([
    { link: A, patch: { listId: 'personal' } },
    { link: B, patch: { listId: 'personal' } },
  ]);
  expect(mockCloseMove).toHaveBeenCalledTimes(1);
  expect(mockExitBulkEdit).toHaveBeenCalledTimes(1);
});

test('creates a top-level list and moves the selection into it', async () => {
  render(<LinkMoveSurface />);

  typeName('Groceries');
  await act(async () => {
    fireEvent.click(row(/Create/));
  });

  // `createTopLevel`, the one create every surface shares — so a list made here
  // sits where one made in Settings would (use-list-mutations.spec.tsx pins where).
  expect(mockCreate).toHaveBeenCalledWith('Groceries');
  // …and the move is part of the same gesture, not a second pick.
  expect(mockUpdateMany).toHaveBeenCalledWith([
    { link: A, patch: { listId: 'groceries' } },
    { link: B, patch: { listId: 'groceries' } },
  ]);
  expect(mockCloseMove).toHaveBeenCalledTimes(1);
  expect(mockExitBulkEdit).toHaveBeenCalledTimes(1);
});

// `createTopLevel` returns null when there was nothing to create. Moving anyway would
// patch every link's `listId` to `undefined` and close over it.
test('moves nothing and stays open when the create comes back empty', async () => {
  mockCreate.mockResolvedValue(null);
  render(<LinkMoveSurface />);

  typeName('Groceries');
  await act(async () => {
    fireEvent.click(row(/Create/));
  });

  expect(mockUpdateMany).not.toHaveBeenCalled();
  expect(mockCloseMove).not.toHaveBeenCalled();
  expect(mockExitBulkEdit).not.toHaveBeenCalled();
});

// One link, so the picker stays on screen while the create lands (the "Moving N
// links…" line that replaces it is for batches) — and a name that is a PREFIX of
// an existing list's leaves that list's row on screen right above the Create row.
// Pressing it must not start a second move that the create's own then follows.
test('refuses a pick while the create is still landing', async () => {
  let land!: (created: { id: string }) => void;
  mockCreate.mockReturnValue(new Promise((resolve) => (land = resolve)));
  mockMoving = [A];
  render(<LinkMoveSurface />);

  typeName('Person');
  await act(async () => {
    fireEvent.click(row(/Create/));
  });
  await act(async () => {
    fireEvent.click(row('Personal'));
  });

  expect(mockUpdateMany).not.toHaveBeenCalled();

  await act(async () => land({ id: 'person' }));

  expect(mockUpdateMany).toHaveBeenCalledTimes(1);
  expect(mockUpdateMany).toHaveBeenCalledWith([{ link: A, patch: { listId: 'person' } }]);
});
