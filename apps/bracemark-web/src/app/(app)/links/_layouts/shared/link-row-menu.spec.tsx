import { act, fireEvent, render, screen } from '@testing-library/react';

import { buildTree, type ListItem } from '@stxapps/shared';
import { type LinkView, useLists } from '@stxapps/web-react';

import { LinkRowMenu } from './link-row-menu';

// The row menu's WIDE "Move to": ListCommand in a dropdown submenu, and since the
// picker gained its Create row, the one link-move surface that neither
// `link-move-surface.spec.tsx` (the page-level dialog and sheet) nor web-ui's
// picker specs reach — the submenu's wiring is inline in the menu. Three things
// are only true here, and none of them shows in the markup:
//
//   - the create and the move are ONE gesture. Drop the move and the menu still
//     closes — over a freshly made, empty list, with the link where it was.
//   - the menu is CONTROLLED because a CommandItem pick is not a menu selection,
//     so Radix closes nothing for it. A path through the picker that forgets to
//     close leaves the menu up and `engaged` held, which stages every background
//     sync behind the refresh pill (hooks.spec.tsx, useEngagedOpen).
//   - the picker's live list read mounts with the SUBMENU, not with the row.
//     This component renders once per virtualized row; read the lists outside
//     the submenu's content and every row on screen holds a liveQuery, with
//     nothing to see but a slower list.
//
// `@stxapps/web-react` is mocked at the barrel — the real hooks are Dexie
// liveQueries and writes over an encrypted local store — and that one mock also
// feeds the real ListCommand the submenu renders. The menu, the submenu and the
// engagement hook are the app's own.

const mockUpdate = jest.fn();
const mockCreate = jest.fn();
const mockSetMenuOpen = jest.fn();
const mockRequestMove = jest.fn();

jest.mock('@stxapps/web-react', () => ({
  linkIdOf: (link: { path: string }) => link.path.replace(/^links\/|\.enc$/g, ''),
  useLists: jest.fn(),
  useListMutations: () => ({ createTopLevel: mockCreate }),
  useLinkMutations: () => ({ update: mockUpdate }),
  usePinMutations: () => ({
    pin: jest.fn(),
    unpin: jest.fn(),
    moveUp: jest.fn(),
    moveDown: jest.fn(),
  }),
  // hooks.ts, which the menu takes useEngagedOpen from, reads these two at
  // module scope of its other hooks.
  useExtraction: () => ({ reportDisplayedLinkPaths: jest.fn() }),
  useTags: () => [],
}));

jest.mock('../../_contexts/view-state-provider', () => ({
  useLinksViewState: () => ({
    openEditor: jest.fn(),
    requestDestroy: jest.fn(),
    requestMove: mockRequestMove,
    setMenuOpen: mockSetMenuOpen,
    wide: true,
  }),
}));

