import * as React from 'react';
import { render } from '@testing-library/react-native';

import { PasswordInput } from '../../features/auth/password-input';
import { Input } from './input';
import { Textarea } from './textarea';

// What a field tells the OS about itself — the native half of web-ui's
// input.spec.tsx. Left unset, Android offers any field to the autofill service
// and iOS guesses at its purpose, so a password manager can offer to save a
// link's URL, or a list-lock password, as this app's login. Nothing in the app
// looks different either way, and no device this suite runs on has an autofill
// service to notice. React Native reads `off` as "not important for autofill"
// on Android and `textContentType="none"` on iOS; what is pinned here is that
// every field asks for it unless it names itself.
function autoCompleteOf(ui: React.ReactElement, label: string): unknown {
  return render(ui).getByLabelText(label).props.autoComplete;
}

test('a field that does not say what it is asks the OS to keep nothing', () => {
  expect(autoCompleteOf(<Input aria-label="URL" />, 'URL')).toBe('off');
  expect(autoCompleteOf(<Textarea aria-label="Note" />, 'Note')).toBe('off');
});

// The other direction, and the one a user would meet at once: a credential field
// that lost its hint to the default is one the password manager no longer fills.
test.each(['username', 'current-password', 'new-password'] as const)(
  'a field that names itself is left alone: %s',
  (hint) => {
    expect(autoCompleteOf(<Input aria-label="Field" autoComplete={hint} />, 'Field')).toBe(hint);
  },
);

// PasswordInput is the one wrapper every secret goes through. A lock password is
// not this app's login, so the default has to reach it; an account password
// names itself and has to win.
test('the default reaches a secret field through PasswordInput, and yields to its hint', () => {
  expect(autoCompleteOf(<PasswordInput aria-label="Lock password" />, 'Lock password')).toBe('off');
  expect(
    autoCompleteOf(
      <PasswordInput aria-label="Account password" autoComplete="current-password" />,
      'Account password',
    ),
  ).toBe('current-password');
});
