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
const tree = (onSubmit: (password: string, checked: boolean) => Promise<void>) => (
  <>
    <LockPasswordDialog
      onOpenChange={jest.fn()}
      title="Unlock list"
      description="Enter the password"
      submitLabel="Unlock"
      onSubmit={onSubmit}
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
