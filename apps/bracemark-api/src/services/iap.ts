import {
  AVAILABLE_PAID_PLANS,
  type Entitlements,
  entitlementsOf,
  type IapPricesResponse,
  type IapVerifyRequest,
  type PaidPlan,
  type Plan,
  planOfStoreProduct,
  type SubscriptionStatus,
} from '@stxapps/shared';

import {
  type PaddleCheckoutEntity,
  paddleCheckoutsRepo,
} from '../db/repositories/paddle-checkouts';
import { type PurchaseEntity, purchasesRepo } from '../db/repositories/purchases';
import { fetchAppstoreSubscription } from '../lib/appstore';
import type { Bindings } from '../lib/env';
import { HttpError } from '../lib/errors';
import { newId } from '../lib/ids';
import {
  fetchPaddleSubscription,
  fetchPaddleTransaction,
  isPaddleTransactionDead,
  isPaddleTransactionUnbilled,
  normalizePaddleStatus,
  type PaddleEvent,
  type PaddleSubscription,
  paddleTimeToMs,
} from '../lib/paddle';
import { acknowledgePlaystorePurchase, fetchPlaystoreSubscription } from '../lib/playstore';
import type { StoreSource, StoreSubscriptionSnapshot } from '../lib/store';

// Subscription/entitlement service. Purchases land in DIRECTORY_DB (written by
// the provider webhooks / future store verifiers); this service owns the FOLD
// from those rows to the account's single SubscriptionStatus — what `iap/status`
// returns, and what the `files/sign` quota gate derives its limits from
// (lib/quota.ts). Clients never see purchase rows, only the fold.

// How long a `past_due` subscription stays entitled past its period end while
// the provider retries payment (Paddle dunning runs up to ~2 weeks). Yanking
// features mid-dunning punishes an expired card harder than a deliberate cancel.
const PAST_DUE_GRACE_MS = 16 * 24 * 60 * 60 * 1000;

// Slack past `expires_at` for a subscription in good standing: the renewal
// webhook lags the period boundary (retries, clock skew), and the row's
// `expires_at` only advances when it lands. Without slack every subscriber
// would flicker to free for the lag window at each renewal.
const EXPIRY_SLACK_MS = 24 * 60 * 60 * 1000;

const PLAN_RANK: Record<Plan, number> = { free: 0, plus: 1, pro: 2 };

// Whether a purchase row still entitles its plan at `now`.
function isEntitled(p: PurchaseEntity, now: number): boolean {
  // A null expiry means "never expires" ONLY for a manual/lifetime grant (comps,
  // lifetime deals — no provider billing period to end). For a PROVIDER row
  // (paddle/appstore/playstore) a null expiry is a MISSING period, not a lifetime
  // grant, so it must not entitle — otherwise a trialing/active event that arrived
  // without a current_billing_period would read as entitled forever.
  const lifetime = p.source === 'manual' && p.expiresAt === null;
  switch (p.status) {
    case 'active':
    case 'trialing':
      return lifetime || (p.expiresAt !== null && now < p.expiresAt + EXPIRY_SLACK_MS);
    case 'past_due':
      return lifetime || (p.expiresAt !== null && now < p.expiresAt + PAST_DUE_GRACE_MS);
    case 'canceled':
      // Entitled through the already-paid period; no slack — the provider
      // stamped the definitive end.
      return p.expiresAt !== null && now < p.expiresAt;
    case 'paused':
      return false;
  }
}

// Fold every purchase row to the account's one SubscriptionStatus. Pure — the
// unit-testable core. Best entitled row wins: highest plan, then latest expiry
// (null = never expires = latest).
export function foldSubscriptionStatus(
  purchases: PurchaseEntity[],
  now: number = Date.now(),
): SubscriptionStatus {
  let best: PurchaseEntity | null = null;
  for (const p of purchases) {
    if (!isEntitled(p, now)) continue;
    if (
      best === null ||
      PLAN_RANK[p.plan] > PLAN_RANK[best.plan] ||
      (PLAN_RANK[p.plan] === PLAN_RANK[best.plan] &&
        (p.expiresAt ?? Infinity) > (best.expiresAt ?? Infinity))
    ) {
      best = p;
    }
  }

  if (!best) {
    return { plan: 'free', status: 'none', source: null, expiresAt: null, willRenew: false };
  }
  return {
    plan: best.plan,
    // The purchase row's lifecycle state, narrowed to what a CLIENT needs:
    // past_due surfaces as 'grace' (entitled, but tell them to fix the card),
    // trialing passes through (entitled, and not yet charged — the UI owes them
    // "first charge on" rather than "renews on"), and everything still entitled
    // at this point is plain 'active'. `paused`/`canceled` can't reach here —
    // isEntitled already excluded them.
    status:
      best.status === 'past_due' ? 'grace' : best.status === 'trialing' ? 'trialing' : 'active',
    source: best.source,
    expiresAt: best.expiresAt,
    // Renews whenever the provider will try to collect again: good standing,
    // and dunning too (past_due means retries are scheduled — auto-renew is
    // still on unless canceledAt says otherwise). Not canceled (scheduled or
    // effective), and with something to renew (a non-expiring grant doesn't).
    willRenew:
      (best.status === 'active' || best.status === 'trialing' || best.status === 'past_due') &&
      best.canceledAt === null &&
      best.expiresAt !== null,
  };
}

// --- staleness refresh — the missed-webhook backstop -------------------------

// Every writer of a purchase row is a provider PUSH (Paddle webhook, App Store
// / Play notification, the app's own verify). Push has holes that the provider's
// own retries don't close: an event we ACKed but couldn't apply is never
// redelivered (see PaddleApplyFailure), a delivery outage longer than the retry
// window is lost outright, and a destination disabled by rotated config takes
// everything with it. This is the PULL side that closes them — the same
// re-fetch-by-external-id the store notify routes already do, triggered by the
// row looking wrong instead of by a provider telling us.
//
// It is deliberately NOT the old iap-server's `/status { doForce }`: the client
// has no say. The server decides from the row's own state, so a poll-happy
// client can't turn a status read into provider fan-out, and a healthy account
// (the overwhelming majority) still costs exactly one indexed D1 query.

// Minimum spacing between refresh ATTEMPTS on one row.
//
// Sized by the USER-VISIBLE path, not the background one: this same clock gates
// the settings page's Refresh button (it is just `iap/status` again), and
// refreshPurchase stamps the attempt in a `finally` — so a provider that was
// down, or a row the provider still reports as wrong, makes that button a
// silent no-op for the rest of the window. The scenario that matters is exactly
// the one this backstop exists for: the user fixes a past_due card or resumes a
// paused subscription in the provider's portal, the event doesn't reach us, and
// they come back and press Refresh. Anything on the order of an hour turns that
// into "the button does nothing" for as long as they're willing to wait.
//
// Going shorter costs approximately nothing, because the debounce was never the
// only bound: MAX_REFRESH_PER_READ caps calls per read, the global `standard`
// rate limiter caps reads at 60/min per IP, and a refresh-worthy row can only
// exist for an account that actually bought something (rows are minted by real
// provider events or the tight-limited verify route). The ceiling here is 3
// outbound calls per 5 minutes on an account whose rows already look wrong.
const REFRESH_DEBOUNCE_MS = 5 * 60 * 1000;

