import type { ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react';

import { type AuthApiClient, entitlementsOf } from '@stxapps/shared';

import { ApiClientProvider } from '../contexts/api-client-provider';
import { useStorageReadout } from './use-storage-usage';

// The readout is a promise read from the other side of the pricing page: it may
// only appear against a ceiling the product publishes, in the units that page
// prints. Nothing else on the screen depends on it, so every way of not knowing
// — loading, failing, an unpublished ceiling — has to draw nothing rather than a
// guess.

const GIB = 1024 ** 3;

function wrap(client: AuthApiClient) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>
      <ApiClientProvider client={client}>{children}</ApiClientProvider>
    </QueryClientProvider>
  );
}

const answering = (usedBytes: number, maxBytes: number) =>
  ({
    call: jest.fn(() => Promise.resolve({ usedBytes, maxBytes })),
  }) as unknown as AuthApiClient;

const plus = entitlementsOf('plus').maxBytes;

it('reads usage against the published ceiling, in the pricing page’s units', async () => {
  const { result } = renderHook(() => useStorageReadout('plus'), {
    wrapper: wrap(answering(1.25 * GIB, plus)),
  });

  await waitFor(() => expect(result.current.readout).not.toBeNull());
  expect(result.current.readout).toMatchObject({
    text: '1.2 GB of 5 GB used',
    fraction: 0.25,
    full: false,
    kept: null,
  });
});

it('caps the bar at full for an account a batch past its ceiling', async () => {
  const { result } = renderHook(() => useStorageReadout('plus'), {
    wrapper: wrap(answering(plus + 1024, plus)),
  });

  await waitFor(() => expect(result.current.readout).not.toBeNull());
  expect(result.current.readout).toMatchObject({ fraction: 1, full: true });
  // Full is a wait, never a loss — the same reading the sync status gives it.
  expect(result.current.readout?.note).toMatch(/wait to sync/);
});

it('draws nothing against Free’s ceiling, which is not published', async () => {
  const client = answering(3 * 1024 ** 2, entitlementsOf('free').maxBytes);
  const { result } = renderHook(() => useStorageReadout('free'), { wrapper: wrap(client) });

  await waitFor(() => expect(result.current.settled).toBe(true));
  expect(result.current.readout).toBeNull();
});

it('draws nothing when the read fails', async () => {
  const client = { call: jest.fn(() => Promise.reject(new Error('offline'))) };
  const { result } = renderHook(() => useStorageReadout('plus'), {
    wrapper: wrap(client as unknown as AuthApiClient),
  });

  // Settled all the same: a failed read must not hold the screen's first paint.
  await waitFor(() => expect(result.current.settled).toBe(true));
  expect(result.current.readout).toBeNull();
});

// The endpoint reports the HIGH-WATER ceiling, so a lapsed Plus account reads
// "of 5 GB" under a plan box that says Free; the readout has to say why.
it('says where a ceiling came from when it outlived the plan', async () => {
  const { result } = renderHook(() => useStorageReadout('free'), {
    wrapper: wrap(answering(1.25 * GIB, plus)),
  });

  await waitFor(() => expect(result.current.readout).not.toBeNull());
  expect(result.current.readout?.kept).toBe(
    'Your 5 GB of storage comes from your earlier Plus plan.',
  );
});

it('is not settled while the read is in flight', () => {
  const client = { call: jest.fn(() => new Promise(() => undefined)) };
  const { result } = renderHook(() => useStorageReadout('plus'), {
    wrapper: wrap(client as unknown as AuthApiClient),
  });

  expect(result.current).toEqual({ readout: null, settled: false });
});
