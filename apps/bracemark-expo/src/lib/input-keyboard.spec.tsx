import * as React from 'react';
import { Platform, type TextInput } from 'react-native';
import { fireEvent, render, screen } from '@testing-library/react-native';

import { PasswordInput } from '../features/auth/password-input';
import { advanceTo, shownSecretKeyboardType } from './input-keyboard';

// WHAT A FIELD ASKS OF THE KEYBOARD — the two answers input-keyboard.ts holds,
// and the one wrapper that applies the second by itself.
//
// Neither has a symptom anywhere but a device. A username that drops the
// keyboard on Return instead of moving to the password type-checks and passes
// every flow (the flows tap each field by `testID`); a revealed password the
// Android keyboard treats as ordinary text looks identical on screen. Jest draws
// no keyboard, so what is pinned here is the props each one comes down to — and,
// for the first, that they arrive TOGETHER, because any two of the three is a
// different bug: without `submitBehavior="submit"` the field blurs first and the
// keyboard falls and rises again; without the handler it stays up on a field the
// user has finished with.
describe('Return on a field that has a next one', () => {
  it('labels the key, keeps the keyboard, and moves the focus — all three', () => {
    const focus = jest.fn();
    const next = { current: { focus } as unknown as TextInput };

    const props = advanceTo(next);

    expect(props.returnKeyType).toBe('next');
    expect(props.submitBehavior).toBe('submit');
    props.onSubmitEditing();
    expect(focus).toHaveBeenCalledTimes(1);
  });

  // The next field can be absent for a render — a mode switch, a step swap.
  it('does nothing, rather than throw, when the next field is not mounted', () => {
    expect(() => advanceTo({ current: null }).onSubmitEditing()).not.toThrow();
  });
});

describe('a secret shown in the clear', () => {
  const realOS = Platform.OS;
  afterEach(() => {
    Platform.OS = realOS;
  });

  it('is a visible password to the Android keyboard, and nothing special on iOS', () => {
    Platform.OS = 'android';
    expect(shownSecretKeyboardType()).toBe('visible-password');

    Platform.OS = 'ios';
    expect(shownSecretKeyboardType()).toBeUndefined();
  });

  // The reveal is the moment a masked field becomes plain text, so it is the
  // moment the keyboard has to be told — and told to stop again on re-hide,
  // where `secureTextEntry` is the stronger statement of the same thing. This is
  // where each press SETTLES; the order it gets there in is what matters on a
  // device, and password-input.spec.tsx pins that.
  it('follows the reveal toggle on a password field', () => {
    Platform.OS = 'android';
    render(<PasswordInput aria-label="Password" />);
    const field = () => screen.getByLabelText('Password');
    expect(field().props.secureTextEntry).toBe(true);
    expect(field().props.keyboardType).toBeUndefined();

    fireEvent.press(screen.getByLabelText('Show password'));
    expect(field().props.secureTextEntry).toBe(false);
    expect(field().props.keyboardType).toBe('visible-password');

    fireEvent.press(screen.getByLabelText('Hide password'));
    expect(field().props.secureTextEntry).toBe(true);
    expect(field().props.keyboardType).toBeUndefined();
  });
});
