import * as React from 'react';
import { PortalHost } from '@rn-primitives/portal';
import { act, fireEvent, render, screen } from '@testing-library/react-native';

import { useLists } from '@stxapps/expo-react';
import { buildTree, type ListItem, TRASH_ID } from '@stxapps/shared';

import { touchClaim } from '../../testing/scroll-claim';
import { MoveToDialog } from './move-to-dialog';

// The Move-to picker the row menu and the bulk bar share. Both hosts hand it one
// `onSelect` and move into whatever list id comes back — so a list created from
// the typed name has to arrive through that same callback, or the dialog makes a
// list and moves nothing: an empty list at the top of the tree and every link
// where it was. Nothing lints or typechecks that, and both hosts look unchanged.
//
// `@stxapps/expo-react` is mocked at the barrel (the real hooks are live reads
// and writes over expo-sqlite); the tree is built with the real `buildTree`, and
// the ListCommand under the dialog is the app's own.

const mockCreate = jest.fn();

// Stands in for SyncProvider. The real useListMutations reads useSync, and the
// app mounts SyncProvider in the `(app)` layout — BELOW the root PortalHost that
// every dialog's content renders into. An @rn-primitives portal re-parents its
// children without their context, so anything in the content that reaches
// useListMutations throws on open. The mock keeps that one property, since
// mocking the package at the barrel would otherwise erase it: the mutations
// exist only under the provider, and `mount` puts the PortalHost outside it,
// where the app has it.
const mockSyncScope = React.createContext(false);

jest.mock('@stxapps/expo-react', () => ({
  useLists: jest.fn(),
  useListMutations: () => {
    const { useContext } = jest.requireActual<typeof import('react')>('react');
    if (!useContext(mockSyncScope)) throw new Error('useSync must be used within <SyncProvider>');
    return { createTopLevel: mockCreate };
  },
}));

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

function mount(onSelect: (listId: string) => void) {
  return render(
    <>
      <mockSyncScope.Provider value={true}>
        <MoveToDialog open onOpenChange={jest.fn()} sharedListId="work" onSelect={onSelect} />
      </mockSyncScope.Provider>
      <PortalHost />
    </>,
  );
}

const typeName = (value: string) =>
  fireEvent.changeText(screen.getByTestId('list-picker-search'), value);
const pressCreate = () =>
  act(async () => {
    fireEvent.press(screen.getByTestId('list-picker-create'));
  });

beforeEach(() => {
  mockCreate.mockReset().mockResolvedValue({ id: 'groceries' });
  jest
    .mocked(useLists)
    .mockReset()
    .mockReturnValue(buildTree([WORK, PERSONAL]));
});

test('reports a picked list', () => {
  const onSelect = jest.fn();
  mount(onSelect);

  fireEvent.press(screen.getByText('Personal'));

  expect(onSelect).toHaveBeenCalledWith('personal');
  expect(mockCreate).not.toHaveBeenCalled();
});

test('creates a top-level list and reports it as the destination', async () => {
  const onSelect = jest.fn();
  mount(onSelect);

  typeName('Groceries');
  await pressCreate();

  // `createTopLevel`, the one create every surface shares — so a list made here
  // sits where one made in Settings would (use-list-mutations.spec.tsx pins where).
  expect(mockCreate).toHaveBeenCalledWith('Groceries');
  expect(onSelect).toHaveBeenCalledWith('groceries');
});

// `createTopLevel` returns null when there was nothing to create. Reporting anyway would
// hand both hosts `undefined` as a list id to move into.
test('reports nothing when the create comes back empty', async () => {
  const onSelect = jest.fn();
  mockCreate.mockResolvedValue(null);
  mount(onSelect);

  typeName('Groceries');
  await pressCreate();

  expect(mockCreate).toHaveBeenCalledTimes(1);
  expect(onSelect).not.toHaveBeenCalled();
});

