// The subscription plans and what each one entitles — the single source of truth
// both edges read: the CLIENT paywall UI
// derives feature gates and upsell copy from `entitlementsOf(plan)`, and the
// SERVER quota gate (bracemark-api lib/quota.ts, applied at `files/sign`) enforces
// the same numbers. Defining the limits once here is the same move as
// LINK_TITLE_MAX in sync/entities.ts: the place that enforces a limit and the
// place that displays it can never drift apart.
//
// What's enforceable where is deliberately asymmetric (the E2E trust model):
// content is opaque to the server, but PATHS are not — so the server COULD hard-
// enforce anything countable blind, while per-feature gates (read-mode,
// screenshot, the page-copy meter) can only ever be client-enforced UX backed by
// the blob rules. What the server CANNOT do is tell one `files/` blob from
// another: a preview image, a screenshot, and a page copy are all opaque
// `files/{id}.enc` under the same namespace, so there is no server-visible signal
// to allow the free preview image while denying a heavy blob. The free tier
// therefore stores `files/` blobs, bounded server-hard only by the byte/count
// backstop (maxBytes, maxFiles); the heavy-blob distinction is client-enforced.
//
// Of what the server COULD count, it now counts only what it must: maxBytes and
// maxFiles, the ceilings whose bypass is an unbounded R2 bill. `maxLinks` is
// countable and is NOT counted — a link-cap bypass costs a few hundred KB and is
// bounded by maxBytes anyway, and enforcing it blind dragged in a create-vs-update
// existence check, a partial-push retry in the sync engine, and a sync state for
// partial refusals. So the hard walls sit exactly where the COST is, not
// everywhere the server can see; a client-side bypass unlocks features that cost
// ~nothing to serve, and one conversion lever we chose to run on the honor system.
//
// So the entitlements below split into two kinds of gate:
//   - COST-DEFENSIVE (maxLinks, maxPageCopies, maxFiles, maxBytes,
//     serverExtraction) — protect real cost / the moat; server-hard where
//     countable.
//   - VALUE-CAPTURE (locks, nestedLists, searchEditor, smartLists,
//     savedSearches, aiTier) — pure willingness-to-pay for things that cost
//     ~nothing to serve; all client-enforced. Their spine: Plus unlocks
//     STRUCTURAL organization (nested lists today, plus the planned tag-hierarchy
//     + per-list-link-order levers — see the PLANNED, NOT YET GATED note
//     below) + the structured search editor + privacy; Pro unlocks AUTOMATED /
//     dynamic organization + intelligence (it arranges itself).
// What is deliberately NOT an entitlement stays free for everyone: theme, FLAT
// tags, flat lists, pin, sort options, MANUAL reorder of list/tag SIBLINGS (and
// of pinned links), multi-select move/tag/delete, and full data export — habit-
// loop, table-stakes, or anti-lock-in, so never gated. Sibling/tree/pin order is
// free across the board: at the free tier's scale (≤200 links, a handful of
// lists/tags) hand-arranging is a cheap habit-loop nicety with ~no willingness-
// to-pay, and pins already give free hand-ordering of links.
//
// PLANNED, NOT YET GATED: two more Plus value-capture levers that are NOT yet
// entitlement fields here, because the product decision is still open (they ship
// on user feedback, not at launch):
//   - tag HIERARCHY (nested tags) — the tag analog of nestedLists; only DEPTH is
//     the lever, FLAT tags stay free (above).
//   - per-list manual LINK ordering — a hand-curated sequence WITHIN a list
//     (distinct from the free sibling/tree order); Plus-worthy only because it
//     pays off past the free tier's link ceiling.
// When either ships, add a `tagHierarchy` / `linkOrdering` boolean below
// (free:false, plus:true, pro:true — mirroring nestedLists).
//
// Three further things are NOT entitlements — a monthly cadence, a free trial,
// and the lifetime launch lever.
// All three now have constants below, and all three follow the same rule as Pro:
// the CATALOG is fully specified here, the STOREFRONT is a separate, smaller
// list. None of them changes this table, because none of them changes what a
// plan unlocks:
//   - MONTHLY is a second billing CADENCE of the same plan, not a plan. It lives
//     in PLAN_USD_PER_MONTH + AVAILABLE_CADENCES, and shipping it is checkout-
//     contract + catalog work (a second `pri_…` per plan, a second store SKU) —
//     see docs/iap.md, _open follow-ups_.
//   - a TRIAL is a subscription STATE: a trialing account is entitled to exactly
//     `plus`, so entitlementsOf() is already correct for it and the fold already
//     treats `trialing` as entitled. Only its LENGTH is data (TRIAL_DAYS). A
//     trial that LAPSES drops every gate below back to free — except the two
//     storage ceilings, which stick at the high-water plan so the library the
//     trial imported stays writable (see maxFiles/maxBytes).
//   - LIFETIME is a one-time purchase of the `plus` entitlement with no expiry —
//     the fold's `expiresAt: null` case. It is a PRICE and a policy, not a tier.