// A hard ceiling on outbound calls per status read, independent of the debounce.
// listByUserId is "a handful of rows at most" by design, but that's a property
// of normal use, not an invariant the schema enforces — and this loop is the one
// place a row count turns into third-party requests on a user-triggered path.
const MAX_REFRESH_PER_READ = 3;

// Whether a row is worth re-asking the provider about. The three refresh-worthy
// shapes, all of which mean "push should have told us something and may not
// have":
//   - not entitled but not finished: an active/trialing row past its period
//     (the renewal event never landed), or a provider row with NO period at all
//     (the event arrived without current_billing_period — see isEntitled);
//   - past_due: dunning changes state on the provider's schedule, not ours;
//   - paused: indefinite, and the resume arrives only as an event.
// Excluded: 'manual' (nothing to fetch — there's no provider), and 'canceled'
// (terminal; a canceled row inside its period is still entitled, so it can't
// reach here, and past it there is nothing left to learn).
//
// NOT covered — deliberately: a row that looks healthy but was canceled at the
// provider without the event reaching us. It over-entitles until its period
// ends, and no read-path heuristic can see it (the row looks perfect). That's
// the scheduled-sweep case (docs/iap.md — reconciliation), which reads rows by
// age rather than by shape and needs no user present.
export function needsRefresh(p: PurchaseEntity, now: number): boolean {
  if (p.source === 'manual') return false;
  if (p.status === 'canceled') return false;
  if (now - p.lastSyncedAt < REFRESH_DEBOUNCE_MS) return false;
  return p.status === 'past_due' || p.status === 'paused' || !isEntitled(p, now);
}

// Re-fetch one row's authoritative state and apply it. The stored `external_id`
// IS the provider's lookup key for all three sources (Paddle sub_… id, App
// Store originalTransactionId, Play purchase token), so no extra column is
// needed to ask.
//
// Never throws: the caller is a read that must still answer. A provider that's
// unreachable, a 404, or a snapshot we can't apply all resolve to "keep the
// stored row" — with the attempt stamped either way, so a permanently-broken
// row costs one call per debounce window instead of one per status read.
async function refreshPurchase(env: Bindings, p: PurchaseEntity): Promise<void> {
  const repo = purchasesRepo(env.DIRECTORY_DB);
  try {
    if (p.source === 'paddle') {
      const data = await fetchPaddleSubscription(env, p.externalId);
      if (data) await applyPaddleSubscription(env, data, Date.now(), `refresh ${p.externalId}`);
      else console.error(`refreshPurchase: paddle does not know ${p.externalId}`);
    } else if (p.source === 'appstore' || p.source === 'playstore') {
      // Exactly the notification path, minus the notification: fetch by the
      // stored key, apply onto the existing binding.
      await applyStoreNotification(env, p.source, p.externalId);
    }
  } catch (e) {
    console.error(`refreshPurchase: ${p.source} ${p.externalId} refresh failed`, e);
  } finally {
    // After the apply, so it wins the upsert's own stamp only when the apply
    // didn't happen; either way the debounce clock advances.
    await repo.markSyncAttempt(p.source, p.externalId);
  }
}

// --- pending checkouts — the PRE-ROW backstop --------------------------------

// The staleness refresh above can only revisit a subscription we already have a
// row for. That leaves one hole it cannot reach by construction: a FIRST Paddle
// purchase whose `subscription.created` never landed. No row is written, so
// `listByUserId` returns nothing, so nothing is refresh-worthy — the user has
// paid and the server has no way to find out. And it cannot be recovered by
// asking Paddle about the user, because Paddle has no such question: every list
// endpoint filters on Paddle's own ids, and the `custom_data.userId` we stamp is
// returned but never queryable.
//
// So the key has to be minted before the purchase exists — which it already is.
// `createPaddleTransaction` mints a `txn_…` and, since this table, persists it.
// Recovery is then two hops through machinery that already existed:
//   txn_… → transaction.subscription_id → fetchPaddleSubscription →
//   applyPaddleSubscription (the same normalize+upsert a webhook takes).
//
// The trigger keeps the same posture as needsRefresh — the SERVER decides from
// stored state, never the client — but on a much shorter clock, because the two
// situations are nothing alike: a stale purchase row can be days old and its
// user isn't watching, whereas a pending checkout's whole life is the minute
// after a payment, with the user staring at the screen (bracemark-web's
// `pollActivation` re-reads `iap/status` every 2s for 30s). Reusing even the
// 5-minute REFRESH_DEBOUNCE_MS would be worse than useless here: the first poll
// fires before Paddle has provisioned the subscription, learns nothing, and
// would then block every remaining poll in the window the user is watching.
//
// So the constants below are sized against that 30s client window rather than
// against a background sweep — a debounce only earns its place if the window
// fits SEVERAL attempts, since the first one is the least likely to succeed.

// Don't ask before a checkout could plausibly have completed. Below this the
// answer is a near-certain "no subscription yet".
//
// Note what this can and cannot do: `created_at` is stamped when the
// transaction is MINTED — before the overlay even opens — so it measures time
// since the user started checking out, not time since they paid (which the
// server never observes). A user who spends longer than this typing card
// details, i.e. nearly all of them, has already cleared the floor by the time
// `pollActivation` starts. It therefore only really suppresses reads that
// arrive WHILE the overlay is open (another tab, another device), and the job
// of not spending everything on one premature attempt belongs to the debounce
// below. Kept because that suppression is free, not because it paces the poll.
const CHECKOUT_MIN_AGE_MS = 20 * 1000;

// Minimum spacing between resolve attempts on one checkout. The client polls 15
// times at 2s (see bracemark-web's ACTIVATION_TRIES/ACTIVATION_INTERVAL_MS), so the
// window a user actually watches is ~30s — and the row is inserted with
// `last_synced_at = 0`, so attempt #1 always fires on the first poll past
// CHECKOUT_MIN_AGE_MS, seconds after payment, which is when Paddle is least
// likely to have populated `transaction.subscription_id` yet. Anything at or
// near the width of that window therefore yields exactly ONE attempt, at the
// worst moment, and the user is told "still processing" for a purchase we could
// have found. At 10s the window instead holds 3-4 attempts, the last of them a
// full ~30s after payment.
//
// Still bounded against a hot-looping client, and by more than this number:
// MAX_CHECKOUT_RESOLVE_PER_READ caps calls per read, the global rate limiter
// caps reads, the whole path is skipped unless the fold is `free` (so no paying
// account ever reaches it), and a resolved row is DELETED rather than re-polled.
const CHECKOUT_DEBOUNCE_MS = 10 * 1000;

