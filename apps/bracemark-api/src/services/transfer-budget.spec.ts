import { afterEach, describe, expect, it, vi } from 'vitest';

import type { Bindings } from '../lib/env';
import { crossed, noteTransfer, transferThresholdsOf } from './transfer-budget';

// The log line is the whole output of a count that refuses nothing, so the two
// properties worth pinning are that it fires exactly once per account per
// threshold per month, and against the account's own plan. Neither shows in any
// response.

const env = (puts?: string) => ({ TRANSFER_BUDGET_PUTS_PER_MONTH: puts }) as unknown as Bindings;

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
});
