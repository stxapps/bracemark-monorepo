'use client';

// The bar above the reader: the host on the left; a ⋯ menu, a divider and the ✕ on
// the right. It is the same bar as the links page's and Settings' — sticky, full
// width, `h-14`, a hairline under it — and takes their placement, not Settings'
// column:
//
//   - FULL WIDTH, NO MEASURE. A bar is chrome, and chrome sits at the window's edges:
//     the ✕ lands in the corner Settings and the links page put theirs, so it is
//     found without looking. The article's `max-w-2xl` is a reading measure, which
//     belongs to the text and not to the bar above it; a bar held to it left a ✕ and
//     its neighbours floating mid-window on a wide screen, with the hairline running
//     out on both sides of them. Nothing here depends on a sidebar being absent:
//     Settings' bar is full width beside its own rail.
//   - THE WAYS OUT ARE ONE ⋯ MENU, the same bar as expo's (bracemark-expo
//     features/reader/topbar.tsx; docs/reader.md, _the expo reader_). There
//     the reader has three actions and no room for a word, and as bare icons two
//     read alike; one shape on both apps is worth a second click to _Open page_ here,
//     where the words would have fitted from `sm` up. In the menu each way out is
//     named at every width. The empty state still says both in words.
//   - THE ✕ IS LAST. Its neighbour is the menu, and a divider says the ✕ is not one
//     more action.
//
//   - THE LINKS PAGE'S RHYTHM. Both buttons are 36 square on a phone or under a coarse
//     pointer (32 for a mouse, like Settings' ✕), so the bar reads as the links page's
//     does. The 44 touch target is not drawn: each box carries the same `after:` slop
//     table-kit's rows do, 5px above and below (the bar is 56 tall, so nothing is
//     covered) and 2px sideways — well inside the 9px (`gap-1`, the divider, `gap-1`)
//     between the two (docs/accessibility.md, _the lever_). The ✕'s box steps in with
//     the size (`pr-3.5` against `pr-4`) so its glyph stays 24px from the edge, where
//     Settings' and the links page's are.
//
// Behind a lock the host and the menu are gone (the host is the locked list's
// contents, docs/locks.md), leaving the label and the ✕.

import { useEffect, useState } from 'react';
import { ArrowUpRight, History, MoreHorizontal, X } from 'lucide-react';
import Link from 'next/link';

import { Button } from '@stxapps/web-ui/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@stxapps/web-ui/components/ui/dropdown-menu';
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
// SLOP is the 44 target; `after:` measures from inside the 1px border, so 5px buys 44
// on a 36 box.
const SLOP = 'relative after:absolute after:-inset-x-[3px] after:-inset-y-[5px]';
const BOX = `${SLOP} max-sm:size-9 pointer-coarse:size-9`;
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
          {showHref || showWayback ? (
            <>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="ghost" size="icon-sm" className={BOX} aria-label="More options">
                    {/* 20, not 16: three dots carry a fraction of a glyph's ink, so at
                        16 they read smaller than the ✕ beside them — the links page's
                        ⋯ (more-options-menu.tsx) has the same bump. */}
                    <MoreHorizontal className={cn('size-5')} />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className={cn('w-auto min-w-36')}>
                  {showHref ? (
                    <DropdownMenuItem asChild>
                      <a href={href} target="_blank" rel="noreferrer">
                        <ArrowUpRight className={cn('size-4')} />
                        Open page
                      </a>
                    </DropdownMenuItem>
                  ) : null}
                  {showWayback ? (
                    <DropdownMenuItem asChild>
                      <a href={waybackHref} target="_blank" rel="noreferrer">
                        <History className={cn('size-4')} />
                        Open in Wayback Machine
                      </a>
                    </DropdownMenuItem>
                  ) : null}
                </DropdownMenuContent>
              </DropdownMenu>
              <span aria-hidden="true" className={cn('h-4 w-px bg-border')} />
            </>
          ) : null}
          <Button asChild variant="ghost" size="icon-sm" className={BOX} aria-label="Close reader">
            <Link href={closeHref}>
              <X className={cn('size-4')} />
            </Link>
          </Button>
        </div>
      </div>
    </header>
  );
}
