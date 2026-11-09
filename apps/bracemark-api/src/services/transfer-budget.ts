import { type Plan, PLANS } from '@stxapps/shared';

import type { TransferCount } from '../do/user-data';
import type { Bindings } from '../lib/env';
import { getHighWaterPlan } from './iap';

// The monthly transfer budget's Worker half: what the counts in the user's DO
// (do/repositories/transfer-budget.ts) are compared against, and the one line a
// crossing writes. COUNTED ONLY — nothing here, or anywhere, refuses a call on a
// count. The counts exist so the thresholds can later be set from what real
// accounts do; until then they say which accounts move far more than a library
// needs, and nothing more.
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
// against every plan's threshold, and the plan is read only when one of them
// lies inside the call's step — once or twice per account per month, not once
// per commit.

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

// Log the crossing, if this call made one. The line names the account by its
// opaque id and nothing else (the blob tier's refusal line is the precedent,
// middleware/rate-limit.ts): an account past its month's budget is the signal,
// and the id is what makes an account-wide look possible.
export async function noteTransfer(
  env: Bindings,
  userId: string,
  counter: TransferCounter,
  count: TransferCount | undefined,
  planOf: () => Promise<Plan> = () => getHighWaterPlan(env, userId),
): Promise<void> {
  if (!count) return;
  const thresholds = transferThresholdsOf(env, counter);
  if (!Object.values(thresholds).some((t) => crossed(count, t))) return;

  const threshold = thresholds[await planOf()];
  if (threshold === undefined || !crossed(count, threshold)) return;
  console.warn(
    `transferBudget: ${userId} passed ${counter} ${threshold} this month (not enforced)`,
  );
}