jest.mock('../../_contexts/page-provider', () => ({
  useLinksPage: () => ({ query: {} }),
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

const LINK = { path: 'a', listId: 'work', url: 'https://a.invalid/' } as unknown as LinkView;

const mount = () =>
  render(
    <LinkRowMenu link={LINK} pinned={false} pinnedAbove={undefined} pinnedBelow={undefined} />,
  );

// Keyboard, not pointer: Radix opens the menu on `pointerdown` and reads the
// event's `button`, which jsdom's PointerEvent stand-in does not carry.
const openMenu = () =>
  act(
    () =>
      void fireEvent.keyDown(screen.getByRole('button', { name: 'Link options' }), {
        key: 'Enter',
      }),
  );
const openMoveTo = () =>
  act(() => void fireEvent.click(screen.getByRole('menuitem', { name: 'Move to' })));
const typeName = (value: string) =>
  fireEvent.change(screen.getByPlaceholderText('Search or create lists…'), { target: { value } });
const row = (name: string | RegExp) => screen.getByRole('option', { name });

beforeEach(() => {
  mockUpdate.mockReset().mockResolvedValue(undefined);
  mockCreate.mockReset().mockResolvedValue({ id: 'groceries' });
  mockSetMenuOpen.mockClear();
  mockRequestMove.mockClear();
  jest
    .mocked(useLists)
    .mockReset()
    .mockReturnValue(buildTree([WORK, PERSONAL]));
});

test('holds no live list read until the Move-to submenu is open', () => {
  mount();
  expect(useLists).not.toHaveBeenCalled();

  // The menu being open is not enough either: the submenu's content, and the
  // hooks in it, exist only once "Move to" itself is open.
  openMenu();
  expect(screen.getByRole('menuitem', { name: 'Move to' })).not.toBeNull();
  expect(useLists).not.toHaveBeenCalled();

  // The control for the two absences above — without it they would pass against
  // a mock nothing ever calls.
  openMoveTo();
  expect(useLists).toHaveBeenCalled();
});

test('moves the link into a picked list and closes the menu', () => {
  mount();
  openMenu();
  openMoveTo();

  act(() => void fireEvent.click(row('Personal')));

  expect(mockCreate).not.toHaveBeenCalled();
  expect(mockUpdate).toHaveBeenCalledWith(LINK, { listId: 'personal' });
  expect(screen.queryByRole('menu')).toBeNull();
  expect(mockSetMenuOpen).toHaveBeenLastCalledWith(false);
});

test('creates a top-level list and moves the link into it, then closes the menu', async () => {
  mount();
  openMenu();
  openMoveTo();

  typeName('Groceries');
  await act(async () => {
    fireEvent.click(row(/Create/));
  });

  // `createTopLevel`, the one create every surface shares — so a list made here
  // sits where one made in Settings would (use-list-mutations.spec.tsx pins where).
  expect(mockCreate).toHaveBeenCalledWith('Groceries');
  // …and the move is part of the same gesture, not a second pick.
  expect(mockUpdate).toHaveBeenCalledTimes(1);
  expect(mockUpdate).toHaveBeenCalledWith(LINK, { listId: 'groceries' });
  expect(screen.queryByRole('menu')).toBeNull();
  expect(mockSetMenuOpen).toHaveBeenLastCalledWith(false);
});

// `createTopLevel` returns null when there was nothing to create. Moving anyway would
// patch the link's `listId` to `undefined`; closing anyway would dismiss the menu
// over a move that never happened.
test('moves nothing and stays open when the create comes back empty', async () => {
  mockCreate.mockResolvedValue(null);
  mount();
  openMenu();
  openMoveTo();

  typeName('Groceries');
  await act(async () => {
    fireEvent.click(row(/Create/));
  });

  expect(mockCreate).toHaveBeenCalledTimes(1);
  expect(mockUpdate).not.toHaveBeenCalled();
  expect(screen.getByRole('menuitem', { name: 'Move to' })).not.toBeNull();
  expect(mockSetMenuOpen).toHaveBeenLastCalledWith(true);
});

// The submenu has no busy state of its own to refuse with — the page-level
// surface does (link-move-surface.spec.tsx) — so here it is the picker's guard
// or nothing. Without it the pick moves the link and closes the menu, and the
// create's own move then lands on a menu nobody is looking at: two writes, and
// the link in the list the user did NOT last choose.
test('moves once, into the new list, when a row is pressed while the create is landing', async () => {
  let land!: (created: { id: string }) => void;
  mockCreate.mockReturnValue(new Promise((resolve) => (land = resolve)));
  mount();
  openMenu();
  openMoveTo();

  typeName('Person');
  await act(async () => {
    fireEvent.click(row(/Create/));
  });
  await act(async () => {
    fireEvent.click(row('Personal'));
  });

  expect(mockUpdate).not.toHaveBeenCalled();
  expect(screen.getByRole('menuitem', { name: 'Move to' })).not.toBeNull();

  await act(async () => land({ id: 'person' }));

  expect(mockUpdate).toHaveBeenCalledTimes(1);
  expect(mockUpdate).toHaveBeenCalledWith(LINK, { listId: 'person' });
  expect(screen.queryByRole('menu')).toBeNull();
});

// `Read` — the one conditional item. It is there only when the link HAS a kept copy:
// the reader would otherwise open onto an empty state the row promised against.
describe('Read', () => {
  const mountWith = (extra: Partial<LinkView>) =>
    render(
      <LinkRowMenu
        link={{ ...LINK, path: 'links/l1.enc', ...extra } as LinkView}
        pinned={false}
        pinnedAbove={undefined}
        pinnedBelow={undefined}
      />,
    );

  test('is absent on a link with no kept copy', () => {
    mountWith({});
    openMenu();
    expect(screen.queryByRole('menuitem', { name: 'Read' })).toBeNull();
  });

  test.each([['readModeId'], ['screenshotId']])(
    'opens the reader for this link when it has a %s',
    (field) => {
      mountWith({ [field]: 'file-1' });
      openMenu();
      expect(screen.getByRole('menuitem', { name: 'Read' }).getAttribute('href')).toBe(
        '/read?link=l1',
      );
    },
  );
});
