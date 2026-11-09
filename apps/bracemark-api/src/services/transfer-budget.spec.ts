import { env as workerEnv } from 'cloudflare:workers';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { Bindings } from '../lib/env';
import {
  crossed,
  noteTransfer,
  purgeTransferDays,
  TRANSFER_DAYS_KEPT,
  TRANSFER_STEPS,
  transferThresholdsOf,
} from './transfer-budget';

// A count that refuses nothing has two outputs, the log line and the day's
// totals, and neither shows in any response. So what is pinned is that the line
// fires exactly once per account per threshold per month, against the account's
// own plan; that the totals add one account per step passed and name nobody;
// and that neither can fail the sync it rides on.
//
// Real D1 (SESSIONS_DB). Storage is shared by every test in this file, so each
// test that reads the totals writes them on a day of its own (`now`).

const DAY_MS = 86_400_000;

const env = (puts?: string) =>
  ({ ...workerEnv, TRANSFER_BUDGET_PUTS_PER_MONTH: puts }) as unknown as Bindings;

type TransferDayRow = {
  day: number;
  counter: string;
  plan: string;
  step: number;
  budget: number;
  accounts: number;
};

async function totalsOn(day: number): Promise<TransferDayRow[]> {
  const { results } = await workerEnv.SESSIONS_DB.prepare(
    `SELECT * FROM transfer_days WHERE day = ? ORDER BY counter, plan, step`,
  )
    .bind(day)
    .all<TransferDayRow>();
  return results;
}

describe('transferThresholdsOf', () => {
  it('reads plan:count pairs', () => {
    expect(transferThresholdsOf(env('free:25000, plus:250000'), 'puts')).toEqual({
      free: 25000,
      plus: 250000,
    });
  });

  // A typo in wrangler.jsonc must not fail a sync, so it drops the pair.
  it('drops a pair that does not parse, and reads unset as none', () => {
    expect(transferThresholdsOf(env('free:abc,gold:5,plus:-1,pro:10'), 'puts')).toEqual({
      pro: 10,
    });
    expect(transferThresholdsOf(env(), 'puts')).toEqual({});
    expect(transferThresholdsOf(undefined, 'commits')).toEqual({});
  });
});

describe('crossed', () => {
  it('is true for the one call whose step reaches the threshold', () => {
    expect(crossed({ period: 1, before: 99, after: 100 }, 100)).toBe(true);
    expect(crossed({ period: 1, before: 100, after: 200 }, 100)).toBe(false);
    expect(crossed({ period: 1, before: 0, after: 99 }, 100)).toBe(false);
  });
});

describe('noteTransfer', () => {
  afterEach(() => vi.restoreAllMocks());

  const thresholds = env('free:100,plus:1000');

  it('logs the account once it passes its plan’s threshold, naming nothing but the id', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    await noteTransfer(thresholds, 'u_1', 'puts', { period: 1, before: 900, after: 1100 }, () =>
      Promise.resolve('plus'),
    );

    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).toBe(
      'transferBudget: u_1 passed puts 1000 this month (not enforced)',
    );
  });

  // The plan is a D1 read; a call nowhere near any threshold must not make it.
  it('reads no plan for a call that crosses nothing', async () => {
    const planOf = vi.fn(() => Promise.resolve('free' as const));

    await noteTransfer(thresholds, 'u_2', 'puts', { period: 1, before: 10, after: 20 }, planOf);

    expect(planOf).not.toHaveBeenCalled();
  });

  // Free's threshold sits inside a Plus account's month; crossing it is not a
  // crossing of the Plus account's own.
  it('stays quiet when only another plan’s threshold was crossed', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    await noteTransfer(thresholds, 'u_3', 'puts', { period: 1, before: 50, after: 150 }, () =>
      Promise.resolve('plus'),
    );

    expect(warn).not.toHaveBeenCalled();
  });

  it('does nothing for an uncounted call', async () => {
    const planOf = vi.fn(() => Promise.resolve('free' as const));

    await noteTransfer(thresholds, 'u_4', 'puts', undefined, planOf);

    expect(planOf).not.toHaveBeenCalled();
  });

  it('adds one account to each step it passed, for its plan, and names nobody', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const e = env('free:100,plus:1500');
    const day = 30_000;
    const plus = () => Promise.resolve('plus' as const);

    await noteTransfer(
      e,
      'u_10',
      'puts',
      { period: 1, before: 900, after: 1600 },
      plus,
      day * DAY_MS,
    );
    await noteTransfer(
      e,
      'u_11',
      'puts',
      { period: 1, before: 990, after: 1010 },
      plus,
      day * DAY_MS,
    );

    const rows = await totalsOn(day);
    expect(rows).toEqual([
      { day, counter: 'puts', plan: 'plus', step: 1000, budget: 0, accounts: 2 },
      { day, counter: 'puts', plan: 'plus', step: 1500, budget: 1, accounts: 1 },
    ]);
    expect(JSON.stringify(rows)).not.toMatch(/u_1[01]/);
  });

  // The ladder and the budget can meet; the totals keep one row, marked.
  it('keeps a threshold that is also a ladder step as one row, marked as the budget', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const day = 30_001;
    expect(TRANSFER_STEPS).toContain(1000);

    await noteTransfer(
      env('plus:1000'),
      'u_12',
      'puts',
      { period: 1, before: 900, after: 1100 },
      () => Promise.resolve('plus'),
      day * DAY_MS,
    );

    expect(await totalsOn(day)).toEqual([
      { day, counter: 'puts', plan: 'plus', step: 1000, budget: 1, accounts: 1 },
    ]);
  });

  // The plan read and the write ride a sync call. Either failing is a total off
  // by one, never a failed sync; the line, written first, still goes out.
  it('never fails the call it rides on', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const day = 30_002;
    const count = { period: 1, before: 50, after: 150 };

    await expect(
      noteTransfer(
        env('free:100'),
        'u_13',
        'puts',
        count,
        () => Promise.reject(new Error('d1')),
        day * DAY_MS,
      ),
    ).resolves.toBeUndefined();
    const broken = {
      ...env('free:100'),
      SESSIONS_DB: {
        prepare: () => {
          throw new Error('d1 down');
        },
      },
    } as unknown as Bindings;
    await expect(
      noteTransfer(broken, 'u_14', 'puts', count, () => Promise.resolve('free'), day * DAY_MS),
    ).resolves.toBeUndefined();

    expect(error).toHaveBeenCalledTimes(2);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(await totalsOn(day)).toEqual([]);
  });
});

describe('purgeTransferDays', () => {
  it('drops the rows older than they are kept, and keeps the rest', async () => {
    const today = 31_000;
    const free = () => Promise.resolve('free' as const);
    const count = { period: 1, before: 0, after: 100 };
    for (const day of [today - TRANSFER_DAYS_KEPT - 1, today - TRANSFER_DAYS_KEPT]) {
      await noteTransfer(env(), 'u_15', 'puts', count, free, day * DAY_MS);
    }

    await purgeTransferDays(env(), today * DAY_MS);

    expect(await totalsOn(today - TRANSFER_DAYS_KEPT - 1)).toEqual([]);
    expect(await totalsOn(today - TRANSFER_DAYS_KEPT)).toHaveLength(1);
  });
});
