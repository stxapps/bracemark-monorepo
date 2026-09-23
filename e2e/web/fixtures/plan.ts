import { type Page } from '@playwright/test';

import { findUserId, grantPlan, lapsePlan, readGrantedPlan } from '../../seed/plan';

// Put a disposable account on Plus, for the cases whose subject is a Plus lever —
// nested lists, the advanced search editor, locks.
//
// This is NOT a shortcut around anything a case asserts. The grant is the
// existing `manual` purchase source, written to local D1 the same way the dev
// seed and the screenshot account get theirs (seed/plan.ts carries the whole
// argument, and e2e/NEXT.md's IAP phase names this as the per-PR mechanism): a
// plaintext server row, folded server-side into the entitlements every client
// reads back from `GET /v1/iap/status`. Nothing test-only is added to the api,
// and the client still has to fetch and honour the entitlement for the gated
// control to open.
//
// No Playwright import: the native runner grants the plan before a device signs
// in, outside any test context. (`type Page` below is erased at compile time, so
// the runtime import graph is still Playwright-free.)
export async function grantPlus(username: string): Promise<void> {
  const userId = await findUserId(username);
  if (!userId) throw new Error(`no user id for ${username}; was the account created?`);
  await grantPlan(userId, 'plus');
  if ((await readGrantedPlan(userId)) !== 'plus') {
    throw new Error(`the Plus grant for ${username} did not land`);
  }
}

// End that grant, the way a comp ends (seed/plan.ts, lapsePlan), and confirm no
// active row is left. The server half only, exactly like `grantPlus`: every
// client still has to re-read `GET /v1/iap/status` before it knows, and the case
// that calls this (IAP-DOWNGRADE-001) makes each client do that the way a person
// would.
export async function lapsePlus(username: string): Promise<void> {
  const userId = await findUserId(username);
  if (!userId) throw new Error(`no user id for ${username}; was the account created?`);
  await lapsePlan(userId);
  if ((await readGrantedPlan(userId)) !== null) {
    throw new Error(`the Plus grant for ${username} is still active after the lapse`);
  }
}

// ⚠ **What a web case must call.** The D1 row landing is not the client knowing
// about it, and the gap between them is silent in BOTH directions that matter:
// `useEntitlements` serves FREE_SUBSCRIPTION_STATUS until the status query
// answers, and a Plus-gated control renders on the free plan too — it just opens
// the paywall. So a case that grants Plus and clicks straight through gets the
// upsell dialog, asserts against it, and reports the app broken. Nothing names
// the plan in that failure: the trace shows a click that landed and a dialog
// that opened, and the case passes alone because the query normally answers
// first. (Specimen: LOCK-APP-001 in the full suite, 8× 429 on `/v1/iap/status`
// when every worker shared one rate-limit bucket — docs/e2e.md.)
//
// The load is the synchronisation, not a nicety. `subscriptionStatusQueryOptions`
// holds a 5-minute staleTime, so a client that already answered `free` will not
// re-ask on its own; only a fresh document gets a fresh queryClient. `/links`
// because it mounts `useEntitlements` (its search bar does) — settings sections
// mount it too, but each case navigates itself immediately after this returns.
//
// The native runner keeps calling bare `grantPlus`: it grants before the device
// signs in, so the device's first status fetch already carries the plan.
export async function grantPlusAndLoad(page: Page, username: string): Promise<void> {
  await grantPlus(username);
  await page.goto('/links');
  await awaitPlus(page);
}

// Block until THIS client holds Plus, read off the device-local last-known copy
// that use-entitlements persists (`writeCachedStatus`, web-react
// data/subscription-store.ts — `bracemark.subscriptionStatus` in localStorage,
// duplicated here because the store exports no key).
//
// Waiting on the cache rather than on the response proves the whole path a
// gated control depends on: the fetch landed, it answered `plus`, and the hook's
// effect ran — which only happens after React has rendered with the fresh value.
// A `waitForResponse` would resolve one render too early.
async function awaitPlus(page: Page): Promise<void> {
  await page.waitForFunction(() => {
    const raw = localStorage.getItem('bracemark.subscriptionStatus');
    if (!raw) return false;
    try {
      return (JSON.parse(raw) as { plan?: string }).plan === 'plus';
    } catch {
      return false;
    }
  });
}
