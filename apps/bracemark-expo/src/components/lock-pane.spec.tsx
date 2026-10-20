import * as React from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react-native';

import { LockPane } from './lock-pane';

// WHAT THE PANE DOES ON ITS WAY UP — the two things it does unasked, and the one
// prop that withholds them.
//
// A pane that mounts raises a keyboard (the password field is `autoFocus`) or,
// when the lock has opted in, runs the OS biometric prompt. Both are the pane
// ASKING for the unlock, and both are wrong when the lock was engaged by hand a
// moment ago: the drawer's "Lock now" raised a keyboard under the drawer, for a
// field nobody could see, and a Face ID lock prompted to reopen itself
// (docs/locks.md, _a hand relock does not ask to be undone_). The hosts decide
// when — features/links/main.spec.tsx pins the list's half — and pass
// `solicit={false}`; this file pins that the pane then does NEITHER, and still
// offers both.
//
// Neither failure shows anywhere but a device. `solicit` is an optional boolean,
// jest raises no keyboard, and the prompt needs an enrolled sensor — so what is
// pinned here is the prop the field is given and the call the prompt would be.
jest.mock('../contexts/sign-out-provider', () => ({
  useSignOutFlow: () => ({ requestSignOut: jest.fn() }),
}));

const field = () => screen.getByTestId('lock-pane-password');

// The prompt resolves `false` (a cancel), which is the outcome that leaves the
// pane up to be asserted on.
const biometric = () => ({ label: 'Face ID', onUnlock: jest.fn().mockResolvedValue(false) });

const pane = (props: Partial<React.ComponentProps<typeof LockPane>> = {}) => (
  <LockPane title="Locked" description="Enter the password" onUnlock={jest.fn()} {...props} />
);

// `await act` because the auto-prompt starts async work in a mount effect
// (docs/testing.md, _an update that lands after `act()` returns_).
async function mount(props: Partial<React.ComponentProps<typeof LockPane>> = {}) {
  const view = render(pane(props));
  await act(() => Promise.resolve());
  return view;
}

// The control: the default is to ask, by whichever means the lock offers — and
// by ONE of them, since a keyboard under the OS sheet is nobody's.
test('a pane arrived at asks: the field takes focus, or the sensor is prompted', async () => {
  await mount();
  expect(field().props.autoFocus).toBe(true);

  screen.unmount();
  const offered = biometric();
  await mount({ biometric: offered });

  expect(offered.onUnlock).toHaveBeenCalledTimes(1);
  expect(field().props.autoFocus).toBe(false);
});

test.each(['refused', 'throws'])(
  'a verification that %s cannot publish an error over newer typing',
  async (outcome) => {
    let finish!: (ok: boolean) => void;
    let fail!: (error: Error) => void;
    const onUnlock = jest.fn(
      () =>
        new Promise<boolean>((resolve, reject) => {
          finish = resolve;
          fail = reject;
        }),
    );
    await mount({ onUnlock });
    fireEvent.changeText(field(), 'old-password');
    fireEvent.press(screen.getByTestId('lock-pane-unlock'));
    fireEvent.changeText(field(), 'corrected-password');
    await act(async () => (outcome === 'refused' ? finish(false) : fail(new Error('failed'))));

    expect(screen.queryByTestId('lock-pane-error')).toBeNull();
    expect(screen.getByTestId('lock-pane-unlock')).not.toBeDisabled();
    fireEvent.press(screen.getByTestId('lock-pane-unlock'));
    expect(onUnlock).toHaveBeenLastCalledWith('corrected-password');
    await act(async () => finish(false));
    expect(screen.getByTestId('lock-pane-error')).toBeTruthy();
  },
);

