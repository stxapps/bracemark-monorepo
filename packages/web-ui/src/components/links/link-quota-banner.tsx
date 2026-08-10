'use client';

// What a create surface renders INSTEAD of its form once the library is at the
// plan's link cap: the count, why saving is off, and the caller's upgrade CTA.
//
// It replaces the form rather than sitting above it because at the cap the form
// is dead — every field in it feeds a save that can't happen. This is also why
// the cap does NOT route through the paywall dialog (bracemark-web's
// PaywallProvider): that's the ACTION-INTERRUPT pattern, for an affordance that
// stays live and explains itself on click. A full library isn't an action the
// user took — it's true before they touch anything — so the honest UI states it
// up front instead of taking a URL and then refusing it.
//
// The copy points at emptying the Trash, not at deleting links: a trashed link
// still holds its `links/{id}.enc` blob and still counts against the cap (see
// useLinkQuota on why the count is trash-inclusive), so "move it to Trash" would
// be advice that doesn't work.
//
// The CTA is a slot: bracemark-web passes a next/link to /settings/subscription,
// while the extension (no such route of its own) opens the web app's page in a
// tab. Everything else — the copy, the count, the shape — lives here so the two
// surfaces can't drift.

import { Lock } from 'lucide-react';

import { PLAN_LABELS } from '@stxapps/shared';

export function LinkQuotaBanner({
  count,
  max,
  action,
}: {
  count: number;
  max: number;
  // The upgrade CTA — a link/button owned by the host app (its router, its
  // tab-opening).
  action: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-start gap-2 rounded-md bg-muted px-3 py-2 text-xs text-muted-foreground">
        <Lock className="mt-0.5 size-3.5 shrink-0" />
        <span>
          You’ve saved{' '}
          <span className="font-medium text-foreground">
            {count} of {max}
          </span>{' '}
          links on the {PLAN_LABELS.free} plan. Upgrade to save more — or empty some of the Trash to
          free up room. Everything you’ve saved stays here, and stays syncing.
        </span>
      </div>
      {action}
    </div>
  );
}
