import * as React from 'react';
import { View } from 'react-native';
import { PortalHost } from '@rn-primitives/portal';
import { act, fireEvent, render, screen } from '@testing-library/react-native';

import type { LinkView } from '@stxapps/expo-react';
import { DEFAULT_LIST_ID, linkIdOf, LINKS_PREFIX, pathFromId, TRASH_ID } from '@stxapps/shared';

import { BulkEditBar } from './bulk-edit-bar';

// The bulk bar's ⋯ actions, as far as jest can see them: which links each one is
// handed and that it is handed them ONCE — the batched mutation, never a loop of
// the single-link one (docs/editors.md, _bulk edit_) — and the confirmation Delete
// copies goes through first. The writes themselves are the packages' specs
// (expo-react data/remove-kept-copy.spec.ts, hooks/use-pin-mutations.spec.tsx);
// the ⋯ menu opening a dialog on a device is BULK-COPIES-001's.

const mockRemoveAllCopies = jest.fn<Promise<number>, [LinkView[]]>();
const mockPinMany = jest.fn<Promise<void>, [LinkView[]]>();
const mockUnpinMany = jest.fn<Promise<void>, [LinkView[]]>();
let mockPinnedIds: string[] = [];
jest.mock('@stxapps/expo-react', () => ({
  linkIdOf: jest.requireActual('@stxapps/shared').linkIdOf,
  readPins: jest.fn(),
  useKeptCopyMutations: () => ({ removeAllCopies: mockRemoveAllCopies }),
  useLinkMutations: () => ({ updateMany: jest.fn() }),
  useLiveRead: () => mockPinnedIds.map((id) => ({ id })),
  usePinMutations: () => ({ pinMany: mockPinMany, unpinMany: mockUnpinMany }),
}));
jest.mock('@react-navigation/native', () => ({ useIsFocused: () => true }));
jest.mock('expo-clipboard', () => ({ setStringAsync: jest.fn() }));
jest.mock('../../lib/window-class', () => ({ useWideWindow: () => false }));
// The Move to dialog reads the list tree; nothing here opens it.
jest.mock('./move-to-dialog', () => ({ MoveToDialog: () => null }));

let mockSelectionId = DEFAULT_LIST_ID;
jest.mock('./page-provider', () => ({
  useLinksPage: () => ({ selection: { kind: 'list', id: mockSelectionId } }),
}));

let mockSelected = new Map<string, LinkView>();
const mockExitBulkEdit = jest.fn();
jest.mock('./view-state-provider', () => ({
  useLinksViewState: () => ({
    bulkEditing: true,
    exitBulkEdit: mockExitBulkEdit,
    selectedLinks: mockSelected,
    selectAll: jest.fn(),
    clearSelected: jest.fn(),
    requestDestroy: jest.fn(),
    requestRetag: jest.fn(),
  }),
}));

function link(id: string, fields: Partial<LinkView> = {}): LinkView {
  return {
    path: pathFromId(id, LINKS_PREFIX),
    url: `https://${id}.example.com/`,
    listId: DEFAULT_LIST_ID,
    tagIds: [],
    title: id,
    createdAt: 1,
    updatedAt: 1,
    ...fields,
  } as LinkView;
}

