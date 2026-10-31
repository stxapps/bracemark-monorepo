## iap — subscriptions, paywall, entitlements

How a bracemark account buys, holds, and exercises a subscription. See
[api-contracts.md](./api-contracts.md) for the endpoint pattern the IAP contracts
follow and [local-first-sync.md](./local-first-sync.md) for the `files/sign` quota
gate the entitlements feed.

### the two decisions everything else follows from

**1. IAP lives in bracemark-api — not a separate app.** The extractor earned its own
app because it fetches arbitrary user URLs (plaintext content through a server —
the thing "api.bracemark.com only sees ciphertext" must exclude). Billing is not
content: bracemark-api already holds plaintext _account_ metadata (usernames,
`public_key`, sessions), and a subscription row is the same class. Decisively,
bracemark-api is itself the main **consumer** of entitlements — the plan-aware quota
gate runs on its own `files/sign` hot path — so a separate billing service would
put a cross-service read on that path for nothing.

**2. Subscription state is NOT a synced entity.** It is a server-derived fact
whose writer of record is a payment-provider webhook; the server can't write
into the user's encrypted keyspace, so a synced `settings/iap.enc` could only be
a stale, client-authored echo — unverifiable (any client could write
`plan: 'pro'` into its own ciphertext) and racing itself under LWW. Instead,
**`GET /v1/iap/status` is the one authority** and every device caches its
answer (web: `useEntitlements`' localStorage last-known copy, so an offline
start doesn't flash free). Cross-device consistency needs no sync here: any
device that can sync can ask.

### the pieces

| layer          | piece                                    | role                                                                                                                                                                                                             |
| -------------- | ---------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| shared         | `iap/plans.ts`                           | `PLANS`, `entitlementsOf(plan)` — the entitlements as data, read by BOTH the client paywall and the server gate (the `LINK_TITLE_MAX` move)                                                                      |
| shared         | `iap/endpoints.ts`                       | contracts: `iap/status`, `iap/checkout`, `iap/prices`, `iap/portal`, `iap/verify` + `subscriptionStatusSchema`                                                                                                   |
| bracemark-api  | `purchases` table (DIRECTORY_DB)         | one row per provider subscription, `UNIQUE(source, external_id)`                                                                                                                                                 |
| bracemark-api  | `services/iap.ts`                        | the purchases→status **fold** (grace windows, plan rank), the second purchases→**ceilings** fold (`foldQuotaCeilings`, high-water — below), webhook application, the staleness refresh (below), Paddle API calls |
| bracemark-api  | `routes/iap.ts`                          | the contract routes + `POST /v1/iap/paddle/webhook` (HMAC-authenticated, log-and-ACK)                                                                                                                            |
| bracemark-api  | `lib/quota.ts`                           | `checkPutQuota(ceilings, usage)` at `files/sign` — the byte/object backstop only                                                                                                                                 |
| react          | `useSubscriptionStatus`                  | the TanStack query on `iap/status`                                                                                                                                                                               |
| react          | `PAYWALL_COPY` (`lib/paywall-copy.ts`)   | the action-interrupt dialog's words — title, sentence, and the plan its CTA names — one copy for both apps' `paywall-provider.tsx` (the rule is brand-assets.md's)                                               |
| shared         | `iap/store-products.ts`                  | the store product-id ↔ plan catalog, read by the expo client AND the server verifiers (ids are ours, identical sandbox/production)                                                                               |
| bracemark-api  | `lib/appstore.ts`, `lib/playstore.ts`    | provider-vocab edges (lib/paddle.ts's siblings): store-API auth, authoritative fetch, status normalization                                                                                                       |
| bracemark-api  | `lib/store.ts`, `lib/jwt.ts`             | what those two edges share so neither imports the other: the normalized `StoreSubscriptionSnapshot`/`StoreSource`, and the base64url + PKCS#8 PEM helpers behind both store JWTs                                 |
| web-react      | `useEntitlements`                        | + device-local last-known copy; cleared on sign-out                                                                                                                                                              |
| bracemark-web  | `lib/paddle.ts`, settings → Subscription | Paddle.js overlay checkout + plan cards + portal + `usePaddlePrices` (the localized price preview — app-level, since it calls app code; see _currency_)                                                          |
| bracemark-expo | `lib/iap.ts`, settings → Subscription    | expo-iap store sheet + `iap/verify` + plan cards + restore + store-manage deep link (expo-react's `useEntitlements` caches in sqlite)                                                                            |

Both Subscription sections render `PLAN_CARD_COPY` **twice over**: as the upgrade
card, shown only on `free`, and as the "Your plan includes" list inside the
current-plan box, shown only on a paid plan. So the same sentences face a buyer
and an owner, and the copy rules in `iap/plans.ts` are written for both readings
— in particular that each list is an **increment** over the plan below it, which
is why the entry paid tier's list gets `Everything in Free` prepended at the two
render sites (and `bracemark-site`'s pricing page supplies the same line from its
own `inherits` field).

`purchases` is **global** (DIRECTORY*DB, not an account shard) because webhook
events after the first arrive keyed by the \_provider's* subscription id with no
username/session to route a shard by — a per-shard table would force the
forbidden try-every-shard scan. Rows are tiny, bounded per user, and
money-adjacent (Tier-0 backup set).

### the purchase flow (Paddle Billing — web)

> The old stxapps iap-server was **Paddle Classic** (`p_signature`,
> vendor/product ids, `/paddle/pre` randomId passthrough) — closed to new
> accounts. This is **Paddle Billing**: `pri_…` price ids, `Paddle-Signature`
> HMAC webhooks, `@paddle/paddle-js`. None of the Classic code ports.

1. **Checkout** — `POST /v1/iap/checkout { plan }` (authed). The server creates
   the Paddle transaction: it stamps `custom_data.userId` from the session (the
   client never knows its own userId — it's server-minted) and picks the
   `pri_…` id from env config, so both the account binding and the price are
   server-authoritative. The `txn_…` is also **persisted** (`paddle_checkouts`)
   before it's returned — the only account→Paddle key that exists before a
   subscription does, and what makes a lost first webhook recoverable
   (_reconciliation_ below). Client opens `Paddle.Checkout.open({ transactionId })`.
   Two guards, because the double-subscription hole has two doors. An
   already-subscribed account **409s** (`already_subscribed`) — a second
   checkout would mint a second live subscription; Plus→Pro is a subscription
   _update_ (proration), a separate flow, not yet built. That check can only see
   a subscription that EXISTS, so it is blind to two checkouts created **before
   either is paid** (double-click, two tabs, a retry) — and two live `txn_…` is
   two payable checkouts on one account. So the endpoint is also **idempotent
   within a checkout window** (`CHECKOUT_REUSE_MS`, 30 min): a repeat call for
   the same plan hands back the account's existing pending `txn_…` instead of
   minting another, and one transaction cannot be paid twice. Past the window a
   new one is minted, so an abandoned checkout doesn't pin a stale transaction
   for the row's 3-day TTL. A pending row for a DIFFERENT plan falls through to
   a new transaction (refusing it would strand someone who abandoned a Plus
   checkout and came back for Pro) — that leaves both payable, which is the same
   gap the plan-change flow has to close, and is unreachable while one plan is
   on sale.
2. **Webhook** — Paddle → `POST /v1/iap/paddle/webhook`. Signature = HMAC-SHA256
   over `${ts}:${rawBody}` against the per-destination secret, ±5 min replay
   window. Past the signature everything is **log-and-ACK** (a signed event we
   can't apply must still 200, or Paddle redelivers it forever). Only
   `subscription.*` events are consumed (renewals arrive as
   `subscription.updated`; `transaction.completed` is deliberately ignored).
   Application is one idempotent upsert keyed by `(source, external_id)` with
   three in-SQL guards: stale events lose on `event_occurred_at`, `user_id` is
   first-write-wins for life, and `expires_at` COALESCEs so an event that omits
   the period keeps the last known end.
3. **Activation** — payment truth reaches the account via the webhook, never the
   client; after `checkout.completed` the UI just **polls `iap/status`** until
   the plan flips (webhooks lag checkout by seconds).

**The fold** (`foldSubscriptionStatus`, pure + unit-tested): best entitled row
wins (plan rank, then latest expiry; `expiresAt: null` = non-expiring
manual/lifetime grant). Entitlement windows: `active`/`trialing` get +1 day
slack past `expires_at` (renewal-webhook lag must not flicker subscribers to
free); `past_due` stays entitled ~16 days (Paddle dunning) and surfaces as
`status: 'grace'` (the UI shows "payment issue", features stay on — and still
`willRenew: true` while nothing says otherwise: dunning means collection
retries are scheduled); `canceled` is entitled to `expires_at` exactly;
`paused` is not entitled. **Refunds claw back** — `expires_at` is the actual
entitlement end, not the originally paid-through date: an Apple revocation
(refund / Family Sharing) clamps it to `revocationDate`, an immediate Paddle
cancel (refund/chargeback) ends at `canceled_at` even though that event drops
the billing period, and Play pulls `expiryTime` back itself. In the other
direction, Apple's configured billing grace period (`gracePeriodExpiresDate`)
is honored while in grace — but as the **later** of Apple's end and the fold's
own `past_due` window, never their sum. `lib/appstore.ts` moves `expires_at`
only as far as the fold needs to reach Apple's end (`gracePeriodExpiresDate −
PAST_DUE_GRACE_MS`, from `lib/dunning.ts`); moving it all the way stacked the two,
and a 16-day grace became ~32 days of access, which nothing would have noticed
because Apple sends no notification when grace ends. Configure the grace in App
Store Connect at **16 days** and it changes nothing about when access ends, only
Apple's side of it (the renewal date survives a recovery inside grace); 3 days is
a no-op for us, 28 extends it.

**Manage/cancel** — `POST /v1/iap/portal` mints a Paddle customer-portal
session URL (needs the secret API key + stored `ctm_…` id, hence server-side).
Its path is `POST /customers/{ctm_…}/portal-sessions` — the customer is a path
segment. There is no top-level portal-sessions resource, and a spec pins the URL.
Store-bought subscriptions (future) are managed in their store.

**The overlay's theme** is passed on each `Checkout.open`, never at
`initializePaddle`: it defaults to light, our initialize happens far earlier (the
price preview), and `Paddle.Update()` carries no checkout settings, so the
resolved `effectiveTheme` is read at the moment the overlay opens —
[theme.md](./theme.md), _per-app wiring_.

#### when the upgrade button fails, there are two failures behind it

`startCheckout` catches its two steps separately, because only one of them is
worth pressing again and the other cannot be. A failed `POST /v1/iap/checkout`
is ours and is retryable in place — the endpoint is idempotent within
`CHECKOUT_REUSE_MS`, so the second press re-uses the pending `txn_…` rather than
minting a second payable one — so it gets _"Could not start the upgrade. Please
try again."_

A **Paddle.js that fails to load is terminal for the page**, and nothing on
screen would say so. `@paddle/paddle-js` caches its own rejected load promise
(`promiseMap` in its `loadFromCDN`, never cleared on failure), so a second
`initializePaddle` returns that rejection without re-fetching the script; our
`getPaddle` singleton sits on top of that, and clearing it would look like a
retry without being one. Only a page load clears either. So this half says
_"Could not open the payment page. Reload the page and try again."_ — the
actionable form naming the act that actually works
([brand-assets.md](./brand-assets.md), _errors have a fixed shape_). The raw
throw must never reach the user: it reads "Failed to load Paddle.js - v1", a
vendor build string in front of someone trying to pay. The payment-link path has
the same failure and a different act — its email link is a fresh page load, so
it says to open that again.

**Manage billing** is the section's other request and holds to the same rule: a
failed `POST /v1/iap/portal` says _"Could not open the billing portal. Please
try again."_, since a portal session is minted per press. It was the last catch
here still printing the throw. A **declined card** is not this section's to
word at all — Paddle reports it inside its own overlay, which is why the web had
no sibling of the store bug below.

#### the payment link — `/settings/subscription?_ptxn=txn_…`

Paddle's account-level **default payment link** is required, not optional:
without one, `POST /transactions` fails (`transaction_default_checkout_url_not_set`),
and with it every checkout 502s. It is also where Paddle's **own emails** send
the customer. Each transaction's `checkout.url` is the link plus
`?_ptxn=<txn_…>`, and that URL is what the "update your payment details" email
for a failed renewal carries. We never send it ourselves, so nothing of ours
surfaces it, but every subscriber in dunning is handed it.

**Paddle's checkout recovery never fires here**, whatever the dashboard's
Checkout settings → Recovery tab says. Paddle only emails abandoned checkouts
whose transaction the checkout itself created. A transaction created through the
API and then passed to `Checkout.open({ transactionId })` is ineligible, and every
one of ours is created that way (step 1 above). The same goes for the recovery
discount. So an abandoned checkout sends no email and never lands on this link.
Moving transaction creation to the client (`Checkout.open({ items })`) would
switch recovery on, but it would also give up the server-stamped
`custom_data.userId` and the server-picked price.

So the link is **`<app origin>/settings/subscription`** in every environment,
and that page opens the checkout it names (`subscription-section.tsx`,
`PAYMENT_LINK_PARAM`). Paddle.js would open it unaided on initialize. It isn't
left to do that, because this page only loads Paddle.js for a **free** account's
price preview: the subscriber in dunning — the customer the link exists for —
would land on a settings page and nothing would open. The section instead reads
`_ptxn`, strips it from the URL at once, and calls `Checkout.open()` itself. Paddle
documents that as taking priority over the auto-open. That buys the in-app
checkout's completed/closed handlers and rules out a second overlay once the
price preview initializes Paddle.js. Stripping it also keeps a reload from
reopening a paid checkout.

What completing it means depends on the fold at the moment it opened:

| fold when opened | what the link was                          | after `checkout.completed`                               |
| ---------------- | ------------------------------------------ | -------------------------------------------------------- |
| `free`           | a purchase — a dunning sub that has lapsed | the activation poll, exactly as an in-app upgrade        |
| paid, `grace`    | the past_due renewal, being paid           | poll until the webhook moves the status off `grace`      |
| paid, otherwise  | a zero-amount card swap                    | "Your payment details are updated." — nothing to wait on |

Three things keep the link working, and nothing fails loudly if one breaks:

- **It must be this page.** A default link at the origin root would go through
  `/`'s redirect to `/links`, which drops the query, and the email would open the
  app on its links page. The link is dashboard config per Paddle account (sandbox
  and live), not something the repo can check.
- **A signed-out customer still gets the link back.** `AuthGuard` carries the
  full path _including the query_ through `/sign-in?next=`, so after signing in
  they land on the same URL and the overlay opens. Anything that shortens `next`
  to a bare pathname breaks this silently.
- **Only a `txn_…`-shaped value is opened.** Anyone can send the link, so junk is
  stripped and ignored rather than handed to an overlay that would error.

It adds no third-party load the published pages don't already describe: Paddle.js
still arrives only on Settings → Subscription.

In live, the link's host must itself be an **approved checkout domain**, and the
match is exact: `bracemark.com` being approved does not cover `app.bracemark.com`,
which needs its own approval. That approval is needed anyway, because the
checkout opens on this origin and live checkout refuses unapproved domains. So a
link on the apex that redirects here would not help. Paddle's review fetches the
domain, and a fetch that runs no JavaScript gets this app's static shell with an
empty `<body>`: a title and nothing else, which reads as "not live". The root
layout's `<noscript>` (`components/no-script-notice.tsx`) gives that reader a real
page while staying invisible to every browser that runs the app. Keep it: Paddle can
re-review an approved domain.

### enforcement — who enforces which limit

The E2E trust split, spelled out (matches the business model's principle: hard
walls exactly where the cost is):

| limit                                         | enforced                                                                                                                                                                                                                                 |
| --------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| storage bytes (free 100 MiB / 5 / 20 GiB)     | **server-hard** — `files/sign`; on free it's the only backstop on preview-image blobs (with the count cap). Sized by the account's **high-water** plan, not its current one (below)                                                      |
| free: 200 `links/`                            | **client-only** — every create surface refuses at the cap (see below); the server does not count links                                                                                                                                   |
| free: preview-image `files/` blobs            | **allowed** — no per-namespace plan gate: a preview image is an opaque `files/` blob the server can't tell from a heavy one, so it's bounded only by the bytes/count backstop; the heavy-blob facets are client-gated (below)            |
| Plus page-copy meter (last 50)                | client-only — a page copy is indistinguishable from any other `files/` blob server-side; bytes backstop                                                                                                                                  |
| read-mode / screenshot capture (`keptCopies`) | client-only — checked where a capture is asked for (the browser extension's save and saved screen); reading a kept copy is never gated. Backstopped by the blob rules ([link-extraction-keep.md](./link-extraction-keep.md), _the gate_) |
| AI gates                                      | client-only (they run on-device), backstopped by the blob rules                                                                                                                                                                          |
| extractor access (plan-gated opt-in)          | client + IP rate limits for now (the extractor is anonymous by design); a bracemark-api-minted signed entitlement token is the upgrade path if abused                                                                                    |

One error code at the gate: `quota_exceeded` (403), a **capacity** refusal on
any plan — the client says "storage full". Puts are the only gated op: GETs and
deletes always work, so an over-quota or downgraded account degrades to
**read-only-plus-delete, never data loss**.

**And the delete half is reachable from the UI, which is less obvious than it
sounds.** "Delete permanently" is offered only on links already in Trash
(`link-row-menu.tsx`, `bulk-edit-toolbar.tsx`, both keyed on `inTrash`), and
move-to-Trash is an `update({ listId })` — a `links/` put, the very thing being
refused. Two properties are what keep that from being a trap, and both are load-
bearing: the move is **local-first** (`useLinkMutations.update` writes Dexie and
calls `requestSync()` without awaiting it, so the link lands in Trash and offers
its destroy immediately, whatever the server says), and `enqueueDelete`
**overwrites a pending put for the same path in place** (put→delete, new
`writeId`), so the destroy's deletes replace the refused put rather than queueing
behind it. Deletes ride `ops/commit` ungated, the freed sizes come off the map,
and the next put fits. All the user sees in between is one cycle reporting that
some changes aren't syncing. Gate "Delete permanently" on the trashed state
having _synced_, make the Trash move await its push, or queue the delete beside
the put rather than over it, and the hatch closes with nothing to show for it —
which is why the sequence is pinned as a sequence, in `web-react`
`sync/engine.spec.ts`, _an over-quota account clearing space_.

Note this is about the byte/count ceilings only. Over `maxLinks` nothing is
refused server-side at all: `useLinkQuota` gates the create surfaces, and moving
a link to Trash is not a create. (Trashing does not lower that count either — it
is deliberately trash-inclusive, since a trashed link still has its blob — so
there too the route back under is `destroy`, with Trash as its staging step.)

**Why the link cap is not here.** It used to be, answering a second code
(`upgrade_required`). Enforcing it server-side meant the gate also had to tell a
CREATE from an in-place UPDATE — an account at its cap must still be able to
retitle, retag and above all **move a link to Trash**, which is itself a `links/`
put and the first half of the only route back under the cap. That distinction
cost an existence check against the DO size map on every sign batch, a
partial-push retry in the sync engine, and a whole sync state for "some of your
changes were refused". The cap moved to the create surfaces, and all of it went
with it.

The trade is that the two gates were never defending the same thing:

- **`maxBytes` / `maxFiles`** is the only thing between one scripted client and
  an unbounded R2 bill. It stays server-hard, and it is deliberately
  namespace-blind, current-usage-only, and sized by the high-water plan — a
  limit no legitimate account reaches needs no create-vs-update subtlety, and
  the one population that _did_ legitimately reach it (the downgraded account)
  is exactly what the high-water rule below removes.
  **Of the pair, `maxBytes` is the one meant to bind.** It is the only ceiling
  denominated in something we are billed for; R2 charges stored bytes and
  operations and never object count, so what `maxFiles` actually bounds is the
  per-user DO, which holds a `file_sizes` row per path. The paid number is sized
  so the bytes run out first: at the old 200 000 they did for a library carrying
  preview images (~100 KB per link over 3 files → ~50 000 links) but not for one
  without them (~2.5 KB per link over 2 files), where the object cap refused the
  account at ~100 000 links while it held 250 MB of a 5 GiB quota — a refusal
  with no cost behind it, from a gate whose whole premise is cost. It is
  1 000 000 now, which leaves both shapes far above any real library and is what
  lets the storefront say "Unlimited links" without a footnote. Free's 5 000 is
  untouched: it is 8× the headroom a 200-link cap can consume, and free's
  binding limit is the link cap, not either ceiling.
- **`maxLinks`** is a conversion gate. Bypassing it costs a few hundred KB of
  metadata and is still bounded by `maxBytes`. So it is **honor-system**: the
  create surfaces refuse at the cap, and devtools or a patched extension build
  walks through it. That cost is accepted, deliberately, in exchange for the
  machinery above.

**Visibility inverts enforcement, and that is not a mistake.** The limit we
enforce hardest is the one we never advertise, and the one anyone can walk
through is printed on the pricing page. `maxBytes` / `maxFiles` are a **cost
backstop, not a product gate** — no plan's copy names a byte figure, on the
marketing site or in either upgrade card — because until the heavy blobs ship
nothing can reach them (a maxed free library is ~16 MB against 100 MiB), and an
advertised ceiling is a promise we'd have to grandfather rather than a number we
can retune. `maxLinks` is the opposite: it exists **to be seen**, since a
conversion gate nobody knows about converts nobody. An account that does hit the
byte ceiling learns it from the `quota_exceeded` → "storage full" surfaces, which
is where a capacity refusal belongs.

The **downgraded** account lands on the client gate, where it always did.
`useLinkQuota` reads `count >= max`, so an over-cap library is refused new links
by the same gate that refuses a full one; every link they already own was
uploaded while entitled, and in-place edits were never counted by anything. That
is the conversion pressure, and it is deliberate.

**The two ceilings are not retroactive, and that is what keeps the paragraph
above true.** `maxFiles` / `maxBytes` are resolved from the **high-water plan** —
the best plan the account has ever held — not the plan it holds today:
`services/iap.ts` folds the same purchase rows a second way
(`foldQuotaCeilings`), taking the highest `plan` on any row regardless of its
status, expiry or cancellation, and `files/sign` gates against that. Everything
else snaps back to `free` the instant a subscription lapses.

Without it, a downgrade did not degrade to read-only-plus-delete so much as
**strand** the account, and it did so far sooner than the numbers look.
`maxFiles` counts paths namespace-blind, and one link is 2 objects (`links/` +
`extractions/`) before its preview image makes 3 — so free's 5 000 files is
~1 600–2 500 links, not 5 000, and free's 100 MiB can bind earlier still on a
library whose links carry preview images. Past either ceiling every put is
refused: no retitle, no retag, and **not even move-to-Trash**, which is itself a
`links/` put. The only surviving route back under is permanent `destroy`, which
is irreversible. Both routes into that state are ordinary rather than exotic —
a canceled subscriber whose library outgrew the free ceilings while they were
paying, and a trial that imported a switcher's library and then ended.

Three reasons the rule is shaped this way rather than by moving a number:

- **It's the honest ceiling.** The backstop asks what we are willing to store,
  and we already agreed to store this — the blobs arrived while the account was
  entitled and the R2 bill is the same either way. Deleting is always free, so
  the account can shed them whenever it likes.
- **It opens no abuse surface.** A raised ceiling needs a purchase row, a
  purchase row needs a completed checkout, and a checkout needs a payment
  method — the exact cost that makes account-farming uneconomic. 100 MiB was
  never defending against someone willing to spend a card per account.
- **It's monotonic.** The ceiling can only rise, so a dunning window, an
  out-of-order webhook or a clock skew can never make a library that fit
  yesterday not fit today — the failure mode a status-aware rule would have.

The trade accepted with it: a trial-then-chargeback keeps the Plus ceiling. That
costs storage on an account that has already been through a chargeback (a
traceable, expensive move for the abuser) and buys the simplicity of a rule with
no expiry logic in it. Revisit only if it shows up in the numbers; the honest
place to put it back is `foldQuotaCeilings`.

### the purchase flow (store IAP — bracemark-expo)

The client library is **expo-iap** (the OpenIAP successor to the deprecated
react-native-iap; Expo Modules-based, config plugin in `app.config.ts`, native — so
`npx expo prebuild` required). `apps/bracemark-expo/src/lib/iap.ts` is the
`lib/paddle.ts` sibling: lazy store connection, global purchase listeners
routed to the open checkout's handlers, and the verify-then-finish protocol.
The store product ids are OURS and identical in sandbox and production (unlike
Paddle's per-env `pri_…` ids), so they're shared constants —
`iap/store-products.ts` in `@stxapps/shared` — read by both the client
(`fetchProducts`, the purchase request) and the server (productId → plan, the
authoritative mapping).

The flow inverts Paddle's direction: a store purchase is a **client-side event**
the server only learns about from the receipt the app submits.

1. **Purchase** — the section's upgrade card opens the store's own sheet
   (`requestPurchase`); prices shown come from the fetched product's
   `displayPrice` (the store's localized, tax-correct number — the USD table is
   only placeholder copy). **A sheet that ends without a purchase is reported
   twice**: expo-iap 4.x rejects `requestPurchase` with the outcome AND emits it
   to the error listener. `openStoreCheckout` settles the checkout on whichever
   lands first, and a cancel is a close (Paddle's `closed`), never an error — a
   rejection that reached the section's catch used to print "User cancelled the
   purchase flow" under the card. `IAP-NATIVE-001` pins it on the iOS simulator
   ([e2e.md](./e2e.md), _subscriptions_).

   **A sheet that FAILS is worded by its code, never by its message**
   (`storeFailureMessage` in `lib/iap.ts`, for purchase, restore and manage
   alike). Nothing thrown on this path was written for a customer: the store
   library attaches a canned string to each code, and a failed verify is
   `ApiError`'s status line. The specimen is Play's "always declines" test
   instrument, which arrives as `BillingUnavailable` and printed "Billing API
   version is not supported for the type requested" under the card — Play's one
   code for a payment method it could not charge, an out-of-date Play Store and
   an unsupported country, so the sentence names the act (check the payment
   method) without asserting the cause. Two failures get a sentence that is
   deliberately NOT "try again", because trying again is a second purchase: a
   verify that failed after the store completed (`PurchaseNotRecordedError` —
   the transaction is unfinished and replays, so the act is Restore purchases),
   and a purchase waiting on approval (Ask to Buy, a pending payment). A code
   with no sentence of its own falls back to the fixed shape for its action
   ([brand-assets.md](./brand-assets.md), _errors have a fixed shape_).

2. **Verify** — on the purchase event the app POSTs `/v1/iap/verify`
   `{ source, productId, token }` (App Store transaction id / Play purchase
   token). The token is only a **lookup key**: bracemark-api fetches the
   authoritative state server-to-server — App Store Server API
   `subscriptions/{transactionId}` (ES256 JWT; production falls back to the
   sandbox host on 404 for App Review, since a sandbox transaction id is
   invisible to the production host — App Review buys with sandbox accounts
   against the production build) or Play Developer API
   `subscriptionsv2.get` (service-account OAuth; **no such fallback and none
   needed** — Google ships one host, so a license tester's purchase, an
   internal-track purchase and a real paid one all resolve through the same URL
   under the same package name, flagged in the response body's `testPurchase`
   rather than by endpoint; a Play 404 means the token genuinely doesn't exist)
   — normalizes the status at the
   edge (`lib/appstore.ts` / `lib/playstore.ts`, the `lib/paddle.ts` siblings),
   and upserts the same `purchases` row. **This call is what binds
   subscription → account** (first sight is for life, the webhook rule); a
   replayed token 409s (`purchase_bound`). The response is the fresh fold — no
   post-checkout polling (the webhook lag that polling covers on web doesn't
   exist here).

   **Why this one can't 409 on a double subscription.** The web's
   `already_subscribed` guard has no sibling here, and the asymmetry is
   deliberate: `POST /iap/checkout` runs **before** any money moves, whereas by
   the time verify is called the store has **already charged** the customer.
   Refusing would leave them paid-for-nothing — the app never reaches
   `finishTransaction`, so Apple replays the transaction forever with nothing
   refunded and Play's 3-day fuse revokes a purchase we could have honored. So
   verify **records and alerts**: an account that binds a store purchase while
   already entitled through a _different_ source logs
   `IAP_DOUBLE_SUBSCRIPTION` (the second alert token beside `IAP_DROP`), and the
   refund is an operator action. What that buys is visibility, not prevention —
   the fold takes the best entitled row, so a double-charged account otherwise
   looks perfectly healthy to itself and to us. Cross-provider only:
   a same-source pair is either impossible (one live subscription per
   subscription group per store account) or the legitimate Play re-key below,
   which would otherwise fire the alert on every Play upgrade. Prevention on this
   path stays a **client** gate — upgrade cards render only on `free`.

3. **Finish** — only after the server has recorded it does the app
   `finishTransaction`. A failed verify leaves the transaction unfinished, so
   the store REPLAYS it on the next connection — the built-in retry;
   "Restore purchases" re-drives the same verify for anything the store holds
   (App-Review-required, and the reinstall/new-device recovery).
   **Acknowledgement (Play only).** Google auto-refunds and REVOKES an initial
   subscription purchase left unacknowledged for **3 days** (renewals are
   exempt) — the one hard deadline anywhere in this design. The app's
   `finishTransaction({ isConsumable: false })` acknowledges on Android and
   already satisfies it, but that call happens only once `iap/verify` has
   returned, so `verifyStorePurchase` **also** acknowledges server-side
   (`purchases.subscriptions.acknowledge`, the v1 endpoint —
   `subscriptionsv2` is query-only) the moment the entitlement is recorded: a
   client that dies in between can no longer lose the purchase to a silent
   revoke. Gated on Google's own `acknowledgementState` (carried on the
   snapshot as `needsAcknowledge`), which buys two things: a restore — whose
   purchase was acknowledged long ago — makes no call at all, and the
   acknowledge is **convergent** rather than fire-once: the purchase RTDN and
   the staleness refresh re-check the same flag when they re-fetch a purchase
   we have recorded (`applyStoreNotification`), so even both purchase-time
   acknowledgements failing (server 5xx + client death) is healed by the next
   event or refresh that touches the row inside the 3-day window. Best-effort
   throughout — a failure is logged and never fails a recorded purchase, a 4xx
   ("already acknowledged", the client's own call racing in) is swallowed, and
   the client call remains what stops the store replaying the transaction.
   Deliberately **not** retried for an unbound purchase: revoke-after-3-days
   there is Google refunding a payment we never entitled, which is the right
   outcome. **Apple has no equivalent**: StoreKit's
   `finishTransaction` is client-only, there is no server acknowledge endpoint,
   and an unfinished transaction is simply replayed forever with nothing
   revoked. Not to be confused with ACKing the _notifications_ below (a 200 so
   the provider stops redelivering) — different mechanism, same word.
4. **Notifications** — renewals/cancellations reach bracemark-api via
   `appstore/notify` (App Store Server Notifications V2) and `playstore/notify`
   (Pub/Sub RTDN push, guarded by a static `?token=` secret). Neither verifies
   provider signatures: the pushed payload is used only to find WHICH
   subscription changed, and the facts are **re-fetched from the store's API**
   (the call-back pattern — a forged POST can only make the server re-read the
   truth, bounded by the webhook rate tier). Log-and-ACK like Paddle;
   notifications carry no account and rely on the binding verify created. On a
   FIRST purchase the push routinely arrives before that binding exists — both
   stores emit it when THEIR backend completes the purchase, while verify
   additionally needs the result to reach the device and the device to reach us
   — so `applyStoreNotification`'s no-binding drop is logged at `console.log`,
   not `error`: it is the ordinary case, and verify lands seconds behind it.
   Making the push self-binding is a follow-up below.

#### plan changes on Play — the `linkedPurchaseToken` chain

Paddle and Apple keep **one identity for life**: a plan change updates the
existing `sub_…` / `originalTransactionId`, so it updates the existing
`purchases` row and there is nothing else to do. **Play re-keys.** An
upgrade/downgrade, a re-signup of a canceled-but-not-yet-lapsed subscription,
a purchase made while the old one is in account hold, and the prepaid
conversions each mint a **new purchase token** — a new identity,
so a new row — and the new record's `linkedPurchaseToken` points back at the one
it replaced.

The old token **cannot be relied on to retire itself.** Play has been seen to
do it in one case: a purchase made over a subscription in account hold (the
upgrade card, which a held account is shown because hold folds to free) left the
old token `SUBSCRIPTION_STATE_EXPIRED`, with
`canceledStateContext.replacementCancellation` and its expiry pulled back to the
moment of replacement. That is one replacement mode out of several, observed
once, and nothing in the API promises it for the others. Where Play does not,
the old token goes on resolving through `subscriptionsv2.get` with its original
period, so a refetch cannot discover that it died, and the staleness refresh
below never even looks at it (a row reading active with a future expiry is
exactly the shape `needsRefresh` skips). Retiring it is therefore the server's
job either way — `supersedeLinkedPlayPurchase` in `services/iap.ts`, called from
both `verifyStorePurchase` and `applyStoreNotification`. Two things break
without it:

- **Downgrade.** The old higher-plan row stays entitled and the fold takes the
  best plan, so a user who moves pro → plus keeps pro until the old period would
  have ended — up to a year on an annual plan.
- **Re-signup under a second account.** The old token is bound to account A for
  life (the upsert never rewrites `user_id`) and the new one binds to B: two
  entitled accounts on one payment. `purchase_bound` cannot catch this — the two
  rows have different tokens — which is exactly the duplicate-subscription hole
  Google's own guidance is about.

Retirement ends the row now (`status='canceled'`, `expires_at` pulled back to
the supersession time — a backward expiry move like the refund clawbacks, but
asserted as our own inference rather than a provider-stated fact, hence the
idempotent MIN), rather than deleting it, so the replacement chain stays
auditable.
It is deliberately **not** scoped to the caller's `user_id`: the replaced token
may be bound to a different account, which is the whole point of the second case
above. Rows carry `linked_external_id`, so walking a Z→Y→X chain is a local read
per hop; the only outbound call is bridging a hop we never recorded (its verify
never landed), and the walk is capped. In `applyStoreNotification` it runs
**before** the binding check, since an upgrade RTDN that beats the app's verify
would otherwise drop out there and leave the old row entitled. Failure is
best-effort + logged with the alert marker — a purchase already recorded must
not fail over it, and nothing downstream retries.

### currency — one base price, many local ones

`PLAN_USD_PER_YEAR` in `iap/plans.ts` is the **base price** ($48/yr Plus), and
the only price that exists in code. It is not what every buyer pays. Both
providers carry a per-country price ladder on top of it, and they build that
ladder by opposite rules:

- **Paddle Billing** — a price has one `unitPrice` in the base currency plus
  optional **`unitPriceOverrides`**, each a fixed amount in another currency for
  a set of countries. There is **no exchange-rate conversion at checkout**: a
  country either has an override and is billed that exact figure, or has none and
  is billed the base price in USD. So a local price is a number we chose and it
  stays put until we change it — which is also why it is safe for the marketing
  site to print "$48" as a dollar figure rather than a converted estimate.
- **App Store / Play** — the inverse. We set a base price and the consoles
  **generate every storefront's price themselves**, by their own FX and rounding
  rules, refreshed as rates move; a per-storefront override is available where the
  generated number is wrong. Auto is the sane default here, since Apple and Google
  already handle the tax and rounding conventions per market.

The asymmetry is worth internalizing: **on Paddle, "local currency" only exists
where we explicitly created it.** Leaving a country alone means charging it
dollars, not converting for it.

#### tax — `location`, so the printed number is the total where custom says it must be

Every Paddle price carries **`tax_mode: 'location'`**, set on the price itself
rather than inherited from the account default (`account_setting`). The account
default was tax-**exclusive**, so a German buyer of the $48 plan was quoted
$57.12 and a UK one $57.60. That broke the premise above: the marketing site
prints "$48", and in Europe a consumer price is expected to _include_ VAT.
`location` follows each country's convention instead:

| where                                                    | the $48 base becomes                                           |
| -------------------------------------------------------- | -------------------------------------------------------------- |
| tax-inclusive markets (EU, UK, AU, …)                    | **$48.00 total** — VAT/GST comes out of our margin, not on top |
| tax-exclusive markets (US, and others Paddle classes so) | $48 **plus** that jurisdiction's sales tax                     |

So "$48/yr" is the exact charge where a shopper expects the tag to be the
total, and the pre-tax figure where the shopper expects tax at the till. The
latter is why every surface that prints the base price also says tax is settled
at checkout. What we give up is margin in the inclusive markets: a UK sale nets
$40 before Paddle's fee. That is the price of an honest tag, and a
`unitPriceOverrides` anchor (`€49`) is priced as a **total** for the same reason.

It is a property of the **price**, so it has to be set on every `pri_…` in
every environment — including the live catalog, a monthly cadence, and any
retirement replacement — or that price quietly falls back to the account
default. Changing it later needs no new price id (`PATCH /prices/{id}`), but it
does change what a market pays.

The account default (dashboard → Checkout → Sales tax settings) is therefore
not what prices our catalog, but it is set to **location** too, on both
accounts, as the backstop. A price created without `tax_mode` inherits it with
no error, and with the default at `location` that omission charges the same as
setting it would have. Left tax-exclusive, the omission would put VAT on top of
the printed "$48" in Europe again, and nothing would say so.

#### which surface shows which number

| surface                                       | shows                                                  | source                                                                   |
| --------------------------------------------- | ------------------------------------------------------ | ------------------------------------------------------------------------ |
| `bracemark-site` /pricing, /faq, landing      | the base price, in USD, always                         | `PLAN_USD_PER_YEAR`                                                      |
| `bracemark-web` settings → Subscription       | the buyer's own currency + tax; base price as fallback | `GET /v1/iap/prices` → `Paddle.PricePreview()` → `formattedTotals.total` |
| `bracemark-expo` settings → Subscription      | the store's localized price; base price as placeholder | `fetchStorePlanProducts()` → `displayPrice`                              |
| either checkout (Paddle overlay, store sheet) | the binding number                                     | the provider                                                             |

The marketing site stays on the base price **on purpose**, and it is not a gap to
close later: localizing it would mean loading Paddle.js on `bracemark.com` to
call `PricePreview`, and that property's published claim — in `/privacy` and the
FAQ's _trackers_ answer alike — is that it loads no third-party script at all. A
nicer number on a page that takes no money does not buy back falsifying that. Its
fine print says the prices are dollars and that some countries are priced
differently, which is the honest version of what it can know.

#### why the displayed price cannot drift from the charged one

Display and charge run on separate paths, and only one of them can move money:

- **Display** is client-side and advisory. `bracemark-web` asks the server which
  `pri_…` is on sale (`GET /v1/iap/prices` — the front of `PADDLE_PRICE_ID_*`,
  see _reconciliation_), then asks Paddle what that costs this visitor.
- **Charge** is server-side. `POST /v1/iap/checkout` resolves the price id from
  the same env list and puts it on the transaction. **No price crosses the wire
  from the client**, in either direction that matters — the client cannot name a
  price, and the preview it rendered is not an input to anything.

So the failure mode is bounded at "we showed the wrong number", never "we charged
the wrong number". The one id is served over the wire rather than duplicated into
a `NEXT_PUBLIC_PADDLE_PRICE_ID_*` for exactly this reason: a second declaration
of _which price is on sale_ could disagree with the first with nothing failing,
and the card would then preview a price the checkout doesn't bill.

The preview is still an **estimate**, and both storefronts treat it as one.
Paddle geolocates by IP when no address is supplied; the real country comes from
the customer's address or card at checkout, which a VPN or a saved Paddle address
in another country will differ from. Only the overlay's number binds. A preview
that fails outright degrades to the base price with the button still live (the
checkout prices itself server-side regardless) — where the expo side, which has
no such luxury, disables the button, because without a store product there is no
sheet to open.

#### picking which currencies to price explicitly

Prices live in the provider catalogs, never in code — the same rule the trial
period follows. The policy:

- **Price a short list explicitly on Paddle** (EUR, GBP, CAD, AUD, and whatever
  the analytics justify later), with **charm-priced local anchors** — `€49`, not
  the `€44.13` a conversion would produce. The conversion lift comes from the
  number looking chosen, not from it being arithmetically faithful.
- **Leave the long tail on the base price.** A country billed $48 in dollars is a
  worse experience than a local price and a much better one than a stale local
  price nobody is maintaining.
- **Leave the stores on auto** except where a generated number is visibly wrong or
  drifts far from Paddle's for the same market.
- Treat every explicit price as **sticky**. FX moves and margin moves with it,
  and correcting it later is a price _increase_ to that market — with the same
  grandfathering problem retiring a `pri_…` has. That stickiness, not the setup
  cost, is the reason to keep the list short.

**The anchors, and they are the same number on all three providers** — Plus,
yearly:

| currency | anchor    | where                                           |
| -------- | --------- | ----------------------------------------------- |
| USD      | **$48**   | the base price; US on both stores               |
| EUR      | **€49**   | the euro area (the 21 member states) and Monaco |
| GBP      | **£45**   | GB                                              |
| CAD      | **CA$69** | CA                                              |
| AUD      | **A$79**  | AU                                              |

One number per currency everywhere is the point: the marketing site, the web
plan cards and the store sheets can then never disagree about what a market
pays. Each is a charm price at roughly the base price plus that market's
consumer tax where the tag is expected to include it (EUR, GBP, AUD); CAD, like
USD, is tax-exclusive and sits near the plain conversion.

Where each one is set, because each provider stores it differently:

- **Paddle** — `unitPriceOverrides` on the yearly `pri_…`, one entry per
  currency, in **both** sandbox and live (they are separate catalogs; a sandbox
  without them tests a checkout nobody in those markets will see).
- **App Store Connect** — a per-territory price on the subscription. Apple's
  auto-equalization already lands on $48, €49, CA$69 and A$79; only the UK was
  overridden (Apple generated £49).
- **Play Console** — a regional price per **country**, not per currency: Play
  prices each euro country separately and folds each one's VAT into its
  generated number (Finland came out at €54.99, Luxembourg at €48.99), so €49 is
  set on every one of them. Gibraltar, San Marino and Vatican City stay on auto
  deliberately — they carry no VAT, and the anchor would be a 20%+ increase
  there. Set these while the base plan is still a draft: before the first
  subscriber any change is free.

Every other country stays on the store's auto price, or on $48 at Paddle.

### reconciliation — when a webhook never arrives

Every writer above is a provider **push**, and push has holes the providers' own
retries don't close:

| failure                                                            | recovered by the provider?          |
| ------------------------------------------------------------------ | ----------------------------------- |
| delivery failed (our 5xx, short outage)                            | yes — retried with backoff          |
| destination disabled / secret rotated wrong                        | partly — manual replay              |
| **we 200'd but couldn't apply** (unknown price/status, no binding) | **no — a 200 is never redelivered** |
| **outage longer than the retry window**                            | **no**                              |

Row three is the sharp one and it's self-inflicted: log-and-ACK is required (or
the provider redelivers forever), so every drop is permanent by construction.
Adding a `pri_…` and forgetting `PADDLE_PRICE_ID_PRO` in one env silently drops
every event for those subscribers.

That one is blunted at the source: **each `PADDLE_PRICE_ID_*` is a
comma-separated LIST, not a single id** (`paddlePriceIds` in `services/iap.ts`),
and it carries the same catalog/storefront split as `PAID_PLANS` vs
`AVAILABLE_PAID_PLANS` one level down. The **read** side recognizes every id in
the list — every price the catalog has ever charged, kept forever, because a
subscriber on a retired price is still a subscriber — while **checkout sells the
first**. Retiring a price is therefore "move the new id to the front, keep the
old one behind it", and the drop above needs someone to actively _delete_ an id
rather than merely forget to add one. It also means the monthly cadence, the
grandfathered launch price, and any currency variant land as config edits on a
path that is otherwise a permanent, silent revenue loss.

So there is a **pull** side: `services/iap.ts` re-fetches a row's authoritative
state and applies it through the same code path a push takes. Three properties
are the design:

- **The server decides, not the client.** This is deliberately _not_ the old
  stxapps iap-server's `POST /status { doForce }`, which let any caller turn a
  status read into provider fan-out and refetched healthy rows to learn nothing.
  The trigger is the row's own shape (`needsRefresh`): not entitled but not
  finished (a period that ended with no renewal event; a provider row with no
  period at all), `past_due`, or `paused`. `manual` has no provider to ask;
  `canceled` is terminal. A healthy account stays exactly one indexed D1 query.
- **One pull path per provider, shared with the push path.** Paddle's webhook
  `data` and its `GET /subscriptions/{id}` `data` are the same entity, so
  `applyPaddleSubscription` normalizes and upserts both (`fetchPaddleSubscription`
  is the `lib/paddle.ts` sibling of the store fetchers that already existed).
  Stores need nothing new: the stored `external_id` **is** the provider's lookup
  key for all three sources (Paddle `sub_…`, App Store `originalTransactionId`,
  Play purchase token), so a refresh is the notification path minus the
  notification.
- **Bounded and non-fatal.** `purchases.last_synced_at` is a debounce clock
  stamped on every refresh **attempt** (success _or_ failure) and on every
  applied push — so a permanently-broken row costs one outbound call per window,
  not one per poll, and a provider being down degrades the read to the stored
  fold rather than failing it. A per-read cap bounds the fan-out independently.
  The window (~5 min) is sized by the **user-visible** path, not the background
  one: the settings page's Refresh button is just `iap/status` again, and because
  a failed attempt stamps the clock too, the window is exactly how long that
  button stays a silent no-op after one. That's the case this backstop exists
  for — the user fixes a card or resumes in the provider's portal, the event
  doesn't reach us, they press Refresh — so an hour-scale window would read as a
  broken button. Shortening it costs little, since the debounce was never the
  only bound: the per-read cap, the global rate limiter, and the fact that a
  refresh-worthy row requires a real purchase all still apply.

Three callers opt in, each where a wrong answer costs more than the round-trip:
`iap/status` (the user is asking this exact question), `iap/checkout`'s
already-subscribed guard (a stale row costs the user a second subscription), and
**`deleteAccount`'s billing gate** (`services/account.ts`) — the last read before
an irreversible action, where a row stale in the "period ended, renewal event
never landed" direction reads as free and lets the account go while the provider
keeps charging, with no session left to reach the portal with. The opposite
staleness (looks healthy, canceled at the provider) is the sweep's case either
way, so refreshing there can't block a deletion that would otherwise pass.
**`getEntitlements` never refreshes** — it sits on the `files/sign` put path,
where a provider's latency would become upload latency. Nor does
`verifyStorePurchase`'s closing fold: the upsert it just performed stamped
`last_synced_at`, so the row in question is the freshest read in the system.

**The pre-row hole — pending checkouts.** Everything above iterates `purchases`
rows, which a **first** purchase doesn't have yet: if its `subscription.created`
is lost, no row is written, nothing looks stale, and the user has paid into
silence. It can't be fixed by asking Paddle about the account either — **Paddle
has no such question.** Every list endpoint filters on Paddle's own ids
(`customer_id`, `subscription_id`, `id`); the `custom_data.userId` we stamp is
returned but never queryable, and the account model has no email to match on.

So the key is minted **before** the purchase exists: `createPaddleTransaction`
already had a `txn_…`, and now persists it (`paddle_checkouts` — see the schema
note in `db/schemas/directory.sql`). Recovery is two hops onto the existing path:
`txn_…` → `transaction.subscription_id` → `fetchPaddleSubscription` →
`applyPaddleSubscription`. Same posture as the staleness gate — the server
decides from stored state, the client has no say — but on a **much shorter
clock**: a pending checkout's whole life is the minute after a payment with the
user watching (`pollActivation` re-reads `iap/status` every 2s for 30s), so even
the 5-minute `REFRESH_DEBOUNCE_MS` would be actively harmful here. The first poll
fires before Paddle has provisioned anything, learns nothing, and would then
debounce away the entire window the user is actually waiting through. Hence its
own constants, sized against that ~30s window rather than against a background
sweep: **don't ask under ~20s**, **~10s between attempts**, **3-day TTL**, and a
per-read cap of 2, the sibling of `MAX_REFRESH_PER_READ`.

The spacing is the load-bearing one. A row is inserted with `last_synced_at = 0`,
so the first attempt always lands on the first poll past the age floor — seconds
after payment, when Paddle is least likely to have populated
`transaction.subscription_id` yet. A debounce anywhere near the width of the
client's window would therefore buy exactly **one** attempt, at the worst moment
in the checkout's life; at ~10s the window holds 3-4, the last a full ~30s after
payment. (The age floor can't cover for it: `created_at` is stamped when the
transaction is minted, _before_ the overlay opens, so it measures time since
checkout started, not since payment — nearly every user has cleared it before
polling begins. It suppresses reads that arrive while the overlay is still open,
and little else.)

The TTL is the other end of the same argument, and it is sized by **when the user
comes back**, not by the poll window (the debounce owns that) — so an hour-scale
TTL would discard the only case with real value. 3 days lines it up with
[Paddle's own retry exhaustion](https://developer.paddle.com/webhooks/about/respond-to-webhooks/)
(60 attempts across 3 days, 47 in the first day), so the row is still there to
_pull_ whatever Paddle eventually gave up _pushing_; it also spans a
pay-Friday-reopen-Monday gap and gives an operator time to fix the config bug
behind an `unknown_price` drop — the one hole Paddle never retries at all, and
whose alert token this path suppresses.

The table means exactly one thing — "this account started a checkout we've seen
no subscription for" — so pending is _row exists_, with no status column: every
terminal outcome **deletes**, and the rest age out on the next scan. Four are
terminal:

- **applied** — `purchases` is the durable record from then on (`resolveCheckout`
  when the pull side got there first);
- **the created webhook landed** — the happy path, and the common one.
  `subscription.created` is the one event Paddle stamps with the `transaction_id`
  that caused it, so the push side can retire the row by exact key
  (`applyPaddleEvent`). Gated on the apply having **landed**: an unapplied event
  is exactly the permanent drop the row exists to retry. It's also the only
  reaper for a successful purchase — an entitled account returns before the scan,
  and its next checkout (the other `deleteStale` caller) is refused as
  already-subscribed, so without this a subscriber's row would never leave;
- **the transaction is canceled**, or **Paddle 404s the id** — nothing will come
  of either;
- **abandoned** — old (~12h) and the transaction is still `draft`/`ready`, i.e. no
  payment was ever _attempted_, so it cannot be the paid-into-silence case at all.
  This is what pays for the 3-day TTL: abandonment is the bulk of the table, and
  until a row is gone it adds a Paddle round-trip to that free account's status
  reads (background ones — `useEntitlements` renders a last-known copy meanwhile).
  Gating on the **status** and not on age alone is what makes it safe, and the
  clock is generous on purpose: it's the only irreversible step here, a `ready`
  transaction has no documented expiry at Paddle, and hour-scale delays between
  opening a checkout and paying are ordinary. Half a day sheds ~5/6 of the tax
  without betting a paid user's recovery on a slow checkout.

An abandoned checkout is otherwise indistinguishable from a lost webhook, which
is precisely why the row is disposable. Two properties fall out: the gate is a
plain existence check, and the row's `user_id` (written from the **session**)
serves as a fallback binding when a first-seen subscription's `custom_data`
didn't survive. Cost to everyone else is nil — an entitled fold can't be hiding a
lost first webhook, so the check runs only after a read still says `free`.

**Drop visibility — a log, not a dead-letter table.** The pull side recovers any
drop on a subscription we already have a row for: the row is what the staleness
gate iterates, so once the bad config is fixed the next status read re-pulls it.
A drop on a **first-seen** subscription used to be unrecoverable outright; with
pending checkouts it now gets retried every debounce window until the TTL, so
`IAP_DROP_UNRECOVERABLE` is suppressed on that path and what's left of the token
means a drop that escaped the webhook _and_ that window (no pending row, or one
already aged out). `applyPaddleSubscription` looks up the binding first and tags
only that case, plus the `sub_…` id: one greppable token to alert on, carrying
exactly what a replay needs. Deliberately not a D1 dead-letter table —
Paddle already stores every notification and replays it on demand, so a table
would duplicate the provider's own queue with no drainer to justify it, and a
dead-letter row without something draining it is a log entry with worse
ergonomics. This leans on `observability.enabled` in `wrangler.jsonc` (Workers
Logs retains and makes `console.error` queryable); without that the argument
collapses. Revisit if drops become routine rather than a config bug fixed once,
or if we ever consume an event a provider doesn't retain.

**What this does not catch:** a row that looks healthy but was canceled at the
provider without the event reaching us. It over-entitles until its period ends,
and no read-path heuristic can see it — the row looks perfect. Nor does anything
above run without a user: every trigger hangs off a status read, so an account
nobody opens is never reconciled.

Both are the **scheduled-sweep** case, and when it's worth building, prefer
Paddle's **event stream** (`GET /events?after=<cursor>`, cursor-paginated, ~90-day
retention) over the age-based row scan first sketched here: replaying every
`subscription.*` since the last cursor closes _all four_ rows of the table above
at once — including events we 200'd but couldn't apply — with no per-user key
needed, and the repo upsert's out-of-order guard makes re-applying already-seen
events free. Not built yet: the read-path gates cover the direction users
actually report (paid but showing free), and a cron + cursor is worth its
infrastructure once there's subscriber volume. Meanwhile Paddle's Notifications
API (`GET /notifications`, `POST /notifications/{id}/replay`) is the ops escape
hatch, and the dashboard's replay button is the zero-code version available today.

The fold, `iap/status`, and the quota gate don't change at all. Manage/cancel
for store purchases lives in the platform store's own surface (the app
deep-links to it); a Paddle purchase seen from the app gets a
"manage on the web" note, the converse of the web's store note.
`source: 'manual'` covers comps/lifetime grants (non-expiring rows) — and, on a
developer machine, it is how you get a paid account without Paddle's sandbox at
all: `npm run seed:accounts` writes one straight into local D1
([e2e.md](./e2e.md), _seeding a dev account_). Nothing test-only is needed here
for that to work, which is the point — a grant with no provider behind it was
always a real product state, so `isEntitled` reads a null expiry on a `manual`
row as never-expiring and `needsRefresh` skips it outright. It is also how a
staging journey that needs a paid lever gets one: the same row, written to
staging's remote D1 for that run's disposable account
([e2e.md](./e2e.md), _deployed staging and mobile Release builds_).

### config per env

- **bracemark-api** (`wrangler.jsonc`): `PADDLE_API_BASE` (sandbox for
  development/staging, live for production), `PADDLE_PRICE_ID_PLUS/_PRO`
  (per-env — sandbox and live mint different `pri_…` ids — and each a
  **comma-separated list**, the price on sale first; see _reconciliation_);
  secrets
  `PADDLE_WEBHOOK_SECRET` + `PADDLE_API_KEY` via `wrangler secret put`
  (the login keychain locally — [env-files.md](./env-files.md), _bracemark-api
  local secrets_). Register the webhook destination per env at
  `…/v1/iap/paddle/webhook`, subscribed to `subscription.*` events.
- **Paddle dashboard → Checkout settings, per Paddle account**: the **default
  payment link** is `<bracemark-web origin>/settings/subscription`. That's
  `https://app.bracemark.com/settings/subscription` on live, and on the sandbox
  staging's origin (or `http://localhost:3000/…` while developing alone — one
  sandbox account serves both). Required: transaction creation fails without it
  (see _the payment link_). Live needs the domain approved first.
- **bracemark-api, store IAP** (`wrangler.jsonc`): `APPSTORE_API_BASE` (sandbox host
  for development/staging, production host for production — production also
  falls back to sandbox on 404 in code, for App Review),
  `APPSTORE_ISSUER_ID`/`APPSTORE_KEY_ID`/`APPSTORE_BUNDLE_ID`,
  `PLAY_PACKAGE_NAME`/`PLAY_SA_EMAIL` (**no `PLAY_API_BASE`** — the Play
  Developer API has one host for test and real purchases alike, so Play's
  per-env dimension is the package name + service account); secrets
  `APPSTORE_PRIVATE_KEY` (the
  In-App Purchase key's PKCS#8 PEM), `PLAY_SA_PRIVATE_KEY` (the service
  account's), and `PLAY_NOTIFY_TOKEN` (the push-endpoint guard) via
  `wrangler secret put` (the login keychain locally, never `.dev.vars`: the
  one In-App Purchase key serves every tier and works on the production host —
  [env-files.md](./env-files.md), _bracemark-api local secrets_). Register per env: App Store
  Server Notifications V2 → `…/v1/iap/appstore/notify`, where App Store Connect
  has exactly one Sandbox and one Production URL, so sandbox → staging and
  local testing replays instead (_exercising the App Store locally_); Play RTDN
  Pub/Sub push → `…/v1/iap/playstore/notify?token=<PLAY_NOTIFY_TOKEN>`. No store product-id
  vars — those are shared constants (`iap/store-products.ts`).
- **bracemark-web** (`.env.*`): `NEXT_PUBLIC_PADDLE_ENV` +
  `NEXT_PUBLIC_PADDLE_CLIENT_TOKEN` (client tokens are public by design). There
  is deliberately **no `NEXT_PUBLIC_PADDLE_PRICE_ID_*`**, even though a `pri_…`
  is equally public: the client gets the on-sale id from `GET /v1/iap/prices` so
  that "which price is on sale" keeps exactly one declaration (see _currency_).
- **The per-currency prices are catalog config in each provider, never env vars
  and never code** — Paddle `unitPriceOverrides`, App Store Connect / Play
  Console storefront prices. Nothing in this repo needs an edit to add one.
- **Every Paddle price is created with `tax_mode: 'location'`**, in sandbox and
  live alike (see _currency_, _tax_). It's catalog config like the overrides.
  Omitting it makes the price inherit the account default instead, with no
  error. That default (Checkout → Sales tax settings) is set to `location` on
  both accounts as the backstop (see _tax_).
- **Every Paddle product is `tax_category: 'saas'`**, in sandbox and live alike.
  Plus is access to a hosted service (the web app, encrypted sync, server link
  previews), which is Paddle's definition of `saas`. `standard` ("Standard
  digital goods" in the dashboard) means pre-written software that is downloaded
  and installed, and some jurisdictions tax the two at different rates. `saas`
  is on every account without approval. It's catalog config like the overrides,
  and the sandbox's Plus product was first created as `standard`, so check it
  whenever a product is re-created (the live catalog is recreated, not copied).
- **CSP note**: bracemark-web's CSP is enforced (it lives in the **CloudFront response
  headers policy**, not Next or Cloudflare — bracemark-web is a static export), and
  it has to allow Paddle's origins: `script-src`/`frame-src`/`connect-src`/`img-src`/
  `style-src` all need `https://*.paddle.com` (one wildcard covers sandbox +
  live). Concrete directives + the `connect-src` exfiltration-widening tradeoff
  are in [hosting.md](./hosting.md#security-headers--where-the-csp-has-to-live).
  `IAP-WEB-001` runs against staging for this reason: local runs open the same
  overlay under no policy at all ([e2e.md](./e2e.md), _subscriptions_).
  **One violation is expected, and it is on production only.** Live Paddle.js
  injects Paddle Retain's `public.profitwell.com/js/profitwell.js`, the
  sandbox never does, and our `script-src` blocks it. Leave it blocked:
  allowing it would make Paddle's no longer the only third-party script in
  Bracemark, and we don't use Retain. Reasoning and specimen are in
  [hosting.md](./hosting.md#security-headers--where-the-csp-has-to-live), the
  ProfitWell bullet.
- **Apple Pay** needs each checkout domain verified with Apple: a file downloaded
  from the Paddle dashboard, served at
  `/.well-known/apple-developer-merchantid-domain-association` on bracemark-web.
  It has no extension, so the CloudFront function needs an exact-path exception
  to serve it — [hosting.md](./hosting.md#apple-pay-domain-verification).

### exercising Paddle locally

`development` is the one tier Paddle cannot reach on its own: `wrangler dev`
answers on `localhost:8787`, and a notification destination needs a public HTTPS
URL. Four ways to exercise this flow, cheapest first — and the order is the
point, because the expensive one proves the least about our code.

1. **The specs sign their own events.** `routes/iap.spec.ts` MACs a body with a
   test secret and posts it at the real route, so the signature, the ±5-minute
   replay window, log-and-ACK, the upsert's three guards, the fold and the
   missed-webhook recovery are all pinned offline, in milliseconds, under the
   Workers pool. Any question about what WE do with an event is answered there.
   Nothing below improves on that; they answer the other question — whether the
   two accounts still hold the config this repo assumes.
2. **`npm run check:paddle`** asks the dashboard directly
   (`tools/scripts/check-paddle.ts`). It reads the tier's `PADDLE_API_BASE` and
   price lists out of `wrangler.jsonc`, resolves every configured `pri_…`
   against the catalog, and then mints ONE transaction and cancels it — the only
   way to see `checkout.url`, and therefore the only way to catch a missing
   default payment link before a customer does. What it fails on: a price
   archived or 404, `tax_mode` back to the account default, a product's
   `tax_category` reset, a one-time price where the cadence on sale is yearly,
   one id configured for two plans, and a payment link whose path isn't
   `/settings/subscription`. Each is dashboard state; none of them fails
   anywhere else. Defaults to `development`; `-- staging` / `-- production`
   for the deploy tiers (the live account prompts first), `-- --no-checkout`
   to stay read-only. No money moves at any tier. It is a `check:` script and
   not a spec because it needs the network and a real API key, which is exactly
   what `npm run test` must not have; the key comes from `PADDLE_API_KEY`, then
   the login keychain (`bracemark-paddle-key-<tier>`) — never from a file, for
   any tier; the `development` item is the one `npm run dev` hands the local api
   ([env-files.md](./env-files.md#whats-committed-vs-ignored)).
3. **The dashboard replays.** Notifications → the simulator sends a synthetic
   event at any destination, and a real delivery can be replayed from its log
   (`POST /notifications/{id}/replay` is the API of the same button). Against
   the deployed staging destination that needs no local wiring at all, and it is
   the right tool for "did my handler change break an event shape".
4. **A tunnel, when it has to be Paddle reaching THIS branch.** A public
   hostname in front of `localhost:8787` plus a second notification destination
   pointed at it — `subscription.*` only, and its own secret as
   `PADDLE_WEBHOOK_SECRET` (exported for that session, or swapped into the
   `bracemark-paddle-webhook-secret-development` keychain item), since each
   destination signs with its own. Three things that are not obvious:
   - **Expose only `/v1/iap/paddle/webhook`.** `localhost:8787` answers every
     route the Worker has, authenticated ones included, so a whole-origin tunnel
     publishes your dev API and its local R2 for as long as it is up. Restrict
     by path, not by intention.
   - **The default payment link is account-level.** One sandbox account serves
     development and staging (_config per env_), so pointing it at
     `http://localhost:3000/settings/subscription` retargets staging's checkouts
     too, and nothing puts it back but you.
   - **The tunnel is machine config, not repo config.** The hostname, its DNS
     record and the ingress rules live outside this repo, and there is
     deliberately no `npm run` alias for them: a script every clone of a public
     repo fails on isn't a convenience, and the mapping would advertise which
     hostname fronts a laptop.

That last one is a **manual release check** — worth doing once after any change
to the Paddle config, and not something to automate (`IAP-PADDLE-RELEASE-001` in
`e2e/web/RELEASE.md` is its checklist). What IS automated stops one step short
of a payment: `IAP-WEB-001` creates the real sandbox transaction, opens the real
overlay and closes it ([e2e.md](./e2e.md), _subscriptions_). Driving the checkout itself
means driving a third-party iframe, a sandbox card and a webhook round trip, and
it leaves a live subscription behind ([e2e.md](./e2e.md), _what e2e may not
assert_).

### exercising the App Store locally

App Store Connect takes **one** Server Notifications URL per environment per
app (App Information → App Store Server Notifications: a Production Server URL
and a Sandbox Server URL, each V2). The sandbox one points at **staging**
(`https://api.dryrunbase.com/v1/iap/appstore/notify`, _config per env_). There
is no second destination to add for a tunnel, as Paddle allows. There is also
no need for one, for two reasons.

- **A first purchase needs no push at all.** `iap/verify` binds the purchase
  and returns the fold, so buying in the sandbox against `wrangler dev` already
  exercises everything up to the notification.
- **Apple keeps what it sent.** The App Store Server API's notification history
  returns the signed payloads of the last 180 days, sandbox included, so the
  push path can be driven by pulling them instead of receiving them.

**`npm run replay:appstore`** (`tools/scripts/replay-appstore.ts`) does that
pull. It lists the sandbox notifications in a window (`--since 6h`/`3d`/a date,
24h by default; `--transaction <id>`, `--type DID_RENEW` to narrow it), POSTs
each one oldest-first to the local `/v1/iap/appstore/notify`, and then compares
the local `purchases` rows before and after. `--dry-run` only lists them. It
signs with the same `APPSTORE_*` ids from `wrangler.jsonc` and the same
`APPSTORE_PRIVATE_KEY` keychain item that `npm run dev` hands `wrangler dev`, and it
refuses any `--api` other than localhost, because the comparison reads local
D1. The loop, with the sandbox's compressed renewal periods (monthly in
minutes): buy in a dev build pointed at the local api, cancel or let it renew,
wait for the event, run the script. How to read its output:

- **A replay applies Apple's state as of now, not as of the notification.** The
  route uses the payload only to find _which_ subscription changed and
  re-fetches the rest (step 4 of _the purchase flow (store IAP)_). What a replay
  proves is the push path end to end (route, decode, Apple fetch, binding,
  upsert). It is not a time machine, and `rewritten, unchanged` is a pass: the
  row already matched Apple, typically because the app's own status read got
  there first through the staleness refresh.
- **`no local row` is the drop working, not a bug.** A notification lands only
  on a subscription _this_ api bound through `iap/verify`. A sandbox purchase
  made from a build pointed at staging has no row locally, just as staging has
  none for a purchase made locally.
- **A 200 means handled, not applied.** The route is log-and-ACK, so the row
  comparison is the answer; `not written` sends you to the `wrangler dev` log's
  `applyStoreNotification` line. A non-200 is the one real failure: Apple's API
  failed, and Apple would have retried.
- **History only holds what Apple tried to deliver**, so the Sandbox Server URL
  has to be set for there to be anything to replay.

Leave the sandbox URL on staging rather than repointing it at a tunnel for an
afternoon. Nothing restores it afterwards, and until it is restored staging
stops hearing about sandbox renewals except through its staleness refresh. A
fan-out forwarder in front of both is possible and harmless, since both
backends re-fetch and each applies only what it bound. It is machine config
like the tunnel, though, and the script above makes it unnecessary.

**Play needs none of this.** RTDN is a Pub/Sub topic, and a topic takes several
push subscriptions, so a second one pointed at a tunnel's
`/v1/iap/playstore/notify?token=<PLAY_NOTIFY_TOKEN>` gets real fan-out. The
tunnel rules under _exercising Paddle locally_ apply unchanged: expose that path
only, and keep the hostname out of this repo.

### open follow-ups

Three of these are one family — **plan change**, **cadence change**, and **the
store crossgrade** below: every change to a live subscription is unbuilt. They
share a cause (a subscription that already exists can only be _updated_, never
re-bought) and a stopgap (upgrade cards render only on free, and
`POST /iap/checkout` 409s + dedupes — see _checkout_ above), so whichever ships
first should land the flow the other two reuse.

Note what that stopgap does **not** cover, since the flow inherits it: the store
side has no pre-payment refusal to add (see _the purchase flow (store IAP)_,
step 2), so on stores the client gate is the whole of the prevention. Today that
holds because the cards render only on `free`; the plan-change flow's entire
purpose is rendering them to **paid** users, so it has to bring its own answer —
a crossgrade inside the existing subscription rather than a second purchase.
`IAP_DOUBLE_SUBSCRIPTION` is the detector either way, not a substitute for it.

- **Plan change (Plus→Pro)** — a Paddle subscription _update_ with proration;
  until then upgrade cards show only on free and the server 409s a second
  checkout. Deferred deliberately: Pro is not on sale (`AVAILABLE_PAID_PLANS`),
  so at launch there is exactly one paid plan and nothing to change to.
- **Cadence change (monthly↔annual)** — the SAME subscription-update flow, not a
  lighter case: on Paddle it is an item swap to the other `pri_…` with
  proration, and on the stores it is a crossgrade inside one subscription group.
  This is why `AVAILABLE_CADENCES` is `['yearly']` at launch — selling monthly
  first would ship a one-way door, where a monthly customer who wants annual has
  no path but cancel, wait out the period, and re-subscribe.
- **Selling the monthly cadence at all** — beyond the switch flow, the catalog
  is still single-cadence on the store side. `STORE_PRODUCT_IDS` is
  `Record<PaidPlan, string>` (one SKU, `…​.yearly`), so it needs the cadence axis
  and both stores need the products created. Paddle's half is now config, not
  code: the price map takes a **list** per plan (see _reconciliation_), so adding
  the monthly `pri_…` to `PADDLE_PRICE_ID_PLUS` is what stops a monthly
  subscriber's webhook failing `unknown_price` — the log-and-ACK permanent drop
  where they pay and never get entitled. What is NOT yet built is letting the
  buyer pick: checkout sells the first id in the list, so a cadence choice needs
  a cadence on `iap/checkout`'s request. Prices are already constants
  (`PLAN_USD_PER_MONTH`); nothing else is.
- **Lifetime ($149, the capped launch lever)** — a one-time Paddle transaction,
  and `applyPaddleEvent` returns early on anything that isn't `subscription.*`
  (`transaction.completed` is deliberately ignored), so today a lifetime payment
  would be accepted and dropped on the floor. Needs that branch, writing a
  purchase row with `expires_at: null` — the fold's non-expiring case, which
  already works for manual grants. `LIFETIME_ON_SALE` in `iap/plans.ts` is the
  single flag every surface reads; it stays `false` until this exists, and the
  pricing page renders nothing at all rather than a "coming soon" strip.
- **The trial is catalog config, plus one detection rule per provider** —
  `TRIAL_DAYS` (14) is the copy's source, but the trial period itself is
  configured in each provider's catalog, never in code: a trial period on the
  **yearly `pri_…`** in Paddle, an introductory offer on the yearly SKU in App
  Store Connect, and an offer on the yearly base plan in Play Console. The fold
  already treats `trialing` as entitled, and the client SEES it:
  `subscriptionStatusSchema.status` carries `'trialing'` alongside `'active'`,
  so both subscription sections say "Free trial — your first payment is on
  <date>" instead of "Renews on <date>" (and "Free trial ends on <date> — you
  won't be charged" once it's been cancelled mid-trial, which the generic "it
  won't renew" leaves unanswered). Trialing and active are identical in
  entitlement (a trialing account gets exactly `plan`, which is why
  `entitlementsOf` takes only the plan) and different in what they owe the user
  — reading "Renews on" mid-trial implies a payment that hasn't happened, which
  is both dishonest and the opposite of what EU/UK distance-selling assumes was
  disclosed.

  **Only one of the three providers reports the trial as a status.** Paddle has
  `trialing` in `status` and flips it to `active` itself. Apple's status codes
  don't — code 1 is plain "active" whether or not an offer applies — so
  `lib/appstore.ts` keys on the transaction's `offerDiscountType === 'FREE_TRIAL'`,
  that value exactly: `PAY_AS_YOU_GO`/`PAY_UP_FRONT` are _discounted_ intro
  offers whose buyer has already been charged. Play has no trial state either
  (v1's `paymentState: 2` did not survive into subscriptionsv2), but its line
  item names the pricing phase it is in, so `lib/playstore.ts` keys on
  `offerPhase.freeTrial` — the member of that one-of Play sets while the trial
  runs, replaced by `basePrice` at the first charge. All
  three are gated on the normalized status being `active`, so a lapsed trial in
  dunning keeps the `past_due` sentence rather than being told it's still free.
  Play's gate has a second arm, because Play alone turns a mid-trial cancel
  into a state of its own (`SUBSCRIPTION_STATE_CANCELED`, where Paddle and Apple
  keep the status and flag the cancellation beside it): a cancelled line still
  in `freeTrial` is `trialing` with its end stamped, which is what earns the
  "you won't be charged" sentence. The arm reads Play's raw state rather than
  ours, since `EXPIRED` normalizes to the same `canceled` and a trial that
  lapsed unconverted goes on reading `freeTrial` — marked `trialing`, it would
  ride the fold's expiry slack a day past its end.

  **The Play trap: the offer outlives the trial.** Play is the only provider
  that carries one line item across the trial→paid boundary (Paddle's status
  flips; Apple mints a fresh transaction for the first paid period and drops the
  offer fields with it), and `offerDetails` rides across it unchanged: it names
  the offer the line was _bought_ under, not the phase it is in. Detection was
  first keyed on that offer's tag, on the assumption that the tag left with the
  trial. It does not. A license tester's subscription, minutes after its first
  charge, read `offerPhase: { basePrice: {} }` beside
  `offerDetails.offerTags: ['free-trial']` and a processed order, and the app
  went on saying "Free trial — your first payment is on <date>" — which in
  production is every Android subscriber who started on the trial, for as long
  as they stay, with nothing to ever clear it. No spec could catch it, because
  the specs build their own payloads.

  **The tag still has one reader, and one rule.** `PLAY_FREE_TRIAL_OFFER_TAG`
  (in `@stxapps/shared`, beside `STORE_PRODUCT_IDS`) is how bracemark-expo's
  checkout picks the trial offer's token: Play lists the base plan and every
  eligible offer in no promised order, so buying the first entry would grant or
  skip the trial by list order. A tag rather than an offer id, so regional or
  campaign trial offers all share one marker and adding one needs no deploy.
  Tag the OFFER, never the base plan: `offerTags` includes tags inherited from
  the base plan, so a base-plan tag lands on the base plan's own entry too and
  the lookup is back to list order.

  **Launch checklist**: configure the trial on the annual price/SKU/base plan in
  all three catalogs and never on a monthly one (`TRIAL_CADENCES`) — the
  marketing site already says "14 days free" (`/pricing`), so a catalog that
  doesn't carry it is a promise the checkout breaks. Then verify the two things
  no unit test can reach, because the specs build their own payloads. First,
  that a real trialing Paddle subscription folds to `trialing` with `expiresAt`
  at the trial end. Paddle documents this: `current_billing_period` is `null`
  only for `paused` and `canceled`, and for a trialing subscription it spans the
  trial, switching to the `billing_cycle` on activation. It still matters
  because a provider row with a null period deliberately does not entitle (see
  `isEntitled`). Run it once through the tunnel (_exercising Paddle locally_),
  then call `POST /subscriptions/{id}/activate` to end the trial early and
  check the row turns `active` with the yearly period, without waiting 14 days.
  Second, that a Play trial CONVERTS: the row is `trialing` while
  `subscriptionsv2` reads `offerPhase.freeTrial`, and turns `active` on the
  renewal notification that follows the first charge. Both stores
  compress subscription periods for sandbox/license testers, so that transition
  runs in minutes rather than 14 days.

- **Surfacing `quota_exceeded` client-side** — DONE.

  The sync engine inspects the 403 (`signPushable`, in both
  `web-react`/`expo-react` `sync/engine.ts`). It used to throw, which failed the
  cycle, left the chunk queued, and re-failed it on every subsequent cycle — a
  permanent wedge, and not confined to the offending blob, since a chunk mixes
  list/tag/pin/settings puts. Now the refusal is recorded on the cycle's
  `SyncOutcome` and the cycle completes. There is no partial retry: no subset of
  a chunk fixes being out of bytes. Blocked ops stay QUEUED, so they upload by
  themselves once the account is back under its limits.

  `SyncOutcome` carries `blocked` and **how many** ops it cost (`blockedCount`),
  collected as a mutable accumulator threaded down the push chain — the refusal
  is learned four frames below the only caller that reports it, so an accumulator
  costs one write at the bottom where bubbling it through return types would
  widen every frame between. `shared/sync/status.ts` owns the accumulation rule
  (`recordBlocked`) and the outcome→status mapping (`bgStatusForOutcome`), so the
  two sibling engines and their providers cannot drift on either.

  The state is then visible rather than silent, and visible as the RIGHT state:
  `BgSyncStatus` has `'blocked-capacity'` and `SyncPhase` `'capacity-blocked'`,
  deliberately NOT `'error'` — the cycle completed and no retry can help, so
  "Sync failed" would send the user hunting for a network problem instead of the
  fix. `syncBlockedDetail` (shared) words the sentence with the count, so all
  three surfaces that EXPLAIN the state (both Data cards, the extension popup
  pill's "Storage full") say the same thing.

  Both links-page **⋯ menus** report it too — the only always-visible sync
  surface that app has — but they do not repeat the sentence. The Sync item
  keeps its plain label there: its other two variants ("Syncing…", "Sync failed
  — Retry") re-label one action by what pressing it will do, and blocked is the
  phase where pressing changes nothing. The state gets its own row instead,
  "Storage full / Some changes aren't syncing", which LINKS to Settings → Data
  where the count and the fix are. That row's icon is the menu's plain ink, like
  every other row's — the second line, not a lighter glyph, is what marks it as a
  report — and on web that second line has to be spelled `text-muted-foreground!`,
  because the item's focus rule repaints every descendant and would otherwise
  flatten the two lines to one weight on hover ([theme.md](./theme.md), _the
  menu-item focus recolour_). The menu also grows the trigger dot for it, full-ink
  `foreground` rather than the error dot's `destructive` — a standing state worth
  noticing, not breakage — and a rung above the advanced-search trigger's
  `foreground/70`, which is why it is not `muted-foreground`: at `/70` that benign
  neighbour was compositing DARKER than a muted dot would, so the ladder read
  upside down.

  There used to be a second pair, `'blocked-plan'` / `'plan-blocked'`, for the
  free tier's link cap, with its own wording and a "See plans" link — the two
  codes wanted opposite advice, since sending a paying customer who is out of
  BYTES to `/settings/subscription` helps nobody. Both are gone with the cap
  itself: an over-cap save is now refused at the create surface and never becomes
  a pending op, so there is no partial push to report and no plan-blocked state
  to be in.

  **Upgrading still kicks a cycle**, and still for a real reason: an upgrade
  raises `maxBytes` by orders of magnitude (100 MiB → 5 GiB), so puts the ceiling
  refused a moment ago now fit. Nothing else would kick one — the engines sync on
  provider mount and on `requestSync` (a local edit), so without it a user
  upgraded, came back, and still read "Some changes aren't syncing" until they
  reloaded. Both subscription sections call `requestSync()` at the moment the
  plan actually widens — web when `pollActivation` sees the webhook land, expo on
  a completed store purchase AND on a successful restore. There is no mirror of
  this on the way down: the ceiling never narrows again (see _enforcement_), so
  a lapse can't turn a syncing library into a refused one.

  The **bracemark-expo share sheet** runs the cap gate on **both** platforms now
  (`isAtLinkCap` in expo-react's `data/share-store.ts`; the sheet reports
  `'quota'` and refuses, matching every other create surface). Android reads the
  store live; iOS reads a `linkCount` + `maxLinks` pair carried on the App Group
  taxonomy snapshot, because its share extension is a separate process barred
  from the app's sqlite ([share-sheet.md](./share-sheet.md)) and so can read
  neither at first hand. That snapshot was already rewritten on every local write
  (`ShareBridge` refreshes on `localWriteNonce`), so the count costs one indexed
  COUNT on a refresh that was happening anyway.

  Still open: the **action-interrupt** paywall for this code (the hoisted
  `usePaywall` dialog) is not wired to sync — the blocked state is reported on
  the Data card, which is a status surface, not an interrupt.

- **Extraction gating beyond the settings toggle** — free stores the preview
  image, but the HEAVY blob facets (read-mode / screenshot / page copy) are
  client-gated: since the server no longer refuses any `files/` put (it can't
  tell a preview image from a heavy blob), client extractors must skip those
  heavier facets on free accounts themselves — the bytes/count quota is only a
  backstop, not the feature gate.
- **Plan change on the stores** — same gap as Paddle's Plus→Pro: a store
  crossgrade (both plans share one App Store subscription group / Play
  subscription) is its own flow; until then upgrade cards show only on free.
- **Self-binding store notifications** — give the stores their own
  `custom_data.userId` so a push can record a purchase the app never verified:
  stamp the account onto the purchase at request time via `appAccountToken`
  (iOS) / `obfuscatedAccountId` (Android) — both typed by the installed
  expo-iap, and both returned on the authoritative fetch (the JWS transaction
  payload; `obfuscatedExternalAccountId` on `subscriptionsv2`). Then
  `applyStoreNotification` gets the same `fallbackUserId` parameter
  `applyPaddleSubscription` already takes for pending checkouts, and the trust
  split is unchanged: **plan from the store, account from the stamp**. Needs a
  binding-key decision first — the client doesn't know its own userId (the fact
  that makes Paddle checkout server-created), so either expose it or mint a
  per-purchase token, which Apple constrains to UUID format (`newId()` is
  `crypto.randomUUID()`, so both qualify). Deliberately deferred: this is
  **purchase recovery, not latency**. Losing the notification race costs the
  user nothing today — verify's own response is the flipped plan, with no
  polling — so the payoff is only where verify never lands at all (app killed,
  offline, a 502), which today ends in Google's 3-day auto-refund or an Apple
  user tapping "Restore purchases". Worth building when store volume makes that
  tail real.
- **Privacy note** — payment inherently deanonymizes (Paddle holds email +
  payment identity). bracemark-api stores only `userId ↔ subscription id ↔ ctm_…`;
  keep it that minimal so "the server knows who pays but still can't read
  anything" stays true.
