import { env } from 'cloudflare:workers';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { CREATE_ACCOUNT_ERROR } from '@stxapps/shared';

import type { Bindings } from '../lib/env';
import { HttpError } from '../lib/errors';
import {
  claimSignupSlot,
  purgeSignupCounts,
  signupCapEnforcedOf,
  signupCapFor,
  signupCapsOf,
} from './signup-cap';
import { purgeSignupDays, reportSignups, SIGNUP_DAYS_KEPT } from './signup-report';

// Real D1 (SESSIONS_DB, migrated by test/apply-migrations.ts), so the counter's
// single-upsert increment and the purge run against the actual table. Storage is
// shared by every test in this file, so each test works on a day of its own and
// counts only its own rows.

const DAY_MS = 86_400_000;
// Noon UTC on some day, so "today" and "tomorrow" are unambiguous.
const NOON = 20_000 * DAY_MS + DAY_MS / 2;

type SignupDayRow = {
  day: number;
  capped_networks: number;
  busiest: number;
  cap_ipv4: number | null;
  cap_ipv6: number | null;
  enforced: number;
};

// The signup_days rows from `day` on, oldest first. Tests here run on days far
// apart, so each reads from a day of its own.
async function signupDaysFrom(day: number): Promise<SignupDayRow[]> {
  const { results } = await env.SESSIONS_DB.prepare(
    `SELECT * FROM signup_days WHERE day >= ? AND day < ? ORDER BY day`,
  )
    .bind(day, day + 100)
    .all<SignupDayRow>();
  return results;
}

