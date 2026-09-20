'use client';

// The Subscription settings section: current plan + upgrade cards + billing
// management. The moving parts and the IAP design:
//  - plan/status come from useEntitlements (the `iap/status` query + the
//    device-local last-known copy);
//  - an upgrade is: POST /v1/iap/checkout (server creates the Paddle
//    transaction, stamping the account binding) → overlay checkout
//    (lib/paddle.ts) → on completion, POLL `iap/status` until the webhook lands
//    and the plan flips (payment truth reaches bracemark-api via webhook, never
//    through this client);
//  - "Manage billing" opens a server-minted Paddle customer-portal session
//    (payment method, invoices, cancel);
//  - this page is Paddle's default payment link, so a `?_ptxn=txn_…` link from
//    one of Paddle's emails opens its checkout here on arrival
//    (PAYMENT_LINK_PARAM);
//  - store-bought subscriptions (future bracemark-expo) are managed in the store,
//    so they get a note instead of the portal button.

import { useEffect, useRef, useState } from 'react';
import { Check, ExternalLink, Loader2, RefreshCw } from 'lucide-react';

import { useApiClient } from '@stxapps/react';
import {
  type AvailablePaidPlan,
  entitlementsOf,
  iapCheckoutEndpoint,
  iapPortalEndpoint,
  type Plan,
  PLAN_CARD_COPY,
  PLAN_CARDS,
  PLAN_LABELS,
  PLAN_USD_PER_YEAR,
  type SubscriptionStatus,
} from '@stxapps/shared';
import { useEntitlements, useSync } from '@stxapps/web-react';
import { Button } from '@stxapps/web-ui/components/ui/button';

import { SettingsHeader, SettingsNotice, SettingsPane } from '../../_components/settings-kit';
import { usePaddlePrices } from './use-paddle-prices';

import { LegalConsent } from '@/components/legal-consent';
import { openPaddleCheckout } from '@/lib/paddle';

// The upgrade cards (copy + which plans are on sale) come from PLAN_CARDS in
// @stxapps/shared iap/plans.ts, next to the entitlements table they render —
// shared with bracemark-expo's store section so the two storefronts can't drift.

// How long to poll `iap/status` after a completed checkout before telling the
// user it's still processing (the webhook usually lands within seconds).
const ACTIVATION_TRIES = 15;
const ACTIVATION_INTERVAL_MS = 2000;

// Paddle's checkout PAYMENT LINK: `<default payment link>?_ptxn=txn_…`. This
// page is the default payment link (docs/iap.md, _the payment link_), so it is
// where Paddle's own emails land: a failed renewal's "update your payment
// details". (Not checkout recovery — Paddle skips API-created transactions,
// and all of ours are; docs/iap.md, _the payment link_.) Paddle.js would open
// such a link by itself on initialize, but only this page loads Paddle.js, and
// only for a free account's price preview — a subscriber in dunning, the
// customer this link exists for, would land on a page that never opened
// anything. So the section opens it explicitly, which Paddle documents as
// taking priority over the auto-open, and which is what gives the overlay the
// same completed/closed handlers as an in-app checkout.
const PAYMENT_LINK_PARAM = '_ptxn';

// The id from the current URL, or null. Read-only — see stripPaymentLinkParam.
// A value that isn't shaped like a transaction id is ignored rather than handed
// to Paddle: the parameter is attacker-writable (anyone can send a link), and
// an overlay that errors on junk is a worse page than one that opens nothing.
function readPaymentLinkTransactionId(): string | null {
  if (typeof window === 'undefined') return null;
  const id = new URL(window.location.href).searchParams.get(PAYMENT_LINK_PARAM);
  return id !== null && /^txn_[a-z\d]+$/.test(id) ? id : null;
}

// Drop `_ptxn` from the address bar, keeping everything else. Two reasons it
// can't stay: a reload (or Back into this page) would open the same overlay
// again, and Paddle.js — initialized by the price preview on a free account —
// would auto-open it a SECOND time on its own. Native replaceState rather than
// the Next router: it changes no route, and Next's router adopts it.
function stripPaymentLinkParam() {
  const url = new URL(window.location.href);
  if (!url.searchParams.has(PAYMENT_LINK_PARAM)) return;
  url.searchParams.delete(PAYMENT_LINK_PARAM);
  window.history.replaceState(window.history.state, '', url);
}