export const PLANS = ['free', 'plus', 'pro'] as const;
export type Plan = (typeof PLANS)[number];

// Paid plans, lowest first — the full paid CATALOG. `PLANS` minus 'free'.
export const PAID_PLANS = ['plus', 'pro'] as const;
export type PaidPlan = (typeof PAID_PLANS)[number];

// The paid plans actually ON SALE right now — the launch subset the checkout
// contract (iap/endpoints.ts) and the upgrade cards enumerate. Pro is fully
// specified in this file (its entitlements, price, and the server's Paddle price
// branch are all the spec-in-waiting) but not yet SOLD: it goes on sale once the
// automated-organization features (smartLists / savedSearches) exist to back it.
// Putting Pro on sale is then a ONE-LINE change here — add 'pro' — and nothing
// else about the plan moves. Kept separate from PAID_PLANS (the full catalog) so
// `entitlementsOf('pro')`, PLAN_USD_PER_YEAR['pro'], and manual 'pro' grants all
// stay valid while Pro is off the storefront.
export const AVAILABLE_PAID_PLANS = ['plus'] as const;
export type AvailablePaidPlan = (typeof AVAILABLE_PAID_PLANS)[number];

export type AiTier = 'none' | 'basic' | 'full';

// What a plan unlocks. `null` on a numeric limit means unlimited.
export type Entitlements = {
  // Max `links/` entries (the free-tier keystone: 200 links is a serious trial
  // but past "free forever"). CLIENT-enforced: every create surface refuses at
  // the cap (web-react's useLinkQuota, expo-react's isAtLinkCap, the import
  // gate), and bracemark-api does NOT count links — see the honor-system note in
  // this file's header. `null` on paid plans.
  maxLinks: number | null;
  // Saved-page-copy meter (Plus keeps the last 50; Pro unlimited) — the count of
  // `pageCopy` extraction blobs, NOT a cap on how many links may sit in the
  // Archive system list (an unrelated concept that used to share the word). CLIENT-
  // enforced only: a page copy is indistinguishable from any other `files/` blob
  // server-side; the byte quota is the backstop.
  maxPageCopies: number | null;
  // Hard object-count cap — an abuse bound, not a product lever (see the byte
  // ceiling for what actually bites). It counts PATHS, not links, and the server
  // counts them namespace-blind: a link is 2 objects (`links/` + `extractions/`)
  // before its preview image makes 3, so 5 000 files is ~1 600-2 500 links, not
  // 5 000.
  //
  // What it guards is NOT the R2 bill — R2 bills stored bytes and class-A/B
  // operations, never object COUNT — but the per-user DO, which holds one
  // `file_sizes` row per path (bracemark-api do/repositories/file-sizes.ts).
  // `maxBytes` below is the ceiling denominated in money, so it is the one meant
  // to bind first, and the paid number is sized so it does; the note on the Plus
  // value has the arithmetic and what went wrong when it wasn't.
  maxFiles: number;
  // Total stored bytes (the storage quota). The real
  // server-hard wall on EVERY plan — and, with maxFiles, now the ONLY one: it is
  // what bounds preview-image blob storage on free, and what bounds a client
  // that ignores the honor-system link cap. A maxed 200-link free library of
  // client-extracted preview images is ~16 MB, well under the free ceiling.
  maxBytes: number;
  // NOT RETROACTIVE — the two ceilings above are the one part of this table the
  // server does NOT resolve from the account's CURRENT plan. It resolves them
  // from the highest plan the account has ever held (services/iap.ts
  // `foldQuotaCeilings`), so a library uploaded while entitled never becomes
  // unwritable when the entitlement ends. Everything else here — maxLinks, every
  // feature flag — snaps straight back to `free` on a downgrade, which is the
  // conversion pressure; the ceilings are a cost backstop and were never doing
  // that job. See lib/quota.ts and docs/iap.md, _enforcement_.
  // Whether the account MAY opt in to `bracemark-extractor` (the separate synced
  // `serverExtraction` preference in settingsGeneralSchema is the user's opt-in;
  // this is the plan gate over it).
  serverExtraction: boolean;

  // --- Value-capture gates (all CLIENT-enforced) --------------------------
  // Pure willingness-to-pay; a client-side bypass only ever unlocks a
  // convenience that costs ~nothing to serve (same acceptable-risk logic as the
  // page-copy meter above).

  // Nested lists/folders (Plus+) — the "manual organization" Plus lever, gating
  // a STRUCTURAL capability (depth/reparenting), not cosmetic order. Free stays
  // fully usable on flat lists + tags; paid organizes deeper — never
  // "un-crippled." (Manual sibling ORDER — drag / up-down / pin order — is NOT
  // gated; see the header note on why manual ordering is free across the board.)
  nestedLists: boolean;
  // App lock + per-list hide — the privacy-wedge lever (Plus+). E2E encryption
  // stays FREE for everyone; this is the convenience layer over it (biometric
  // quick-lock, hide-a-list), not the security substrate, so gating it is not
  // gating privacy.
  locks: boolean;
  // Structured search editor (Plus+) — the middle rung of the search ladder.
  // Free already gets real word search across the WHOLE library (title / url /
  // host); that basic rung is NOT gated (gating it would cripple a daily-loop
  // basic). This gates only the EDITOR: field-scoped (url vs title), multi-list
  // / multi-tag, boolean queries. Client-side, so it costs ~nothing to serve,
  // and it couples to unlimited links the same way per-list ordering does. Pro
  // then persists these queries as `savedSearches` — Basic → structure-by-hand
  // → automated mirrors the Free → Plus → Pro spine.
  searchEditor: boolean;
  // Smart lists & smart tags (Pro) — the "it organizes itself" half of the Pro
  // story. A saved RULE that auto-POPULATES from metadata the user already set
  // (domain, existing tags, dates): a smart list is a query promoted to the
  // lists tree, a smart tag is a virtual/computed tag whose membership is a
  // rule. Deterministic, runs on the client's local decrypted store (no server,
  // no plaintext leak) — which is why it needs NO AI: buildable whenever, not
  // blocked on on-device-model quality (a readiness point, not a ship date — Pro
  // is SEQUENCED after the Free+Plus launch, built once the app is stable, not
  // live now). Explicitly NOT AI auto-
  // tagging: it never WRITES `listId`/`tagIds` onto a link, and it infers
  // nothing from page CONTENT. Auto-choosing a list / auto-adding tags from
  // content is `aiTier` (parked) — kept a separate entitlement on purpose so
  // the two never get conflated.
  smartLists: boolean;
  // Saved searches (Pro) — same predicate-over-local-store engine as smartLists,
  // just surfaced in the search UI (an ad-hoc query, remembered) rather than
  // promoted into the lists/tags taxonomy. Same automated-org spine.
  savedSearches: boolean;
  // On-device AI — the future Pro lever (auto-tag/keywords → summaries/semantic
  // search). Client-enforced (runs on-device). PARKED for now: on-device models
  // aren't good enough yet, so every plan ships `'none'` and AI is marketed as
  // "coming." When it lands it belongs wholly to Pro (all intelligence lives in
  // Pro); Plus is already carried by locks + nested lists.
  aiTier: AiTier;
};