async function rowsOn(day: number): Promise<number> {
  const row = await env.SESSIONS_DB.prepare(`SELECT COUNT(*) AS n FROM signup_counts WHERE day = ?`)
    .bind(day)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

// The env with each family's cap set, ENFORCED, since most tests here are about
// refusals; the observe-mode tests pass `SIGNUP_CAP_ENFORCE: undefined` in
// `extra`. No default for `ipv6`: a default parameter also fills in an explicit
// `undefined`, which is the "this family is off" case.
function caps(
  ipv4: string | undefined,
  ipv6: string | undefined,
  extra: Partial<Bindings> = {},
): Bindings {
  return {
    ...env,
    SIGNUP_CAP_IPV4_PER_DAY: ipv4,
    SIGNUP_CAP_IPV6_PER_DAY: ipv6,
    SIGNUP_CAP_ENFORCE: '1',
    ...extra,
  } as Bindings;
}

const OBSERVE: Partial<Bindings> = { SIGNUP_CAP_ENFORCE: undefined };

// Both families at one cap, for the tests about counting rather than families.
function capped(cap: string | undefined): Bindings {
  return caps(cap, cap);
}

async function refusal(p: Promise<void>): Promise<HttpError> {
  const err = await p.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(HttpError);
  return err as HttpError;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('signupCapsOf', () => {
  it('reads a positive integer per family and treats everything else as off', () => {
    expect(signupCapsOf(caps('50', '10'))).toEqual({ ipv4: 50, ipv6: 10 });
    expect(signupCapsOf(caps('50', undefined))).toEqual({ ipv4: 50, ipv6: null });
    for (const off of [undefined, '', '0', 'ten', '2.5']) {
      expect(signupCapsOf(capped(off))).toEqual({ ipv4: null, ipv6: null });
    }
    expect(signupCapsOf(undefined)).toEqual({ ipv4: null, ipv6: null });
  });
});

describe('signupCapEnforcedOf', () => {
  it('enforces on "1" only, and observes on anything else', () => {
    expect(signupCapEnforcedOf(capped('5'))).toBe(true);
    for (const v of [undefined, '', '0', 'true', 'yes']) {
      expect(signupCapEnforcedOf(caps('5', '5', { SIGNUP_CAP_ENFORCE: v }))).toBe(false);
    }
    expect(signupCapEnforcedOf(undefined)).toBe(false);
  });
});

describe('signupCapFor', () => {
  it('gives a /64 the IPv6 cap and every other network the IPv4 one', () => {
    const e = caps('50', '10');
    expect(signupCapFor(e, '2001:db8:0:1::/64')).toBe(10);
    expect(signupCapFor(e, '203.0.113.7')).toBe(50);
    // No address from the edge: the IPv4 cap, the one for a single address.
    expect(signupCapFor(e, 'unknown')).toBe(50);
  });
});

describe('claimSignupSlot', () => {
  it('admits up to the cap, then refuses with signup_limited until the next UTC day', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const e = capped('2');

    await claimSignupSlot(e, '203.0.113.7', NOON);
    await claimSignupSlot(e, '203.0.113.7', NOON);
    const err = await refusal(claimSignupSlot(e, '203.0.113.7', NOON));

    expect(err.status).toBe(429);
    expect(err.code).toBe(CREATE_ACCOUNT_ERROR.signupLimited);
    // Twelve hours from noon to midnight UTC.
    expect(err.headers?.['retry-after']).toBe(String(12 * 60 * 60));

    // The next day is a fresh allowance.
    await claimSignupSlot(e, '203.0.113.7', NOON + DAY_MS);
  });

  it('logs the first refusal of the day only', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const e = capped('1');

    await claimSignupSlot(e, '198.51.100.4', NOON);
    await refusal(claimSignupSlot(e, '198.51.100.4', NOON));
    await refusal(claimSignupSlot(e, '198.51.100.4', NOON));

    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith('signupCap: refused 198.51.100.4 after 1 today');
  });

  it('observes where the cap is not enforced: counts, logs once, refuses nothing', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const e = caps('1', '1', OBSERVE);
    const at = NOON + 50 * DAY_MS;

    for (let i = 0; i < 4; i++) await claimSignupSlot(e, '198.51.100.40', at);

    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(
      'signupCap: 198.51.100.40 went past 1 today (observing, not refused)',
    );
    // Still counted, so the report can say what the cap would have done.
    const row = await env.SESSIONS_DB.prepare(
      `SELECT MAX(count) AS n FROM signup_counts WHERE day = ?`,
    )
      .bind(Math.floor(at / DAY_MS))
      .first<{ n: number }>();
    expect(row?.n).toBe(4);
  });

  it('holds each family to its own cap', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const e = caps('3', '1');
    const at = NOON + 30 * DAY_MS;

    await claimSignupSlot(e, '2001:db8:0:9::/64', at);
    await refusal(claimSignupSlot(e, '2001:db8:0:9::/64', at));

    await claimSignupSlot(e, '192.0.2.9', at);
    await claimSignupSlot(e, '192.0.2.9', at);
    await claimSignupSlot(e, '192.0.2.9', at);
    await refusal(claimSignupSlot(e, '192.0.2.9', at));
  });

  it('writes nothing for a family whose cap is off', async () => {
    const e = caps('5', undefined);
    const at = NOON + 40 * DAY_MS;

    await claimSignupSlot(e, '2001:db8:0:a::/64', at);
    expect(await rowsOn(Math.floor(at / DAY_MS))).toBe(0);

    await claimSignupSlot(e, '192.0.2.10', at);
    expect(await rowsOn(Math.floor(at / DAY_MS))).toBe(1);
  });

  it('counts each network on its own', async () => {
    const e = capped('1');

    await claimSignupSlot(e, '192.0.2.1', NOON);
    await claimSignupSlot(e, '192.0.2.2', NOON);
    await claimSignupSlot(e, '2001:db8:0:1::/64', NOON);
  });

  it('stores a keyed hash, never the network', async () => {
    await claimSignupSlot(capped('5'), '203.0.113.99', NOON);

    const { results } = await env.SESSIONS_DB.prepare(
      `SELECT network_hash FROM signup_counts`,
    ).all<{ network_hash: string }>();
    expect(results.length).toBeGreaterThan(0);
    for (const r of results) {
      expect(r.network_hash).toMatch(/^[0-9a-f]{64}$/);
      expect(r.network_hash).not.toContain('203.0.113.99');
    }
  });

  it('writes nothing when the cap is off', async () => {
    const at = NOON + 10 * DAY_MS;
    await claimSignupSlot(capped(undefined), '203.0.113.50', at);
    await claimSignupSlot(undefined, '203.0.113.50', at);

    expect(await rowsOn(Math.floor(at / DAY_MS))).toBe(0);
  });
});

describe('purgeSignupCounts', () => {
  it('drops past days and keeps today', async () => {
    const e = capped('5');
    const today = NOON + 20 * DAY_MS;
    await claimSignupSlot(e, '203.0.113.1', today - DAY_MS);
    await claimSignupSlot(e, '203.0.113.1', today);

    await purgeSignupCounts(e, today);
    expect(await rowsOn(Math.floor(today / DAY_MS) - 1)).toBe(0);
    expect(await rowsOn(Math.floor(today / DAY_MS))).toBe(1);
  });
});

