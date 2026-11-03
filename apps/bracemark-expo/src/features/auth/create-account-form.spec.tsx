import * as React from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react-native';

import { SignupLimitedError, useCreateAccount, UsernameTakenError } from '@stxapps/expo-react';
import { CREATE_ACCOUNT_COPY, useUsernameAvailable } from '@stxapps/react';

import { CreateAccountForm } from './create-account-form';

// The native half of web-ui's create-account-form.spec.tsx: ONE STEP — username, the
// password field on generated words, Create account (docs/account.md, _creating an
// account_). Every e2e account but NATIVE-ACCOUNT-003's is created in a browser, so
// this is the layer that holds the native form's contract with the mutation:
//
//   1. the button creates the account with exactly what the field holds, canonical
//      name, no recovery code (the welcome mints one);
//   2. it is the gate, and nothing sends a second create while one is in flight;
//   3. a username taken at the last moment is said under the username, anything else
//      under the button;
//   4. it is a sign-up to a manager: a username ahead of a masked new password.

jest.mock('@stxapps/expo-react', () => {
  class UsernameTakenError extends Error {}
  class SignupLimitedError extends Error {}
  return { SignupLimitedError, UsernameTakenError, useCreateAccount: jest.fn() };
});

jest.mock('@stxapps/react', () => ({
  ...jest.requireActual('@stxapps/react'),
  useUsernameAvailable: jest.fn(),
}));

let mockGuessesLog10: number | null = 30;
jest.mock('./password-strength', () => ({
  ...jest.requireActual('./password-strength'),
  usePasswordStrength: () => ({ guessesLog10: mockGuessesLog10, displayScore: null, ready: true }),
}));

jest.mock('expo-clipboard', () => ({
  setStringAsync: jest.fn(() => Promise.resolve(true)),
}));

const USERNAME = 'Wit_E2E';
const STRONG = 'x7Kq2mVn9Rt4Lw8Zp3Hy6Bf1';

let createAccount: jest.Mock;
let isPending: boolean;

beforeEach(() => {
  mockGuessesLog10 = 30;
  isPending = false;
  createAccount = jest.fn().mockResolvedValue(undefined);
  (useCreateAccount as jest.Mock).mockImplementation(() => ({
    mutateAsync: createAccount,
    isPending,
  }));
  (useUsernameAvailable as jest.Mock).mockReturnValue({
    data: { available: true },
    isFetching: false,
    isError: false,
    current: true,
  });
});

const submitButton = () => screen.getByTestId('create-account-submit');
const passwordField = () => screen.getByLabelText(CREATE_ACCOUNT_COPY.passwordLabel);
const typeUsername = (value = USERNAME) =>
  fireEvent.changeText(screen.getByLabelText('Username'), value);
const press = async () => {
  await act(async () => {
    fireEvent.press(submitButton());
  });
};

describe('CreateAccountForm (native) — one step', () => {
  it('creates with the generated words, canonical name, and no recovery code', async () => {
    render(<CreateAccountForm />);
    typeUsername();
    const words = passwordField().props.value as string;
    expect(words).toMatch(/^[a-z]+(-[a-z]+){6}$/);

    await press();

    expect(createAccount).toHaveBeenCalledTimes(1);
    expect(createAccount).toHaveBeenCalledWith({ username: 'wit_e2e', password: words });
  });

  it('creates with a password typed over the words', async () => {
    render(<CreateAccountForm />);
    typeUsername();
    fireEvent.changeText(passwordField(), STRONG);

    await press();

    expect(createAccount).toHaveBeenCalledWith({ username: 'wit_e2e', password: STRONG });
  });

  it('holds the button until both lines pass', () => {
    render(<CreateAccountForm />);
    expect(submitButton()).toBeDisabled();
    typeUsername();
    expect(submitButton()).toBeEnabled();
    mockGuessesLog10 = 10;
    fireEvent.changeText(passwordField(), 'password password password');
    expect(submitButton()).toBeDisabled();
  });

  // A keyboard's Return is not disabled with the button, and a second create for the
  // same name would come back as UsernameTakenError on an account just made.
  it('sends nothing while a create is in flight', async () => {
    isPending = true;
    render(<CreateAccountForm />);
    typeUsername();
    await press();
    expect(createAccount).not.toHaveBeenCalled();
    expect(screen.getByText(CREATE_ACCOUNT_COPY.creating)).toBeTruthy();
  });
});

describe('CreateAccountForm (native) — failures', () => {
  it('says a username taken at the last moment under the username', async () => {
    createAccount.mockRejectedValue(new UsernameTakenError());
    render(<CreateAccountForm />);
    typeUsername();
    await press();
    expect(screen.getByText(/taken/i)).toBeTruthy();
    expect(submitButton()).toBeDisabled();
  });

  it('announces any other failure under the button', async () => {
    createAccount.mockRejectedValue(new Error('network'));
    render(<CreateAccountForm />);
    typeUsername();
    await press();
    expect(screen.getByRole('alert')).toHaveTextContent(
      'Could not create account. Please try again.',
    );
    expect(submitButton()).toBeEnabled();
  });

  it('says to come back tomorrow when the network has reached its daily cap', async () => {
    createAccount.mockRejectedValue(new SignupLimitedError());
    render(<CreateAccountForm />);
    typeUsername();
    await press();
    expect(screen.getByRole('alert')).toHaveTextContent(CREATE_ACCOUNT_COPY.signupLimited);
  });
});

describe('CreateAccountForm (native) — what a password manager reads', () => {
  it('is a username ahead of a masked new password', () => {
    render(<CreateAccountForm />);
    const username = screen.getByLabelText('Username');
    expect(username.props.textContentType).toBe('username');
    expect(passwordField().props.autoComplete).toBe('new-password');
    expect(passwordField().props.secureTextEntry).toBe(true);
  });
});
