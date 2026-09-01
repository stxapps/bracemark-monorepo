import Link from 'next/link';

import { cn } from '@stxapps/web-ui/lib/utils';

import type { ElsewhereCard } from '../content/elsewhere';
import { ArrowGlyph } from './glyphs';

// The hairline card list the 404 and /support both end on. It was the same
// markup in both files down to the class strings — a `gap-px` grid over
// `bg-border`, which is this site's divider idiom rather than a bordered card
// (the landing page's capture grid does it too), and it only reads as one
// surface while both copies agree. Two of them drift on the first hover or
// focus-ring change, and the pages are far enough apart that nobody would see it.
//
// `className` is for the caller's SPACING and nothing else: /support puts this
// under an h2 and needs the margin, the 404 opens with it and does not.
export function ElsewhereList({
  cards,
  className,
}: {
  cards: ElsewhereCard[];
  className?: string;
}) {
  return (
    <ul className={cn('grid gap-px overflow-hidden rounded-xl bg-border', className)}>
      {cards.map(({ href, title, body }) => (
        <li key={href} className={cn('bg-background')}>
          <Link
            className={cn(
              'group flex items-start justify-between gap-6 p-6 transition-colors hover:bg-muted/50 focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none',
            )}
            href={href}
          >
            <span>
              <span className={cn('block text-base font-semibold')}>{title}</span>
              <span className={cn('mt-1.5 block text-body text-muted-foreground')}>{body}</span>
            </span>
            <ArrowGlyph
              className={cn(
                'mt-1 size-4 shrink-0 text-muted-foreground transition-transform group-hover:translate-x-0.5',
              )}
            />
          </Link>
        </li>
      ))}
    </ul>
  );
}
