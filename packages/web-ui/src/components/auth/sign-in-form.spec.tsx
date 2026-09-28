import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';

import {
  InvalidCredentialsError,
  InvalidRecoveryCodeError,
  useSignIn,
  useSignInWithRecovery,
} from '@stxapps/web-react';

import { SignInForm } from './sign-in-form';

// Both doors into an account, in one component. What is worth pinning here is not
// the happy path — that is the one thing a person exercises constantly — but the
// three rules around FAILURE, each of which is silent when it breaks:
//
//   1. A credential failure ANNOUNCES. It arrives as the result of a click with
//      nothing else changing on screen, so without `role="alert"` (FieldError) a
//      screen-reader user gets a button that silently re-enables. It was missed at
//      a comparable share of sites on web before the carriers existed
//      (docs/accessibility.md).
//   2. It CLEARS when the user edits. The failure is a submit-level `root` error,
//      which react-hook-form's onChange re-validation never touches — so it has to
//      be dropped by hand, or "Incorrect username or password" sits under a
//      corrected field claiming the correction is wrong.
//   3. The recovery submit is NEVER disabled on empty input. Everyone who reaches
//      that screen has already lost their password, and a disabled button is
//      silent in every channel at once: `pointer-events-none` kills hover, the
//      attribute drops it from the tab order, and nothing is announced. Empty
//      input submits and answers per field instead (docs/account.md, _when a
//      submit is allowed to be `disabled`_).
//
// Only `@stxapps/web-react` is mocked — the mutations reach a real API and a real
// key derivation. The form itself is the real react-hook-form + zod resolver from
// `@stxapps/react`, because rules 2 and 3 are ABOUT that wiring.

jest.mock('@stxapps/web-react', () => {
  class InvalidCredentialsError extends Error {}
  class InvalidRecoveryCodeError extends Error {}
  return {
    InvalidCredentialsError,
    InvalidRecoveryCodeError,
    useSignIn: jest.fn(),
    useSignInWithRecovery: jest.fn(),
  };
});

const mutation = (mutateAsync: jest.Mock) => ({ mutateAsync, isPending: false });

let signIn: jest.Mock;
let recoverySignIn: jest.Mock;

beforeEach(() => {
  signIn = jest.fn().mockResolvedValue(undefined);
  recoverySignIn = jest.fn().mockResolvedValue(undefined);
  (useSignIn as jest.Mock).mockReturnValue(mutation(signIn));
  (useSignInWithRecovery as jest.Mock).mockReturnValue(mutation(recoverySignIn));
});

const fill = (label: string, value: string) =>
  fireEvent.change(screen.getByLabelText(label), { target: { value } });

const submit = async (name: RegExp) => {
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name }));
  });
};

const useRecoveryDoor = () =>
  fireEvent.click(screen.getByRole('button', { name: /Forgot your password/ }));

describe('SignInForm — the password door', () => {
  it('submits what was typed', async () => {
    render(<SignInForm />);
    fill('Username', 'wit');
    fill('Password', 'a-very-long-passphrase');

    await submit(/^Sign in$/);

    expect(signIn).toHaveBeenCalledWith({ username: 'wit', password: 'a-very-long-passphrase' });
  });

  it('announces a credential failure', async () => {
    signIn.mockRejectedValue(new InvalidCredentialsError());
    render(<SignInForm />);
    fill('Username', 'wit');
    fill('Password', 'a-very-long-passphrase');

    await submit(/^Sign in$/);

    await waitFor(() =>
      expect(screen.getByRole('alert').textContent).toBe('Incorrect username or password'),
    );
  });

  // A failure that is NOT a credential failure must not be reported as one:
  // telling someone their password is wrong when the request never landed sends
  // them to the recovery door for nothing, and there is no reset behind it.
  it('distinguishes a transport failure from a wrong password', async () => {
    signIn.mockRejectedValue(new Error('network'));
    render(<SignInForm />);
    fill('Username', 'wit');
    fill('Password', 'a-very-long-passphrase');

    await submit(/^Sign in$/);

    await waitFor(() =>
      expect(screen.getByRole('alert').textContent).toBe('Could not sign in. Please try again.'),
    );
  });

  it.each(['Username', 'Password'])('clears the failure when %s is edited', async (field) => {
    signIn.mockRejectedValue(new InvalidCredentialsError());
    render(<SignInForm />);
    fill('Username', 'wit');
    fill('Password', 'a-very-long-passphrase');
    await submit(/^Sign in$/);
    await waitFor(() => expect(screen.queryByRole('alert')).not.toBeNull());

    act(() => void fill(field, 'edited-value-long-enough'));

    expect(screen.queryByRole('alert')).toBeNull();
  });

  // The button is `disabled` while a request is in flight, which is
  // `pointer-events-none` and out of the tab order — it announces nothing on its
  // own. The label is the only signal that anything is happening.
  it('says it is working while a sign-in is in flight', async () => {
    (useSignIn as jest.Mock).mockReturnValue({
      mutateAsync: jest.fn(() => new Promise<never>(() => undefined)),
      isPending: true,
    });
    render(<SignInForm />);
    fill('Username', 'wit');
    fill('Password', 'a-very-long-passphrase');

    act(() => void fireEvent.click(screen.getByRole('button', { name: /^Sign in$/ })));

    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Signing in…' }).hasAttribute('disabled')).toBe(
        true,
      ),
    );
  });
});