// How long a pending checkout stays worth asking about. Past this it gets
// deleted on the next scan and automatic recovery is over.
//
// Sized to outlive PADDLE's own retries. Paddle redelivers a failed live
// notification 60 times across 3 days (47 of them in the first day) before
// marking it failed, so at 3 days this row is still around to pull whatever
// Paddle eventually gave up pushing. It also covers the two windows a shorter
// TTL cuts off: a user who paid into silence on Friday and reopens the app on
// Monday, and an operator fixing the config bug behind an ACKed-but-unapplied
// drop (`unknown_price` — the one hole Paddle does not retry at all, and whose
// alert token this path deliberately suppresses).
//
// The floor is NOT the client's activation poll — CHECKOUT_DEBOUNCE_MS owns
// that window. It's when the user comes back, which is why anything on the
// order of an hour would throw away the only case with real value.
//
// The ceiling is that an ABANDONED checkout never resolves, and until it's gone
// it adds an inline Paddle round-trip to that free account's status reads. That
// cost is what the abandonment delete in resolveCheckout pays off: a row that
// is old and still unbilled leaves early, so this TTL governs (almost) only
// rows that could still turn into a purchase.
const CHECKOUT_TTL_MS = 3 * 24 * 60 * 60 * 1000;

// How long an UNBILLED transaction is given before its row is read as an
// abandoned checkout and dropped (see isPaddleTransactionUnbilled — no payment
// has been attempted, so this is not the paid-into-silence case).
//
// Deliberately far past any plausible checkout session, because this is the one
// IRREVERSIBLE decision on this path and Paddle gives no help with it: a `ready`
// transaction has no documented expiry, so "old and unbilled" never becomes
// "can no longer be paid" — the delete is always a bet that the user won't come
// back to an overlay they left open.
//
// To lose a purchase to it, all of this has to line up: the user takes longer
// than this to pay, a status read lands in that window (which happens — see the
// CHECKOUT_MIN_AGE_MS note on reads arriving while the overlay is open), they
// then pay, and their webhook is lost. Rare, but the second link stops being
// rare at hour scale ("open checkout, go find the card, come back"), and the
// victim is exactly who this table is for.
//
// The other side is cheap by comparison: an abandoned row costs a Paddle
// round-trip on that free account's status reads until it goes, and those reads
// block nothing (useEntitlements renders a device-local last-known copy while
// the query is in flight). Half a day still clears ~5/6 of that tax, so it keeps
// paying for the 3-day TTL above without betting a paid user's recovery on a
// slow checkout.
const CHECKOUT_ABANDONED_MS = 12 * 60 * 60 * 1000;

// Per-read cap on checkout→Paddle round-trips, the sibling of
// MAX_REFRESH_PER_READ. Ordered newest-first, so the cap keeps the checkout the
// user is most likely waiting on.
const MAX_CHECKOUT_RESOLVE_PER_READ = 2;

// How long a pending checkout is REUSED instead of minting a second one — the
// window in which a repeat `POST /iap/checkout` for the same plan is treated as
// the same checkout attempt (see createPaddleTransaction).
//
// The `already_subscribed` guard below only sees subscriptions that EXIST, so it
// cannot stop two calls that both land before either is paid — a double-click,
// two tabs, a retry after a flaky response — and two live `txn_…` for one
// account is two payable checkouts, i.e. the double-subscription hole via a
// different door. Handing back the same transaction makes them unpayable twice.
//
// Sized as "one checkout session, generously": long enough to cover leaving the
// overlay to find a card, short enough that an abandoned checkout doesn't pin a
// stale transaction to the account for the 3-day row TTL. A transaction paid
// inside the window turns into a subscription, and the guard takes over.
const CHECKOUT_REUSE_MS = 30 * 60 * 1000;

// Whether a pending checkout is due for a resolve attempt.
export function needsCheckoutResolve(c: PaddleCheckoutEntity, now: number): boolean {
  const age = now - c.createdAt;
  if (age < CHECKOUT_MIN_AGE_MS || age > CHECKOUT_TTL_MS) return false;
  return now - c.lastSyncedAt >= CHECKOUT_DEBOUNCE_MS;
}

// Resolve one pending checkout. Returns whether a purchase row was applied.
// Never throws — the caller is a read that must still answer.
//
// Every terminal outcome DELETES the row: applied (the `purchases` row is the
// durable record from then on), the transaction canceled, Paddle not knowing the
// id at all, or a checkout that was plainly abandoned (old and still unbilled).
// Non-terminal outcomes (payment in flight, Paddle unreachable, a snapshot we
// couldn't apply) stamp the debounce clock and leave the row for the next
// window — bounded by the TTL, after which it's swept.
async function resolveCheckout(env: Bindings, c: PaddleCheckoutEntity): Promise<boolean> {
  const repo = paddleCheckoutsRepo(env.DIRECTORY_DB);
  try {
    const txn = await fetchPaddleTransaction(env, c.transactionId);
    if (!txn) {
      console.error(`resolveCheckout: paddle does not know ${c.transactionId}`);
      await repo.delete(c.transactionId);
      return false;
    }

    if (!txn.subscription_id) {
      // No subscription yet — three cases, and only the first is worth waiting
      // on:
      //   - payment in flight (the overwhelmingly likely case this early);
      //   - the transaction is dead (canceled) — nothing will come of it;
      //   - it's old and payment was never even attempted: an abandoned
      //     checkout, which would otherwise spend the rest of the TTL adding an
      //     inline Paddle round-trip to this free account's status reads while
      //     having nothing left to recover.
      const abandoned =
        isPaddleTransactionUnbilled(txn.status) && Date.now() - c.createdAt > CHECKOUT_ABANDONED_MS;
      if (isPaddleTransactionDead(txn.status) || abandoned) await repo.delete(c.transactionId);
      else await repo.markSyncAttempt(c.transactionId);
      return false;
    }

    const data = await fetchPaddleSubscription(env, txn.subscription_id);
    if (!data) {
      // A transaction pointing at a subscription Paddle then 404s on is a
      // contradiction, not a normal state — keep the row and re-ask next window.
      console.error(`resolveCheckout: paddle does not know ${txn.subscription_id}`);
      await repo.markSyncAttempt(c.transactionId);
      return false;
    }

    // `c.userId` as the fallback binding: our row was written from the SESSION
    // at checkout creation, so it's at least as trustworthy as the custom_data
    // we stamped there — and it still binds when that field is missing.
    const result = await applyPaddleSubscription(
      env,
      data,
      Date.now(),
      `checkout ${c.transactionId}`,
      c.userId,
    );
    if (!result.applied) {
      await repo.markSyncAttempt(c.transactionId);
      return false;
    }
    await repo.delete(c.transactionId);
    return true;
  } catch (e) {
    console.error(`resolveCheckout: ${c.transactionId} failed`, e);
    await repo.markSyncAttempt(c.transactionId).catch(() => undefined);
    return false;
  }
}

