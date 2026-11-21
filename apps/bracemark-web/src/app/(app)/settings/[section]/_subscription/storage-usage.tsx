'use client';

import type { StorageReadout } from '@stxapps/react';
import { cn } from '@stxapps/web-ui/lib/utils';

// Settings → Subscription's storage readout: what the library stores against the
// ceiling the pricing page publishes ("1.2 GB of 5 GB used"). It is that page's
// promise read from the other side, so it appears only against a published
// ceiling — Plus's, and a lapsed Plus account's, which keeps it — and draws
// nothing while loading, after a failed read, or on Free (useStorageReadout).
// On a lapsed account it says where that ceiling came from (`kept`), since the
// box it sits in names a plan whose own ceiling is smaller.
//
// The SECTION reads the readout and hands it in, rather than this reading it:
// the section's reveal gate waits on the same read, so the block arrives with
// the page instead of under it a moment later.
//
// A labelled sub-block of the current-plan box, like "Your plan includes" above
// it: a property of the plan, not a control, so no border or button of its own.
//
// The SENTENCE is the readout; the bar is decoration and `aria-hidden`. A gauge's
// ARIA role is `meter`, not the `progressbar` the shared ProgressMeter draws for
// jobs, and the visible text already says everything a role would announce — so a
// screen reader reads the one line, once. Expo draws the same way
// (features/settings/storage-usage.tsx).
export function StorageUsage({ readout }: { readout: StorageReadout | null }) {
  if (!readout) return null;

  return (
    <div className="mt-4">
      <p className="text-sm font-medium">Storage</p>
      <p className="mt-1 text-sm text-muted-foreground tabular-nums">{readout.text}</p>
      {readout.kept && <p className="mt-0.5 text-xs text-muted-foreground">{readout.kept}</p>}
      <div aria-hidden className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-muted">
        <div
          className={cn('h-full rounded-full', readout.full ? 'bg-destructive' : 'bg-primary')}
          style={{ width: `${readout.fraction * 100}%` }}
        />
      </div>
      <p className="mt-2 text-xs text-muted-foreground">{readout.note}</p>
    </div>
  );
}
