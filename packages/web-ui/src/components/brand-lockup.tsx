import * as React from 'react';

import { BRAND } from '@stxapps/shared';

import { cn } from '../lib/utils';
import { BracemarkIcon } from './icons/bracemark-icon';

// The mark next to the name — the one thing every surface that has no other
// brand carrier renders. Four web surfaces render it: bracemark-web's links
// rail, its settings rail and its focused-page card (sign-in, the lock gate,
// 404, the error screen), plus the browser extension's popup header.
// bracemark-expo's `components/brand-lockup.tsx` is the same component for the
// same reason, five call sites there; the two files are ports of one lockup.
//
// It exists as a component because the utilities were typed into those four
// files by hand and each carried a comment saying "same size, same step, same
// gap as the others, keep them equal" — which is a rule stated four times and
// enforced nowhere. Nothing lints a lockup and no test can see one, so the
// comments WERE the mechanism, and the browser extension's popup had already
// drifted off them once (16px/13px/`gap-2`) before anyone noticed. Now the
// measurements exist once and the comments can point here.
//
// THE MEASUREMENTS: a 16px mark (`h-4`), the wordmark at
// `text-[0.9375rem] leading-none font-semibold tracking-tight`, `gap-2.5`
// between them. docs/brand-assets.md, _the lockup_, holds them.
//
// THE PAIR IS A RATIO, and this file is where both halves of it finally sit
// together. 16 against 15 is the mark at 1.6× the wordmark's cap height — the
// proportion that makes the two read as one lockup rather than as an icon with
// text beside it — and 16 is simultaneously the mark's floor, since the 45° cut
// stops reading under it (`icons/bracemark-icon.tsx`). So the two numbers below
// move together or not at all, and they can never move DOWN. Changing only one
// is the exact drift the popup shipped once, and it is invisible to every check
// this repo runs.
//
// The 15px is NOT bracemark-site's `--text-body`, which is the same size at a
// different leading for running prose. Two roles, one number; only the prose one
// is a token, because only it repeats within a single stylesheet. (The site's
// header and footer carry a THIRD thing again — a larger mark beside a wordmark
// set in the display face — which is that site's own lockup and not this one.)
//
// The name comes from `BRAND.name` rather than the literal so the one file that
// owns what the product is called (shared `brand/brand.ts`) owns it here too.
export function BrandLockup({
  // Trailing control on the lockup's row — the links rail's sidebar toggle. The
  // settings rail and the focused-page card have nothing to put there, and the
  // browser extension's popup keeps its own actions OUTSIDE this component,
  // because its header renders them in the back-button mode too, where there is
  // no lockup at all.
  //
  // IT IS PLACED WITH `ml-auto`, so it is only rightmost if this component's own
  // row is as wide as the header. Pass the header's chrome through `className`
  // (as the two rails do) rather than wrapping this in a flex row, or the
  // control parks mid-header hard against the wordmark.
  action,
  className,
}: {
  action?: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn('flex items-center gap-2.5', className)}>
      <BracemarkIcon className={cn('h-4 w-auto shrink-0')} aria-hidden="true" />
      <span className={cn('text-[0.9375rem] leading-none font-semibold tracking-tight')}>
        {BRAND.name}
      </span>
      {action ? <span className={cn('ml-auto flex items-center')}>{action}</span> : null}
    </div>
  );
}
