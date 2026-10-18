/** @jest-environment jsdom */
import * as React from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';

import { LockPasswordDialog } from './lock-password-dialog';

// The twin of bracemark-expo's lock-password-dialog.spec.tsx, case for case. This
// dialog never took its field away mid-submit — the native one did, and paid for
// it with the keyboard (docs/soft-keyboard.md, _a submit drops it_) — so the
// first case pins the parity from this side, as lock-pane.spec.tsx's last case
// does for the pane. The rest is what the two share outright: a new password is
// held still while it saves, and a late answer is shown only on the text it is
// about.

// Radix measures its checkbox; this spec observes state rather than geometry.
beforeAll(() => {
  (globalThis as { ResizeObserver?: unknown }).ResizeObserver ??= class {
    observe = () => undefined;
    unobserve = () => undefined;
    disconnect = () => undefined;
  };
});

const tree = (
  onSubmit: (password: string, checked: boolean) => Promise<void>,
  props: Partial<React.ComponentProps<typeof LockPasswordDialog>> = {},
) => (
  <LockPasswordDialog
    onOpenChange={jest.fn()}
    title="Unlock list"
    description="Enter the password"
    submitLabel="Unlock"
    onSubmit={onSubmit}
    {...props}
  />
);

const field = () => screen.getByLabelText<HTMLInputElement>('Password');
const submitButton = () => screen.getByRole<HTMLButtonElement>('button', { name: /^Unlock/ });

test('the field stays editable while a password is being verified, and after it is refused', async () => {
  let refuse: (reason: Error) => void = () => undefined;
  const onSubmit = jest.fn(() => new Promise<void>((_resolve, reject) => (refuse = reject)));
  render(tree(onSubmit));

  fireEvent.change(field(), { target: { value: 'not-the-password' } });
  fireEvent.click(submitButton());
  await act(() => Promise.resolve());

  expect(submitButton().disabled).toBe(true);
  expect(field().readOnly).toBe(false);
  expect(field().disabled).toBe(false);

  await act(async () => refuse(new Error('Password is not correct')));

  expect(screen.getByRole('alert')).toBeTruthy();
  expect(field().readOnly).toBe(false);
  expect(field().disabled).toBe(false);
});

test('creating a lock freezes the password and hide option until the write settles', async () => {
  let refuse!: (reason: Error) => void;
  const onSubmit = jest.fn(() => new Promise<void>((_resolve, reject) => (refuse = reject)));
  render(tree(onSubmit, { mode: 'create', checkboxLabel: 'Hide while locked' }));

  fireEvent.change(field(), { target: { value: 'the-new-password' } });
  fireEvent.click(screen.getByRole('checkbox'));
  fireEvent.click(submitButton());

  expect(field().readOnly).toBe(true);
  // One control here, where the native row is two pressables.
  const box = screen.getByRole<HTMLButtonElement>('checkbox');
  expect(box.disabled).toBe(true);
  fireEvent.click(box);
  expect(box.getAttribute('aria-checked')).toBe('true');
  expect(onSubmit).toHaveBeenCalledWith('the-new-password', true);

  await act(async () => refuse(new Error('Write failed')));
  expect(field().readOnly).toBe(false);
  expect(screen.getByRole('alert')).toBeTruthy();
});

test('a failed verification does not label a password edited during the attempt as wrong', async () => {
  let refuse!: (reason: Error) => void;
  const onSubmit = jest.fn(() => new Promise<void>((_resolve, reject) => (refuse = reject)));
  render(tree(onSubmit));
  fireEvent.change(field(), { target: { value: 'old-password' } });
  fireEvent.click(submitButton());
  fireEvent.change(field(), { target: { value: 'corrected-password' } });
  await act(async () => refuse(new Error('Password is not correct')));

  expect(screen.queryByRole('alert')).toBeNull();
  expect(submitButton().disabled).toBe(false);
  fireEvent.click(submitButton());
  expect(onSubmit).toHaveBeenLastCalledWith('corrected-password', false);
  await act(async () => refuse(new Error('Password is not correct')));
  // The same result belongs on screen when that attempt's input stayed put.
  expect(screen.getByRole('alert')).toBeTruthy();
});

// An edit undone before the answer arrives leaves the refused text in the field
// (lock-pane.spec.tsx has the reasoning): that refusal is the field's, and shows.
test('a failed verification still shows when the field was edited and put back meanwhile', async () => {
  let refuse!: (reason: Error) => void;
  const onSubmit = jest.fn(() => new Promise<void>((_resolve, reject) => (refuse = reject)));
  render(tree(onSubmit));
  fireEvent.change(field(), { target: { value: 'not-the-password' } });
  fireEvent.click(submitButton());
  fireEvent.change(field(), { target: { value: 'not-the-passwordx' } });
  fireEvent.change(field(), { target: { value: 'not-the-password' } });
  await act(async () => refuse(new Error('Password is not correct')));

  expect(screen.getByRole('alert')).toBeTruthy();
});

// lock-pane.spec.tsx has the reasoning. Here the cost was the save prompt:
// setting a lock had Chrome offer to replace the saved sign-in password.
test.each(['create', 'verify'] as const)(
  'the %s field tells a password manager it is not the login',
  (mode) => {
    render(tree(jest.fn(), { mode }));

    expect(field().getAttribute('autocomplete')).toBe('one-time-code');
    expect(field().type).toBe('password');
  },
);