function select(...links: LinkView[]) {
  mockSelected = new Map(links.map((l) => [l.path, l]));
  return links;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

beforeEach(() => {
  // The menu is placed from its trigger's measurement, which jest's View never
  // reports (components/ui/dropdown-menu.spec.tsx).
  jest.spyOn(View.prototype, 'measure').mockImplementation((cb) => cb(0, 0, 32, 32, 300, 700));
  mockSelectionId = DEFAULT_LIST_ID;
  mockPinnedIds = [];
  mockSelected = new Map();
  mockRemoveAllCopies.mockReset().mockResolvedValue(1);
  mockPinMany.mockReset().mockResolvedValue(undefined);
  mockUnpinMany.mockReset().mockResolvedValue(undefined);
  mockExitBulkEdit.mockReset();
});

afterEach(() => jest.restoreAllMocks());

const mount = (links: LinkView[]) =>
  render(
    <>
      <BulkEditBar links={links} />
      <PortalHost />
    </>,
  );

const openMenu = () => fireEvent.press(screen.getByTestId('bulk-more'));

describe('Delete copies', () => {
  test('is disabled when no selected link keeps a copy', () => {
    mount(select(link('a'), link('b')));
    openMenu();

    expect(screen.getByTestId('bulk-menu-delete-copies')).toBeDisabled();
  });

  test('confirms first, then removes the copies of the links that have them — Trash included — once', async () => {
    // Trashed links are left out of every other ⋯ action (`actionable`); a copy is
    // the user's to delete wherever its link sits. Trashed links only share a view
    // with others under an advanced search that names Trash.
    const read = link('read', { readModeId: 'r1' });
    const trashed = link('trashed', { listId: TRASH_ID, screenshotId: 's1' });
    mount(select(read, link('bare'), trashed));
    openMenu();
    fireEvent.press(screen.getByTestId('bulk-menu-delete-copies'));

    expect(screen.getByText('Delete the copies kept with 2 links?')).toBeTruthy();
    expect(mockRemoveAllCopies).not.toHaveBeenCalled();

    await act(async () => fireEvent.press(screen.getByTestId('bulk-delete-copies-submit')));

    expect(mockRemoveAllCopies).toHaveBeenCalledTimes(1);
    expect(mockRemoveAllCopies.mock.calls[0][0].map(linkIdOf)).toEqual([
      linkIdOf(read),
      linkIdOf(trashed),
    ]);
    expect(mockExitBulkEdit).toHaveBeenCalledTimes(1);
    expect(screen.queryByText('Delete the copies kept with 2 links?')).toBeNull();
  });

  test('"Keep them" closes the dialog and deletes nothing', () => {
    mount(select(link('read', { readModeId: 'r1' })));
    openMenu();
    fireEvent.press(screen.getByTestId('bulk-menu-delete-copies'));
    expect(screen.getByText('Delete the copies kept with 1 link?')).toBeTruthy();

    fireEvent.press(screen.getByText('Keep them'));

    expect(screen.queryByText('Delete the copies kept with 1 link?')).toBeNull();
    expect(mockRemoveAllCopies).not.toHaveBeenCalled();
    expect(mockExitBulkEdit).not.toHaveBeenCalled();
  });

  test('stays up, busy, until the removal resolves', async () => {
    const removal = deferred<number>();
    mockRemoveAllCopies.mockReturnValueOnce(removal.promise);
    mount(select(link('read', { readModeId: 'r1' })));
    openMenu();
    fireEvent.press(screen.getByTestId('bulk-menu-delete-copies'));

    fireEvent.press(screen.getByTestId('bulk-delete-copies-submit'));

    expect(screen.getByText('Deleting…')).toBeTruthy();
    // Disabled, so a second press while busy can't start a second removal.
    expect(screen.getByTestId('bulk-delete-copies-submit')).toBeDisabled();
    expect(mockRemoveAllCopies).toHaveBeenCalledTimes(1);
    expect(mockExitBulkEdit).not.toHaveBeenCalled();

    await act(async () => removal.resolve(1));

    expect(mockExitBulkEdit).toHaveBeenCalledTimes(1);
  });
});

describe('Pin and Unpin', () => {
  test('hand the batched mutation every eligible link at once, in selection order', async () => {
    const [a, b, c] = select(link('a'), link('b'), link('c'));
    mockPinnedIds = [linkIdOf(b)];
    mount([a, b, c]);

    openMenu();
    await act(async () => fireEvent.press(screen.getByTestId('bulk-menu-pin')));
    expect(mockPinMany).toHaveBeenCalledTimes(1);
    expect(mockPinMany.mock.calls[0][0].map(linkIdOf)).toEqual([linkIdOf(a), linkIdOf(c)]);

    openMenu();
    await act(async () => fireEvent.press(screen.getByTestId('bulk-menu-unpin')));
    expect(mockUnpinMany).toHaveBeenCalledTimes(1);
    expect(mockUnpinMany.mock.calls[0][0].map(linkIdOf)).toEqual([linkIdOf(b)]);
  });
});
