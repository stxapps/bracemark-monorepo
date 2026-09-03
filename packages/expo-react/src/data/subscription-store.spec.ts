// Specs for the device-local last-known subscription copy. Same trust model as web's
// sibling — a soft cache that only gates CLIENT-side feature UX, re-checked server-side at
// `files/sign` regardless — but a different backing store, and one consequence that only
// exists here: the value comes back out of a JSON column, so it was never a string this
// module parsed. Nothing about a drizzle read forces it through the wire schema, which
// makes the `safeParse` easy to drop and impossible to notice: every valid input behaves
// identically, and only a stale or hand-edited row shows the difference — by handing a
// malformed plan straight to `entitlementsOf`.
//
// The other two rules are about not breaking a render: this is read SYNCHRONOUSLY at first
// mount to seed react-query's placeholder, so a throwing store has to degrade to `null`
// rather than take the first render with it.

import { sql } from 'drizzle-orm';

import type { SubscriptionStatus } from '@stxapps/shared';

import * as db from './db';
import {
  clearCachedSubscriptionStatus,
  readCachedStatus,
  writeCachedStatus,
} from './subscription-store';

jest.mock('expo-sqlite', () => require('../testing/node-sqlite'));

const PAID: SubscriptionStatus = {
  plan: 'plus',
  status: 'active',
  source: 'paddle',
  expiresAt: 1_700_000_000_000,
  willRenew: true,
};

// A row this module would never write — a value from an older build, or a hand-edited one.
function seedRawValue(value: unknown): void {
  db.getDb().run(
    sql`INSERT INTO subscription_status (id, value) VALUES ('singleton', ${JSON.stringify(value)})
        ON CONFLICT(id) DO UPDATE SET value = excluded.value`,
  );
}

beforeEach(() => {
  jest.restoreAllMocks();
  db.getDb().run(sql`DELETE FROM subscription_status`);
});

describe('readCachedStatus', () => {
  it('is null when this device has cached nothing', () => {
    expect(readCachedStatus()).toBeNull();
  });

  it('round-trips a written status', () => {
    writeCachedStatus(PAID);

    expect(readCachedStatus()).toEqual(PAID);
  });

  // THE ONE THAT MATTERS. The JSON column hands back an object, so nothing forces the wire
  // schema on it — drop the parse and an arbitrary `plan` reaches entitlementsOf, which is
  // the fold every client-side gate is derived from.
  it('rejects a shape the wire schema does not accept', () => {
    seedRawValue({ plan: 'unlimited-everything' });

    expect(readCachedStatus()).toBeNull();
  });

  it('rejects a partially-shaped status', () => {
    seedRawValue({ plan: 'plus' });

    expect(readCachedStatus()).toBeNull();
  });

  // Read synchronously during the first render (that is the whole reason this cache
  // exists), so a store failure must degrade rather than throw.
  it('is null when the store itself is unreadable', () => {
    jest.spyOn(db, 'getDb').mockImplementation(() => {
      throw new Error('database is locked');
    });

    expect(readCachedStatus()).toBeNull();
  });
});

describe('writeCachedStatus', () => {
  it('keeps one cached status per device', () => {
    writeCachedStatus(PAID);
    writeCachedStatus({ ...PAID, plan: 'free', status: 'none', source: null, expiresAt: null });

    expect(readCachedStatus()?.plan).toBe('free');
  });

  // The in-memory query cache still serves this session — a failed persist costs a colder
  // next start, never an error the user sees.
  it('is a no-op when the store is unwritable', () => {
    jest.spyOn(db, 'getDb').mockImplementation(() => {
      throw new Error('database is locked');
    });

    expect(() => writeCachedStatus(PAID)).not.toThrow();
  });
});

describe('clearCachedSubscriptionStatus', () => {
  // Called from the sign-out teardown: the next account on this device must not inherit
  // the previous one's plan — an unlocked paywall for someone who never paid.
  it('drops the cached copy so the next account cannot inherit it', () => {
    writeCachedStatus(PAID);

    clearCachedSubscriptionStatus();

    expect(readCachedStatus()).toBeNull();
  });

  it('is a no-op when the store is unreachable', () => {
    jest.spyOn(db, 'getDb').mockImplementation(() => {
      throw new Error('database is locked');
    });

    expect(() => clearCachedSubscriptionStatus()).not.toThrow();
  });
});