describe('SignInForm — the recovery door', () => {
  it('swaps doors without leaving the page', () => {
    render(<SignInForm />);

    useRecoveryDoor();

    expect(screen.getByLabelText('Recovery code')).not.toBeNull();
    expect(screen.queryByLabelText('Password')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: /Use your password instead/ }));
    expect(screen.getByLabelText('Password')).not.toBeNull();
  });

  // RULE 3. This screen is reached by people who have already lost their
  // password; handing them a dead button with no explanation is the worst
  // available outcome, and it is what a `disabled={!username || !code}` produces.
  it('offers a live submit on empty input, and answers per field', async () => {
    render(<SignInForm />);
    useRecoveryDoor();

    const button = screen.getByRole('button', { name: /Sign in with recovery code/ });
    expect(button.hasAttribute('disabled')).toBe(false);

    await submit(/Sign in with recovery code/);

    // Every announced message the schema produced — not a silent no-op.
    await waitFor(() => expect(screen.getAllByRole('alert').length).toBeGreaterThan(0));
    expect(recoverySignIn).not.toHaveBeenCalled();
  });

  it('announces a rejected recovery code, and clears it on an edit', async () => {
    recoverySignIn.mockRejectedValue(new InvalidRecoveryCodeError());
    render(<SignInForm />);
    useRecoveryDoor();
    fill('Username', 'wit');
    fill('Recovery code', 'ABCD-EFGH-IJKL-MNOP');

    await submit(/Sign in with recovery code/);
    await waitFor(() =>
      expect(screen.getAllByRole('alert').map((el) => el.textContent)).toContain(
        'That recovery code didn’t work. Check it and try again.',
      ),
    );

    act(() => void fill('Recovery code', 'ABCD-EFGH-IJKL-MNOQ'));

    expect(screen.queryByRole('alert')).toBeNull();
  });
});

// The expired state's resume (docs/sessions.md): a normal sign-in, but only as the
// account whose library is on this device. The username is pre-filled and read-only —
// still focusable and announced, and still submitted — on both doors.
describe('SignInForm — resuming a locked username', () => {
  it('submits the stored username with the password, and will not take another', async () => {
    render(<SignInForm lockedUsername="alice" />);
    const username = screen.getByLabelText('Username') as HTMLInputElement;

    expect(username.value).toBe('alice');
    expect(username.readOnly).toBe(true);
    expect(username.disabled).toBe(false);

    fill('Password', 'a-very-long-passphrase');
    await submit(/^Sign in$/);

    expect(signIn).toHaveBeenCalledWith({ username: 'alice', password: 'a-very-long-passphrase' });
  });

  it('keeps the username locked through the recovery door', async () => {
    render(<SignInForm lockedUsername="alice" />);
    useRecoveryDoor();

    const username = screen.getByLabelText('Username') as HTMLInputElement;
    expect(username.value).toBe('alice');
    expect(username.readOnly).toBe(true);
  });
});
