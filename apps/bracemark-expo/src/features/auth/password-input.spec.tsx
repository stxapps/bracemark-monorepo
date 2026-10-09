import * as React from 'react';
import { Platform } from 'react-native';
import { fireEvent, render, screen } from '@testing-library/react-native';

import { PasswordInput } from './password-input';

// THE ORDER A REVEAL REACHES THE NATIVE FIELD IN — the one thing about
// PasswordInput that a device decides and nothing else can see.
//
// On Android a revealed password should become a `visible-password` field, so
// the keyboard stops treating it as text (lib/input-keyboard.ts). But un-masking
// and that keyboard type write the SAME native input-type bits, and React Native
// applies an update's props in an order of its own. Delivered in one update, the
// un-masking's clear lands last. Measured on the Pixel 8 AVD:
//
//   masked                              0x80081
//   revealed, no keyboard type          0x80001   Gboard shows the password in its strip
//   revealed, both in ONE update        0x80000   no input class at all; the strip stays
//   revealed, keyboard type a commit on 0x80090   Gboard's password keyboard, no strip
//
// So the field must be handed the un-masking FIRST and the keyboard type in the
// commit after. The final props are identical either way —
// lib/input-keyboard.spec.tsx passes for both — which is exactly why this is
// pinned as a sequence. The stand-in below records what `Input` is given on each
// render.
const mockHanded: [unknown, unknown][] = [];
jest.mock('../../components/ui/input', () => {
  const { TextInput } = jest.requireActual('react-native');
  return {
    Input: (props: { secureTextEntry?: boolean; keyboardType?: string }) => {
      const last = mockHanded[mockHanded.length - 1];
      // Collapse the repeats a StrictMode double render produces.
      if (!last || last[0] !== props.secureTextEntry || last[1] !== props.keyboardType) {
        mockHanded.push([props.secureTextEntry, props.keyboardType]);
      }
      return <TextInput {...props} />;
    },
  };
});

const realOS = Platform.OS;
beforeEach(() => {
  mockHanded.length = 0;
});
afterEach(() => {
  Platform.OS = realOS;
});

test('on Android the un-masking arrives a commit before the keyboard type, never with it', () => {
  Platform.OS = 'android';
  render(<PasswordInput aria-label="Password" />);

  fireEvent.press(screen.getByLabelText('Show password'));
  fireEvent.press(screen.getByLabelText('Hide password'));

  expect(mockHanded).toEqual([
    [true, undefined],
    [false, undefined],
    [false, 'visible-password'],
    // Re-masking is one step: `secureTextEntry` alone settles the type.
    [true, undefined],
  ]);
});

// iOS has no such keyboard type, and must not be handed one.
test('on iOS a reveal changes the masking and nothing else', () => {
  Platform.OS = 'ios';
  render(<PasswordInput aria-label="Password" />);

  fireEvent.press(screen.getByLabelText('Show password'));

  expect(mockHanded).toEqual([
    [true, undefined],
    [false, undefined],
  ]);
});
