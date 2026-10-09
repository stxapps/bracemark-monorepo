// The expo sibling of web-react's hooks/use-sign-out.spec.tsx, and the same rule.
// Sign-out's one decision beyond the POST: WHICH session its late local step ends
// (docs/sessions.md). The request can take long enough for a resume to mint a
// replacement, and the replacement must survive. So the generation is read before
// the request, from the token the request carries; read after it, the answer is
// the replacement's, and endSession wipes it.

import type { ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react-native';

import { useSignOut } from './use-sign-out';

let mockGeneration = 'gen-1';
const mockCall = jest.fn();
const mockEndSession = jest.fn((..._args: unknown[]) => Promise.resolve());

jest.mock('@stxapps/react', () => ({ useApiClient: () => ({ call: mockCall }) }));
jest.mock('../contexts/auth-provider', () => ({
  useAuth: () => ({ endSession: mockEndSession }),
}));
jest.mock('../data/session-store', () => ({
  getSession: () => ({ generation: mockGeneration }),
}));

function renderSignOut() {
  // No gc timer: a settled mutation's five-minute cache timer keeps jest alive.
  const client = new QueryClient({ defaultOptions: { mutations: { gcTime: Infinity } } });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  return renderHook(() => useSignOut(), { wrapper });
}

beforeEach(() => {
  mockGeneration = 'gen-1';
  mockCall.mockReset();
  mockEndSession.mockClear();
});

it('ends the generation whose token it sent, not one a resume minted meanwhile', async () => {
  mockCall.mockImplementation(() => {
    mockGeneration = 'gen-2'; // a resume lands while the request is in flight
    return Promise.resolve({});
  });
  const { result } = renderSignOut();

  await act(() => result.current.mutateAsync());
  // TanStack hands the hook its settled state on a timer, which can land after
  // act() has returned — React then warns of an update outside act.
  await waitFor(() => expect(result.current.isSuccess).toBe(true));

  expect(mockEndSession).toHaveBeenCalledWith({ generation: 'gen-1' });
});

// Best-effort revocation: a failed or refused request must not trap the user
// signed in — the local end still runs, for the same generation.
it('still ends the session locally when the request fails', async () => {
  mockCall.mockRejectedValue(new Error('offline'));
  const { result } = renderSignOut();

  await act(() => result.current.mutateAsync());
  await waitFor(() => expect(result.current.isSuccess).toBe(true));

  expect(mockEndSession).toHaveBeenCalledWith({ generation: 'gen-1' });
});

it('does not revoke or wipe a session replaced before the mutation starts', async () => {
  const { result } = renderSignOut();
  mockGeneration = 'gen-2';

  await act(() => result.current.mutateAsync({ generation: 'gen-1' }));
  await waitFor(() => expect(result.current.isSuccess).toBe(true));

  expect(mockCall).not.toHaveBeenCalled();
  expect(mockEndSession).not.toHaveBeenCalled();
});

it('revokes and ends an explicitly targeted session that is still current', async () => {
  mockCall.mockResolvedValue({});
  const { result } = renderSignOut();

  await act(() => result.current.mutateAsync({ generation: 'gen-1' }));
  await waitFor(() => expect(result.current.isSuccess).toBe(true));

  expect(mockCall).toHaveBeenCalledTimes(1);
  expect(mockEndSession).toHaveBeenCalledWith({ generation: 'gen-1' });
});
