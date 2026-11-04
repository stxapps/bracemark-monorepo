import * as React from 'react';
import { fireEvent, render, screen } from '@testing-library/react-native';

import { LockedUsernameInput } from './locked-username-input';

// The props are what a spec can see; what iOS AutoFill and Android autofill make
// of them was measured by hand (docs/password-manager.md, _the iOS app_). The one
// that matters most is the one that is NOT there: `editable={false}` is a disabled
// UITextField, which iOS skips, and then no new account's password is ever offered
// for saving.
it('is an enabled username field that a person cannot change', () => {
  render(<LockedUsernameInput testID="name" username="alice-e2e" />);
  const { props } = screen.getByTestId('name');
  expect(props.value).toBe('alice-e2e');
  expect(props.editable).not.toBe(false);
  expect(props.autoComplete).toBe('username');
  expect(props.textContentType).toBe('username');
  expect(props.showSoftInputOnFocus).toBe(false);
  expect(props.caretHidden).toBe(true);
  expect(props.contextMenuHidden).toBe(true);
  expect(props['aria-disabled']).toBe(true);
});

it('puts the account’s name back when something edits it', () => {
  render(<LockedUsernameInput testID="name" username="alice-e2e" />);
  fireEvent.changeText(screen.getByTestId('name'), 'mallory');
  expect(screen.getByTestId('name').props.value).toBe('alice-e2e');
});