const MIB = 1024 * 1024;
const GIB = 1024 * MIB;

// The entitlements, as data — minus the two rows noted in the header (tag
// hierarchy, per-list link order), planned Plus levers not yet gated. Numbers are
// planning values — tune here and both edges follow.
const ENTITLEMENTS: Record<Plan, Entitlements> = {
  free: {
    maxLinks: 200,
    maxPageCopies: 0,
    // A maxed 200-link library of client-extracted preview images is ~16 MB;
    // maxFiles here is a pure abuse backstop (links + preview-image blobs +
    // lists/tags/pins/extractions ride along, never legitimately near this).
    maxFiles: 5_000,
    maxBytes: 100 * MIB,
    serverExtraction: false,
    nestedLists: false,
    locks: false,
    searchEditor: false,
    smartLists: false,
    savedSearches: false,
    aiTier: 'none',
  },
  plus: {
    maxLinks: null,
    maxPageCopies: 50,
    // 1 000 000, and it was 200 000. Which ceiling binds depends on whether a
    // library carries preview images, and only one of the two answers was
    // defensible. WITH them a link is ~100 KB over 3 files (PREVIEW_MAX_DIMENSION
    // 1024 at PREVIEW_JPEG_QUALITY 0.82 — image/preview.ts), so maxBytes binds
    // first at ~50 000 links and this cap never fires. WITHOUT them — an import
    // of bare URLs, nothing extracted — a link is ~2.5 KB over 2 files, so
    // 200 000 refused the account at ~100 000 links while it was holding 250 MB
    // of its 5 GiB: an object cap firing at 5% of the ceiling that actually
    // costs us something, which is precisely what lib/quota.ts says this gate is
    // not for. At 1 000 000 the byte ceiling binds first in the shape that has
    // previews and this one binds at ~500 000 links in the shape that doesn't,
    // both far above any real library — which is what lets the storefront say
    // "Unlimited links" plainly (bracemark-site lib/plans.ts). Not higher,
    // because the DO row count is the thing this number is really bounding.
    maxFiles: 1_000_000,
    maxBytes: 5 * GIB,
    serverExtraction: true,
    // Plus = structural organization.
    nestedLists: true,
    locks: true,
    searchEditor: true,
    smartLists: false,
    savedSearches: false,
    aiTier: 'none',
  },
  pro: {
    maxLinks: null,
    maxPageCopies: null,
    // Same object bound as Plus, for the same reason — what Pro buys is bytes.
    maxFiles: 1_000_000,
    maxBytes: 20 * GIB,
    serverExtraction: true,
    nestedLists: true,
    locks: true,
    searchEditor: true,
    // Pro = automated / dynamic organization + intelligence (it arranges itself).
    smartLists: true,
    savedSearches: true,
    // Set to 'full' once on-device AI ships; parked at 'none' for now.
    aiTier: 'none',
  },
};

