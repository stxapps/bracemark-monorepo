import { env } from 'cloudflare:workers';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { CREATE_ACCOUNT_ERROR } from '@stxapps/shared';

import type { Bindings } from '../lib/env';
import { HttpError } from '../lib/errors';
import { claimSignupSlot, purgeSignupCounts, signupCapOf } from './signup-cap';
import { reportSignups } from './signup-report';

// Real D1 (SESSIONS_DB, migrated by test/apply-migrations.ts), so the counter's
// single-upsert increment and the purge run against the actual table. Storage is
// shared by every test in this file, so each test works on a day of its own and
// counts only its own rows.

const DAY_MS = 86_400_000;
// Noon UTC on some day, so "today" and "tomorrow" are unambiguous.
const NOON = 20_000 * DAY_MS + DAY_MS / 2;

async function rowsOn(day: number): Promise<number> {
  const row = await env.SESSIONS_DB.prepare(`SELECT COUNT(*) AS n FROM signup_counts WHERE day = ?`)
    .bind(day)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

function capped(cap: string | undefined, extra: Partial<Bindings> = {}): Bindings {
  return { ...env, SIGNUP_CAP_PER_DAY: cap, ...extra } as Bindings;
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

describe('signupCapOf', () => {
  it('reads a positive integer and treats everything else as off', () => {
    expect(signupCapOf(capped('10'))).toBe(10);
    expect(signupCapOf(capped(undefined))).toBeNull();
    expect(signupCapOf(capped(''))).toBeNull();
    expect(signupCapOf(capped('0'))).toBeNull();
    expect(signupCapOf(capped('ten'))).toBeNull();
    expect(signupCapOf(capped('2.5'))).toBeNull();
    expect(signupCapOf(undefined)).toBeNull();
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

    await expect(reportSignups(e, at)).resolves.toEqual({ created: 1, cappedNetworks: 1 });
    expect(log).toHaveBeenCalledWith(
      'signups: 1 accounts in the last 24 h; 1 networks reached the daily cap yesterday',
    );
  });

  it('raises the line to an error above the alert threshold', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const at = NOON + 200 * DAY_MS;
    await claimName('a1', at - 1000);
    await claimName('a2', at - 2000);

    await reportSignups(capped(undefined, { SIGNUP_ALERT_PER_DAY: '1' }), at);
    expect(error).toHaveBeenCalledWith(
      'signups: 2 accounts in the last 24 h; 0 networks reached the daily cap yesterday (above the alert threshold of 1)',
    );
  });
});
