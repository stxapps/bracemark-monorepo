import { type ApiClient, ApiError } from '@stxapps/shared';

import { hasRecoveryDoorQueryKey, hasRecoveryDoorQueryOptions } from './use-has-recovery-door';

// This query reads EXISTENCE out of a status code, which is the whole risk: the
// endpoint answers with the user's wrapped door or with 404, and "does this account
// have a recovery door" is inferred from which. Every other failure — a 500, an
// expired session, the phone being offline — has to stay an error, because the one
// thing the caller does with `false` is show "no recovery set", and the action that
// nudge offers MINTS A NEW CODE. Minting kills the old one server-side (the `remint`
// copy says so in as many words), so a 500 folded into `false` walks a user who has a
// working door into destroying it.
//
// Nothing else pins the mapping: the widening is one `instanceof`/`status` clause, it
// typechecks either way, and the visible result is a nudge appearing — which looks
// exactly like the legitimate case it was written for.

const callWith = (impl: () => Promise<unknown>) =>
  ({ call: jest.fn(impl) }) as unknown as ApiClient;

// The queryFn takes TanStack's context; nothing here reads it.
const run = (client: ApiClient, username: string | null) =>
  (hasRecoveryDoorQueryOptions(client, username).queryFn as () => Promise<boolean>)();

describe('hasRecoveryDoorQueryOptions', () => {
  it('reads a served door as existing', async () => {
    await expect(
      run(
        callWith(() => Promise.resolve({})),
        'alice',
      ),
    ).resolves.toBe(true);
  });

  it('reads 404 — and only 404 — as no door', async () => {
    const notFound = () => Promise.reject(new ApiError(404, ''));
    await expect(run(callWith(notFound), 'alice')).resolves.toBe(false);
  });

  // The rung that matters. Each of these would otherwise report "no recovery set" to
  // an account that has one, in front of a button that destroys it.
  it.each([
    ['a server fault', new ApiError(500, '')],
    ['an expired session', new ApiError(401, '')],
    ['a rate limit', new ApiError(429, '')],
    ['a transport failure', new TypeError('Failed to fetch')],
  ])('rethrows %s rather than reporting no door', async (_label, err) => {
    await expect(
      run(
        callWith(() => Promise.reject(err)),
        'alice',
      ),
    ).rejects.toBe(err);
  });

  // Signed out, or before the session has resolved: the endpoint takes a username, so
  // there is nothing to ask. `enabled` is what keeps the query from firing, and the
  // key still carries the username so a second account can't read the first's answer
  // out of the cache.
  it('stays disabled with no username, and keys per account', () => {
    const client = callWith(() => Promise.resolve({}));
    expect(hasRecoveryDoorQueryOptions(client, null).enabled).toBe(false);
    expect(hasRecoveryDoorQueryOptions(client, 'alice').enabled).toBe(true);
    expect(hasRecoveryDoorQueryOptions(client, 'alice').queryKey).not.toEqual(
      hasRecoveryDoorQueryOptions(client, 'bob').queryKey,
    );
  });

  // The exported prefix is how the (re)generate flows invalidate this reader. A key
  // that stopped starting with it would leave the "no recovery set" nudge on screen
  // after the user just minted a code — the invalidation would match nothing, and
  // silently: `invalidateQueries` reports no error for a prefix that hits nothing.
  it('keys under the prefix the mint flows invalidate', () => {
    const key = hasRecoveryDoorQueryOptions(
      callWith(() => Promise.resolve({})),
      'alice',
    ).queryKey;
    expect(key.slice(0, hasRecoveryDoorQueryKey.length)).toEqual([...hasRecoveryDoorQueryKey]);
  });
});