export function entitlementsOf(plan: Plan): Entitlements {
  return ENTITLEMENTS[plan];
}

// Display metadata for the plan cards. The PRICES here are the planned list
// prices for copy only ("$48/yr") — the authoritative, localized,
// tax-inclusive price is whatever the Paddle checkout (or the store sheet)
// shows; these must match the BASE price configured in that catalog. Not every
// price in it: both providers carry a per-country price ladder on top of the
// base, and no table in this package tracks those (see PLAN_USD_PER_YEAR).
//
// CHANGING A NUMBER BELOW IS NOT A PRICE CHANGE. These render straight onto the
// upgrade cards (bracemark-web + bracemark-expo subscription-section.tsx), so a value
// that disagrees with the Paddle catalog / App Store product shows the customer
// one price and charges another. Move the catalog FIRST, then this table.
export const PLAN_LABELS: Record<Plan, string> = {
  free: 'Free',
  plus: 'Plus',
  pro: 'Pro',
};

// --- billing cadence ------------------------------------------------------
// A cadence is HOW OFTEN the same entitlement is billed, never what it unlocks —
// so it is deliberately not part of `Plan`, and nothing in ENTITLEMENTS branches
// on it. Same catalog/storefront split as PAID_PLANS vs AVAILABLE_PAID_PLANS.

export const BILLING_CADENCES = ['yearly', 'monthly'] as const;
export type BillingCadence = (typeof BILLING_CADENCES)[number];

// The cadences actually ON SALE. Yearly only at launch, and that is a decision,
// not a stub: a monthly sub pays twelve processor charges instead of one and
// only out-earns annual if it survives twelve months. The harder blocker is that
// switching cadence is the SAME unbuilt subscription-update flow as Plus→Pro
// (docs/iap.md, _open follow-ups_) — so selling monthly before that lands would
// ship a one-way door: monthly→annual with no path but cancel-and-wait.
export const AVAILABLE_CADENCES = ['yearly'] as const;
export type AvailableCadence = (typeof AVAILABLE_CADENCES)[number];