// Scan this account's pending checkouts and resolve the due ones. Returns
// whether anything was applied (i.e. whether the caller must re-fold).
async function resolvePendingCheckouts(
  env: Bindings,
  userId: string,
  now: number,
): Promise<boolean> {
  const repo = paddleCheckoutsRepo(env.DIRECTORY_DB);
  const pending = await repo.listPendingByUserId(userId);
  if (pending.length === 0) return false;

  // Opportunistic cleanup on a path that has already read the table — a row past
  // the TTL can no longer do anything, so dropping it needs no sweep and no
  // timeliness.
  //
  // This is not the reaper for a SUCCESSFUL purchase's row, and can't be: an
  // entitled account returns before it gets here (see getSubscriptionStatus), and
  // its next checkout — the other caller of deleteStale — is refused by the
  // already-subscribed guard, so a subscriber has no next checkout to ride
  // along on. Those rows are retired by applyPaddleEvent, at the moment the
  // webhook lands, or by resolveCheckout when it's the one that applied them.
  if (pending.some((c) => now - c.createdAt > CHECKOUT_TTL_MS)) {
    await repo.deleteStale(userId, now - CHECKOUT_TTL_MS);
  }

  const due = pending
    .filter((c) => needsCheckoutResolve(c, now))
    .slice(0, MAX_CHECKOUT_RESOLVE_PER_READ);

  let applied = false;
  for (const c of due) {
    if (await resolveCheckout(env, c)) applied = true;
  }
  return applied;
}

// The authenticated `iap/status` read: one indexed D1 query + the pure fold.
//
// `refresh` opts INTO the staleness backstop above. Three callers pass it, each
// because a wrong answer there costs more than the bounded round-trip: the
// `iap/status` route (the user is asking this exact question), the
// already-subscribed guard in createPaddleTransaction (a stale row buys them a
// second subscription), and deleteAccount's billing gate (an irreversible
// deletion that leaves the provider still charging). Everyone else reads the
// stored fold — getEntitlements on the `files/sign` hot path above all, where a
// provider's latency would become upload latency.
//
// Note it is pointless right after an apply: upsertFromProvider stamps
// `last_synced_at`, so a row this request just wrote can't be stale (see
// verifyStorePurchase's return).
export async function getSubscriptionStatus(
  env: Bindings,
  userId: string,
  options: { refresh?: boolean } = {},
): Promise<SubscriptionStatus> {
  const repo = purchasesRepo(env.DIRECTORY_DB);
  const purchases = await repo.listByUserId(userId);
  if (!options.refresh) return foldSubscriptionStatus(purchases);

  const now = Date.now();
  const stale = purchases.filter((p) => needsRefresh(p, now)).slice(0, MAX_REFRESH_PER_READ);
  // Sequential, not Promise.all: these rows are NOT independent. A playstore
  // refresh reaches applyStoreNotification → supersedeLinkedPlayPurchase, which
  // writes OTHER rows of this same account — so two stale rows in one
  // replacement chain would race that supersede against the superseded row's own
  // upsert, both stamped with ~the same time, which the repo's out-of-order guard
  // can't arbitrate. The cost of ordering them is bounded and rare: the cap is
  // MAX_REFRESH_PER_READ round-trips, on an account whose rows already look
  // wrong, at most once per REFRESH_DEBOUNCE_MS per row — a healthy account
  // (the overwhelming majority) never enters this loop at all.
  for (const p of stale) await refreshPurchase(env, p);
  // Re-read rather than patching the in-memory list: refreshPurchase writes
  // through the repo's guarded upsert, which may legitimately decline the write
  // (a stale snapshot), so the row is the only honest source of what landed.
  const fold = foldSubscriptionStatus(
    stale.length > 0 ? await repo.listByUserId(userId) : purchases,
  );

  // Only a `free` answer can be hiding a lost FIRST webhook — if any row already
  // entitles this account, there is nothing a pending checkout could add, and
  // the paid majority never touches the table. Ordered last deliberately: the
  // refresh above is the cheaper, likelier fix, and resolving what it already
  // healed would be wasted round-trips.
  if (fold.plan !== 'free') return fold;
  if (!(await resolvePendingCheckouts(env, userId, now))) return fold;
  return foldSubscriptionStatus(await repo.listByUserId(userId));
}

// What the quota gate reads on the `files/sign` put path (services/sync.ts):
// plan → limits via the shared entitlementsOf, so the server enforces exactly
// the numbers the client paywall displays. Never refreshes — see above.
export async function getEntitlements(env: Bindings, userId: string): Promise<Entitlements> {
  return entitlementsOf((await getSubscriptionStatus(env, userId)).plan);
}

// --- paddle (web overlay checkout) ----------------------------------

// Why an apply didn't land. Every value is a PERMANENT drop (a webhook that
// hits one has been ACKed and will never be redelivered), which is exactly what
// makes them worth naming rather than logging into the void: the reason is what
// an operator needs to act on, and what a later refetch — once the config is
// fixed — can clear. See the drop-visibility note above applyPaddleSubscription.
export type PaddleApplyFailure =
  | 'unknown_status' // Paddle grew a subscription status our map doesn't have
  | 'unknown_price' // a pri_… none of this env's PADDLE_PRICE_ID_* name
  | 'unbound'; // no stored binding and no custom_data.userId to bind to

export type PaddleApplyResult = { applied: true } | { applied: false; reason: PaddleApplyFailure };

// One greppable token on every UNRECOVERABLE drop — an event we ACKed (so no
// provider will resend it) for a subscription we have no row for (so the
// staleness refresh can never revisit it). Narrower than it used to be: a FIRST
// Paddle purchase now also has the pending-checkout path, which re-drives this
// same apply every debounce window until the TTL, so the token is suppressed
// there (see fallbackUserId) and what's left of it means a drop that escaped
// the webhook AND that window. This is the alert surface, and it is
// deliberately a LOG rather than a dead-letter table: Paddle already stores
// every notification and can replay it on demand, so a D1 copy would duplicate
// the provider's own queue without a drainer to justify it. What the operator
// needs is to KNOW, and the subscription id to replay — both are on this line.
// (`observability.enabled` in wrangler.jsonc is what makes these retained and
// queryable; without it this whole argument collapses.) Revisit if drops ever
// become routine rather than a config bug you fix once. See docs/iap.md.
const IAP_DROP = 'IAP_DROP_UNRECOVERABLE';

// The second greppable alert token: one account paying two providers at once.
// Unlike IAP_DROP this costs the CUSTOMER money rather than costing them their
// entitlement, and nothing in the system self-heals it — the fold takes the best
// entitled row, so a double-charged account looks perfectly healthy to itself
// and to us. An operator has to refund one side, which is why the line carries
// both sources. See verifyStorePurchase for why this is a log and not a refusal.
const IAP_DOUBLE_SUB = 'IAP_DOUBLE_SUBSCRIPTION';

// --- the price → plan map ----------------------------------------------------