describe('reportSignups', () => {
  async function claimName(username: string, createdAt: number) {
    await env.DIRECTORY_DB.prepare(
      `INSERT INTO usernames (username, user_id, account_db_id, created_at) VALUES (?, ?, '1', ?)`,
    )
      .bind(username, `u_${username}`, createdAt)
      .run();
  }

  it('counts the last 24 h of accounts and yesterday’s capped networks, as a log line', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const e = capped('1');
    const at = NOON + 100 * DAY_MS;

    await claimName('recent', at - 60_000);
    await claimName('old', at - 2 * DAY_MS);
    await claimSignupSlot(e, '203.0.113.2', at - DAY_MS);
    await refusal(claimSignupSlot(e, '203.0.113.2', at - DAY_MS));

    await expect(reportSignups(e, at)).resolves.toEqual({
      created: 1,
      cappedNetworks: 1,
      busiest: 2,
    });
    expect(log).toHaveBeenCalledWith(
      'signups: 1 accounts in the last 24 h; yesterday 1 networks went past their daily cap (refused) and the busiest network made 2 signups',
    );
  });

  // Production's mode: the line says what the cap would have done, and says so.
  it('reports an observed cap as observed, with the busiest network', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const e = caps('2', '2', OBSERVE);
    const at = NOON + 400 * DAY_MS;
    const yesterday = at - DAY_MS;

    for (let i = 0; i < 5; i++) await claimSignupSlot(e, '203.0.113.60', yesterday);
    await claimSignupSlot(e, '203.0.113.61', yesterday);

    await expect(reportSignups(e, at)).resolves.toEqual({
      created: 0,
      cappedNetworks: 1,
      busiest: 5,
    });
    expect(log).toHaveBeenCalledWith(
      'signups: 0 accounts in the last 24 h; yesterday 1 networks went past their daily cap (observed, not refused) and the busiest network made 5 signups',
    );
  });

  // The row says which cap it was counted against, so a count that is over the
  // IPv6 cap but under the IPv4 one is read right without the report knowing
  // which family the (hashed) network was.
  it('judges each network by its own family’s cap', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const e = caps('3', '1');
    const at = NOON + 300 * DAY_MS;
    const yesterday = at - DAY_MS;

    // Two each: past the /64's cap of 1, inside the address's cap of 3.
    await claimSignupSlot(e, '2001:db8:0:b::/64', yesterday);
    await refusal(claimSignupSlot(e, '2001:db8:0:b::/64', yesterday));
    await claimSignupSlot(e, '192.0.2.11', yesterday);
    await claimSignupSlot(e, '192.0.2.11', yesterday);

    await expect(reportSignups(e, at)).resolves.toMatchObject({ cappedNetworks: 1 });
  });

  // What the cron writes down before the purge takes the per-network rows away.
  // A skipped run skips its purge too, so the next run finds both days still in
  // signup_counts and writes each exactly, and the day nobody signed up gets a
  // row of zeros rather than no row: no row is how a cron that didn't run shows.
  it('keeps every finished day since the last as a row of totals, zeros included', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const e = caps('1', '2');
    const base = NOON + 700 * DAY_MS;
    const day = Math.floor(base / DAY_MS);

    await reportSignups(e, base);
    await claimSignupSlot(e, '203.0.113.70', base);
    await refusal(claimSignupSlot(e, '203.0.113.70', base));
    await refusal(claimSignupSlot(e, '203.0.113.70', base));
    await claimSignupSlot(e, '203.0.113.71', base);
    // No run on day + 1: the next is on day + 2.
    await expect(reportSignups(e, base + 2 * DAY_MS)).resolves.toMatchObject({
      cappedNetworks: 0,
      busiest: 0,
    });

    const written = await signupDaysFrom(day);
    expect(written).toEqual([
      { day, capped_networks: 1, busiest: 3, cap_ipv4: 1, cap_ipv6: 2, enforced: 1 },
      { day: day + 1, capped_networks: 0, busiest: 0, cap_ipv4: 1, cap_ipv6: 2, enforced: 1 },
    ]);

    // The same run again writes the same rows, not a second set.
    await reportSignups(e, base + 2 * DAY_MS);
    expect(await signupDaysFrom(day)).toEqual(written);
  });

  // A table empty or long idle starts SIGNUP_DAYS_KEPT back, not at the epoch:
  // a row older than that would be purged on the same run.
  it('reaches back no further than the rows are kept', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const at = NOON + 900 * DAY_MS;
    const today = Math.floor(at / DAY_MS);

    await reportSignups(caps(undefined, undefined, OBSERVE), at);

    const written = await signupDaysFrom(today - SIGNUP_DAYS_KEPT - 1);
    expect(written[0]?.day).toBe(today - SIGNUP_DAYS_KEPT);
    expect(written.at(-1)).toEqual({
      day: today - 1,
      capped_networks: 0,
      busiest: 0,
      cap_ipv4: null,
      cap_ipv6: null,
      enforced: 0,
    });
  });
});

describe('purgeSignupDays', () => {
  it('drops the rows older than they are kept, and keeps the rest', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const at = NOON + 1200 * DAY_MS;
    const today = Math.floor(at / DAY_MS);
    await reportSignups(capped('5'), at);

    await purgeSignupDays(capped('5'), at + DAY_MS);

    const kept = await signupDaysFrom(today - SIGNUP_DAYS_KEPT);
    expect(kept[0]?.day).toBe(today + 1 - SIGNUP_DAYS_KEPT);
    expect(kept.at(-1)?.day).toBe(today - 1);
  });
});
