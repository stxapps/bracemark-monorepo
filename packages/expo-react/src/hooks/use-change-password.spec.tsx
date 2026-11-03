// The expo sibling of web-react's hooks/use-change-password.spec.tsx, and the same rule.
// A door rotation whose final save gets NO answer may still have landed. After a
// password change, the old password may be refused already; after a new recovery
// code, the old code may be dead and the new one never shown. "Please try again"
// leads the user into a lockout, so that one case has its own type
// (UnconfirmedSaveError). It must stay narrow. A failure BEFORE the save wrote
// nothing, and a save the server answered is an answer, so both keep their own
// error.

import type { ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react-native';

import {
  ApiError,
  ApiTimeoutError,
  changePasswordEndpoint,
  putRecoveryDoorEndpoint,
  readPasswordDoorEndpoint,
} from '@stxapps/shared';

import { UnconfirmedSaveError, useChangePassword } from './use-change-password';
import { useRecoveryCode } from './use-recovery-code';

let mockDoorFailure: Error | undefined;
let mockSaveFailure: Error | undefined;
const mockCall = jest.fn((endpoint: unknown) => {
  if (endpoint === readPasswordDoorEndpoint) {
    return mockDoorFailure
      ? Promise.reject(mockDoorFailure)
      : Promise.resolve({ wrappedDek: '00', iv: '00' });
  }
  if (endpoint === changePasswordEndpoint || endpoint === putRecoveryDoorEndpoint) {
    return mockSaveFailure ? Promise.reject(mockSaveFailure) : Promise.resolve({ ok: true });
  }
  return Promise.reject(new Error('unexpected endpoint'));
});

const mockDoor = { wrappedDek: new Uint8Array([1]), iv: new Uint8Array([2]) };
const mockAccount = { publicKey: 'pk', sign: () => Promise.resolve('sig') };
jest.mock('@stxapps/react', () => ({ useApiClient: () => ({ call: mockCall }) }));
jest.mock('@stxapps/expo-crypto', () => ({
  changePasswordDoor: () => Promise.resolve({ passwordDoor: mockDoor, account: mockAccount }),
  regenerateRecoveryDoor: () => Promise.resolve({ recoveryDoor: mockDoor, account: mockAccount }),
}));
jest.mock('./use-sign-in', () => ({ InvalidCredentialsError: class extends Error {} }));
jest.mock('./use-sign-in-with-recovery', () => ({
  InvalidRecoveryCodeError: class extends Error {},
}));
jest.mock('../contexts/auth-provider', () => ({ useAuth: () => ({ username: 'alice' }) }));

const proof = { kind: 'password', currentPassword: 'old' } as const;
const FLOWS = [
  {
    name: 'change password',
    run: () => {
      const { result } = renderWithClient(() => useChangePassword());
      return { result, mutate: () => result.current.mutateAsync({ newPassword: 'new', proof }) };
    },
  },
  {
    name: 'a new recovery code',
    run: () => {
      const { result } = renderWithClient(() => useRecoveryCode());
      return { result, mutate: () => result.current.mutateAsync({ proof }) };
    },
  },
];

function renderWithClient<T>(hook: () => T) {
  // No gc timer: a settled mutation's five-minute cache timer keeps jest alive.
  const client = new QueryClient({ defaultOptions: { mutations: { gcTime: Infinity } } });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  return renderHook(hook, { wrapper });
}

async function failureOf(flow: (typeof FLOWS)[number]): Promise<unknown> {
  const { result, mutate } = flow.run();
  let failure: unknown;
  await act(async () => {
    await mutate().catch((err: unknown) => {
      failure = err;
    });
  });
  // TanStack settles the hook on a timer that can land after act() returns.
  await waitFor(() => expect(result.current.isError || result.current.isSuccess).toBe(true));
  return failure;
}

beforeEach(() => {
  mockDoorFailure = undefined;
  mockSaveFailure = undefined;
});

describe.each(FLOWS)('$name', (flow) => {
  it('saves without an error when the server answers', async () => {
    expect(await failureOf(flow)).toBeUndefined();
  });

  it('reports a save that timed out as unconfirmed, since it may have landed', async () => {
    mockSaveFailure = new ApiTimeoutError(60_000);
    expect(await failureOf(flow)).toBeInstanceOf(UnconfirmedSaveError);
  });

  it('reports a save whose connection dropped as unconfirmed', async () => {
    mockSaveFailure = new TypeError('Failed to fetch');
    expect(await failureOf(flow)).toBeInstanceOf(UnconfirmedSaveError);
  });

  it('keeps a save the server answered with a 500 as that answer', async () => {
    mockSaveFailure = new ApiError(500, '{"error":"internal_error"}');
    expect(await failureOf(flow)).toBe(mockSaveFailure);
  });

  it('keeps a timeout before the save as an ordinary failure, since nothing was written', async () => {
    mockDoorFailure = new ApiTimeoutError(60_000);
    expect(await failureOf(flow)).toBe(mockDoorFailure);
  });
});