// One plan's configured Paddle prices, newest-first. Each PADDLE_PRICE_ID_* var
// is a COMMA-SEPARATED LIST rather than a single id, and that shape is the point:
// the price map is the ONE place where adding to the catalog is not a pure
// addition. `unknown_price` is a log-and-ACK permanent drop (see
// PaddleApplyFailure), so the moment a plan can be billed at a price this env
// doesn't name — a second cadence, a grandfathered launch price, a currency
// variant — those subscribers pay and are never entitled, and Paddle never
// redelivers the event that would have fixed it. A list makes "the catalog grew"
// a config edit rather than a code change, and lets a price stay RECOGNIZED long
// after it stops being SOLD.
//
// Which is the other half: this is the same catalog/storefront split as
// PAID_PLANS vs AVAILABLE_PAID_PLANS in iap/plans.ts, applied to prices. The
// READ side (applyPaddleSubscription, below) accepts every id in the list —
// every price the catalog has ever charged, forever, because a subscriber on a
// retired price is still a subscriber. The WRITE side (createPaddleTransaction)
// sells exactly the FIRST one. So retiring a price is: move the new id to the
// front, keep the old id in the list. Never delete an id that anyone might still
// be billed at.
export function paddlePriceIds(value: string | undefined): string[] {
  return (value ?? '')
    .split(',')
    .map((id) => id.trim())
    .filter((id) => id.length > 0);
}

// One plan's configured price list — the FORWARD direction of the map (the
// reverse, price → plan, is planOfPaddlePrices just below). Both callers of the
// forward direction want the same thing from it, so the plan → env-var ternary
// lives here rather than being written out at each: `createPaddleTransaction`
// takes the front of the list to sell, and `onSalePaddlePrices` reports that
// same front id to the client. Two spellings of "which price is on sale" could
// drift apart; one cannot.
function configuredPriceIds(env: Bindings, plan: PaidPlan): string[] {
  return paddlePriceIds(plan === 'pro' ? env.PADDLE_PRICE_ID_PRO : env.PADDLE_PRICE_ID_PLUS);
}

// What each on-sale plan is SOLD at right now, for `iap/prices` — display data
// for the web client's price preview, never an input to a charge (see the
// endpoint's contract note). A plan with nothing configured in this env drops
// out of the array rather than reporting an empty id: the client then shows the
// base price, and the operator hears about the gap from the 500
// createPaddleTransaction already throws, which is the surface that can act on
// it.
export function onSalePaddlePrices(env: Bindings): IapPricesResponse['prices'] {
  const prices: IapPricesResponse['prices'] = [];
  for (const plan of AVAILABLE_PAID_PLANS) {
    const [priceId] = configuredPriceIds(env, plan);
    if (priceId) prices.push({ plan, priceId });
  }
  return prices;
}

// The authoritative price → plan lookup. Pro is checked first so that a
// subscription somehow carrying prices from both plans resolves to the higher
// one — the same "best plan wins" bias as the fold, and never the cheaper one.
function planOfPaddlePrices(env: Bindings, priceIds: string[]): PaidPlan | null {
  const carries = (configured: string | undefined): boolean => {
    const ids = paddlePriceIds(configured);
    return priceIds.some((id) => ids.includes(id));
  };
  if (carries(env.PADDLE_PRICE_ID_PRO)) return 'pro';
  if (carries(env.PADDLE_PRICE_ID_PLUS)) return 'plus';
  return null;
}

// Apply one Paddle subscription snapshot — the shared core of BOTH directions:
// a pushed `subscription.*` webhook event (applyPaddleEvent) and a pulled
// refetch (refreshPurchase). Paddle's webhook `data` and its
// GET /subscriptions/{id} `data` are the same entity (lib/paddle.ts), so there
// is deliberately one normalization + upsert here rather than a pull path that
// drifts from the push path.
//
// `occurredAt` orders the write against stored state (the repo's out-of-order
// guard): the event's `occurred_at` for a webhook, fetch time for a refetch —
// a value we just read from Paddle is newer than any event that already
// happened. The residual risk is clock skew between Paddle and the edge, which
// is seconds against a guard that only cares about ordering minutes apart.
//
// Anything unappliable is returned as a typed failure and LOGGED, never thrown:
// the webhook route must 200 regardless, or Paddle redelivers a permanently-
// unappliable event forever.
async function applyPaddleSubscription(
  env: Bindings,
  data: PaddleSubscription,
  occurredAt: number,
  logContext: string,
  // Supplied ONLY by resolveCheckout, where a stored pending checkout names the
  // account (written from the session). Two effects: it binds a first-seen
  // subscription whose custom_data didn't survive, and it suppresses the
  // unrecoverable-drop alert below — that caller retries every debounce window
  // until the TTL, so a drop on this path is not the dead end the token means.
  fallbackUserId?: string,
): Promise<PaddleApplyResult> {
  // Looked up BEFORE the validations below, not because the write needs it yet
  // but because it's what tells a drop apart from a disaster: a drop on a
  // subscription we already have a row for is recoverable (the staleness refresh
  // will re-pull it once the config is fixed), while a drop on a FIRST-SEEN one
  // leaves no row anywhere — nothing to iterate, nothing to notice, and a user
  // who paid. Only the latter gets the alert token. Costs one indexed read on a
  // path that already performs it whenever it succeeds.
  const repo = purchasesRepo(env.DIRECTORY_DB);
  const existing = await repo.findBySourceExternalId('paddle', data.id);
  const fail = (reason: PaddleApplyFailure, detail: string): PaddleApplyResult => {
    const marker = existing || fallbackUserId ? '' : ` ${IAP_DROP}`;
    console.error(`applyPaddleSubscription: ${detail} (${logContext}) [${reason}]${marker}`);
    return { applied: false, reason };
  };

  const status = normalizePaddleStatus(data.status);
  if (!status) return fail('unknown_status', `unknown status "${data.status}" for ${data.id}`);

  // Plan from the subscription's price id — the AUTHORITATIVE mapping (never
  // custom_data, which any client could set). Configured per env since sandbox
  // and live Paddle mint different pri_… ids.
  const priceIds = (data.items ?? []).map((i) => i.price?.id).filter((id) => id != null);
  const plan = planOfPaddlePrices(env, priceIds);
  if (!plan) return fail('unknown_price', `no known price in [${priceIds}] for ${data.id}`);

  // Bind the subscription to an account: the STORED binding wins (first sight is
  // for life — see the repo's upsert note); a first-seen subscription binds to
  // the userId our checkout stamped into custom_data.
  const userId = existing?.userId ?? data.custom_data?.userId ?? fallbackUserId;
  if (!userId) return fail('unbound', `no userId for ${data.id}`);

  const periodEndsAt = paddleTimeToMs(data.current_billing_period?.ends_at);
  // Cancellation is either effective (canceled_at) or scheduled for period end
  // (scheduled_change.action === 'cancel'); computed to null when neither, and
  // the upsert OVERWRITES with null so a resumed subscription clears it.
  const canceledAt =
    paddleTimeToMs(data.canceled_at) ??
    (data.scheduled_change?.action === 'cancel'
      ? paddleTimeToMs(data.scheduled_change.effective_at)
      : null);
  // An IMMEDIATE cancellation (refund/chargeback — Paddle's effective_from
  // 'immediately') ends entitlement at canceled_at, but the event DROPS
  // current_billing_period, and the upsert's COALESCE would then keep the
  // stale period end — entitling a refunded user to the rest of the period.
  // Clamp: for a canceled subscription the entitlement runs to the EARLIER of
  // the period end and the cancellation time (a period-end cancel has
  // canceled_at ≈ period end, so this is a no-op there).
  const expiresAt =
    status === 'canceled' && canceledAt !== null
      ? Math.min(periodEndsAt ?? canceledAt, canceledAt)
      : periodEndsAt;

  await repo.upsertFromProvider({
    id: newId(),
    userId,
    source: 'paddle',
    externalId: data.id,
    plan,
    status,
    providerCustomerId: data.customer_id ?? null,
    expiresAt,
    canceledAt,
    eventOccurredAt: occurredAt,
  });
  return { applied: true };
}

