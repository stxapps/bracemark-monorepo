import { findUserId, grantPlan, readGrantedPlan } from '../../seed/plan';

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
// in, outside any test context.
export async function grantPlus(username: string): Promise<void> {
  const userId = await findUserId(username);
  if (!userId) throw new Error(`no user id for ${username}; was the account created?`);
  await grantPlan(userId, 'plus');
  if ((await readGrantedPlan(userId)) !== 'plus') {
    throw new Error(`the Plus grant for ${username} did not land`);
  }
}
