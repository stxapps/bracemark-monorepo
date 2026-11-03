import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';

import {
  beginWelcome,
  CREATE_ACCOUNT_COPY,
  endWelcome,
  RECOVERY_CODE_COPY,
  useWelcome,
  WELCOME_COPY,
} from '@stxapps/react';

import { WelcomeGate } from './welcome-gate';

// THE WELCOME'S CONTRACT (docs/account.md, _the welcome_), none of which any other
// layer reaches: e2e drives the happy path, and nothing else runs this file at all.
//
//   1. it covers the app only for the account it was begun for, and ending it
//      uncovers the app;
//   2. the recovery code is minted with the HELD password — nothing to type — and
//      skipping mints nothing;
//   3. the check is a local compare of canonical forms, empty is not a mismatch, and
//      the two labels Safari reads as a login are pinned;
//   4. a password the BROWSER filled is offered as the account's new one, through a
//      real password change behind the strength floor, and a typed one never is;
//   5. Import ends the welcome and goes to Settings → Data.

const mockPush = jest.fn();
jest.mock('next/navigation', () => ({ useRouter: () => ({ push: mockPush }) }));

const mockMintRecovery = jest.fn();
const mockChangePassword = jest.fn();
let mockUsername: string | null = 'wit_e2e';
jest.mock('@stxapps/web-react', () => ({
  useAuth: () => ({ username: mockUsername }),
  useRecoveryCode: () => ({ mutateAsync: mockMintRecovery, isPending: false }),
  useChangePassword: () => ({ mutateAsync: mockChangePassword, isPending: false }),
}));

const mockSetQueryData = jest.fn();
jest.mock('@tanstack/react-query', () => ({
  useQueryClient: () => ({ setQueryData: mockSetQueryData, invalidateQueries: jest.fn() }),
}));

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

const USERNAME = 'wit_e2e';
const PASSWORD = 'mango-tunnel-violin-orbit-shy-lemon-quest';
// Safari's own format: three groups of six, 20 characters.
const SAFARI = 'Xq7mLp-2vRt9w-Kd4zPa';

beforeEach(() => {
  mockUsername = USERNAME;
  mockGuessesLog10 = 30;
  mockPush.mockReset();
  mockSetQueryData.mockReset();
  mockMintRecovery.mockReset().mockResolvedValue({ recoveryCode: 'ABCDE-FGHIJ-KLMNO' });
  mockChangePassword.mockReset().mockResolvedValue(undefined);
  act(() => beginWelcome({ username: USERNAME, password: PASSWORD }));
});

afterEach(() => {
  act(() => endWelcome());
});

const button = (name: string | RegExp) => screen.getByRole('button', { name });
const heading = () => screen.getByRole('heading', { level: 1 }).textContent;
const checkField = () => document.querySelector<HTMLInputElement>('#welcome-password');

function renderGate() {
  return render(
    <WelcomeGate>
      <p>the app</p>
    </WelcomeGate>,
  );
}

async function toCheck() {
  renderGate();
  fireEvent.click(button(WELCOME_COPY.skipRecovery));
  await screen.findByRole('button', { name: WELCOME_COPY.signIn });
}

const enter = (value: string) => {
  const field = checkField();
  if (!field) throw new Error('not on the check');
  fireEvent.change(field, { target: { value } });
};

const pressSignIn = () => fireEvent.click(button(WELCOME_COPY.signIn));

// What `:autofill` answers on the check field, said on the browser's behalf: jsdom's
// own answer is not one to trust (it says yes). Only that selector, because Testing
// Library calls `matches` too.
function filled(answer: boolean) {
  const field = checkField();
  if (!field) throw new Error('not on the check');
  const real = field.matches.bind(field);
  field.matches = (selector: string) => (selector === ':autofill' ? answer : real(selector));
}
const browserFilled = () => filled(true);
const typedByHand = () => filled(false);

describe('WelcomeGate — whose welcome', () => {
  it('covers the app for the account just made', () => {
    renderGate();
    expect(screen.queryByText('the app')).toBeNull();
    expect(heading()).toBe(WELCOME_COPY.heading.recovery.title);
  });

  it('never covers another account', () => {
    mockUsername = 'someone_else';
    renderGate();
    expect(screen.getByText('the app')).toBeTruthy();
  });

  it('uncovers the app once it ends', () => {
    renderGate();
    act(() => endWelcome());
    expect(screen.getByText('the app')).toBeTruthy();
  });
});

describe('WelcomeGate — the recovery code', () => {
  it('mints with the held password, shows the code, and records that one exists', async () => {
    renderGate();

    await act(async () => {
      fireEvent.click(button(WELCOME_COPY.createRecovery));
    });

    expect(mockMintRecovery).toHaveBeenCalledWith({
      proof: { kind: 'password', currentPassword: PASSWORD },
    });
    expect(screen.getByLabelText(RECOVERY_CODE_COPY.secretLabel).textContent).toBe(
      'ABCDE-FGHIJ-KLMNO',
    );
    expect(mockSetQueryData).toHaveBeenCalledWith(['recovery-door-exists', USERNAME], true);
    // No checkbox: the code is live already.
    expect(screen.queryByRole('checkbox')).toBeNull();

    fireEvent.click(button(WELCOME_COPY.continue));
    expect(heading()).toBe(WELCOME_COPY.heading.check.title);
  });

  it('mints nothing on Skip', () => {
    renderGate();
    fireEvent.click(button(WELCOME_COPY.skipRecovery));
    expect(mockMintRecovery).not.toHaveBeenCalled();
    expect(heading()).toBe(WELCOME_COPY.heading.check.title);
  });

  it('says a failed mint, and stays to retry or skip', async () => {
    mockMintRecovery.mockRejectedValue(new Error('offline'));
    renderGate();
    await act(async () => {
      fireEvent.click(button(WELCOME_COPY.createRecovery));
    });
    expect(screen.getByRole('alert').textContent).toBe(WELCOME_COPY.recoveryFailed);
    expect(button(WELCOME_COPY.skipRecovery)).toBeTruthy();
  });
});