// Apply one verified Paddle subscription.* event (signature already checked in
// the route). Log-and-drop, never throw — see applyPaddleSubscription.
// Idempotency and out-of-order safety live in the repo upsert.
export async function applyPaddleEvent(env: Bindings, event: PaddleEvent): Promise<void> {
  if (!event.event_type.startsWith('subscription.')) return; // only ever subscribed to these

  const occurredAt = paddleTimeToMs(event.occurred_at);
  if (occurredAt === null) {
    console.error(`applyPaddleEvent: bad occurred_at "${event.occurred_at}" (${event.event_id})`);
    return;
  }

  const result = await applyPaddleSubscription(env, event.data, occurredAt, event.event_id);

  // The happy path's cleanup: this subscription's pending checkout has done its
  // job, and `purchases` is the durable record from here on. `transaction_id` is
  // carried by `subscription.created` alone (lib/paddle.ts), which is precisely
  // the event that retires a row — a later event's id, if Paddle ever adds one,
  // would name a renewal transaction we never inserted, so the delete would find
  // nothing.
  //
  // Gated on `applied`: an UNAPPLIED event is the exact permanent drop this row
  // exists to retry (we ACKed it, so Paddle will never resend), and deleting
  // here would hand that hole straight back — plus re-arm IAP_DROP_UNRECOVERABLE
  // for a case that is in fact still recoverable. Best-effort like the write in
  // createPaddleTransaction: the route must 200, and a cleanup that doesn't
  // happen only leaves a row the TTL will sweep.
  if (result.applied && event.data.transaction_id) {
    try {
      await paddleCheckoutsRepo(env.DIRECTORY_DB).delete(event.data.transaction_id);
    } catch (e) {
      console.error(
        `applyPaddleEvent: could not clear checkout ${event.data.transaction_id} ` +
          `(${event.event_id})`,
        e,
      );
    }
  }
}

// Create a Paddle transaction for the authed user to open in the overlay
// checkout. Server-created so the webhook's account binding
// (`custom_data.userId`) is stamped from the SESSION — the client never knows
// its own userId (it's server-minted) — and so the purchased price is the
// server's configured pri_… id, never a client-supplied one.
export async function createPaddleTransaction(
  env: Bindings,
  userId: string,
  plan: PaidPlan,
): Promise<string> {
  // Guard the double-subscription hole: a second checkout from an already-
  // entitled account would mint a SECOND live Paddle subscription (double
  // billing) — a plan change is a subscription UPDATE (proration), a separate
  // flow. The UI hides upgrade cards on paid plans too.
  // Refreshes: this is the one read where a stale row costs the USER money (a
  // subscriber whose renewal event was lost would be waved through to a second
  // subscription), and the path is already outbound + tight-rate-limited.
  const current = await getSubscriptionStatus(env, userId, { refresh: true });
  if (current.plan !== 'free') {
    throw new HttpError(409, 'already_subscribed', 'This account already has a subscription');
  }

  const repo = paddleCheckoutsRepo(env.DIRECTORY_DB);
  const now = Date.now();

  // The guard above can only see subscriptions that EXIST, so it is blind to the
  // other half of the hole: two checkouts created before either is paid. Reuse
  // this account's own fresh transaction for the same plan instead of minting a
  // second payable one (CHECKOUT_REUSE_MS). This is what makes the endpoint
  // idempotent across a double-click, two tabs, or a retry — the client gets one
  // `txn_…`, and one transaction cannot be paid twice.
  //
  // A row for a DIFFERENT plan falls through to a new transaction: refusing it
  // would strand someone who abandoned a Plus checkout and came back for Pro.
  // That leaves both payable, which is the same gap the plan-change flow has to
  // close — and it is unreachable while one plan is on sale (docs/iap.md).
  //
  // Best-effort, like the record below: if the table can't be read we mint,
  // which is exactly the old behaviour. Failing a paying customer's checkout
  // because a dedupe read blipped would trade a rare double-charge for a certain
  // lost sale.
  try {
    const pending = await repo.listPendingByUserId(userId);
    const reusable = pending.find((c) => c.plan === plan && now - c.createdAt < CHECKOUT_REUSE_MS);
    if (reusable) return reusable.transactionId;
  } catch (e) {
    console.error(`createPaddleTransaction: could not read pending checkouts for ${userId}`, e);
  }

  // The STOREFRONT side of the price list: sell the first configured id. The
  // read side accepts every id in the list (see paddlePriceIds); exactly one of
  // them is on sale, and it is the front of the list.
  //
  // A missing var used to reach Paddle as `price_id: undefined` and fail there
  // as an opaque 502; naming it here turns a config gap into a log line that
  // says which var is empty in which env.
  const [priceId] = configuredPriceIds(env, plan);
  if (!priceId) {
    console.error(`createPaddleTransaction: no price configured for plan "${plan}"`);
    throw new HttpError(500, 'not_configured', 'This plan is not available for purchase');
  }

  const res = await fetch(`${env.PADDLE_API_BASE}/transactions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.PADDLE_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      items: [{ price_id: priceId, quantity: 1 }],
      custom_data: { userId },
    }),
  });
  if (!res.ok) {
    console.error(`createPaddleTransaction: Paddle API ${res.status}`);
    throw new HttpError(502, 'paddle_unavailable', 'Could not reach Paddle, please retry');
  }

  const body = (await res.json()) as { data?: { id?: string } };
  if (!body.data?.id) {
    console.error('createPaddleTransaction: no transaction id in Paddle response');
    throw new HttpError(502, 'paddle_unavailable', 'Could not reach Paddle, please retry');
  }
  const transactionId = body.data.id;

  // Record the txn_… before handing it to the client: it is the ONLY key that
  // can re-find this purchase if the subscription webhook never lands (see the
  // pending-checkouts section above). Best-effort — this is a backstop, and
  // failing the user's checkout because the backstop couldn't be written would
  // trade a rare recovery for a certain outage. The stale sweep rides along on
  // the write we're already doing.
  try {
    await repo.create({ transactionId, userId, plan, createdAt: now });
    await repo.deleteStale(userId, now - CHECKOUT_TTL_MS);
  } catch (e) {
    console.error(`createPaddleTransaction: could not record checkout ${transactionId}`, e);
  }

  return transactionId;
}

// Mint a Paddle customer-portal session (payment method, invoices, cancel) for
// the authed user's Paddle subscription. Server-side because it needs the
// secret API key + the stored ctm_… id; the client just opens the URL.
export async function createPaddlePortalSession(env: Bindings, userId: string): Promise<string> {
  const purchases = await purchasesRepo(env.DIRECTORY_DB).listByUserId(userId);
  const paddle = purchases.find((p) => p.source === 'paddle' && p.providerCustomerId !== null);
  if (!paddle) {
    throw new HttpError(404, 'no_paddle_subscription', 'No Paddle subscription on this account');
  }

  const res = await fetch(`${env.PADDLE_API_BASE}/customer-portal-sessions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.PADDLE_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ customer_id: paddle.providerCustomerId }),
  });
  if (!res.ok) {
    console.error(`createPaddlePortalSession: Paddle API ${res.status}`);
    throw new HttpError(502, 'paddle_unavailable', 'Could not reach Paddle, please retry');
  }

  const body = (await res.json()) as { data?: { urls?: { general?: { overview?: string } } } };
  const url = body.data?.urls?.general?.overview;
  if (!url) {
    console.error('createPaddlePortalSession: no overview url in Paddle response');
    throw new HttpError(502, 'paddle_unavailable', 'Could not reach Paddle, please retry');
  }
  return url;
}

