'use client';

// The links page's first-run offer for link previews — bracemark-web's counterpart to
// bracemark-expo's `features/links/previews-prompt.tsx`, and deliberately NOT a port of it
// (docs/link-extraction.md — _the links-page offer_). Same shape, same one-time
// device-local dismissal, same "ask at the first moment it means something" rationale:
// it shows only when links are actually waiting for a preview, so a fresh account with
// nothing saved gets no banner and neither does a fully-previewed library.
//
// What differs is the ASK, because on web the thing being offered isn't free:
//
//   - **Plus/Pro** — the offer is the synced `serverExtraction` opt-in, which admits a
//     new party (`bracemark-extractor`) to the URLs it fetches. That is heavier consent
//     than expo's on-device fetch, so this banner does NOT flip it: the button links to
//     Settings → Link previews, where the toggle sits next to the copy that names the
//     service and next to "Generate all" (the confirm-gated job that actually drains
//     the backlog this banner is counting). A one-tap "turn on" here would both thin
//     the consent and under-deliver — enabling the opt-in alone only starts the
//     displayed-scoped auto drain, so the N in the headline would barely move.
//   - **free** — `serverExtraction` is a Plus entitlement (shared `entitlementsOf`), so
//     the honest offer is the browser extension: free, local, and the best extractor
//     there is (active-tab DOM — see _capability tiers_). It previews links as you save
//     them rather than back-filling these, which the copy says plainly instead of
//     implying an install clears the count; the back-fill is what Plus adds, linked
//     second and stated once, not sold. It links straight to /settings/subscription
//     rather than calling `usePaywall()`: the paywall dialog is the ACTION-INTERRUPT
//     pattern (a free user clicked a gated affordance), and nothing was clicked here
//     — this is the inline "See plans" surface the paywall provider's header points
//     such cases at, the same door LockedBanner (search-bar.tsx) uses.
//
// The count comes from `readRawPendingTitleImageCount` (four index counts, no decode,
// no trash-correction join), not `useExtractionCounts`: the exact tally is gated on
// extraction being ENABLED, which is precisely what this banner exists to ask about.
// Raw pending is a strict over-count, the right side to err on for a "you have links
// without previews" prompt — and the read runs ONLY while the banner could show, so it
// costs nothing in steady state. Pass-through-returned into `useLiveQuery` (no stacked
// await) so Dexie's dependency tracking survives — see readLinks' zone-echo note.

import { useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { Sparkles, X } from 'lucide-react';
import Link from 'next/link';

import {
  readRawPendingTitleImageCount,
  useEntitlements,
  useSettingMutations,
  useSettings,
} from '@stxapps/web-react';
import { Button } from '@stxapps/web-ui/components/ui/button';

import { extensionStoreUrl } from '../../../../lib/extension-stores';

export function PreviewsPrompt() {
  const { serverExtraction, previewsPromptDismissed } = useSettings();
  const { dismissPreviewsPrompt } = useSettingMutations();
  // `isLoading` is true only on a cold start with no cached status, and gating on it
  // matters here because the two variants ask different things: without it a Plus user
  // on a fresh browser would see the free/upsell copy flash before the plan lands.
  const { entitlements, isLoading: planLoading } = useEntitlements();

  // The offer is inert unless it could actually be shown. For a paid account that's
  // "the opt-in is still off"; for a free one the synced preference is irrelevant
  // (the entitlement gate means nothing is being extracted either way), so what's
  // offered is the extension instead — see the header.
  const canServerExtract = entitlements.serverExtraction;
  const armed = !previewsPromptDismissed && !planLoading && !(canServerExtract && serverExtraction);
  const pending =
    useLiveQuery(() => (armed ? readRawPendingTitleImageCount() : Promise.resolve(0)), [armed]) ??
    0;

  // Read once per mount so the value is identity-stable, and because it's a UA sniff
  // that must not differ between the server render and hydration.
  const [storeUrl] = useState(extensionStoreUrl);

  if (!armed || pending === 0) return null;

  // Dismissal is one-way for this device: it makes the banner's own condition false.
  // A failed write just leaves the banner up — Settings is the durable surface.
  const dismiss = () => void dismissPreviewsPrompt().catch(() => undefined);

  return (
    <aside className="flex items-start gap-3 border-b border-border bg-muted/40 px-4 py-3">
      <Sparkles className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
      <div className="flex min-w-0 flex-1 flex-col gap-2">
        <p className="text-sm font-medium">
          {pending} link{pending === 1 ? '' : 's'} without a preview
        </p>
        {canServerExtract ? (
          <>
            <p className="text-sm text-muted-foreground">
              Bracemark can fill in their titles and images by fetching each page through its
              preview service. Only the link&apos;s URL is sent, nothing is stored, and it never
              runs until you turn it on.
            </p>
            <div className="flex flex-wrap items-center gap-2">
              <Button asChild size="sm" variant="outline">
                <Link href="/settings/extraction">Set up previews</Link>
              </Button>
            </div>
          </>
        ) : (
          <>
            <p className="text-sm text-muted-foreground">
              The Bracemark browser extension previews links right in your browser as you save them
              — free, and the page never leaves your device. Filling in the ones already here, saved
              on the web or added by import, is part of Plus.
            </p>
            <div className="flex flex-wrap items-center gap-2">
              <Button asChild size="sm" variant="outline">
                <a href={storeUrl} target="_blank" rel="noreferrer">
                  Get the browser extension
                </a>
              </Button>
              <Button asChild size="sm" variant="ghost">
                <Link href="/settings/subscription">See plans</Link>
              </Button>
            </div>
          </>
        )}
      </div>
      <Button variant="ghost" size="icon-sm" aria-label="Dismiss" onClick={dismiss}>
        <X className="size-4" />
      </Button>
    </aside>
  );
}
