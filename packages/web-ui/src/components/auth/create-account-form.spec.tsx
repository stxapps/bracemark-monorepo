import { act, fireEvent, render, screen } from '@testing-library/react';

import { NEW_PASSWORD_COPY, RECOVERY_CODE_COPY, useUsernameAvailable } from '@stxapps/react';
import { useCreateAccount, UsernameTakenError } from '@stxapps/web-react';

import { installJsdomStubs } from '../../testing/jsdom-stubs';
import { CreateAccountForm } from './create-account-form';

// THREE RULES THE CEREMONY KEEPS NOWHERE ELSE. Almost nothing in this form is
// worth this layer: the gate is `useNewPassword` (new-password-field.spec.tsx),
// the two message ladders are `@stxapps/react`'s (lib/field-messages.spec.ts),
// the announced errors are `FieldError`'s (ui/field.spec.tsx), and the happy path
// through all three steps runs on EVERY e2e worker — `e2e/web/fixtures/account.ts`
// drives the real ceremony, through both exits, before a single spec in that suite
// starts. A render-and-click spec over `canContinueSetup` or the "Step n of 3"
// counter would restate the code.
//
// What is left is the part the fixture structurally cannot reach, because it types
// the same string twice and always gets a fresh username:
//
//   1. the confirm step compares CANONICAL forms, not raw ones;
//   2. `UsernameTakenError` goes back to step ONE, not to the generic error;
//   3. Regenerate clears the saved-it attestation.
//
// Each is silent: no lint error, no type error, and the fixture stays green
// through every wrong version of all three.
//
// Everything real except the two edges that leave the component: the account
// mutation (real key derivation, real API) and the availability query (needs a
// QueryClient and an api client, and its own ladder is pinned one layer down).
// `usePasswordStrength` is stubbed for cost, not for behaviour — this spec takes
// the GENERATED path, where the estimator is handed the empty string and answers
// nothing, so the real one would dynamically import ~1.7 MB of dictionary per
// mount to say `null`. The typed path it actually serves is covered beside this.

jest.mock('@stxapps/react', () => ({
  ...jest.requireActual('@stxapps/react'),
  useUsernameAvailable: jest.fn(),
}));

jest.mock('@stxapps/web-react', () => {
  class UsernameTakenError extends Error {}
  return { UsernameTakenError, useCreateAccount: jest.fn() };
});

jest.mock('@stxapps/web-ui/components/auth/password-strength', () => ({
  ...jest.requireActual('@stxapps/web-ui/components/auth/password-strength'),
  usePasswordStrength: () => ({
    guessesLog10: null,
    displayScore: null,
    ready: true,
    failed: false,
  }),
}));

const USERNAME = 'wit_e2e';

let createAccount: jest.Mock;

beforeAll(() => {
  // Radix's Checkbox is the attestation control on two of the three steps.
  installJsdomStubs();
});

