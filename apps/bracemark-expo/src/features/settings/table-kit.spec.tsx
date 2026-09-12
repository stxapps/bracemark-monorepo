import * as React from 'react';
import { Pressable } from 'react-native';
import { PortalHost } from '@rn-primitives/portal';
import { act, fireEvent, render, screen } from '@testing-library/react-native';

import { Text } from '../../components/ui/text';
import { DestroyConfirm, useDestroyRequest } from './table-kit';

// Pins the delete flow the Lists and Tags tables share — web's peer
// (settings/_components/table-kit.spec.tsx) names the failures. Its focus case
// has no twin here: it is about Radix's alert dialog, and native has no focus to
// strand. The rest are the same properties over the RN primitives, where the
// confirm is a plain Button (not the Action, which closes before its handler
// runs) — so "keeps the dialog up" is a separate fact on this side, not a
// consequence of web's preventDefault.

const item = (id: string) => ({ id });

function Harness({
  blocker,
  onDestroy,
}: {
  blocker: (entry: { id: string }) => Promise<string | null>;
  onDestroy: (id: string) => Promise<void>;
}) {
  const { destroyRequest, requestDestroy, closeDestroy } = useDestroyRequest(blocker);
  return (
    <>
      <Pressable role="button" onPress={() => requestDestroy(item('a'))}>
        <Text>Request a</Text>
      </Pressable>
      <Pressable role="button" onPress={() => requestDestroy(item('b'))}>
        <Text>Request b</Text>
      </Pressable>
      {destroyRequest && (
        <DestroyConfirm
          noun="list"
          blocker={destroyRequest.blocker}
          description={`Confirm ${destroyRequest.id}`}
          onDestroy={() => onDestroy(destroyRequest.id)}
          onClose={closeDestroy}
        />
      )}
      {/* The dialog portals to the default host, which the root `_layout.tsx`
          mounts in the app — stand it up here or it renders nowhere. */}
      <PortalHost />
    </>
  );
}

test('a blocked delete opens as the refusal, with nothing that can fire destroy', async () => {
  const onDestroy = jest.fn(() => Promise.resolve());
  render(
    <Harness
      blocker={() => Promise.resolve('“a” still has 2 links. Move or delete them first.')}
      onDestroy={onDestroy}
    />,
  );

  fireEvent.press(screen.getByText('Request a'));

  expect(await screen.findByText('Can’t delete this list')).toBeTruthy();
  expect(screen.getByText('“a” still has 2 links. Move or delete them first.')).toBeTruthy();
  expect(screen.queryByText('Delete')).toBeNull();

  fireEvent.press(screen.getByText('OK'));
  expect(screen.queryByText('Can’t delete this list')).toBeNull();
  expect(onDestroy).not.toHaveBeenCalled();
});

test('a clear delete confirms, and closes once destroy resolves', async () => {
  const onDestroy = jest.fn(() => Promise.resolve());
  render(<Harness blocker={() => Promise.resolve(null)} onDestroy={onDestroy} />);

  fireEvent.press(screen.getByText('Request a'));
  expect(await screen.findByText('Confirm a')).toBeTruthy();

  await act(async () => {
    fireEvent.press(screen.getByText('Delete'));
  });

  expect(onDestroy).toHaveBeenCalledWith('a');
  expect(screen.queryByText('Confirm a')).toBeNull();
});

test('a refusal from destroy itself announces, and keeps the dialog up', async () => {
  // The check passed, then another device filed a link into the list before the
  // tap — destroy re-checks and throws. The line mounts as the result of the
  // tap, so it must carry role="alert" (docs/accessibility.md).
  const onDestroy = jest.fn(() =>
    Promise.reject(new Error('“a” still has 1 link. Move or delete it first.')),
  );
  render(<Harness blocker={() => Promise.resolve(null)} onDestroy={onDestroy} />);

  fireEvent.press(screen.getByText('Request a'));
  await screen.findByText('Confirm a');
  await act(async () => {
    fireEvent.press(screen.getByText('Delete'));
  });

  expect(screen.getByRole('alert').props.children).toContain(
    '“a” still has 1 link. Move or delete it first.',
  );
  expect(screen.getByText('Confirm a')).toBeTruthy();
});

test('a check overtaken by a newer request never raises its dialog', async () => {
  let settleA: (reason: string | null) => void = () => undefined;
  const blocker = ({ id }: { id: string }) =>
    id === 'a'
      ? new Promise<string | null>((resolve) => {
          settleA = resolve;
        })
      : Promise.resolve(null);
  render(<Harness blocker={blocker} onDestroy={() => Promise.resolve()} />);

  fireEvent.press(screen.getByText('Request a'));
  fireEvent.press(screen.getByText('Request b'));
  expect(await screen.findByText('Confirm b')).toBeTruthy();

  await act(async () => {
    settleA('“a” still has 2 links. Move or delete them first.');
  });

  expect(screen.getByText('Confirm b')).toBeTruthy();
  expect(screen.queryByText('Can’t delete this list')).toBeNull();
});