// --- store IAP (bracemark-expo) -------------------------------------------------

// Fetch a store subscription's authoritative state (the token is only a lookup
// key — see the trust-model notes in lib/appstore.ts / lib/playstore.ts).
async function fetchStoreSubscription(
  env: Bindings,
  source: StoreSource,
  token: string,
): Promise<StoreSubscriptionSnapshot | null> {
  return source === 'appstore'
    ? fetchAppstoreSubscription(env, token)
    : fetchPlaystoreSubscription(env, token);
}

// How far to follow a replacement chain. Chains are Z→Y→X and each hop is
// normally retired as it happens (one hop per purchase), so >1 only matters when
// an earlier hop's event was missed entirely. A cap keeps a malformed or cyclic
// chain from turning one purchase into unbounded work.
const MAX_SUPERSEDE_HOPS = 5;

// Retire the purchase token(s) a Play purchase REPLACED (lib/playstore.ts,
// linkedExternalId). Play is the only provider that re-keys a subscription on a
// plan change, so this has no appstore/paddle sibling — and because the old
// token keeps resolving as valid at Google, nothing else in the system can
// discover it: the staleness backstop never re-asks about a row that still
// reads active with a future expiry (needsRefresh, above). Without this:
//   - a DOWNGRADE leaves the old higher-plan row entitled, and the fold takes
//     the best plan — the user pays plus and keeps pro until the old period
//     would have ended (a year, on an annual plan);
//   - a RE-SIGNUP while signed into a second Bracemark account leaves both accounts
//     entitled on one payment, which `purchase_bound` cannot catch because the
//     two rows have different tokens.
//
// Walks the chain through STORED rows — each row keeps the token it replaced,
// so the common case costs one indexed read per hop and no outbound call. The
// fetch is only a bridge across a hop we never recorded (its verify never
// landed): there is no row to retire there, but the chain may continue past it
// to one we did record.
//
// Never throws. The caller has either just recorded a paid entitlement (verify)
// or must ACK a notification, and neither should fail over this. A failure is
// logged with the alert marker instead, because nothing downstream will retry
// it — the operator has the token to retire by hand.
async function supersedeLinkedPlayPurchase(
  env: Bindings,
  snapshot: StoreSubscriptionSnapshot,
  now: number,
): Promise<void> {
  let token = snapshot.linkedExternalId ?? null;
  if (!token) return;

  const repo = purchasesRepo(env.DIRECTORY_DB);
  try {
    for (let hop = 0; token && hop < MAX_SUPERSEDE_HOPS; hop++) {
      const row = await repo.findBySourceExternalId('playstore', token);
      if (row) {
        await repo.supersedeByExternalId('playstore', token, now);
        console.log(
          `supersedeLinkedPlayPurchase: retired playstore ${token} (user ${row.userId}, ` +
            `replaced by ${snapshot.externalId})`,
        );
        token = row.linkedExternalId;
        continue;
      }
      // Unrecorded hop — ask Google what IT replaced, to keep walking.
      const bridged = await fetchPlaystoreSubscription(env, token);
      token = bridged?.linkedExternalId ?? null;
    }
  } catch (e) {
    console.error(
      `supersedeLinkedPlayPurchase: could not retire playstore ${token} ` +
        `(replaced by ${snapshot.externalId}) ${IAP_DROP}`,
      e,
    );
  }
}

