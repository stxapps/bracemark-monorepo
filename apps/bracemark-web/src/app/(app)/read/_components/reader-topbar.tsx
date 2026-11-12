'use client';

// The bar above the reader: the host on the left; the two ways out and the ✕ on the
// right. It is the same bar as the links page's and Settings' — sticky, full width,
// `h-14`, a hairline under it — and takes their placement, not Settings' column:
//
//   - FULL WIDTH, NO MEASURE. A bar is chrome, and chrome sits at the window's edges:
//     the ✕ lands in the corner Settings and the links page put theirs, so it is
//     found without looking. The article's `max-w-2xl` is a reading measure, which
//     belongs to the text and not to the bar above it; a bar held to it left a ✕ and
//     two buttons floating mid-window on a wide screen, with the hairline running
//     out on both sides of them. Nothing here depends on a sidebar being absent:
//     Settings' bar is full width beside its own rail.
//   - THE ✕ IS LAST. Its neighbours are the ways out, so the group reads as one run
//     with the ✕ closing it, and a divider says the ✕ is not one more link.
//
//   - THE LINKS PAGE'S RHYTHM. Buttons sit `gap-1` apart, 36 square on a phone or under
//     a coarse pointer (32 for a mouse, like Settings' ✕), so the bar reads as the
//     links page's does. The 44 touch target is not drawn: each box carries the same
//     `after:` slop table-kit's rows do, 5px above and below (the bar is 56 tall, so
//     nothing is covered) and 2px sideways, half the 4px gap to the next control —
//     the most a pressable neighbour allows (docs/accessibility.md, _the lever_).
//     Real 44 boxes were tried first and spaced the icons 48 apart against the links
//     page's 40. The ✕'s box steps in with the size (`pr-3.5` against `pr-4`) so its
//     glyph stays 24px from the edge, where Settings' and the links page's are.
//
// Behind a lock the host and both ways out are gone (the host is the locked list's
// contents, docs/locks.md), leaving the label and the ✕.

import { useEffect, useState } from 'react';
import { ArrowUpRight, History, X } from 'lucide-react';
import Link from 'next/link';

import { Button } from '@stxapps/web-ui/components/ui/button';
import { cn } from '@stxapps/web-ui/lib/utils';

import { readLinksReturn } from '@/lib/links-return';

// The ✕'s target: where the links page was, read after mount because
// sessionStorage isn't there during the static render (settings' topbar does the
// same).
function useCloseHref(): string {
  const [href, setHref] = useState('/links');
  useEffect(() => setHref(readLinksReturn()), []);
  return href;
}

// The touch layout is "narrow OR coarse": a phone is both, a tablet is coarse alone, a
// narrowed desktop window is narrow alone, and each wants the links page's 36 boxes.
// `px-0!` beats the size's one-sided icon padding, which beside no label leaves the
// glyph off-centre. SLOP is the 44 target; `after:` measures from inside the 1px
// border, so 5px buys 44 on a 36 box.
const SLOP = 'relative after:absolute after:-inset-x-[3px] after:-inset-y-[5px]';
const WAY_OUT = `${SLOP} max-sm:size-9 max-sm:px-0! pointer-coarse:h-9`;
const CLOSE = `${SLOP} max-sm:size-9 pointer-coarse:size-9`;
const BAR_PADDING = 'pl-4 pr-4 max-sm:pr-3.5 pointer-coarse:pr-3.5';

export function ReaderTopbar({
  host,
  href,
  waybackHref,
  locked,
}: {
  host: string;
  href: string | undefined;
  waybackHref: string | undefined;
  locked: boolean;
}) {
  const closeHref = useCloseHref();
  const showHref = !locked && href !== undefined;
  const showWayback = !locked && waybackHref !== undefined;

  return (
    <header className={cn('sticky top-0 z-10 h-14 border-b border-border bg-background')}>
      <div className={cn('flex h-full w-full items-center gap-2', BAR_PADDING)}>
        <span className={cn('min-w-0 flex-1 truncate text-sm font-medium text-muted-foreground')}>
          {!locked && host ? host : 'Reader'}
        </span>
        <div className={cn('flex shrink-0 items-center gap-1')}>
          {/* Both ways out are icon-only below `sm`: with the host and the ✕ there is no
              room for a label on a phone, and each label is one tap away in the row menu
              and in the empty state. The accessible name is the full phrase at every
              width. See WAY_OUT for the box. */}
          {showHref ? (
            <Button asChild variant="ghost" size="sm" className={WAY_OUT}>
              <a
                href={href}
                target="_blank"
                rel="noreferrer"
                aria-label="Open page"
                title="Open page"
              >
                <span className={cn('hidden sm:inline')}>Open page</span>
                <ArrowUpRight data-icon="inline-end" />
              </a>
            </Button>
          ) : null}
          {showWayback ? (
            <Button asChild variant="ghost" size="sm" className={WAY_OUT}>
              <a
                href={waybackHref}
                target="_blank"
                rel="noreferrer"
                aria-label="Open in Wayback Machine"
                title="Open in Wayback Machine"
              >
                <History data-icon="inline-start" />
                <span className={cn('hidden sm:inline')}>Wayback Machine</span>
              </a>
            </Button>
          ) : null}
          {showHref || showWayback ? (
            <span aria-hidden="true" className={cn('h-4 w-px bg-border')} />
          ) : null}
          <Button
            asChild
            variant="ghost"
            size="icon-sm"
            className={CLOSE}
            aria-label="Close reader"
          >
            <Link href={closeHref}>
              <X className={cn('size-4')} />
            </Link>
          </Button>
        </div>
      </div>
    </header>
  );
}