// The BASE price, and the only price this package knows. It is NOT necessarily
// what a given buyer pays: the Paddle catalog carries per-country currency
// prices anchored to this figure, and the App Store / Play consoles generate a
// price per storefront from it. So a buyer's real price is asked of the provider
// at display time — `Paddle.PricePreview` in bracemark-web, `displayPrice` off
// the store product in bracemark-expo — and this table is the fallback for when
// that lookup can't run, plus the honest number for bracemark-site, which has no
// provider to ask and deliberately loads no script that could ask one.
//
// Which is why "$48/yr" is still safe to print here and on the marketing site: a
// country we have not priced locally IS billed this, in dollars. Paddle does not
// convert at an exchange rate — a country is either given a price or given the
// base. The Paddle price is `tax_mode: 'location'`, so in VAT/GST markets this
// figure is the TOTAL, and in sales-tax markets (the US) tax is added at
// checkout. → docs/iap.md, _currency_ and its _tax_ note.
export const PLAN_USD_PER_YEAR: Record<PaidPlan, number> = {
  plus: 48,
  pro: 96,
};

// The monthly list price, for card copy — the same "must match the catalog"
// warning as PLAN_USD_PER_YEAR above. $5.99 against $48/yr makes annual a 33%
// saving, which reads as a real discount; $4.99 would make annual only 20% off
// and the annual plan pointless. Pro's is spec-in-waiting at the same ratio.
export const PLAN_USD_PER_MONTH: Record<PaidPlan, number> = {
  plus: 5.99,
  pro: 11.99,
};

// --- free trial -----------------------------------------------------------
// 14 days, and the length is load-bearing:
// Bracemark's value is cumulative, so a trial has to span at least one full
// weekly usage cycle plus the browser-extension install — a 3-day trial expires
// before the habit that justifies paying has formed. Not a refund strategy: the
// EU/UK statutory withdrawal window runs from the CHARGE date, so a trial that
// converts on day 14 opens a fresh 14-day window then.
export const TRIAL_DAYS = 14;

// The trial rides on the ANNUAL plan only — it funnels conversions into the
// plan that pays ~$48 at once rather than ~$6. Enforced by the Paddle catalog
// (the trial period is configured on the yearly `pri_…`, not in code), so this
// constant is the marketing copy's source, and the checklist item that keeps the
// two in step lives in docs/iap.md.
export const TRIAL_CADENCES = ['yearly'] as const;

// --- lifetime (launch lever) ----------------------------------------------
// $149 once, for `plus` forever. It trades a stream of future renewals for cash
// at the moment cash is scarcest. What it costs is that a lifetime buyer is
// permanently excluded from every future price increase, which is why it is
// capped (LIFETIME_SEATS) and retired rather than standing.
//
// Attached to Plus, never Pro: Plus is the only plan on sale at launch, and
// $149 against $48/yr is a ~3.1-year payback, which reads as a real deal.
// "Lifetime" therefore means Plus's entitlements as they grow — NOT an
// automatic upgrade to Pro, and not Pro's quota.
export const LIFETIME_PLAN = 'plus' satisfies PaidPlan;
export const LIFETIME_USD = 149;

// The cap that makes it urgent — stated on the pricing page, enforced by
// retiring the Paddle product. A standing lifetime offer is the long-tail
// liability; a capped one is a launch lever.
export const LIFETIME_SEATS = 500;

// Off until the checkout can actually take the money. Lifetime is a ONE-TIME
// Paddle transaction, and `applyPaddleEvent` returns early on anything that
// isn't `subscription.*` — `transaction.completed` is deliberately ignored — so
// today a lifetime payment would be accepted and dropped. Flipping this to
// `true` is the last step, after that webhook branch and the Paddle product
// exist; every surface reads this flag rather than deciding for itself, so the
// offer appears everywhere at once or nowhere. See docs/iap.md, _open
// follow-ups_.
// Typed `boolean`, not inferred as the literal `false`: a literal type would let
// every consumer's dead-branch analysis delete the on-sale UI at compile time,
// which turns "flip one flag" into "flip one flag and rediscover what it broke".
export const LIFETIME_ON_SALE = false;

