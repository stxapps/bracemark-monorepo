import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen } from '@testing-library/react';

import { RECOVERY_CODE_COPY } from '@stxapps/react';
import { ApiError } from '@stxapps/shared';

import { AccountSection } from './account-section';

// WHICH RECEIPT THE RECOVERY CODE SCREEN GIVES, decided at the press (docs/account.md,
// _a recovery code in Settings_). The view needs to know whether the account already
// had a code, and the lookup can still be in flight when the view opens. It used to
// capture the answer at mount, where "not answered yet" read as "none": no warning
// that the existing code would stop working, then "set up" over a code it had just
// replaced. Only staging's latency showed it (WEB-ACCOUNT-008); locally the lookup
// always answers first, so this spec holds the lookup open by hand.

// The lookup's request, resolved by the test: `true` answers 200 (a door), `false` 404.
let answerLookup: (hasDoor: boolean) => void = () => undefined;
const mockCall = jest.fn(
  () =>
    new Promise((resolve, reject) => {
      answerLookup = (hasDoor) =>
        hasDoor ? resolve({ wrappedDek: '00', iv: '00' }) : reject(new ApiError(404, ''));
    }),
);
const mockApi = { call: mockCall };
const mockMint = jest.fn();

jest.mock('next/link', () => ({
  __esModule: true,
  default: ({ children, href }: { children: React.ReactNode; href: string }) => (
    <a href={href}>{children}</a>
  ),
}));

jest.mock('@stxapps/react', () => ({
  ...jest.requireActual('@stxapps/react'),
  useApiClient: () => mockApi,
  useSignOutOthers: () => ({ mutateAsync: jest.fn(), isPending: false }),
}));

jest.mock('@stxapps/web-react', () => {
  // The real query, over the fake api: what is under test is how the view treats a
  // lookup that has not answered, so the lookup has to be the real one.
  const { useQuery: useRealQuery } = jest.requireActual('@tanstack/react-query');
  const { hasRecoveryDoorQueryOptions: options } = jest.requireActual('@stxapps/react');
  class Named extends Error {}
  return {
    InvalidCredentialsError: class extends Named {},
    InvalidRecoveryCodeError: class extends Named {},
    SubscriptionActiveError: class extends Named {},
    UnconfirmedSaveError: class extends Named {},
    useAuth: () => ({ username: 'wit_e2e' }),
    useHasRecoveryDoor: () => useRealQuery(options(mockApi, 'wit_e2e')),
    useRecoveryCode: () => ({ mutateAsync: mockMint, isPending: false }),
    useChangePassword: () => ({ mutateAsync: jest.fn(), isPending: false }),
    useDeleteAccount: () => ({ mutateAsync: jest.fn(), isPending: false }),
    useEntitlements: () => ({ data: undefined }),
  };
});

function renderSection() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: Infinity } },
  });
  return render(
    <QueryClientProvider client={client}>
      <AccountSection />
    </QueryClientProvider>,
  );
}

async function openAndGenerate() {
  fireEvent.click(screen.getByRole('button', { name: /^Recovery code/ }));
  fireEvent.change(screen.getByLabelText('Current password'), {
    target: { value: 'current-password' },
  });
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: /^Generate/ }));
  });
}

beforeEach(() => {
  mockCall.mockClear();
  mockMint.mockReset().mockResolvedValue({ recoveryCode: 'ABCDE-FGHIJ-KLMNO' });
});

describe('Settings → Recovery code, opened before the lookup answers', () => {
  it('warns that the existing code will stop working while it is unknown', () => {
    renderSection();
    fireEvent.click(screen.getByRole('button', { name: /^Recovery code/ }));
    expect(screen.getByText(/Your previous code will stop working/)).toBeTruthy();
  });

  it('waits for the answer, and says the previous code was replaced when there was one', async () => {
    renderSection();
    await openAndGenerate();
    // Still in flight: nothing minted on a guess, and the view is waiting on the
    // overview's request rather than sending a second one. (After the mint a refresh
    // is meant to follow, so the count is taken here.)
    expect(mockMint).not.toHaveBeenCalled();
    expect(mockCall).toHaveBeenCalledTimes(1);

    await act(async () => answerLookup(true));
    expect(mockMint).toHaveBeenCalledTimes(1);
    expect(screen.getByText(RECOVERY_CODE_COPY.minted.replaced)).toBeTruthy();
  });

  it('says "set up" when the answer is that there was none', async () => {
    renderSection();
    await openAndGenerate();
    await act(async () => answerLookup(false));
    expect(screen.getByText(RECOVERY_CODE_COPY.minted.first)).toBeTruthy();
  });
});