function formatDate(epochMs: number): string {
  return new Date(epochMs).toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });
}

export function SubscriptionSection() {
  const api = useApiClient();
  const { subscription, isLoading, refetch } = useEntitlements();
  // Kicked the moment the plan actually widens — see pollActivation.
  const { requestSync } = useSync();

  // One busy flag drives every control: 'checkout:<plan>' while a checkout is
  // being created/open ('checkout:link' for one a payment link opened),
  // 'activating' / 'recovering' while polling for the webhook, 'portal' while
  // minting a portal session. Serializing them keeps double-clicks and
  // overlapping flows out.
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // The poll survives the overlay's own lifecycle, but must stop if the section
  // unmounts mid-loop.
  const unmounted = useRef(false);
  useEffect(() => {
    return () => {
      unmounted.current = true;
    };
  }, []);

  // The buyer's own price for the upgrade cards, looked up only when those cards
  // will render — which is also what first loads Paddle.js (see the hook, and
  // the published claim it answers to). bracemark-expo's section does the same
  // one layer over, against the store catalog instead of Paddle's.
  //
  // `isFetched`, not `isPending` or `data === undefined`, is what tells the
  // fine print below whether the lookup is DONE: loading and failed both leave
  // `data` undefined, so testing that would flash a dollars disclaimer during a
  // lookup that is about to render euros. (`isPending` would be worse — a
  // disabled query stays pending forever.)
  const plan = subscription.plan;
  const { data: prices, isFetched: pricesFetched } = usePaddlePrices({
    enabled: !isLoading && plan === 'free',
  });

  // After a completed payment, re-read `iap/status` until the webhook has
  // landed — `settled` says what "landed" looks like for this payment — then
  // hand the fresh status to `onSettled`. Payment truth only ever arrives by
  // webhook, so every completed overlay ends in one of these polls.
  const pollStatus = async (options: {
    busy: 'activating' | 'recovering';
    settled: (status: SubscriptionStatus) => boolean;
    onSettled: (status: SubscriptionStatus) => void;
    timeoutNotice: string;
  }) => {
    setBusy(options.busy);
    setNotice(null);
    for (let i = 0; i < ACTIVATION_TRIES; i++) {
      const { data } = await refetch().catch(() => ({ data: undefined }));
      if (unmounted.current) return;
      if (data && options.settled(data)) {
        setBusy(null);
        options.onSettled(data);
        return;
      }
      await new Promise((r) => setTimeout(r, ACTIVATION_INTERVAL_MS));
      if (unmounted.current) return;
    }
    setBusy(null);
    setNotice(options.timeoutNotice);
  };

  // A purchase: poll until the webhook flips the plan. The plan upgrade case
  // (plus → pro) polls for any CHANGE from the starting plan.
  const pollActivation = (fromPlan: Plan) =>
    pollStatus({
      busy: 'activating',
      settled: (data) => data.plan !== fromPlan,
      onSettled: (data) => {
        // The widened entitlement is the ONLY thing that unblocks a queue the
        // quota gate refused (engine signPushable / BgSyncStatus
        // 'blocked-capacity'): an upgrade raises maxBytes by orders of magnitude
        // (100 MB → 5 GB), so puts that were over the ceiling a moment ago now
        // fit. Nothing else would kick a cycle — the engine syncs on mount and
        // on local edits, so without this the user upgrades, comes back, and
        // still reads "Some changes aren't syncing" until they reload or make an
        // edit. Safe to fire eagerly — cycles single-flight per account.
        requestSync();
        setNotice(`You’re on ${PLAN_LABELS[data.plan]} now — thank you.`);
      },
      timeoutNotice:
        'Payment received — your upgrade is still processing. It activates automatically; check back in a minute.',
    });

  // A payment link completed on an account that is ALREADY paid — Paddle's
  // "update your payment details". The plan doesn't move, so the activation
  // poll's "plan changed" test would never settle. What moves, and only in
  // dunning, is the status: paying the past_due renewal takes it from `grace`
  // back to active once the webhook lands. In good standing the overlay was a
  // zero-amount card swap and there is nothing to wait for.
  //
  // (A LAPSED dunning account never reaches here: its fold is already `free`,
  // so its payment link takes the purchase branch, and "You're on Plus now" is
  // the right sentence for it — the plan really does come back.)
  const confirmPaymentLink = (from: SubscriptionStatus) => {
    if (from.status !== 'grace') {
      setNotice('Your payment details are updated.');
      void refetch().catch(() => undefined);
      return;
    }
    void pollStatus({
      busy: 'recovering',
      settled: (data) => data.status !== 'grace',
      onSettled: () => setNotice('Payment received — the payment issue is resolved.'),
      timeoutNotice:
        'Payment received — it can take a minute to show here. It updates automatically; check back shortly.',
    });
  };

  // Open the checkout a payment link names (see PAYMENT_LINK_PARAM). `from` is
  // the fold at the moment it opens: a free account is BUYING (a dunning
  // account that has already lapsed), a paid one is fixing its card.
  const openPaymentLink = async (transactionId: string, from: SubscriptionStatus) => {
    setError(null);
    setNotice(null);
    setBusy('checkout:link');
    try {
      await openPaddleCheckout({
        transactionId,
        onCompleted: () =>
          from.plan === 'free' ? void pollActivation(from.plan) : confirmPaymentLink(from),
        onClosed: () => setBusy((b) => (b === 'checkout:link' ? null : b)),
      });
    } catch {
      setBusy(null);
      // Something they CAN act on — the link is still in their email — so it
      // names the act (docs/brand-assets.md, _errors have a fixed shape_).
      setError('Could not open the payment page. Open the link from your email again.');
    }
  };

  // The payment link, captured ONCE per mount. Read in the state initializer
  // (pure), stripped in an effect (a side effect) — never both in the
  // initializer, which StrictMode calls twice: the second call would find the
  // URL already stripped and win with null.
  const [linkTransactionId] = useState(readPaymentLinkTransactionId);
  useEffect(() => {
    stripPaymentLinkParam();
  }, []);
  // Opened only once the fold is known, since `from` decides what completing
  // it means — and once, which the ref holds across StrictMode's re-run and any
  // later re-render.
  const linkOpened = useRef(false);
  useEffect(() => {
    if (!linkTransactionId || isLoading || linkOpened.current) return;
    linkOpened.current = true;
    void openPaymentLink(linkTransactionId, subscription);
    // Deliberately keyed on the gate alone: `subscription` is read at the moment
    // the gate opens, and re-running on its later changes would be exactly the
    // re-open the ref forbids.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [linkTransactionId, isLoading]);

  const startCheckout = async (plan: AvailablePaidPlan) => {
    setError(null);
    setNotice(null);
    setBusy(`checkout:${plan}`);
    const fromPlan = subscription.plan;

    // Two steps, two catches, because only one of these failures has an act the
    // user can take from this page — which is the whole choice the error shape
    // asks for (docs/brand-assets.md, _errors have a fixed shape_).
    //
    // Neither sentence is the thrown one. `e.message` here reads "Request
    // failed with status 409" (ApiError's, which is for logs) or "Failed to
    // load Paddle.js - v1" (the SDK's) — a status code and a vendor's build
    // string, in front of a customer at the one moment they were trying to pay.
    let transactionId: string;
    try {
      ({ transactionId } = await api.call(iapCheckoutEndpoint, { plan }));
    } catch {
      setBusy(null);
      // Ours, and worth pressing again: the endpoint is idempotent within
      // CHECKOUT_REUSE_MS, so a second press hands back the same pending
      // `txn_…` rather than minting a second payable one (docs/iap.md, step 1).
      setError('Could not start the upgrade. Please try again.');
      return;
    }

    try {
      await openPaddleCheckout({
        transactionId,
        onCompleted: () => void pollActivation(fromPlan),
        // Fires after completion too — only clear the checkout busy state, never
        // an in-flight activation poll.
        onClosed: () => setBusy((b) => (b === `checkout:${plan}` ? null : b)),
      });
    } catch {
      setBusy(null);
      // NOT retryable in place, so it must not say "try again": a Paddle.js
      // that failed to load stays failed for the life of the page, the SDK
      // having cached its own rejection (lib/paddle.ts, getPaddle). A reload is
      // the only thing that can work, which makes this the actionable form.
      setError('Could not open the payment page. Reload the page and try again.');
    }
  };

  const openPortal = async () => {
    setError(null);
    setBusy('portal');
    try {
      const { url } = await api.call(iapPortalEndpoint, {});
      window.open(url, '_blank', 'noopener');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  const refreshStatus = async () => {
    setError(null);
    // The notice too, not just the error — the only path here that has to clear
    // one it didn't set. pollActivation's timeout notice ("still processing —
    // check back in a minute") is precisely what SENDS the user to this button,
    // so leaving it up has it contradicting a plan box that just flipped to Plus.
    setNotice(null);
    setBusy('refresh');
    await refetch().catch(() => undefined);
    setBusy(null);
  };

  if (isLoading) {
    return (
      <SettingsPane>
        <SettingsHeader title="Subscription" description="Loading your subscription…" />
      </SettingsPane>
    );
  }

  // `plan` is read above the early return (the price-preview effect needs it).
  const { status, source, expiresAt, willRenew } = subscription;
  // Upgrade cards only from FREE: a paid user opening a second checkout would
  // create a second live Paddle subscription (double-billing) — a Plus→Pro
  // switch is a subscription UPDATE (proration) and ships as its own flow. The
  // server enforces the same guard at /v1/iap/checkout.
  const upgradeCards = plan === 'free' ? PLAN_CARDS : [];

  // What a PAID plan unlocks, listed inside the current-plan box — the same
  // words the upgrade card sells, read the other way round (PLAN_CARD_COPY in
  // plans.ts covers both directions). It exists because a Plus account's whole
  // Subscription section was otherwise one small box with a date in it, and
  // because `locks` and `searchEditor` are the two entitlements with the worst
  // in-app discoverability: a renewal notice that never says what is being
  // renewed is where a cancellation starts.
  //
  // Off PLAN_CARD_COPY, NOT PLAN_CARDS — that one is the storefront subset
  // (AVAILABLE_PAID_PLANS), so a manually-granted 'pro' account would find
  // nothing in it and render an empty block. Free gets nothing here: its own
  // description line above already says what it has, and a check list under it
  // would be a second one.
  //
  // 'Everything in Free' is prepended for the ENTRY paid tier only. Plus's copy
  // is written as what it ADDS, so unprefixed it reads as the whole of what the
  // account has and silently drops encryption, sync, lists and tags; Pro's copy
  // already opens with 'Everything in Plus', which carries the same baseline
  // transitively and would double up. bracemark-site's pricing page makes the
  // identical split with its `inherits` line.
  const includedFeatures =
    plan === 'free'
      ? []
      : [...(plan === 'plus' ? ['Everything in Free'] : []), ...PLAN_CARD_COPY[plan].features];

  return (
    <SettingsPane>
      <SettingsHeader
        title="Subscription"
        description="Your plan applies to your whole account, on every device. Payments are handled by Paddle; Bracemark never sees your card details."
      />

      {/* Current plan. Not a SettingsRow: the row is a title/description pair with
          one trailing control, and this grows a payment-issue notice and a
          Manage-billing block UNDER that pair, inside the same border. */}
      <div className="rounded-lg border border-border p-4">
        <div className="flex items-start justify-between gap-4">
          <div className="flex min-w-0 flex-col gap-0.5">
            <span className="font-medium">
              {PLAN_LABELS[plan]}
              {plan !== 'free' && status === 'trialing' && (
                <span className="ml-2 text-sm font-normal text-muted-foreground">free trial</span>
              )}
              {plan !== 'free' && status === 'grace' && (
                <span className="ml-2 text-sm font-normal text-destructive">payment issue</span>
              )}
            </span>
            <span className="text-sm text-muted-foreground">
              {plan === 'free'
                ? // NOT "without previews": free stores preview images like every
                  // plan, it just needs a client to extract them — the browser
                  // extension or mobile app. What Plus buys is `serverExtraction`,
                  // which lets the web app fill pending previews itself (see
                  // docs/link-extraction.md, _the web-only gap_).
                  `Encrypted saving, sync, lists and tags — up to ${entitlementsOf('free').maxLinks} links, with previews from the browser extension or mobile app.`
                : expiresAt === null
                  ? 'Never expires.'
                  : // A trial's period end is the FIRST CHARGE, not a renewal —
                    // say that, rather than letting "Renews on" imply they have
                    // already paid. Canceling mid-trial gets its own sentence
                    // too: the generic "it won't renew" is accurate but leaves
                    // the question they actually cancelled over — am I being
                    // charged? — unanswered.
                    status === 'trialing'
                    ? willRenew
                      ? `Free trial — your first payment is on ${formatDate(expiresAt)}.`
                      : `Free trial ends on ${formatDate(expiresAt)} — you won’t be charged.`
                    : willRenew
                      ? `Renews on ${formatDate(expiresAt)}.`
                      : `Ends on ${formatDate(expiresAt)} — it won’t renew.`}
            </span>
          </div>
          {/* `outline`, like the sync row's Sync now (_data/data-section.tsx) — the
              same control in the same slot: a manual kick of something that already
              runs on its own, alone as the trailing action of a bordered status
              block. `ghost` on this surface means a bare-icon trigger or the quieter
              of two adjacent buttons, and this is neither: Manage billing only
              renders for a paid Paddle account, so on the plan a free user sees this
              is the box's only control and has to look like one at rest. */}
          <Button variant="outline" size="sm" disabled={busy !== null} onClick={refreshStatus}>
            <RefreshCw data-icon="inline-start" className="size-4" />
            {busy === 'refresh' ? 'Refreshing…' : 'Refresh'}
          </Button>
        </div>

        {status === 'grace' && (
          <SettingsNotice tone="error" className="mt-3">
            Your last payment didn’t go through. Update your payment method to keep your plan —
            we’ll retry for a while before it lapses.
          </SettingsNotice>
        )}

        {plan !== 'free' && source === 'paddle' && (
          <div className="mt-3">
            <Button variant="outline" disabled={busy !== null} onClick={openPortal}>
              <ExternalLink data-icon="inline-start" className="size-4" />
              {busy === 'portal' ? 'Opening…' : 'Manage billing'}
            </Button>
            <p className="mt-2 text-xs text-muted-foreground">
              Payment method, invoices, and cancellation — in Paddle’s secure portal.
            </p>
          </div>
        )}
        {(source === 'appstore' || source === 'playstore') && (
          <p className="mt-3 text-sm text-muted-foreground">
            This subscription was purchased in the{' '}
            {source === 'appstore' ? 'App Store' : 'Play Store'} — manage or cancel it there.
          </p>
        )}

        {/* LAST in the box, and that ordering is load-bearing: the grace notice
            says "update your payment method" and Manage billing is the control
            that does it, so nothing may come between them. Reference material
            with no urgency closes the block instead.

            16 rather than the 3 sibling blocks' 12 — those are notes hanging off
            what precedes them, this is a labelled sub-block of its own, and at
            the same step it would read as a fourth note.

            LABELLED, which is the whole difference between this and an upsell: a
            bare row of checkmarks under a renewal date reads as the thing you are
            about to be sold. `font-medium` at `text-sm` keeps it one step UNDER
            the plan name at the top of the box — this is a property of that plan,
            not a second heading competing with it.

            The items themselves are MUTED, which is the kit's standing shape (a
            font-medium foreground line over text-sm muted body — SettingsHeader,
            SettingsRow, and the plan-name/status pair at the top of this box).
            At full foreground they outweighed the renewal date, i.e. the list
            outranked the thing the box exists to say; muted also matches the
            already-muted Check beside them and bracemark-site's pricing cards,
            so the block sits at or below the volume of the copy that SELLS it.
            The upgrade cards below deliberately keep theirs at foreground —
            that contrast is what separates what you're being sold from what you
            already have. */}
        {includedFeatures.length > 0 && (
          <div className="mt-4">
            <p className="text-sm font-medium">Your plan includes</p>
            <ul className="mt-2 flex flex-col gap-1.5">
              {includedFeatures.map((feature) => (
                <li key={feature} className="flex items-start gap-2 text-sm text-muted-foreground">
                  <Check className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                  {feature}
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>

      {/* The ONLY pending notice on this surface that gets a spinner, because it
          is the only one describing something actually in flight — the poll
          against `iap/status`, running for up to 30 seconds behind a screen where
          the checkout overlay has just closed and nothing else moves. Motion is
          what makes a strip read as pending; no background value does that job.
          Deliberately not on the two in _extraction (both are standing states —
          previews unavailable, auto-previews paused — and a spinner would promise
          progress that isn't happening), nor on `notice` below, which is a RESULT
          ("You're on Plus now") or the timeout's advice, never a wait. */}
      {(busy === 'activating' || busy === 'recovering') && (
        <SettingsNotice tone="pending" icon={<Loader2 className="size-4 animate-spin" />}>
          {busy === 'activating' ? 'Finishing your upgrade…' : 'Confirming your payment…'}
        </SettingsNotice>
      )}
      {notice && <SettingsNotice tone="pending">{notice}</SettingsNotice>}
      {error && <SettingsNotice tone="error">{error}</SettingsNotice>}

      {/* Upgrades. Wrapped in a tighter column than the pane's `gap-8` so the
          consent line reads as the cards' own fine print rather than as a third
          block of the section — the kit's note on SettingsPane calls for exactly
          this when something has to sit closer than the page rhythm.

          Gated with the cards, not with `plan === 'free'`: the sentence is about
          the act of subscribing, so it belongs wherever there is something to
          subscribe TO and nowhere else. A paid user reading their renewal date
          has already agreed, and telling them again is noise. */}
      {upgradeCards.length > 0 && (
        <div className="flex flex-col gap-3">
          <div className="grid gap-4 sm:grid-cols-2">
            {upgradeCards.map(({ plan: cardPlan, blurb, features }) => (
              <div key={cardPlan} className="flex flex-col rounded-lg border border-border p-4">
                <div className="flex items-baseline justify-between">
                  <span className="font-medium">{PLAN_LABELS[cardPlan]}</span>
                  <span className="text-sm text-muted-foreground">
                    {/* Paddle's number for THIS buyer once it lands — their
                        currency, their tax, the figure the overlay will repeat.
                        Until then (and if the lookup failed) the USD base price
                        from plans.ts, which is what the marketing site shows and
                        what a buyer in an unpriced country actually pays. */}
                    {prices?.[cardPlan]
                      ? `${prices[cardPlan]}/year`
                      : `$${PLAN_USD_PER_YEAR[cardPlan]}/year`}
                  </span>
                </div>
                {/* 2, matching the title/description step the rest of this surface
                    uses — SettingsRow's `gap-0.5`, and the current-plan block above,
                    which is the same bordered box with the same font-medium line over
                    the same text-sm muted one. Kept as a margin rather than folded
                    into a gap column because the card's three steps differ (2/12/16).
                    bracemark-expo's card is the same line; change the two together. */}
                <p className="mt-0.5 text-sm text-muted-foreground">{blurb}</p>
                <ul className="mt-3 flex flex-1 flex-col gap-1.5">
                  {features.map((feature) => (
                    <li key={feature} className="flex items-start gap-2 text-sm">
                      <Check className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                      {feature}
                    </li>
                  ))}
                </ul>
                <Button
                  className="mt-4"
                  disabled={busy !== null}
                  onClick={() => void startCheckout(cardPlan)}
                >
                  {busy === `checkout:${cardPlan}`
                    ? 'Opening checkout…'
                    : `Upgrade to ${PLAN_LABELS[cardPlan]}`}
                </Button>
              </div>
            ))}
          </div>

          {/* Shown ONLY while a card is still displaying the base price rather
              than this buyer's own. Once the preview lands the number above IS
              the charge, and a "may vary" line under it would undercut a figure
              that is actually correct; when the preview didn't land, the buyer
              is reading dollars that may not be their currency and should hear
              it from us rather than from the overlay. Gated on `pricesFetched`
              so it doesn't flash during the lookup. */}
          {pricesFetched && upgradeCards.some(({ plan: cardPlan }) => !prices?.[cardPlan]) && (
            <p className="text-xs text-muted-foreground">
              Shown in US dollars. Your own currency and any tax are confirmed at checkout.
            </p>
          )}

          {/* No mention of Paddle here — the section header already says who
              takes the payment, and repeating it in the fine print is how a
              settings surface accretes text nobody reads. */}
          <LegalConsent action="subscribing" />
        </div>
      )}
    </SettingsPane>
  );
}