// The plan cards' customer-facing copy — the human rendering of the
// entitlements table above, so it lives HERE rather than in each app: it is plain
// data with no platform types, and every checkout surface (bracemark-web's Paddle
// section, bracemark-expo's store section, any future one) renders the same words.
// It used to be copy-pasted per app under a "keep these VERBATIM in step"
// comment, which is exactly the drift the rest of this file exists to prevent —
// the place that defines a tier and the place that sells it can't disagree if
// there's only one of each.
//
// It is read in TWO directions, which is why the increment rule below matters.
// Facing a buyer it is an UPGRADE card (what the money adds); facing an owner it
// is the "Your plan includes" list on both settings sections' current-plan box
// (what the account has). The second reading is the stricter one — a feature
// promised to someone who has already paid is a support ticket, not a lost sale.
// Four rules when editing:
//   - Only list what actually SHIPS. Reader view, screenshots, page copies, and AI
//     are gated in ENTITLEMENTS above but not yet built, so they are NOT promised
//     here — re-add each line as it lands. At launch Plus is unlimited links +
//     server-side link previews + app lock/hidden lists + the structured search
//     editor.
//   - Every list here is an INCREMENT over the plan below it, never an inventory.
//     Pro says so itself ('Everything in Plus'); Plus's baseline is supplied by
//     whoever renders it — bracemark-site's pricing page has its own `inherits`
//     line, and the two settings sections prepend 'Everything in Free' for the
//     entry paid tier only. Fold a free-tier feature into a list below and it
//     reads as newly bought; drop the prepended line and an owner reads four
//     bullets as the whole of what they have.
//   - Never sell the preview IMAGE. It is free for everyone (a client extracts it
//     at zero cost to us), and this list said "Preview images" for a while from
//     back when it was a paid lever — which read as "free users get no
//     thumbnails", the opposite of what ENTITLEMENTS says. What Plus actually gates is
//     `serverExtraction`, and the honest claim is COVERAGE, not quality: the
//     server is the WORST extractor (`extractedBy: 'server'` is the floor of
//     `tierOf` — see docs/link-extraction.md, _who extracts and what wakes it_),
//     but it lets the web app fill pending previews itself. Free still gets the
//     BEST extractor in the browser extension and free on-device coverage in the
//     mobile app, including synced and imported links when its setting is `all`.
//   - "Unlimited" is fixed, not a word to re-pick. docs/brand-assets.md quotes
//     'Unlimited saved links' — this exact string — as its specimen of the object
//     noun, and /faq and both of bracemark-site's pricing surfaces spell it the
//     same way, so a synonym here ("uncapped", "no limit") forks the vocabulary
//     for one entitlement. What retires the word is a byte ceiling that can bind
//     a real library, and the honest fix then is a clause about stored bytes
//     rather than a quieter adjective — to write when the heavy blobs ship, not
//     before (bracemark-site lib/plans.ts carries the long form).
//   - Pro's copy is kept as spec-in-waiting even though Pro isn't sold: only
//     AVAILABLE_PAID_PLANS get a card, so putting Pro on sale stays the one-line
//     change described above.
export const PLAN_CARD_COPY: Record<PaidPlan, { blurb: string; features: string[] }> = {
  plus: {
    blurb: 'The full visual library',
    // Two fixes, both about a stranger reading this list with a card in hand:
    //
    //   - "Advanced search" is the RIGHT name in the app — it labels the
    //     disclosure that opens the query grammar, one screen over from a plain
    //     text box, and `PaywallFeature.searchEditor` keeps it for exactly that
    //     reason (docs/brand-assets.md — a disclosure is named for what is
    //     behind it). It is the WRONG name here. This list is read by someone
    //     who has never seen the app, next to a price, and everyone arriving
    //     from a paid tier elsewhere decodes "advanced search" as full-text
    //     search inside saved pages. It is not that — the haystack is url ⊕
    //     title (docs/search.md) — and discovering it after paying is the one
    //     failure mode the storefront copy exists to prevent. The comparison
    //     table on /pricing already spelled it accurately; now the card agrees.
    //   - "Nested lists" was missing outright, though `nestedLists` is a plus
    //     entitlement and the paywall has a whole dialog for it. It is also the
    //     one Plus feature a switcher with folders actually needs, so omitting
    //     it understated the card to precisely the buyer it was written for.
    features: [
      'Unlimited saved links',
      'Server link previews in the web app',
      'Nested lists',
      'App lock & hidden lists',
      'Search editor — fields, lists and tags',
    ],
  },
  pro: {
    blurb: 'The permanent offline library',
    features: ['Everything in Plus', 'Full on-device AI — summaries & semantic search'],
  },
};

// The upgrade cards actually rendered: the plans on sale, with their copy. Both
// checkout surfaces map straight over this.
export const PLAN_CARDS: { plan: AvailablePaidPlan; blurb: string; features: string[] }[] =
  AVAILABLE_PAID_PLANS.map((plan) => ({ plan, ...PLAN_CARD_COPY[plan] }));
