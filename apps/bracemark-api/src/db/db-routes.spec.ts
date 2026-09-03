import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';

import { accountsDb, assignAccountDbId } from './db-routes';

// The sharding seam. Nothing else in the workspace fails if this starts
// resolving the wrong way: a user routed to the wrong shard reads as an account
// that does not exist, and one routed to a shard that isn't bound would read as
// a runtime crash — so both arms are pinned, plus the relation that keeps
// placement and routing in step when a shard is added.
describe('accountsDb', () => {
  it('resolves the stored id to that shard’s binding', () => {
    expect(accountsDb(env, '1')).toBe(env.ACCOUNTS_DB_1);
  });

  // Loud, not silent: an unrecognized id means a row we cannot serve, and
  // falling back to shard 1 would answer "no such account" for a real one.
  it('throws for an id no binding is declared for', () => {
    expect(() => accountsDb(env, '2')).toThrow('unknown account_db_id "2"');
    expect(() => accountsDb(env, '')).toThrow();
  });

  // The placement policy and the routing table are separate functions that must
  // agree — handing new signups an id nothing resolves would break create-account.
  it('places new accounts on a shard that routes', () => {
    expect(() => accountsDb(env, assignAccountDbId())).not.toThrow();
  });
});
