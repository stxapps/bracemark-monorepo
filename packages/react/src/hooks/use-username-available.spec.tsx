import type { ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react';

import { ApiError, type AuthApiClient, canonicalizeUsername } from '@stxapps/shared';

import { ApiClientProvider } from '../contexts/api-client-provider';
import {
  USERNAME_CHECK_RETRIES,
  usernameAvailableQueryOptions,
  useUsernameAvailable,
} from './use-username-available';

// Two properties, both invisible from the app.
//
// CANONICALIZATION, because availability is a fact about the canonical handle — that
// is the server's UNIQUE key. If the raw text reached the key, `Alice` and `alice`
// would be two cache entries for one question, and the submit-time `fetchQuery`
// (which passes the EXACT typed value) would miss the entry the live hook just
// filled and buy a second round trip at the worst moment. Nothing about that shows
// on screen: both requests return the same answer.
//
// `current`, because it is what the message ladder reads to avoid saying "Username
// is available" about a name the user has already typed past (field-messages.spec.ts
// has the other half). It is false for the ~400ms after a keystroke — while
// `isFetching` is still false, since no request has started — and that window is too
// short to hold still in a browser.

const availabilityClient = (available = true) =>
  ({ call: jest.fn(() => Promise.resolve({ available })) }) as unknown as AuthApiClient;

describe('usernameAvailableQueryOptions', () => {
  it('keys on the canonical handle, so case and padding are one question', () => {
    const client = availabilityClient();
    const canonical = usernameAvailableQueryOptions(client, 'alice').queryKey;
    for (const typed of ['Alice', 'ALICE', '  alice  ']) {
      expect(usernameAvailableQueryOptions(client, typed).queryKey).toEqual(canonical);
    }
  });

  // And ASKS about the canonical handle too — a key that agreed with itself while the
  // request carried the raw text would cache the server's answer about `Alice` under
  // `alice`.
  it('asks the server about the canonical handle', async () => {
    const client = availabilityClient();
    const options = usernameAvailableQueryOptions(client, '  Alice  ');
    await (options.queryFn as (ctx: { signal?: AbortSignal }) => Promise<unknown>)({});
    expect(client.call).toHaveBeenCalledWith(
      expect.anything(),
      { username: 'alice' },
      expect.anything(),
    );
  });

  // Race safety: TanStack hands the query's `signal` in, and it has to reach fetch or
  // a superseded request (an older keystroke) resolves after the newer one and
  // overwrites a fresh answer with a stale one.
  it('passes the abort signal through to the request', async () => {
    const client = availabilityClient();
    const signal = new AbortController().signal;
    const options = usernameAvailableQueryOptions(client, 'alice');
    await (options.queryFn as (ctx: { signal: AbortSignal }) => Promise<unknown>)({ signal });
    expect(client.call).toHaveBeenCalledWith(expect.anything(), expect.anything(), { signal });
  });

  // The endpoint is unauthenticated and rate-limited per IP, so a name that can't be
  // registered must not cost a request — the format rules already reject it, and the
  // ladder is showing the schema's own message rather than an availability verdict.
  it.each([
    ['too short', 'ab'],
    ['an illegal character', 'has space'],
    ['a reserved name', 'admin'],
    ['nothing typed', ''],
  ])('does not ask the server about %s', (_label, username) => {
    expect(usernameAvailableQueryOptions(availabilityClient(), username).enabled).toBe(false);
  });

  it('asks about a name that passes the shared rules', () => {
    expect(usernameAvailableQueryOptions(availabilityClient(), 'alice').enabled).toBe(true);
  });

  // Which failures are retried decides whether the field can get stuck. A retry
  // spent on a 4xx on the merits only delays its message; a 429 NOT retried (or
  // retried inside the window that refused it, TanStack's own timing) lands on
  // "Couldn’t check. Try again." with the submit disabled, for a state that
  // clears by itself.
  describe('retries', () => {
    const options = usernameAvailableQueryOptions(availabilityClient(), 'alice');
    const retry = options.retry as (failureCount: number, err: unknown) => boolean;
    const retryDelay = options.retryDelay as (failureCount: number, err: unknown) => number;

    it('retries a refused, failed or dropped check, up to the limit', () => {
      for (const err of [new ApiError(429, '', 60), new ApiError(503, ''), new TypeError('x')]) {
        expect(retry(0, err)).toBe(true);
        expect(retry(USERNAME_CHECK_RETRIES - 1, err)).toBe(true);
        expect(retry(USERNAME_CHECK_RETRIES, err)).toBe(false);
      }
    });

    it('does not retry a check refused on its merits, or one a newer keystroke aborted', () => {
      expect(retry(0, new ApiError(400, ''))).toBe(false);
      expect(retry(0, new DOMException('aborted', 'AbortError'))).toBe(false);
    });

    it('waits out the window a 429 names, not a guessed backoff', () => {
      // Literal 60 s: the `standard` tier's period, which the api sends as
      // Retry-After. It is also retryDelayMs's ceiling, so no jitter rides on it.
      expect(retryDelay(0, new ApiError(429, '', 60))).toBe(60_000);
    });
  });
});

describe('useUsernameAvailable', () => {
  const wrap = (client: AuthApiClient) => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    return ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={queryClient}>
        <ApiClientProvider client={client}>{children}</ApiClientProvider>
      </QueryClientProvider>
    );
  };

  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('marks its answer stale the moment the name changes, and current again once it settles', async () => {
    const client = availabilityClient();
    const { result, rerender } = renderHook(({ name }) => useUsernameAvailable(name), {
      initialProps: { name: 'alice' },
      wrapper: wrap(client),
    });

    await waitFor(() => expect(result.current.data).toEqual({ available: true }));
    expect(result.current.current).toBe(true);

    // The debounce window. `data` still describes 'alice' and no request is in
    // flight, so `current` is the ONLY thing standing between a stale verdict and
    // the user reading it about 'alice2'.
    rerender({ name: 'alice2' });
    expect(result.current.current).toBe(false);
    expect(result.current.isFetching).toBe(false);
    expect(result.current.data).toEqual({ available: true });

    await act(async () => void jest.advanceTimersByTime(400));
    await waitFor(() => expect(result.current.current).toBe(true));
  });

  // Case is not a change of question — re-opening a "checking…" window on a
  // capitalization would flicker the message for a name already answered.
  it('does not re-open the window for a name that only changed case', async () => {
    const client = availabilityClient();
    const { result, rerender } = renderHook(({ name }) => useUsernameAvailable(name), {
      initialProps: { name: 'alice' },
      wrapper: wrap(client),
    });
    await waitFor(() => expect(result.current.data).toBeDefined());

    rerender({ name: 'Alice' });
    expect(canonicalizeUsername('Alice')).toBe('alice');
    expect(result.current.current).toBe(true);
  });

  // The user-facing half of the retry policy: a refused check reads as "checking"
  // (isFetching, no isError) for the whole window the server named, and then
  // answers — never "Couldn’t check" for a refusal that clears by itself.
  it('holds a refused check as in flight until its window clears, then answers', async () => {
    let refusing = true;
    const client = {
      call: jest.fn(() =>
        refusing ? Promise.reject(new ApiError(429, '', 60)) : Promise.resolve({ available: true }),
      ),
    } as unknown as AuthApiClient;
    const { result } = renderHook(() => useUsernameAvailable('alice'), {
      wrapper: wrap(client),
    });

    await waitFor(() => expect(result.current.failureCount).toBeGreaterThan(0));
    expect(result.current.isFetching).toBe(true);
    expect(result.current.isError).toBe(false);
    refusing = false;

    // Not one try inside the window: TanStack's own 1 s / 2 s / 4 s would have
    // spent all three here and given up.
    await act(async () => void jest.advanceTimersByTime(59_000));
    expect(result.current.data).toBeUndefined();
    expect(result.current.isFetching).toBe(true);

    await act(async () => void jest.advanceTimersByTime(1_000));
    await waitFor(() => expect(result.current.data).toEqual({ available: true }));
    expect(result.current.isError).toBe(false);
  });

  // The point of debouncing at all: one request per pause in typing, not per
  // keystroke. The endpoint's per-IP cap is what this is staying under, and going
  // over it looks like nothing until a real user on a real connection gets 429s.
  it('buys one request for a name typed straight through', async () => {
    const client = availabilityClient();
    const { rerender } = renderHook(({ name }) => useUsernameAvailable(name), {
      initialProps: { name: 'alice' },
      wrapper: wrap(client),
    });
    await waitFor(() => expect(client.call).toHaveBeenCalled());
    // Counted from here, not from zero: under StrictMode (docs/testing.md) the mount
    // itself asks twice — TanStack cancels a query whose `signal` was read when its
    // last observer unmounts, and the simulated remount asks again. Dev-only; what
    // this pins is the typing that follows.
    const mounted = jest.mocked(client.call).mock.calls.length;

    for (const name of ['alicex', 'alicexy', 'alicexyz']) {
      rerender({ name });
      await act(async () => void jest.advanceTimersByTime(100));
    }
    expect(client.call).toHaveBeenCalledTimes(mounted);

    await act(async () => void jest.advanceTimersByTime(400));
    await waitFor(() => expect(client.call).toHaveBeenCalledTimes(mounted + 1));
  });
});
