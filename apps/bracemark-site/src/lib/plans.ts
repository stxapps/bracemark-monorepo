// The plan LIMITS as this site prints them, derived rather than typed.
//
// /pricing is the only reader, and these two are extracted from it rather than
// left inside it for one reason: a Next.js `page.tsx` is not a module anything
// imports, so a helper defined there cannot be unit-tested. The branch below is
// worth a test — a paid plan's `maxLinks` is `null`, and interpolating that
// without the branch renders "null links" on the card a buyer is reading — so it
// lives in a file a spec can import. `plans.spec.ts` beside this one is that
// test.
//
// The landing page does NOT read these, deliberately, and the boundary is DERIVE
// A NUMBER, CURATE A CLAIM. 200 is a number that moves, so every surface
// printing it interpolates — the landing page through its own `FREE_LINKS`
// const, this file for /pricing, which needs the phrase built per plan because
// its cards map over all of them. "Unlimited" is not a number: it is a curated
// label, typed by hand in `PLAN_CARD_COPY.plus`, in /pricing's meta description
// and in the FAQ, so the landing page types it too rather than computing one
// item of a four-item list. What holds that claim to the entitlement is shared's
// plans.spec.ts, which asserts `maxLinks` is `null` on every paid plan: a Plus
// cap fails the suite where it is introduced, which is louder and earlier than a
// template that silently rewrites itself.
//
// The rule both pages carry in their own headers is upstream of all of it — only
// promise what ships, and never quote a cap the app does not enforce.
//
// The byte ceiling IS here now, but only where it is published:
// `isPublishedStorageCeiling` (shared iap/storage.ts) says which plans that is —
// the ones that keep copies, since screenshots are what can fill a library — and
// `formatStorageCeiling` prints it in the units the app's own readout counts in,
// rounded down. Free's ceiling stays unpublished, for the reason the header of
// `app/pricing/page.tsx` gives. The file ceiling (`maxFiles`) is never printed:
// no honest library reaches it.

import {
  entitlementsOf,
  formatStorageCeiling,
  isPublishedStorageCeiling,
  type Plan,
  PLAN_LABELS,
} from '@stxapps/shared';

/** The cap alone — "Unlimited" or "200" — for a comparison-table cell. */
export function formatLinks(plan: Plan): string {
  const { maxLinks } = entitlementsOf(plan);
  return maxLinks === null ? 'Unlimited' : `${maxLinks}`;
}

/**
 * The cap as a phrase — "Unlimited links" or "200 links". The line of hard
 * limits under a pricing card, and the first item of the landing page's Plus
 * feature list.
 *
 * **"Unlimited", not "uncapped".** `PLAN_CARD_COPY.plus` sells "Unlimited saved
 * links" from the same file the number comes from, /faq answers in the same
 * word, and docs/brand-assets.md quotes that string as its specimen of the
 * object noun — so a synonym here would teach a second vocabulary for one
 * entitlement, which is the failure the terminology table names. It also buys
 * nothing: "uncapped" sounds narrower only to a reader who already knows there
 * is a byte ceiling, and reads identically to everyone else. When the heavy
 * blobs land and that ceiling can actually bind a library, the honest fix is a
 * clause about stored bytes, not a quieter adjective.
 */
export function linksLimitLabel(plan: Plan): string {
  return `${formatLinks(plan)} links`;
}

/**
 * The plan's published storage — "5 GB of storage" — or null where the ceiling
 * is not published (Free). Derived from `maxBytes` like the link cap from
 * `maxLinks`, so a retuned ceiling reprints itself.
 */
export function storageLimitLabel(plan: Plan): string | null {
  const { maxBytes } = entitlementsOf(plan);
  return isPublishedStorageCeiling(maxBytes)
    ? `${formatStorageCeiling(maxBytes)} of storage`
    : null;
}

/**
 * The line of hard limits under a pricing card: every limit that can bind on
 * that plan, and no other. "200 links" on Free, where the link cap binds long
 * before bytes; "Unlimited links · 5 GB of storage" on Plus, where the cap is
 * gone and kept copies are what fill a library.
 */
export function planLimitsLabel(plan: Plan): string {
  return [linksLimitLabel(plan), storageLimitLabel(plan)].filter(Boolean).join(' · ');
}

/**
 * "Plus includes 5 GB of storage" — the clause the note under /pricing's
 * comparison table opens with, or null when no plan in the list publishes a
 * ceiling (then there is no note). The table itself has no storage row, because
 * Free's cell would have nothing true to say: its ceiling is unpublished, and a
 * dash reads as "Free stores nothing". The note carries the number to a reader
 * who skipped the cards and went straight to the table, where "Unlimited" sits
 * in the links row with no ceiling beside it.
 *
 * Takes the storefront's columns rather than naming a plan, so a second paid
 * plan adds its own clause the way it adds its own column.
 */
export function storageIncludedLabel(plans: readonly Plan[]): string | null {
  const clauses = plans.flatMap((plan) => {
    const storage = storageLimitLabel(plan);
    return storage ? [`${PLAN_LABELS[plan]} includes ${storage}`] : [];
  });
  if (clauses.length === 0) return null;
  if (clauses.length <= 2) return clauses.join(' and ');
  return `${clauses.slice(0, -1).join(', ')}, and ${clauses[clauses.length - 1]}`;
}
