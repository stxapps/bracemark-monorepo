import * as React from 'react';
import { Pressable, type TextInput } from 'react-native';
import { PortalHost } from '@rn-primitives/portal';
import { act, fireEvent, render, renderHook, screen } from '@testing-library/react-native';

import { Text } from '../../components/ui/text';
import { DestroyConfirm, RenameField, useDestroyRequest, useStableActions } from './table-kit';

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

// The commit fires a promise the field only reacts to when it settles; this
// flushes that microtask and the re-render it causes.
const flush = () =>
  act(async () => {
    await Promise.resolve();
  });

// RenameField's revert. The failure each case prevents is the same one and it is
// SILENT: the field is uncontrolled and the call site keys it on the STORED name,
// so a commit that doesn't land leaves the row displaying a name nothing holds —
// no error on the row, no re-render, nothing until the section is re-entered.
//
// WHAT THESE ASSERT, and why it isn't the text. An uncontrolled TextInput keeps
// its text in the native layer, which does not exist under RNTL: `props.value` is
// undefined and `props.defaultValue` is the STORED name in every case, passing
// whether the field reverted or not. The revert IS the remount (the `key` bump),
// so the ref is the observable — a remount detaches and reattaches it, a plain
// re-render does not. The web twin has a real `input.value` and asserts on that.

function RenameHarness({
  onRename,
  inputRef,
}: {
  onRename: (name: string) => Promise<unknown>;
  inputRef: React.RefObject<TextInput | null>;
}) {
  return <RenameField name="Reading" label="List name" onRename={onRename} inputRef={inputRef} />;
}

function renameHarness(onRename: (name: string) => Promise<unknown>) {
  const inputRef = React.createRef<TextInput>();
  render(<RenameHarness onRename={onRename} inputRef={inputRef} />);
  return { inputRef, mounted: inputRef.current };
}

const endEditing = (text: string) =>
  fireEvent(screen.getByLabelText('List name'), 'endEditing', { nativeEvent: { text } });

// The positive control for the two reverts below: without it, "the field
// remounted" would be satisfied just as well by a field that remounts on every
// commit, which would throw away a rename that DID land.
test('a rename that lands leaves the field alone', async () => {
  const onRename = jest.fn(() => Promise.resolve());
  const { inputRef, mounted } = renameHarness(onRename);

  endEditing('Reading later');
  await flush();

  expect(onRename).toHaveBeenCalledWith('Reading later');
  expect(inputRef.current).toBe(mounted);
});

test('a rename the store rejects puts the stored name back', async () => {
  const onRename = jest.fn(() => Promise.reject(new Error('Storage is full.')));
  const { inputRef, mounted } = renameHarness(onRename);

  endEditing('Reading later');
  await flush();

  // Remounted, so the field is a fresh uncontrolled one at `defaultValue` — the
  // name the store still holds — instead of the text that failed to save.
  expect(onRename).toHaveBeenCalledWith('Reading later');
  expect(inputRef.current).not.toBe(mounted);
});

test('a blank name is not a rename, and never reaches the mutation', async () => {
  // The mutations treat a blank name as "no rename" rather than an error, so
  // nothing throws and nothing else would take the empty field back.
  const onRename = jest.fn(() => Promise.resolve());
  const { inputRef, mounted } = renameHarness(onRename);

  endEditing('   ');
  await flush();

  expect(onRename).not.toHaveBeenCalled();
  expect(inputRef.current).not.toBe(mounted);
});

// The tables' rows are memoized, and the handlers object is the one prop every
// row shares: a fresh one per render would re-render every row on every render
// of the section — each frame of a progressive fill among them, which is how
// the Lists switch's total blocking nearly doubled on a Pixel (lists-section.tsx).
// A stable one that froze the first render's handlers would be worse: a rename
// would write against the lists as they were when the table mounted.
test('useStableActions keeps one object and calls the latest render’s handler', () => {
  const first = jest.fn();
  const second = jest.fn();
  const { result, rerender } = renderHook(({ handler }) => useStableActions({ run: handler }), {
    initialProps: { handler: first },
  });
  const initial = result.current;

  rerender({ handler: second });

  expect(result.current).toBe(initial);
  result.current.run();
  expect(second).toHaveBeenCalledTimes(1);
  expect(first).not.toHaveBeenCalled();
});