beforeEach(() => {
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
const continueButton = () => screen.getByRole('button', { name: /^Continue$/ });
const attestation = () => screen.getByRole('checkbox');
const secret = (label: string) => screen.getByLabelText(label).textContent ?? '';

/**
 * Steps 1 and 2 — username, the generated passphrase, and the re-entry — leaving
 * the form on step 3. Returns the passphrase, which is minted on mount and so is
 * only knowable by reading it off the panel, exactly as the user does.
 * `reenter` shapes what gets typed into the confirm field; the default retypes it.
 */
function fillCredentialSteps(reenter: (passphrase: string) => string = (p) => p) {
  fireEvent.change(screen.getByLabelText('Username'), { target: { value: USERNAME } });
  fireEvent.click(attestation());

  const passphrase = secret(NEW_PASSWORD_COPY.create.secretLabel);
  fireEvent.click(continueButton());

  fireEvent.change(screen.getByLabelText('Confirm your password'), {
    target: { value: reenter(passphrase) },
  });
  fireEvent.click(continueButton());

  return passphrase;
}

describe('CreateAccountForm — the confirm step', () => {
  // THE RULE. Derivation canonicalizes (trim + NFC, crypto/params.ts) before it
  // ever reaches Argon2id, so a re-entry that differs only in what canonicalization
  // strips derives the SAME KEK and would sign in fine. Compare the raw strings
  // here and that password becomes uncreatable: the user is held at step 2 by a
  // form telling them they mistyped a password they did not mistype, and pasting
  // it back out of the password manager that added the space reproduces it every
  // time. The e2e fixture types one known string into both fields, so it passes
  // against a raw `!==`.
  it('accepts a re-entry differing only by what derivation strips', () => {
    render(<CreateAccountForm />);

    fillCredentialSteps((passphrase) => `  ${passphrase}  `);

    expect(heading(RECOVERY_CODE_COPY.title)).not.toBeNull();
  });

  // The other direction, or the assertion above would also pass on a form that
  // never compared anything at all.
  it('still rejects a re-entry that is genuinely different', () => {
    render(<CreateAccountForm />);

    fillCredentialSteps((passphrase) => `${passphrase}x`);

    expect(heading(RECOVERY_CODE_COPY.title)).toBeNull();
    expect(heading('Confirm your password')).not.toBeNull();
    expect(screen.getByRole('alert').textContent).toMatch(/doesn’t match/);
  });

  // The username's own input unmounted with step one, and on the generated path
  // this step's field is the only password input the ceremony ever renders — so
  // it is the one a password manager saves from, and with nothing beside it the
  // saved login has no username. Nothing reports that: the account is created,
  // sign-in works, and the evidence is a nameless entry in one person's browser.
  // The field has to be a TEXT input (`type="hidden"` is skipped), carrying the
  // name the account is created under, ahead of the password in the document.
  it('names the account to a password manager beside the only password field', () => {
    render(<CreateAccountForm />);

    fireEvent.change(screen.getByLabelText('Username'), { target: { value: ' Wit_E2E ' } });
    fireEvent.click(attestation());
    fireEvent.click(continueButton());

    const named = document.querySelector<HTMLInputElement>('input[autocomplete="username"]');
    const password = screen.getByLabelText('Confirm your password');

    expect(named).not.toBeNull();
    expect(named?.type).toBe('text');
    expect(named?.value).toBe(USERNAME);
    expect(
      named && named.compareDocumentPosition(password) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });
});

describe('CreateAccountForm — a username taken at the last moment', () => {
  // The availability check is debounced and advisory; the authoritative answer is
  // the server's, at creation — two steps after the field that can fix it. So this
  // failure has to navigate BACKWARDS, and it is the only one that does. Let it
  // fall into the generic branch instead and the user is stranded on step 3 with
  // "Could not create account. Please try again." over a problem they cannot see,
  // and every retry fails identically. Unreachable from e2e, which mints a random
  // username per worker and never collides.
  it('returns to step one and names the field that has to change', async () => {
    createAccount.mockRejectedValue(new UsernameTakenError('taken'));
    render(<CreateAccountForm />);
    fillCredentialSteps();

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /without a recovery code/i }));
    });

    expect(heading('Create account')).not.toBeNull();
    expect(screen.getByText('Username is taken')).not.toBeNull();
  });

  // The contrast that makes the above a claim about the BRANCH rather than about
  // errors in general: everything else stays where the retry is. Bouncing an
  // offline blip back to step one would discard a confirmed password and a saved
  // recovery code to re-ask a question that was never the problem.
  it('keeps every other failure on the step that has the retry', async () => {
    createAccount.mockRejectedValue(new Error('offline'));
    render(<CreateAccountForm />);
    fillCredentialSteps();

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /without a recovery code/i }));
    });

    expect(heading(RECOVERY_CODE_COPY.title)).not.toBeNull();
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
    const passphrase = fillCredentialSteps();

    const first = secret(RECOVERY_CODE_COPY.secretLabel);
    fireEvent.click(attestation());
    const create = screen.getByRole('button', { name: /^Create account$/ }) as HTMLButtonElement;
    expect(create.disabled).toBe(false);

    fireEvent.click(screen.getByRole('button', { name: /Regenerate/ }));

    const second = secret(RECOVERY_CODE_COPY.secretLabel);
    expect(second).not.toBe(first);
    expect(create.disabled).toBe(true);

    // And the reset is load-bearing precisely because the NEW code is what gets
    // submitted — asserted at the wire, since that is the half the user can't see.
    fireEvent.click(attestation());
    fireEvent.click(create);

    expect(createAccount).toHaveBeenCalledWith({
      username: USERNAME,
      password: passphrase,
      recoveryCode: second,
    });
  });
});
