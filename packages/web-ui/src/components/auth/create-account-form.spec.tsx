import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';

import { CREATE_ACCOUNT_COPY, RECOVERY_CODE_COPY, useUsernameAvailable } from '@stxapps/react';
import { useCreateAccount, UsernameTakenError } from '@stxapps/web-react';

import { installJsdomStubs } from '../../testing/jsdom-stubs';
import { CreateAccountForm } from './create-account-form';

// THE RULES THE CEREMONY KEEPS NOWHERE ELSE. Almost nothing in this form is worth this
// layer: the two message ladders are `@stxapps/react`'s (lib/field-messages.spec.ts),
// the announced errors are `FieldError`'s (ui/field.spec.tsx), and the happy path
// through all three steps runs on EVERY e2e worker — `e2e/web/fixtures/account.ts`
// drives the real ceremony, through both exits, before a single spec in that suite
// starts. A render-and-click spec over `canContinueSetup` or the "Step n of 3"
// counter would restate the code.
//
// What is left is the part the fixture structurally cannot reach, because it types
// the same string twice and always gets a fresh username:
//
//   1. the check compares CANONICAL forms, not raw ones;
//   2. nothing is created until the check passes;
//   3. the two labels Safari reads as a login, and the shape of that form;
//   4. a password the BROWSER filled is adopted, and a typed one never is;
//   5. `UsernameTakenError` goes back to step ONE, not to the generic error;
//   6. Regenerate clears the saved-it attestation.
//
// Each is silent: no lint error, no type error, and the fixture stays green
// through every wrong version of them.
//
// Everything real except the two edges that leave the component: the account
// mutation (real key derivation, real API) and the availability query (needs a
// QueryClient and an api client, and its own ladder is pinned one layer down).
// `usePasswordStrength` is stubbed for cost, not for behaviour — the words are never
// scored, so the real one would dynamically import ~1.7 MB of dictionary per mount to
// say `null`. `mockGuessesLog10` answers for any value that does get scored.

jest.mock('@stxapps/react', () => ({
  ...jest.requireActual('@stxapps/react'),
  useUsernameAvailable: jest.fn(),
}));

jest.mock('@stxapps/web-react', () => {
  class UsernameTakenError extends Error {}
  return { UsernameTakenError, useCreateAccount: jest.fn() };
});

let mockGuessesLog10: number | null = null;

jest.mock('@stxapps/web-ui/components/auth/password-strength', () => ({
  ...jest.requireActual('@stxapps/web-ui/components/auth/password-strength'),
  usePasswordStrength: () => ({
    guessesLog10: mockGuessesLog10,
    displayScore: null,
    ready: true,
    failed: false,
  }),
}));

const USERNAME = 'wit_e2e';
const STRONG = 'x7Kq2mVn9Rt4Lw8Zp3Hy6Bf1';

let createAccount: jest.Mock;

beforeAll(() => {
  // Radix's Checkbox is the attestation control on the recovery step.
  installJsdomStubs();
});

beforeEach(() => {
  mockGuessesLog10 = 30;
  createAccount = jest.fn().mockResolvedValue(undefined);
  (useCreateAccount as jest.Mock).mockReturnValue({ mutateAsync: createAccount, isPending: false });
  // A settled, CURRENT "free" answer — the only shape `usernameMessage` opens the
  // gate on. Every other rung of that ladder is pinned in field-messages.spec.ts.
  (useUsernameAvailable as jest.Mock).mockReturnValue({
    data: { available: true },
    isFetching: false,
    isError: false,
    current: true,
  });
});

const heading = (name: string) => screen.queryByRole('heading', { name });
const button = (name: string | RegExp) => screen.getByRole('button', { name });
const continueButton = () => button(/^Continue$/);
const finishButton = () => button(CREATE_ACCOUNT_COPY.signIn);
const skipRecovery = () => button(CREATE_ACCOUNT_COPY.continueWithoutRecovery);
const passwordField = () => document.querySelector<HTMLInputElement>('#password');
const secret = (label: string) => screen.getByLabelText(label).textContent ?? '';

