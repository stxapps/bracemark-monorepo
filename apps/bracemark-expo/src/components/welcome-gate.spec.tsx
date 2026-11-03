import * as React from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react-native';

import { beginWelcome, endWelcome, useWelcome, WELCOME_COPY } from '@stxapps/react';

import { WelcomeGate } from './welcome-gate';

// The native half of bracemark-web's welcome-gate.spec.tsx (docs/account.md, _the
// welcome_): the gate covers only the account it was begun for; the recovery code is
// minted with the held password and Skip mints nothing; the check is a canonical
// compare whose two Safari-read labels are the shared ones; Import ends the welcome
// and goes to Settings → Data once the app under it is back. No adopt branch: React
// Native has no `:autofill`.

const mockPush = jest.fn();
jest.mock('expo-router', () => ({ router: { push: (href: string) => mockPush(href) } }));

const mockMintRecovery = jest.fn();
let mockUsername: string | null = 'wit_e2e';
jest.mock('@stxapps/expo-react', () => ({
  UnconfirmedSaveError: class UnconfirmedSaveError extends Error {},
  useAuth: () => ({ username: mockUsername }),
  useRecoveryCode: () => ({ mutateAsync: mockMintRecovery, isPending: false }),
}));

const mockSetQueryData = jest.fn();
jest.mock('@tanstack/react-query', () => ({
  useQueryClient: () => ({ setQueryData: mockSetQueryData, invalidateQueries: jest.fn() }),
}));

jest.mock('expo-clipboard', () => ({
  setStringAsync: jest.fn(() => Promise.resolve(true)),
}));

// The card chrome only: AuthScreen's keyboard-aware scroll needs a native runtime.
jest.mock('../features/auth/auth-screen', () => {
  const { Text, View } = jest.requireActual('react-native');
  return {
    AuthScreen: ({ title, children }: { title: string; children: React.ReactNode }) => (
      <View>
        <Text role="heading">{title}</Text>
        {children}
      </View>
    ),
  };
});

const USERNAME = 'wit_e2e';
const PASSWORD = 'mango-tunnel-violin-orbit-shy-lemon-quest';

beforeEach(() => {
  mockUsername = USERNAME;
  mockPush.mockReset();
  mockSetQueryData.mockReset();
  mockMintRecovery.mockReset().mockResolvedValue({ recoveryCode: 'ABCDE-FGHIJ-KLMNO' });
  act(() => beginWelcome({ username: USERNAME, password: PASSWORD }));
});

afterEach(() => {
  act(() => endWelcome());
});

function renderGate() {
  const { Text } = jest.requireActual('react-native');
  return render(
    <WelcomeGate>
      <Text>the app</Text>
    </WelcomeGate>,
  );
}
const tap = (testID: string) => fireEvent.press(screen.getByTestId(testID));
const heading = () => screen.getByRole('heading').props.children;

describe('WelcomeGate (native)', () => {
  it('covers the app for the account just made, and never another', () => {
    renderGate();
    expect(screen.queryByText('the app')).toBeNull();
    expect(heading()).toBe(WELCOME_COPY.heading.recovery.title);
  });

  it('leaves another account alone', () => {
    mockUsername = 'someone_else';
    renderGate();
    expect(screen.getByText('the app')).toBeTruthy();
  });

  it('mints the recovery code with the held password, and records that one exists', async () => {
    renderGate();
    await act(async () => {
      tap('welcome-create-recovery');
    });
    expect(mockMintRecovery).toHaveBeenCalledWith({
      proof: { kind: 'password', currentPassword: PASSWORD },
    });
    expect(screen.getByTestId('welcome-recovery-code')).toHaveTextContent('ABCDE-FGHIJ-KLMNO');
    expect(mockSetQueryData).toHaveBeenCalledWith(['recovery-door-exists', USERNAME], true);
  });

  // A mint that got no answer may have landed unseen, which Settings would read as
  // "has a recovery code": so it says to make another now, not later in Settings.
  it('says a mint that got no answer may have landed, and to make another now', async () => {
    const { UnconfirmedSaveError } = jest.requireMock<{ UnconfirmedSaveError: typeof Error }>(
      '@stxapps/expo-react',
    );
    mockMintRecovery.mockRejectedValue(new UnconfirmedSaveError());
    renderGate();
    await act(async () => {
      tap('welcome-create-recovery');
    });
    expect(screen.getByText(WELCOME_COPY.recoveryUnconfirmed)).toBeTruthy();
  });

  it('mints nothing on Skip', () => {
    renderGate();
    tap('welcome-skip-recovery');
    expect(mockMintRecovery).not.toHaveBeenCalled();
    expect(heading()).toBe(WELCOME_COPY.heading.check.title);
  });

  it('checks canonically: empty is empty, a mismatch says so, a match passes', () => {
    renderGate();
    tap('welcome-skip-recovery');
    const field = () => screen.getByTestId('welcome-check-password');

    tap('welcome-check-submit');
    expect(screen.getByTestId('welcome-check-error')).toHaveTextContent(WELCOME_COPY.empty);

    fireEvent.changeText(field(), `${PASSWORD}x`);
    tap('welcome-check-submit');
    expect(screen.getByTestId('welcome-check-error')).toHaveTextContent(WELCOME_COPY.mismatch);

    fireEvent.changeText(field(), ` ${PASSWORD}  `);
    fireEvent(field(), 'submitEditing');
    expect(screen.getByText(WELCOME_COPY.passed)).toBeTruthy();
  });

  it('keeps the labels Safari reads as a login, and shows the password again', () => {
    renderGate();
    tap('welcome-skip-recovery');
    expect(screen.getByText(WELCOME_COPY.signIn)).toBeTruthy();
    expect(WELCOME_COPY.signIn).toMatch(/^Sign in/);
    expect(WELCOME_COPY.showPassword).toMatch(/^Forgot your password\?/);
    expect(screen.getByTestId('welcome-check-password').props.autoComplete).toBe(
      'current-password',
    );
    tap('welcome-show-password');
    expect(screen.getByTestId('welcome-shown-password')).toHaveTextContent(PASSWORD);
  });

  it('ends into the app, dropping the held password', () => {
    let held: ReturnType<typeof useWelcome> = null;
    function Probe() {
      held = useWelcome();
      return null;
    }
    render(<Probe />);
    renderGate();
    tap('welcome-skip-recovery');
    tap('welcome-skip-check');
    tap('welcome-start');
    expect(screen.getByText('the app')).toBeTruthy();
    expect(held).toBeNull();
    expect(mockPush).not.toHaveBeenCalled();
  });

  it('opens Settings → Data for an import once the app is back under it', () => {
    renderGate();
    tap('welcome-skip-recovery');
    tap('welcome-skip-check');
    tap('welcome-import');
    expect(screen.getByText('the app')).toBeTruthy();
    expect(mockPush).toHaveBeenCalledWith('/settings/data');
  });
});