describe('WelcomeGate — the check', () => {
  it('passes a re-entry that differs only by what derivation strips', async () => {
    await toCheck();
    enter(`  ${PASSWORD} `);
    pressSignIn();
    expect(screen.getByRole('status').textContent).toBe(WELCOME_COPY.passed);
  });

  it.each(['', '   '])('asks for a password, not a match, on %j', async (entry) => {
    await toCheck();
    enter(entry);
    pressSignIn();
    expect(screen.getByRole('alert').textContent).toBe(WELCOME_COPY.empty);
  });

  it('refuses a typed mismatch, and never offers it as the password', async () => {
    await toCheck();
    enter(`${PASSWORD}x`);
    typedByHand();
    pressSignIn();
    expect(screen.getByRole('alert').textContent).toBe(WELCOME_COPY.mismatch);
    expect(screen.queryByRole('button', { name: WELCOME_COPY.useOfferedPassword })).toBeNull();
  });

  it('shows the held password again, for whoever did not save it', async () => {
    await toCheck();
    fireEvent.click(button(WELCOME_COPY.showPassword));
    expect(screen.getByLabelText(CREATE_ACCOUNT_COPY.shownPasswordLabel).textContent).toBe(
      PASSWORD,
    );
  });

  // ⚠ The strings ARE the behaviour: Safari reads "Sign in" + "Forgot your password?"
  // as a login, and anything else as a sign-up whose strong password it saves over the
  // real one (docs/account.md, _how safari tells a login from a sign-up_).
  it('keeps the two labels Safari reads as a login, on a username + current-password form', async () => {
    await toCheck();
    expect(button('Sign in to check')).toBeTruthy();
    expect(button('Forgot your password? Show it again')).toBeTruthy();
    const username = screen.getByLabelText('Username') as HTMLInputElement;
    const password = checkField();
    expect(username.value).toBe(USERNAME);
    expect(username.readOnly).toBe(true);
    expect(password?.autocomplete).toBe('current-password');
    expect(username.form).toBe(password?.form);
  });
});

describe('WelcomeGate — a password the browser filled', () => {
  it('switches the account to it with a real change, proved by the held password', async () => {
    await toCheck();
    enter(SAFARI);
    browserFilled();
    pressSignIn();
    expect(screen.getByRole('alert').textContent).toBe(WELCOME_COPY.offeredPassword);

    await act(async () => {
      fireEvent.click(button(WELCOME_COPY.useOfferedPassword));
    });

    expect(mockChangePassword).toHaveBeenCalledWith({
      newPassword: SAFARI,
      proof: { kind: 'password', currentPassword: PASSWORD },
    });
    expect(screen.getByRole('status').textContent).toBe(WELCOME_COPY.passed);
  });

  it('holds what the browser filled to the same floor as any new password', async () => {
    mockGuessesLog10 = 5;
    await toCheck();
    enter(SAFARI);
    browserFilled();
    pressSignIn();
    expect(
      (screen.getByRole('button', { name: WELCOME_COPY.useOfferedPassword }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    expect(mockChangePassword).not.toHaveBeenCalled();
  });

  it('keeps the held password the one that opens, after the switch', async () => {
    let held: ReturnType<typeof useWelcome> = null;
    function Probe() {
      held = useWelcome();
      return null;
    }
    render(<Probe />);
    await toCheck();
    enter(SAFARI);
    browserFilled();
    pressSignIn();
    await act(async () => {
      fireEvent.click(button(WELCOME_COPY.useOfferedPassword));
    });
    await waitFor(() => expect(held?.password).toBe(SAFARI));
  });

  it('says a failed switch, and keeps the offer', async () => {
    mockChangePassword.mockRejectedValue(new Error('offline'));
    await toCheck();
    enter(SAFARI);
    browserFilled();
    pressSignIn();
    await act(async () => {
      fireEvent.click(button(WELCOME_COPY.useOfferedPassword));
    });
    expect(screen.getByText(WELCOME_COPY.switchFailed)).toBeTruthy();
    expect(button(WELCOME_COPY.useOfferedPassword)).toBeTruthy();
  });
});

describe('WelcomeGate — getting started', () => {
  async function toStart() {
    await toCheck();
    fireEvent.click(button(WELCOME_COPY.skipCheck));
    expect(heading()).toBe(WELCOME_COPY.heading.start.title);
  }

  it('ends the welcome and opens Settings → Data for an import', async () => {
    await toStart();
    fireEvent.click(button(WELCOME_COPY.importBookmarks));
    expect(mockPush).toHaveBeenCalledWith('/settings/data');
    expect(screen.getByText('the app')).toBeTruthy();
  });

  it('ends the welcome into the app, and drops the held password', async () => {
    let held: ReturnType<typeof useWelcome> = null;
    function Probe() {
      held = useWelcome();
      return null;
    }
    render(<Probe />);
    await toStart();
    fireEvent.click(button(WELCOME_COPY.startEmpty));
    expect(screen.getByText('the app')).toBeTruthy();
    expect(held).toBeNull();
  });
});