const newPasswordField = () =>
  screen.getByLabelText(CREATE_ACCOUNT_COPY.passwordLabel) as HTMLInputElement;

/** Step 1: returns what the field holds, which is minted on mount. */
function fillSetup() {
  fireEvent.change(screen.getByLabelText('Username'), { target: { value: USERNAME } });
  const password = newPasswordField().value;
  fireEvent.click(continueButton());
  return password;
}

/** Steps 1 and 2, leaving the form on the check. */
function reachCheck() {
  const password = fillSetup();
  fireEvent.click(skipRecovery());
  return password;
}

const enter = (value: string) => {
  const field = passwordField();
  if (!field) throw new Error('not on the check step');
  fireEvent.change(field, { target: { value } });
};

// What `:autofill` answers on the check field, said on the browser's behalf: jsdom
// has no opinion worth trusting. Only that selector, because Testing Library calls
// `matches` too. `answer` throwing is an engine that has never heard of it.
function browserFilled(field: HTMLInputElement | null, answer: () => boolean = () => true) {
  if (!field) throw new Error('not on the check step');
  const real = field.matches.bind(field);
  field.matches = (selector: string) => (selector === ':autofill' ? answer() : real(selector));
}

describe('CreateAccountForm — the check', () => {
  // THE RULE. Derivation canonicalizes (trim + NFC, crypto/params.ts) before it
  // ever reaches Argon2id, so a re-entry that differs only in what canonicalization
  // strips derives the SAME KEK and would sign in fine. Compare the raw strings
  // here and that password becomes uncreatable: the user is held on the last step by
  // a form telling them they mistyped a password they did not mistype, and pasting
  // it back out of the password manager that added the space reproduces it every
  // time. The e2e fixture types one known string into both fields, so it passes
  // against a raw `!==`.
  it('accepts a re-entry differing only by what derivation strips', async () => {
    render(<CreateAccountForm />);
    const password = reachCheck();

    enter(`  ${password}  `);
    fireEvent.click(finishButton());

    expect(createAccount).toHaveBeenCalledTimes(1);
  });

  // The other direction, or the assertion above would also pass on a form that
  // never compared anything at all. It is also rule 2: the check passing is the only
  // thing that creates an account, which is what lets Back undo everything and a
  // closed tab strand no username.
  it('creates nothing on a re-entry that is genuinely different', () => {
    render(<CreateAccountForm />);
    const password = reachCheck();

    enter(`${password}x`);
    browserFilled(passwordField(), () => false);
    fireEvent.click(finishButton());

    expect(createAccount).not.toHaveBeenCalled();
    expect(heading(CREATE_ACCOUNT_COPY.heading.check.title)).not.toBeNull();
    expect(screen.getByRole('alert').textContent).toBe(CREATE_ACCOUNT_COPY.mismatch);
  });

  // Nothing entered is not a mismatch, and saying "doesn't match" sends someone to
  // check a saved copy they have not typed yet. Spaces count as nothing, because
  // derivation trims them.
  it.each(['', '   '])('asks for a password, rather than a match, on %j', (entry) => {
    render(<CreateAccountForm />);
    reachCheck();

    enter(entry);
    fireEvent.click(finishButton());

    expect(createAccount).not.toHaveBeenCalled();
    expect(screen.getByRole('alert').textContent).toBe(CREATE_ACCOUNT_COPY.empty);
  });

  it('reveals the password on request, for whoever did not save it', () => {
    render(<CreateAccountForm />);
    const password = reachCheck();

    expect(screen.queryByLabelText(CREATE_ACCOUNT_COPY.shownPasswordLabel)).toBeNull();
    fireEvent.click(button(CREATE_ACCOUNT_COPY.showPassword));

    expect(secret(CREATE_ACCOUNT_COPY.shownPasswordLabel)).toBe(password);
  });
});