// The `iap/verify` seam: the app hands over its store's proof of purchase
// (App Store transaction id / Play purchase token), the server fetches the
// authoritative state from the store's API, records the purchase bound to the
// SESSION's account, and returns the fresh fold. Unlike Paddle — where checkout
// carries our userId straight to the webhook — a store purchase is a
// client-side event the server only learns about here, so THIS call is what
// binds subscription → account (first sight is for life, same rule as the
// webhook upsert; store notifications carry no account and rely on the binding
// this call created).
export async function verifyStorePurchase(
  env: Bindings,
  userId: string,
  req: IapVerifyRequest,
): Promise<SubscriptionStatus> {
  let snapshot: StoreSubscriptionSnapshot | null;
  try {
    snapshot = await fetchStoreSubscription(env, req.source, req.token);
  } catch (e) {
    // The store API erring/unreachable is retryable — mirror paddle_unavailable.
    console.error(`verifyStorePurchase: ${req.source} fetch failed`, e);
    throw new HttpError(502, 'store_unavailable', 'Could not reach the store, please retry');
  }
  if (!snapshot) {
    throw new HttpError(422, 'invalid_receipt', 'The store did not recognize this purchase');
  }

  // Plan from the STORE's productId (never the request's — that field is
  // advisory, the same never-trust-custom_data rule as the Paddle price map).
  const plan = planOfStoreProduct(snapshot.productId);
  if (!plan) {
    console.error(`verifyStorePurchase: unknown product "${snapshot.productId}"`);
    throw new HttpError(422, 'invalid_receipt', 'The store did not recognize this purchase');
  }

  // First sight binds the subscription to this account for life. A replay of
  // someone else's token can't re-point it (the upsert never updates user_id);
  // surface the conflict instead of silently recording a row the caller's fold
  // will never include.
  const repo = purchasesRepo(env.DIRECTORY_DB);
  const existing = await repo.findBySourceExternalId(req.source, snapshot.externalId);
  if (existing && existing.userId !== userId) {
    throw new HttpError(
      409,
      'purchase_bound',
      'This store subscription is already linked to another Bracemark account',
    );
  }

  // The store-side half of the double-subscription guard — deliberately a
  // DETECTOR, not the 409 createPaddleTransaction throws. The asymmetry is real,
  // not an oversight: checkout can refuse because it runs BEFORE any money
  // moves, while a store purchase is already CHARGED by the time verify hears
  // about it. Refusing here would leave the customer paid-for-nothing — the app
  // never reaches finishTransaction, so Apple replays the transaction forever
  // with nothing refunded, and Play's 3-day fuse revokes a purchase we could
  // simply have honored. Recording it is strictly better for them (the fold
  // takes the best row, so they stay entitled either way); what was missing is
  // that the fold also makes the second charge INVISIBLE. This line is the
  // visibility, and the refund is an operator action.
  //
  // Scoped to OTHER sources on purpose. A same-source pair is either impossible
  // (both stores allow one live subscription per subscription group per store
  // account) or legitimate: Play RE-KEYS on a plan change, so the replacement
  // token's verify necessarily sees the superseded row still entitled — that one
  // is retired a few lines below by supersedeLinkedPlayPurchase, and flagging it
  // here would make the alert fire on every Play upgrade. Only a cross-provider
  // pair is a genuine second charge.
  //
  // Gated on `!existing`, so it fires at the moment the second subscription
  // BINDS rather than on every restore and renewal re-verify afterwards.
  if (!existing) {
    const others = (await repo.listByUserId(userId)).filter((p) => p.source !== req.source);
    const otherFold = foldSubscriptionStatus(others);
    if (otherFold.plan !== 'free') {
      console.error(
        `verifyStorePurchase: ${userId} bought ${req.source} ${snapshot.externalId} while ` +
          `already entitled to ${otherFold.plan} via ${otherFold.source} — ${IAP_DOUBLE_SUB}`,
      );
    }
  }

  await repo.upsertFromProvider({
    id: newId(),
    userId,
    source: req.source,
    externalId: snapshot.externalId,
    plan,
    status: snapshot.status,
    providerCustomerId: null,
    expiresAt: snapshot.expiresAt,
    canceledAt: snapshot.canceledAt,
    linkedExternalId: snapshot.linkedExternalId,
    // State fetched later is newer — fetch time orders refetch-based writes
    // (verify + notifications), the same axis Paddle's occurred_at orders.
    eventOccurredAt: Date.now(),
  });

  // Retire whatever this purchase replaced — AFTER the 409 above, so a token
  // already bound elsewhere can't be used to retire rows on the way to being
  // rejected, and after the upsert, so the new entitlement is recorded first.
  await supersedeLinkedPlayPurchase(env, snapshot, Date.now());

  // Play's 3-day acknowledgement deadline, closed from the server side the
  // moment the entitlement is recorded (lib/playstore.ts has the full argument).
  // Gated on Google's own acknowledgementState, so a restore — whose purchase
  // was acknowledged long ago — makes no call. Best-effort by design: the app
  // acknowledges too, via the `finishTransaction` it makes as soon as this call
  // returns, and applyStoreNotification retries off the same flag, so a failure
  // here costs nothing that isn't covered. Never let it fail a purchase the
  // server has already recorded.
  if (req.source === 'playstore' && snapshot.needsAcknowledge) {
    try {
      await acknowledgePlaystorePurchase(env, snapshot.productId, snapshot.externalId);
    } catch (e) {
      console.error(`verifyStorePurchase: acknowledge failed for ${snapshot.externalId}`, e);
    }
  }

  // Re-read + fold rather than deriving the answer from `snapshot`: the upsert
  // above may legitimately have declined (the out-of-order guard — a store
  // notification for this same subscription can land first), and the account's
  // status is the fold over ALL its rows, so an existing higher-ranked purchase
  // must still win. Same reasoning as getSubscriptionStatus's post-refresh
  // re-read. No `refresh` — the upsert just stamped this row's last_synced_at,
  // so needsRefresh declines it, and paying provider round-trips for the other
  // rows would land on the confirmation screen right after the user paid.
  return getSubscriptionStatus(env, userId);
}

// Apply one store notification by RE-FETCHING authoritative state (call-back
// pattern — the pushed payload is never trusted for facts, so neither route
// needs provider signature verification). Log-and-drop like applyPaddleEvent:
// the notify routes must ACK regardless, or the store redelivers forever.
// `token` is the store's lookup key (App Store originalTransactionId / Play
// purchase token) extracted by the lib decoder.
export async function applyStoreNotification(
  env: Bindings,
  source: StoreSource,
  token: string,
): Promise<void> {
  let snapshot: StoreSubscriptionSnapshot | null;
  try {
    snapshot = await fetchStoreSubscription(env, source, token);
  } catch (e) {
    // The store API being down is the one case worth a redelivery — rethrow so
    // the route non-200s and the store retries later.
    console.error(`applyStoreNotification: ${source} fetch failed`, e);
    throw e;
  }
  if (!snapshot) {
    console.error(`applyStoreNotification: ${source} lookup resolved nothing`);
    return;
  }

  const plan = planOfStoreProduct(snapshot.productId);
  if (!plan) {
    console.error(`applyStoreNotification: unknown product "${snapshot.productId}"`);
    return;
  }

  // Retire whatever this purchase replaced. Deliberately BEFORE the binding
  // check below: supersession is a fact about the replaced token, true whether
  // or not the REPLACEMENT is bound to an account here. A Play upgrade
  // notification that beats the app's `iap/verify` would otherwise drop out at
  // that check and leave the old row entitled. Safe against a forged push, for
  // the usual call-back reason — the link comes from Google's answer, not the
  // pushed payload.
  await supersedeLinkedPlayPurchase(env, snapshot, Date.now());

  // Notifications carry no account: the binding must already exist from the
  // purchase-time `iap/verify`. A notification for a never-verified
  // subscription is dropped — the app's verify (or the next notification after
  // it) records it.
  //
  // LOG, not error: on a FIRST purchase this is the ordinary case, not a fault.
  // Both stores emit the notification when THEIR backend completes the purchase,
  // while verify additionally needs the result to reach the device and the
  // device to reach us — so the push routinely wins the race. Nothing here is
  // actionable either: this line cannot tell that benign race apart from a
  // purchase that never gets verified at all, and both already have owners (the
  // app's verify; failing that, Play's 3-day acknowledge fuse auto-refunding, or
  // a later "Restore purchases" on the App Store). Kept at error it would fire
  // on a large share of all first store purchases and drown IAP_DROP.
  const repo = purchasesRepo(env.DIRECTORY_DB);
  const existing = await repo.findBySourceExternalId(source, snapshot.externalId);
  if (!existing) {
    console.log(`applyStoreNotification: no binding yet for ${source} ${snapshot.externalId}`);
    return;
  }

  await repo.upsertFromProvider({
    id: newId(),
    userId: existing.userId,
    source,
    externalId: snapshot.externalId,
    plan,
    status: snapshot.status,
    providerCustomerId: null,
    expiresAt: snapshot.expiresAt,
    canceledAt: snapshot.canceledAt,
    linkedExternalId: snapshot.linkedExternalId,
    eventOccurredAt: Date.now(),
  });

  // The convergent retry for Play's 3-day acknowledge fuse: if both
  // purchase-time acknowledgements failed (the server's 5xx'd AND the client
  // died before `finishTransaction`), the purchase RTDN and the staleness
  // refresh land here with Google still reporting the purchase unacknowledged.
  // Only for a purchase we have RECORDED (the binding check above) — an
  // unbound purchase's revoke-after-3-days is Google refunding a payment we
  // never entitled, which is the right outcome. Best-effort like the verify
  // path: never fail (the route must ACK) over it.
  if (source === 'playstore' && snapshot.needsAcknowledge) {
    try {
      await acknowledgePlaystorePurchase(env, snapshot.productId, snapshot.externalId);
    } catch (e) {
      console.error(`applyStoreNotification: acknowledge failed for ${snapshot.externalId}`, e);
    }
  }
}
