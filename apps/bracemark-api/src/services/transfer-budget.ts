import { type Plan, PLANS } from '@stxapps/shared';

import { transferDaysRepo, type TransferStepPassed } from '../db/repositories/transfer-days';
import type { TransferCount } from '../do/user-data';
import type { Bindings } from '../lib/env';
import { getHighWaterPlan } from './iap';

// The monthly transfer budget's Worker half: what the counts in the user's DO
// (do/repositories/transfer-budget.ts) are compared against, the one line a
// crossing writes, and the daily totals it adds to. COUNTED ONLY — nothing here,
// or anywhere, refuses a call on a count. The counts exist so the thresholds can
// later be set from what real accounts do; until then they say which accounts
// move far more than a library needs, and nothing more.
//
// THE THRESHOLDS ARE PER HIGH-WATER PLAN, like the storage ceilings (services/
// iap.ts foldQuotaCeilings): a lapsed Plus account keeps Plus's numbers, because
// a library it uploaded while paying still has to sync to a new phone. They come
// from the env (TRANSFER_BUDGET_*_PER_MONTH, wrangler.jsonc), never from
// shared plans.ts: no client needs them, and they must be retunable without a
// release. Unset logs nothing, the same convention as the signup cap.
//
// THE PLAN IS READ LAZILY. A count arrives from a DO call that is already made
// (putGate, commitOps); the plan is a D1 read. So the crossing test runs first
// against every plan's threshold and every ladder step, and the plan is read
// only when one of them lies inside the call's step — a dozen times per account
// per month at the most, not once per commit.
//
// WHAT IS KEPT IS TOTALS (transfer_days, db/repositories/transfer-days.ts). The
// per-account counts sit one per DO, where no cron can read them, so the call
// that moves a count past a step adds one to that day's total for the step,
// counter and plan. Two kinds of step: the plan's own threshold, marked as the
// budget, and a fixed LADDER that every account climbs the same way. Counts only
// rise within a month, so an account passes each step at most once a month, and
// a month's rows for a step add up to how many accounts reached it: the month's
// distribution, which is what the thresholds get set from. A total names nobody;
// the account is named only in the log line, which is where a crossing is
// looked into. A batch the quota check refuses is handed back before this runs
// (services/sync.ts), so it is never noted.
//
// IT MUST NEVER FAIL A SYNC. The plan read and the write are caught and logged:
// a lost increment is a total off by one, and a sync that failed for it would be
// a refusal by the back door.

const DAY_MS = 86_400_000;

// The ladder: 1-2-5 steps from a small library to far past any plan's threshold.
// A constant, not config: moving a step mid-month would break the month's sums.
export const TRANSFER_STEPS: readonly number[] = [
  100, 200, 500, 1_000, 2_000, 5_000, 10_000, 20_000, 50_000, 100_000, 200_000, 500_000, 1_000_000,
];

// How long a transfer_days row is kept: a whole past month, read early in the
// next one, with a few days to spare.
export const TRANSFER_DAYS_KEPT = 40;

export type TransferCounter = 'puts' | 'commits';

const ENV_KEY: Record<TransferCounter, keyof Bindings> = {
  puts: 'TRANSFER_BUDGET_PUTS_PER_MONTH',
  commits: 'TRANSFER_BUDGET_COMMITS_PER_MONTH',
};

// "free:25000,plus:250000" → { free: 25000, plus: 250000 }. A pair that doesn't
// parse — an unknown plan, a count that isn't a positive integer — is dropped
// rather than thrown: a typo in wrangler.jsonc must not fail a sync.
export function transferThresholdsOf(
  env: Bindings | undefined,
  counter: TransferCounter,
): Partial<Record<Plan, number>> {
  const raw = env?.[ENV_KEY[counter]];
  const thresholds: Partial<Record<Plan, number>> = {};
  if (typeof raw !== 'string') return thresholds;
  for (const pair of raw.split(',')) {
    const [plan, value] = pair.split(':').map((part) => part.trim());
    const n = Number(value);
    if ((PLANS as readonly string[]).includes(plan) && Number.isInteger(n) && n > 0) {
      thresholds[plan as Plan] = n;
    }
  }
  return thresholds;
}

// A call crossed `threshold` if the counter was below it before the call and at
// or past it after. Monotonic within a month, so this is true for exactly one
// call per threshold per month.
export function crossed({ before, after }: TransferCount, threshold: number): boolean {
  return before < threshold && threshold <= after;
}

// Note the call's crossings, if it made any: the log line for the plan's own
// threshold, and one more account on each step's total for the day. The line
// names the account by its opaque id and nothing else (the blob tier's refusal
// line is the precedent, middleware/rate-limit.ts): an account past its month's
// budget is the signal, and the id is what makes an account-wide look possible.
export async function noteTransfer(
  env: Bindings,
  userId: string,
  counter: TransferCounter,
  count: TransferCount | undefined,
  planOf: () => Promise<Plan> = () => getHighWaterPlan(env, userId),
  now: number = Date.now(),
): Promise<void> {
  if (!count) return;
  const thresholds = transferThresholdsOf(env, counter);
  const steps = TRANSFER_STEPS.filter((step) => crossed(count, step));
  if (steps.length === 0 && !Object.values(thresholds).some((t) => crossed(count, t))) return;

  try {
    const plan = await planOf();
    const threshold = thresholds[plan];
    const budget = threshold !== undefined && crossed(count, threshold) ? threshold : undefined;
    if (budget !== undefined) {
      console.warn(
        `transferBudget: ${userId} passed ${counter} ${budget} this month (not enforced)`,
      );
    }
    const passed: TransferStepPassed[] = steps.map((step) => ({ step, budget: step === budget }));
    if (budget !== undefined && !steps.includes(budget))
      passed.push({ step: budget, budget: true });
    await transferDaysRepo(env.SESSIONS_DB).addPassed(
      Math.floor(now / DAY_MS),
      counter,
      plan,
      passed,
    );
  } catch (err) {
    console.error(`transferBudget: could not note a ${counter} crossing`, err);
  }
}

// For the daily cron: drop the rows older than TRANSFER_DAYS_KEPT.
export function purgeTransferDays(env: Bindings, now: number = Date.now()): Promise<number> {
  return transferDaysRepo(env.SESSIONS_DB).purgeBefore(
    Math.floor(now / DAY_MS) - TRANSFER_DAYS_KEPT,
  );
}