describe('CreateAccountForm — what Safari reads as a login', () => {
  // ⚠ The strings ARE the behaviour. Safari decides sign-up against login from words
  // on the page, and on the real browser it takes both of these: reword either and
  // "Use Strong Password" is back on a field that has to match, on one browser, with
  // everything else green. "Show my password again" sounds like the same control and
  // was measured failing. Changing either means re-measuring in real Safari
  // (docs/account.md, _how safari tells a login from a sign-up_), so this fails on
  // purpose rather than following the copy.
  it('keeps the two labels the classification depends on', () => {
    render(<CreateAccountForm />);
    reachCheck();

    expect(screen.getByRole('button', { name: 'Sign in to finish' })).not.toBeNull();
    expect(
      screen.getByRole('button', { name: 'Forgot your password? Show it again' }),
    ).not.toBeNull();
  });

  // The rest of what a login is, to a manager reading the document: one form holding
  // a named username ahead of a `current-password`, with a real submit. A manager
  // reads a login as a pair, and this is the form it saves from.
  it('is one form, a visible username ahead of a current password', () => {
    render(<CreateAccountForm />);
    reachCheck();

    const username = screen.getByLabelText('Username') as HTMLInputElement;
    const password = passwordField();

    expect(username.value).toBe(USERNAME);
    expect(username.readOnly).toBe(true);
    expect(username.autocomplete).toBe('username');
    expect(password?.autocomplete).toBe('current-password');
    expect(password && username.form === password.form).toBe(true);
    expect(finishButton().getAttribute('type')).toBe('submit');
    expect(
      password && username.compareDocumentPosition(password) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });
});

describe('CreateAccountForm — a password the browser filled', () => {
  // THE SAFETY NET. Safari has already saved what it filled, so finishing with the
  // other password would leave a saved copy that can never sign in, on an account with
  // no reset. The specimen is real: Safari's own password refused here, then a Not Now
  // on its update prompt. What matters is what reaches the wire.
  it('creates the account with what the browser holds', async () => {
    render(<CreateAccountForm />);
    reachCheck();

    enter(STRONG);
    browserFilled(passwordField());
    fireEvent.click(finishButton());

    expect(createAccount).not.toHaveBeenCalled();
    expect(screen.getByRole('alert').textContent).toBe(CREATE_ACCOUNT_COPY.offeredPassword);

    fireEvent.click(button(CREATE_ACCOUNT_COPY.useOfferedPassword));

    await waitFor(() =>
      expect(createAccount).toHaveBeenCalledWith({
        username: USERNAME,
        password: STRONG,
        recoveryCode: undefined,
      }),
    );
  });

  // The check's whole value: a TYPO must never be offered as the new password, or the
  // form would let someone adopt the mistake it exists to catch.
  it('never offers that for a value the user typed', () => {
    render(<CreateAccountForm />);
    reachCheck();

    enter(STRONG);
    browserFilled(passwordField(), () => false);
    fireEvent.click(finishButton());

    expect(
      screen.queryByRole('button', { name: CREATE_ACCOUNT_COPY.useOfferedPassword }),
    ).toBeNull();
  });

  // An engine without the selector throws on it. The form must still answer.
  it('falls back to the plain mismatch where the selector does not exist', () => {
    render(<CreateAccountForm />);
    reachCheck();

    enter(STRONG);
    browserFilled(passwordField(), () => {
      throw new SyntaxError('unknown selector');
    });
    fireEvent.click(finishButton());

    expect(screen.getByRole('alert').textContent).toBe(CREATE_ACCOUNT_COPY.mismatch);
  });

  // Adopting goes through step one's gate, not around it: an older save of this
  // username is not known to be strong.
  it('holds an adopted password to the same floor', async () => {
    render(<CreateAccountForm />);
    reachCheck();

    mockGuessesLog10 = 1;
    enter(STRONG);
    browserFilled(passwordField());
    fireEvent.click(finishButton());
    fireEvent.click(button(CREATE_ACCOUNT_COPY.useOfferedPassword));

    await waitFor(() => expect(screen.getByRole('alert').textContent).not.toBe(''));
    expect(createAccount).not.toHaveBeenCalled();
  });
});

describe('CreateAccountForm — a username taken at the last moment', () => {
  // The availability check is debounced and advisory; the authoritative answer is
  // the server's, at creation — two steps after the field that can fix it. So this
  // failure has to navigate BACKWARDS, and it is the only one that does. Let it
  // fall into the generic branch instead and the user is stranded on the last step
  // with "Could not create account. Please try again." over a problem they cannot
  // see, and every retry fails identically. Unreachable from e2e, which mints a
  // random username per worker and never collides.
  it('returns to step one and names the field that has to change', async () => {
    createAccount.mockRejectedValue(new UsernameTakenError('taken'));
    render(<CreateAccountForm />);
    const password = reachCheck();

    enter(password);
    await act(async () => {
      fireEvent.click(finishButton());
    });

    expect(heading(CREATE_ACCOUNT_COPY.heading.setup.title)).not.toBeNull();
    expect(screen.getByText('Username is taken')).not.toBeNull();
    // Nothing the user has already done is lost on the way back.
    expect(newPasswordField().value).toBe(password);
  });

  // The contrast that makes the above a claim about the BRANCH rather than about
  // errors in general: everything else stays where the retry is. Bouncing an
  // offline blip back to step one would re-ask a question that was never the problem.
  it('keeps every other failure on the step that has the retry', async () => {
    createAccount.mockRejectedValue(new Error('offline'));
    render(<CreateAccountForm />);
    const password = reachCheck();

    enter(password);
    await act(async () => {
      fireEvent.click(finishButton());
    });

    expect(heading(CREATE_ACCOUNT_COPY.heading.check.title)).not.toBeNull();
    expect(screen.getByRole('alert').textContent).toMatch(/Could not create account/);
  });
});

describe('CreateAccountForm — the recovery step', () => {
  // `recoverySaved` is an attestation about the code ON SCREEN, and Regenerate
  // replaces that code. Without the reset the primary stays enabled over a string
  // the user has never seen, and the account is created — irreversibly, since this
  // ceremony is the only moment the code exists in a saveable form — with its one
  // second door set to something nobody wrote down. e2e never clicks Regenerate.
  it('re-shuts the gate when the code the user attested to is replaced', () => {
    render(<CreateAccountForm />);
    const password = fillSetup();

    const first = secret(RECOVERY_CODE_COPY.secretLabel);
    fireEvent.click(screen.getByRole('checkbox'));
    const next = continueButton() as HTMLButtonElement;
    expect(next.disabled).toBe(false);

    fireEvent.click(button(/Regenerate/));

    const second = secret(RECOVERY_CODE_COPY.secretLabel);
    expect(second).not.toBe(first);
    expect(next.disabled).toBe(true);

    // And the reset is load-bearing precisely because the NEW code is what gets
    // submitted — asserted at the wire, since that is the half the user can't see.
    fireEvent.click(screen.getByRole('checkbox'));
    fireEvent.click(next);
    enter(password);
    fireEvent.click(finishButton());

    expect(createAccount).toHaveBeenCalledWith({
      username: USERNAME,
      password,
      recoveryCode: second,
    });
  });

  it('sends no recovery code down the way that declines one', () => {
    render(<CreateAccountForm />);
    const password = reachCheck();

    enter(password);
    fireEvent.click(finishButton());

    expect(createAccount).toHaveBeenCalledWith({
      username: USERNAME,
      password,
      recoveryCode: undefined,
    });
  });
});
