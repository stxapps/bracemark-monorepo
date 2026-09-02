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
// What is NOT here, deliberately: the byte/file storage quota. It is a
// server-hard cost backstop rather than a product gate, and the header of
// `app/pricing/page.tsx` carries the whole argument for leaving it unpublished.

import { entitlementsOf, type Plan } from '@stxapps/shared';

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
