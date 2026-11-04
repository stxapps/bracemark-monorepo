import * as React from 'react';
import { fireEvent, render, screen } from '@testing-library/react-native';

import { AccountSection } from './account-section';

// What a password manager reads on the Account views that take the account's
// password: a username naming the account, AHEAD of the password field it belongs
// to, on change password (account-username-field.tsx has the why), and NO username
// on recovery code and delete account, where the password only proves who you are
// and a named one was offered for saving as the form went away. The props are all a
// spec can see. The manager's reading of them is system UI, outside the app's
// tree, so no spec or flow sees it, and docs/password-manager.md records what was
// measured.
//
// The data layer is mocked whole. None of these views has to submit for the shape
// to be read; only `useAuth().username` reaches the field.
jest.mock('@stxapps/expo-react', () => {
  const idle = () => ({ mutate: jest.fn(), mutateAsync: jest.fn(), isPending: false, error: null });
  return {
    InvalidCredentialsError: class extends Error {},
    InvalidRecoveryCodeError: class extends Error {},
    SubscriptionActiveError: class extends Error {},
    UnconfirmedSaveError: class extends Error {},
    useAuth: () => ({ username: 'alice-e2e' }),
    useChangePassword: idle,
    useDeleteAccount: () => ({ ...idle(), reset: jest.fn() }),
    useEntitlements: () => ({ subscription: { status: 'none', willRenew: false } }),
    useHasRecoveryDoor: () => ({ data: true }),
    useRecoveryCode: idle,
  };
});

jest.mock('@stxapps/react', () => ({
  ...jest.requireActual('@stxapps/react'),
  useApiClient: () => ({}),
  useSignOutOthers: () => ({ mutateAsync: jest.fn(), isPending: false }),
}));

jest.mock('@tanstack/react-query', () => ({
  useQueryClient: () => ({}),
}));

jest.mock('expo-router', () => ({
  useRouter: () => ({ push: jest.fn() }),
}));

const VIEWS = [
  {
    open: 'change-password-open',
    username: 'change-password-username',
    password: 'change-password-current',
  },
] as const;

describe.each(VIEWS)('$open — whose password this is', ({ open, username, password }) => {
  beforeEach(() => {
    render(<AccountSection />);
    fireEvent.press(screen.getByTestId(open));
  });

  it('names the account in a username field that cannot be typed into', () => {
    const { props } = screen.getByTestId(username);
    expect(props.value).toBe('alice-e2e');
    expect(props.autoComplete).toBe('username');
    // Not left to React Native's mapping of `autoComplete`: the explicit iOS type
    // is what wins there (docs/accessibility.md, _what a field tells the browser_).
    expect(props.textContentType).toBe('username');
    // ⚠ Enabled: iOS AutoFill skips a disabled field (locked-username-input.tsx).
    expect(props.editable).not.toBe(false);
    expect(props.showSoftInputOnFocus).toBe(false);
    expect(props['aria-label']).toBe('Username');
  });

  it('puts the username ahead of the password it names', () => {
    // Tree order, the order a manager walks the fields in.
    const ids = screen
      .getAllByTestId(/-(username|current|password)$/)
      .map((node) => node.props.testID as string);
    expect(ids.indexOf(username)).toBeGreaterThanOrEqual(0);
    expect(ids.indexOf(username)).toBeLessThan(ids.indexOf(password));
  });
});

it('change password keeps the username when the proof switches to the recovery code', () => {
  render(<AccountSection />);
  fireEvent.press(screen.getByTestId('change-password-open'));
  fireEvent.press(screen.getByText('I forgot it — use my recovery code'));
  expect(screen.getByTestId('change-password-username').props.value).toBe('alice-e2e');
});

// A password that only proves who you are gets fill and no save offer, so no
// account's name beside it (docs/password-manager.md, _a password that only proves
// who you are_).
it.each([
  ['delete-account-open', 'delete-account-password'],
  ['recovery-code-open', 'recovery-code-current'],
])('%s names no account beside its password', (open, password) => {
  render(<AccountSection />);
  fireEvent.press(screen.getByTestId(open));
  expect(screen.getByTestId(password).props.autoComplete).toBe('current-password');
  expect(screen.queryByLabelText('Username')).toBeNull();
  expect(screen.queryByText('alice-e2e')).toBeNull();
});