// Nothing sits between the name and the move here — no Save, as an editor has —
// so a double tap that got through twice would be two identically named lists
// and the selection filed in one of them. The guard is ListCommand's, and web-ui's
// list-command.spec.tsx is canonical for it; this is the drift guard for the
// native copy, on the surface where a second create costs the most.
test('creates once when Create is pressed again while the first is landing', async () => {
  let land!: (created: { id: string }) => void;
  mockCreate.mockReturnValue(new Promise((resolve) => (land = resolve)));
  const onSelect = jest.fn();
  mount(onSelect);

  typeName('Groceries');
  await pressCreate();
  await pressCreate();

  expect(mockCreate).toHaveBeenCalledTimes(1);
  expect(onSelect).not.toHaveBeenCalled();

  await act(async () => land({ id: 'groceries' }));

  expect(onSelect).toHaveBeenCalledTimes(1);
  expect(onSelect).toHaveBeenCalledWith('groceries');
});

// The same guard from the other side, and the drift guard for the native copy
// of it: a name that is a prefix of an existing list's leaves that list's row on
// screen beside the Create row. Both hosts move on every `onSelect`, so a pick
// reported here would be followed by the create's own — and the bulk bar drops a
// second move while the first is in flight, which leaves the new list empty.
test('reports only the created list when a row is pressed while the create is landing', async () => {
  let land!: (created: { id: string }) => void;
  mockCreate.mockReturnValue(new Promise((resolve) => (land = resolve)));
  const onSelect = jest.fn();
  mount(onSelect);

  typeName('Person');
  await pressCreate();
  fireEvent.press(screen.getByText('Personal'));

  expect(onSelect).not.toHaveBeenCalled();

  await act(async () => land({ id: 'person' }));

  expect(onSelect).toHaveBeenCalledTimes(1);
  expect(onSelect).toHaveBeenCalledWith('person');
});

// The dialog hides Trash, and the typed name is checked against every list, not
// the rows shown — or a user looking for Trash is offered a second one, and
// confirming it files the selection there. Web-ui's list-command.spec.tsx is
// canonical; this is the drift guard for the native copy, on a RENAMED Trash so
// that a check against the literal word cannot pass it.
test('offers no create for the name of the Trash it hides', () => {
  jest.mocked(useLists).mockReturnValue(buildTree([WORK, PERSONAL, list(TRASH_ID, 'Bin', 'a2')]));
  mount(jest.fn());

  typeName('bin');

  expect(screen.queryByTestId('list-picker-create')).toBeNull();
  expect(screen.getByText('No lists found.')).toBeTruthy();

  // The control: a name no list has still gets its Create row.
  typeName('Bins');
  expect(screen.getByTestId('list-picker-create')).toBeTruthy();
});

// DialogContent claims every touch its children leave, from AROUND the
// picker's scroller, so ListCommand claims them first from inside. Without that,
// a drag starting on the empty text or the root's divider does not scroll on iOS
// (components/ui/scroll-claim.tsx).
test('claims a touch on non-row content inside the picker scroller', () => {
  jest.mocked(useLists).mockReturnValue(buildTree([WORK, PERSONAL, list(TRASH_ID, 'Bin', 'a2')]));
  mount(jest.fn());

  typeName('bin');

  expect(touchClaim(screen.getByText('No lists found.'))).toBe('inside');
});

// The crash the provider stand-in above exists for. Wire the create inside the
// dialog's content — the tidy-looking place, next to the picker that uses it —
// and on a device the dialog opens onto "useSync must be used within
// <SyncProvider>" from both hosts, while a spec that mounts everything under one
// tree stays green. Opening and rendering rows is the whole assertion: the
// content has to come up outside the provider.
test('opens with its content rendered outside the sync provider', () => {
  mount(jest.fn());

  expect(screen.getByTestId('list-picker-search')).toBeTruthy();
  expect(screen.getByText('Personal')).toBeTruthy();
});
