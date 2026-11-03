import { act, fireEvent, render, screen } from '@testing-library/react';

import { CREATE_ACCOUNT_COPY, useUsernameAvailable } from '@stxapps/react';
import { useCreateAccount, UsernameTakenError } from '@stxapps/web-react';

import { installJsdomStubs } from '../../testing/jsdom-stubs';
import { CreateAccountForm } from './create-account-form';

// ONE STEP: username, password, Create account (docs/account.md, _creating an
// account_). The two message ladders are `@stxapps/react`'s (field-messages.spec.ts)
// and the field is new-password-field.spec.tsx's, so what is left here is the form's
// own contract with the mutation and with a password manager:
//
//   1. the field starts on generated words, and the button creates the account with
//      exactly what the field holds — no recovery code, which the welcome mints;
//   2. the button is the gate: closed until both lines pass, and once pressed,
//      nothing sends a second create while the first is in flight;
//   3. a username taken at the last moment is said under the username, and anything
//      else under the button, with the form still there to retry;
//   4. it is the shape a manager saves a sign-up from: a username ahead of a
//      `new-password`, in one form with a real submit.

jest.mock('@stxapps/react', () => ({
  ...jest.requireActual('@stxapps/react'),
  useUsernameAvailable: jest.fn(),
}));

jest.mock('@stxapps/web-react', () => {
  class UsernameTakenError extends Error {}
  return { UsernameTakenError, useCreateAccount: jest.fn() };
});

let mockGuessesLog10: number | null = 30;
jest.mock('@stxapps/web-ui/components/auth/password-strength', () => ({
  ...jest.requireActual('@stxapps/web-ui/components/auth/password-strength'),
  usePasswordStrength: () => ({
    guessesLog10: mockGuessesLog10,
    displayScore: null,
    ready: true,
    failed: false,
  }),
}));

const USERNAME = 'Wit_E2E';
const STRONG = 'x7Kq2mVn9Rt4Lw8Zp3Hy6Bf1';

let createAccount: jest.Mock;
let isPending: boolean;

beforeAll(() => {
  installJsdomStubs();
});

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

const submitButton = () => screen.getByRole('button', { name: CREATE_ACCOUNT_COPY.submit });
const passwordField = () =>
  screen.getByLabelText(CREATE_ACCOUNT_COPY.passwordLabel) as HTMLInputElement;
const usernameField = () => screen.getByLabelText('Username') as HTMLInputElement;
const typeUsername = (value = USERNAME) => fireEvent.change(usernameField(), { target: { value } });
const submit = async () => {
  await act(async () => {
    fireEvent.submit(usernameField().form as HTMLFormElement);
  });
};

describe('CreateAccountForm — one step', () => {
  it('creates the account with the generated words, canonical name, and no recovery code', async () => {
    render(<CreateAccountForm />);
    typeUsername();
    const words = passwordField().value;
    expect(words).toMatch(/^[a-z]+(-[a-z]+){6}$/);

    await submit();

    expect(createAccount).toHaveBeenCalledTimes(1);
    expect(createAccount).toHaveBeenCalledWith({ username: 'wit_e2e', password: words });
  });

  it('creates with a password typed, or suggested by a manager, over the words', async () => {
    render(<CreateAccountForm />);
    typeUsername();
    fireEvent.change(passwordField(), { target: { value: STRONG } });

    await submit();

    expect(createAccount).toHaveBeenCalledWith({ username: 'wit_e2e', password: STRONG });
  });

  it('holds the button until both lines pass', async () => {
    render(<CreateAccountForm />);
    expect((submitButton() as HTMLButtonElement).disabled).toBe(true);

    typeUsername();
    expect((submitButton() as HTMLButtonElement).disabled).toBe(false);

    mockGuessesLog10 = 10;
    fireEvent.change(passwordField(), { target: { value: 'password password password' } });
    expect((submitButton() as HTMLButtonElement).disabled).toBe(true);
    await submit();
    expect(createAccount).not.toHaveBeenCalled();
  });

  it('sends nothing more while a create is in flight, and says it is working', async () => {
    isPending = true;
    render(<CreateAccountForm />);
    typeUsername();

    await submit();

    expect(createAccount).not.toHaveBeenCalled();
    expect(
      (screen.getByRole('button', { name: CREATE_ACCOUNT_COPY.creating }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    // Read-only, not disabled: a manager reads the username as the form goes away.
    expect(usernameField().readOnly).toBe(true);
    expect(usernameField().disabled).toBe(false);
  });
});

describe('CreateAccountForm — failures', () => {
  it('says a username taken at the last moment under the username', async () => {
    createAccount.mockRejectedValue(new UsernameTakenError());
    render(<CreateAccountForm />);
    typeUsername();

    await submit();

    expect(usernameField().getAttribute('aria-invalid')).toBe('true');
    expect(screen.getByText(/taken/i)).toBeTruthy();
    expect((submitButton() as HTMLButtonElement).disabled).toBe(true);
    // A new name clears it.
    typeUsername('wit_e2e_2');
    expect(usernameField().getAttribute('aria-invalid')).toBe('false');
  });

  it('announces any other failure under the button, with the form still there', async () => {
    createAccount.mockRejectedValue(new Error('network'));
    render(<CreateAccountForm />);
    typeUsername();
    const words = passwordField().value;

    await submit();

    expect(screen.getByRole('alert').textContent).toBe(
      'Could not create account. Please try again.',
    );
    expect(passwordField().value).toBe(words);
    expect((submitButton() as HTMLButtonElement).disabled).toBe(false);
  });
});

describe('CreateAccountForm — what a password manager reads', () => {
  // A sign-up: a named username ahead of a `new-password`, in one form with a real
  // submit. The manager saves from it when it goes away, which is now after the
  // account exists. The page's heading is the page's (create-account/page.tsx).
  it('is one form, a username ahead of a new password', () => {
    render(<CreateAccountForm />);

    const username = usernameField();
    const password = passwordField();
    expect(username.autocomplete).toBe('username');
    expect(password.autocomplete).toBe('new-password');
    expect(password.type).toBe('password');
    expect(username.form).toBe(password.form);
    expect(submitButton().getAttribute('type')).toBe('submit');
    expect(username.compareDocumentPosition(password) & Node.DOCUMENT_POSITION_FOLLOWING).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );
    // Exactly one secret field: nothing else for a manager to mistake for it.
    expect(document.querySelectorAll('input[type="password"]')).toHaveLength(1);
  });

  it('shows the whole password under the field while revealed', () => {
    render(<CreateAccountForm />);
    const words = passwordField().value;

    fireEvent.click(screen.getByRole('button', { name: 'Show password' }));

    expect(passwordField().type).toBe('text');
    expect(screen.getAllByText(words).length).toBeGreaterThan(0);
  });
});
