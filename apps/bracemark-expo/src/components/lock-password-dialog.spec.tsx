import * as React from 'react';
import { PortalHost } from '@rn-primitives/portal';
import { act, fireEvent, render, screen } from '@testing-library/react-native';

import { LockPasswordDialog } from './lock-password-dialog';

// THE FIELD IS NEVER TAKEN AWAY MID-SUBMIT — lock-pane.spec.tsx's last case, on
// the other field that carried `editable={!busy}`. On native that prop drops the
// keyboard (a focused field that goes non-editable loses its focus, and nothing
// returns it), and this dialog's contract is that a rejected password leaves the
// field up for a retry: with the prop, the retry started with a tap back into a
// field that had been typed in a second earlier (docs/soft-keyboard.md, _a
// submit drops it_). Jest has no keyboard to watch, so what is pinned is the
// prop — and the guard it was mistaken for, which is the disabled button.
const tree = (
  onSubmit: (password: string, checked: boolean) => Promise<void>,
  props: Partial<React.ComponentProps<typeof LockPasswordDialog>> = {},
) => (
  <>
    <LockPasswordDialog
      onOpenChange={jest.fn()}
      title="Unlock list"
      description="Enter the password"
      submitLabel="Unlock"
      onSubmit={onSubmit}
      {...props}
    />
    <PortalHost />
  </>
);

const field = () => screen.getByTestId('lock-dialog-password');

test('the field stays editable while a password is being verified, and after it is refused', async () => {
  let refuse: (reason: Error) => void = () => undefined;
  const onSubmit = jest.fn(() => new Promise<void>((_resolve, reject) => (refuse = reject)));
  render(tree(onSubmit));
  await act(() => Promise.resolve());

  fireEvent.changeText(field(), 'not-the-password');
  fireEvent.press(screen.getByTestId('lock-dialog-submit'));
  await act(() => Promise.resolve());

  expect(screen.getByTestId('lock-dialog-submit')).toBeDisabled();
  expect(field().props.editable).not.toBe(false);

  await act(async () => refuse(new Error('Password is not correct')));

  expect(screen.getByTestId('lock-dialog-error')).toBeTruthy();
  expect(field().props.editable).not.toBe(false);
});

test('creating a lock freezes the password and hide option until the write settles', async () => {
  let refuse!: (reason: Error) => void;
  const onSubmit = jest.fn(() => new Promise<void>((_resolve, reject) => (refuse = reject)));
  render(tree(onSubmit, { mode: 'create', checkboxLabel: 'Hide while locked' }));

  fireEvent.changeText(field(), 'the-new-password');
  fireEvent.press(screen.getByTestId('lock-dialog-checkbox'));
  fireEvent.press(screen.getByTestId('lock-dialog-submit'));

  expect(field().props.editable).toBe(false);
  // Two pressables, each disabled for itself: the row, and the box inside it.
  const [row, box] = screen.getAllByRole('checkbox');
  expect(row).toBe(screen.getByTestId('lock-dialog-checkbox'));
  fireEvent.press(row);
  expect(row).toBeChecked();
  fireEvent.press(box);
  expect(row).toBeChecked();
  expect(onSubmit).toHaveBeenCalledWith('the-new-password', true);

  await act(async () => refuse(new Error('Write failed')));
  expect(field().props.editable).not.toBe(false);
  expect(screen.getByTestId('lock-dialog-error')).toBeTruthy();
});

test('a failed verification does not label a password edited during the attempt as wrong', async () => {
  let refuse!: (reason: Error) => void;
  const onSubmit = jest.fn(() => new Promise<void>((_resolve, reject) => (refuse = reject)));
  render(tree(onSubmit));
  fireEvent.changeText(field(), 'old-password');
  fireEvent.press(screen.getByTestId('lock-dialog-submit'));
  fireEvent.changeText(field(), 'corrected-password');
  await act(async () => refuse(new Error('Password is not correct')));

  expect(screen.queryByTestId('lock-dialog-error')).toBeNull();
  expect(screen.getByTestId('lock-dialog-submit')).not.toBeDisabled();
  fireEvent.press(screen.getByTestId('lock-dialog-submit'));
  expect(onSubmit).toHaveBeenLastCalledWith('corrected-password', false);
  await act(async () => refuse(new Error('Password is not correct')));
  // The same result belongs on screen when that attempt's input stayed put.
  expect(screen.getByTestId('lock-dialog-error')).toBeTruthy();
});

// An edit undone before the answer arrives leaves the refused text in the field
// (lock-pane.spec.tsx has the reasoning): that refusal is the field's, and shows.
test('a failed verification still shows when the field was edited and put back meanwhile', async () => {
  let refuse!: (reason: Error) => void;
  const onSubmit = jest.fn(() => new Promise<void>((_resolve, reject) => (refuse = reject)));
  render(tree(onSubmit));
  fireEvent.changeText(field(), 'not-the-password');
  fireEvent.press(screen.getByTestId('lock-dialog-submit'));
  fireEvent.changeText(field(), 'not-the-passwordx');
  fireEvent.changeText(field(), 'not-the-password');
  await act(async () => refuse(new Error('Password is not correct')));

  expect(screen.getByTestId('lock-dialog-error')).toBeTruthy();
});
