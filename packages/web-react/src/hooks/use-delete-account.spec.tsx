/** @jest-environment jsdom */
// Delete-account's local end runs in `onSuccess`, and TanStack runs the LATEST
// render's `onSuccess` — not the one current when the request left. So the account
// to end is carried out of the request itself: read from this render's `username`
// instead, a device that adopted another account meanwhile would wipe THAT one
// (docs/sessions.md). A refused deletion ends nothing.

import type { ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook } from '@testing-library/react';

import { ApiError, deleteAccountEndpoint, passwordDoorEndpoint } from '@stxapps/shared';

import { SubscriptionActiveError, useDeleteAccount } from './use-delete-account';

let mockUsername = 'alice';
let releaseDelete: (() => void) | undefined;
let mockDeleteFailure: Error | undefined;
const mockEndSession = jest.fn((..._args: unknown[]) => Promise.resolve());
const mockCall = jest.fn((endpoint: unknown) => {
  if (endpoint === passwordDoorEndpoint) return Promise.resolve({ wrappedDek: '00', iv: '00' });
  if (endpoint === deleteAccountEndpoint) {
    if (mockDeleteFailure) return Promise.reject(mockDeleteFailure);
    return new Promise<void>((resolve) => {
      releaseDelete = resolve;
    });
  }
  return Promise.reject(new Error('unexpected endpoint'));
});

jest.mock('@stxapps/react', () => ({ useApiClient: () => ({ call: mockCall }) }));
jest.mock('@stxapps/web-crypto', () => ({
  unlockAccount: () => Promise.resolve({ publicKey: 'pk', sign: () => Promise.resolve('sig') }),
  WrongPasswordError: class extends Error {},
}));
jest.mock('./use-sign-in', () => ({ InvalidCredentialsError: class extends Error {} }));
jest.mock('../contexts/auth-provider', () => ({
  useAuth: () => ({ username: mockUsername, endSession: mockEndSession }),
}));

function renderDeleteAccount() {
  // No gc timer: a settled mutation's five-minute cache timer keeps jest alive.
  const client = new QueryClient({ defaultOptions: { mutations: { gcTime: Infinity } } });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  return renderHook(() => useDeleteAccount(), { wrapper });
}

beforeEach(() => {
  mockUsername = 'alice';
  releaseDelete = undefined;
  mockDeleteFailure = undefined;
  mockEndSession.mockClear();
});

it('ends the deleted account, even after this context moved to another one', async () => {
  const { result, rerender } = renderDeleteAccount();
  let deleted!: Promise<unknown>;
  act(() => {
    deleted = result.current.mutateAsync({ password: 'pw' });
  });
  await act(async () => {
    while (!releaseDelete) await new Promise((r) => setTimeout(r, 0));
  });

  mockUsername = 'bob'; // adopted while the request was in flight
  rerender();
  await act(async () => {
    releaseDelete?.();
    await deleted;
  });

  expect(mockEndSession).toHaveBeenCalledTimes(1);
  expect(mockEndSession).toHaveBeenCalledWith({ username: 'alice' });
});

it('ends nothing when the server refuses the deletion', async () => {
  mockDeleteFailure = new ApiError(409, '{"error":"subscription_active"}');
  const { result } = renderDeleteAccount();

  await act(async () => {
    await expect(result.current.mutateAsync({ password: 'pw' })).rejects.toBeInstanceOf(
      SubscriptionActiveError,
    );
  });

  expect(mockEndSession).not.toHaveBeenCalled();
});