// The other side of the same rule, and the one a change COUNTER got wrong: an
// edit that is undone before the answer arrives leaves the refused text in the
// field, so the refusal is about what is on screen and has to show.
test('a refusal still shows when the field was edited and put back meanwhile', async () => {
  let finish!: (ok: boolean) => void;
  const onUnlock = jest.fn(() => new Promise<boolean>((resolve) => (finish = resolve)));
  await mount({ onUnlock });
  fireEvent.changeText(field(), 'not-the-password');
  fireEvent.press(screen.getByTestId('lock-pane-unlock'));
  fireEvent.changeText(field(), 'not-the-passwordx');
  fireEvent.changeText(field(), 'not-the-password');
  await act(async () => finish(false));

  expect(screen.getByTestId('lock-pane-error')).toBeTruthy();
});

test('a pane told not to solicit raises no keyboard', async () => {
  await mount({ solicit: false });

  expect(field().props.autoFocus).toBe(false);
});

test('a pane told not to solicit runs no biometric prompt, and still offers the button', async () => {
  const offered = biometric();
  await mount({ solicit: false, biometric: offered });

  expect(offered.onUnlock).not.toHaveBeenCalled();
  expect(field().props.autoFocus).toBe(false);
  expect(screen.getByText('Unlock with Face ID')).toBeTruthy();

  fireEvent.press(screen.getByText('Unlock with Face ID'));
  await act(() => Promise.resolve());
  expect(offered.onUnlock).toHaveBeenCalledTimes(1);
  expect(screen.getByTestId('lock-pane-unlock')).not.toBeDisabled();
});

// The host's answer can change under a pane that is still up — the auto-relock
// clears the by-hand mark — and biometry can become available after mount (the
// provider probes the device once, asynchronously). Neither may turn a pane that
// went up quiet into one that summons a Face ID sheet later, on its own.
test('a quiet pane stays quiet: the answer is read once, on the way up', async () => {
  const view = await mount({ solicit: false });
  const offered = biometric();

  view.rerender(pane({ solicit: true, biometric: offered }));
  await act(() => Promise.resolve());

  expect(offered.onUnlock).not.toHaveBeenCalled();
  expect(field().props.autoFocus).toBe(false);
});

// THE FIELD IS NEVER TAKEN AWAY MID-SUBMIT. It used to be `editable={!busy}`,
// which reads as a double-submit guard and on native is a keyboard dismissal: a
// focused field that goes non-editable loses its focus on both platforms, and
// nothing gives it back when `busy` clears. So a wrong password ended with the
// error showing and the keyboard down, and the retype it asks for cost a tap
// first (docs/soft-keyboard.md, _a submit drops it_). No keyboard exists here to
// watch fall; what is pinned is the prop that made it fall — and that the guard
// it was mistaken for is still in place, on the button.
test('the field stays editable while a password is being verified, and after it is refused', async () => {
  let refuse: (ok: boolean) => void = () => undefined;
  const onUnlock = jest.fn(() => new Promise<boolean>((resolve) => (refuse = resolve)));
  await mount({ onUnlock });

  fireEvent.changeText(field(), 'not-the-password');
  fireEvent.press(screen.getByTestId('lock-pane-unlock'));
  await act(() => Promise.resolve());

  expect(screen.getByTestId('lock-pane-unlock')).toBeDisabled();
  expect(field().props.editable).not.toBe(false);

  // ...and the press that cannot get through is how re-entry is stopped.
  fireEvent.press(screen.getByTestId('lock-pane-unlock'));
  expect(onUnlock).toHaveBeenCalledTimes(1);

  await act(async () => refuse(false));

  expect(screen.getByTestId('lock-pane-error')).toBeTruthy();
  expect(field().props.editable).not.toBe(false);
});

// A lock password is not this app's login, and the `off` default did not tell
// iOS so: `textContentType="none"` leaves Password AutoFill to read the secure
// field as a password, and after an unlock it offered to replace the saved
// sign-in password with the lock password. No simulator spec sees that sheet;
// what is pinned is the type that keeps it away — and that Android keeps `off`,
// which `one-time-code` would have turned into an SMS-code hint there.
test('the field tells the OS it is not the login', async () => {
  await mount();

  expect(field().props.textContentType).toBe('oneTimeCode');
  expect(field().props.autoComplete).toBe('off');
  expect(field().props.secureTextEntry).toBe(true);
});
