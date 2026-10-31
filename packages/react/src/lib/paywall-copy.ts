import type { AvailablePaidPlan } from '@stxapps/shared';

// The words the upgrade dialog prints for every action-triggered value-capture
// gate — a title, a sentence, and the plan whose name the CTA carries. Rendered on
// TWO surfaces, `contexts/paywall-provider.tsx` in each app, which are separate
// components (the native one a hand port of the web one) that had all six strings
// written out twice, character for character, with nothing keeping them together.
//
// Only the WORDS are here, on the rule the copy next door keeps (lock-copy.ts,
// misc-settings-copy.ts). The dialog stays per-platform, and it diverges in more
// than markup: web restores focus to the element that opened the gate and routes
// the CTA through `<Link>`, native has no focus to hand back, pushes the route,
// and drops the dismiss callback on the way out so the caller's own surface does
// not reopen over the Subscription screen.
//
// `plan` travels with the words rather than staying at the call site, because by
// the time the user sees it, it IS words: the CTA reads
// `Upgrade to {PLAN_LABELS[plan]}`, and every description below names the same
// plan in prose. Split across two files, the sentence can promise Plus while the
// button sells Pro. Keep it in sync with the entitlement table in @stxapps/shared
// (iap/plans.ts): the plan named here must actually grant the feature, and the
// copy only promises what is live.
//
// A `Record` for misc-settings-copy.ts's reason — a new gate fails to typecheck
// until it has words.

export type PaywallFeature = 'searchEditor' | 'locks' | 'nestedLists' | 'keptCopies';

export const PAYWALL_COPY: Record<
  PaywallFeature,
  { plan: AvailablePaidPlan; title: string; description: string }
> = {
  // Two names for one entitlement, and this dialog is the only surface that sees
  // both. "Advanced search" is the title because it is what the user just
  // pressed — the disclosure it fires from carries the same words in both apps
  // (the links search bar, web and native), and a disclosure is named for what is
  // behind it (docs/brand-assets.md, _the voice_). The storefront can't use that
  // name: read next to a price by someone who has never opened the app, "advanced
  // search" decodes as full-text search inside saved pages, which this is not — so
  // PLAN_CARD_COPY and /pricing say "Search editor" instead (iap/plans.ts carries
  // that reasoning). Upgrade leads straight to the Subscription section, which
  // renders that card, so the description spends a clause naming the other term
  // rather than leaving the user to match what they were just sold against a line
  // they can't find.
  searchEditor: {
    plan: 'plus',
    title: 'Advanced search',
    description:
      'Field-scoped search across URL and title, with multi-list and multi-tag filters, is a Plus feature — the plan card calls it the “Search editor”. Basic word search stays free.',
  },
  // Covers both app lock (Misc) and per-list locks (Lists) — one `locks`
  // entitlement gates them together.
  locks: {
    plan: 'plus',
    title: 'Locks',
    description:
      'Locking the app, or a single list, on this device is a Plus feature. Your links stay end-to-end encrypted on every plan — this is the convenience layer on top.',
  },
  nestedLists: {
    plan: 'plus',
    title: 'Nested lists',
    description:
      'Nesting a list inside another is a Plus feature. Flat lists and tags stay free and fully usable.',
  },
  // Fired from the browser extension's saved screen (which opens the web app's
  // Subscription section instead of rendering this dialog — it has no paywall of
  // its own) and from the web reader's empty state. The second sentence is the
  // promise iap/plans.ts's `keptCopies` note makes: only TAKING a copy is gated.
  keptCopies: {
    plan: 'plus',
    title: 'Keep a copy',
    description:
      'Keeping the text of a page in read mode, and a screenshot of how it looked, is a Plus feature. Copies you have already kept stay readable on every plan.',
  },
};
