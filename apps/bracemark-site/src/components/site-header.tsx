import Link from 'next/link';

import { BracemarkIcon } from '@stxapps/web-ui/components/icons/bracemark-icon';
import { Button } from '@stxapps/web-ui/components/ui/button';
import { cn } from '@stxapps/web-ui/lib/utils';

import { HEADER_LINKS, SIGN_IN_URL } from '../lib/site';

// "Sign in" is a plain <a>, not next/link: it crosses origins (bracemark.com →
// app.bracemark.com), so there is no client-side navigation to prefetch and
// next/link would only add a router entry for a full page load.
//
// Sticky, because /terms and /privacy are long documents and a reader three
// screens into the liability section should not have to scroll back to the top to
// leave. The blur keeps the hairline legible over the hero panel behind it.
//
// The safe utilities sit on the <header> and the numeric gutter a level in, which
// is the sheet.tsx shape (docs/safe-area.md, _applying safe area_): the tinted,
// blurred bar bleeds to the physical edge while only its CONTENTS inset, so a
// landscape notch eats no logo. They can't share an element anyway — `px-safe` and
// `px-4` both resolve to padding-left/right and would fight by stylesheet order.
// `pt-safe` is 0 in Safari, where the URL bar already covers the notch; it earns
// its place in standalone/PWA display, where nothing does.
export function SiteHeader() {
  return (
    <header
      className={cn(
        'sticky top-0 z-50 border-b border-border bg-background/85 pt-safe px-safe backdrop-blur-md',
      )}
    >
      <div className={cn('mx-auto flex h-16 max-w-6xl items-center gap-4 px-4 md:px-6 lg:px-8')}>
        <Link
          className={cn(
            'flex shrink-0 items-center gap-2.5 rounded-sm focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:ring-offset-2 focus-visible:outline-none',
          )}
          href="/"
        >
          <BracemarkIcon className={cn('h-7 w-auto')} aria-hidden="true" />
          {/* The mark alone is ambiguous at 28px to someone who has never been
              here before, so the apex spells the name out. Below `sm` the nav
              needs the room more than the wordmark does. */}
          <span
            className={cn(
              'hidden font-display text-lg leading-none font-semibold tracking-tight sm:block',
            )}
          >
            Bracemark
          </span>
          <span className={cn('sr-only')}>Bracemark home</span>
        </Link>

        {/* The nav is a fixed width budget and it is genuinely spent. Measured
            at the base breakpoint: the four labels are 168px, the Sign in
            button 71px, the mark 23px — so with `gap-4` the row wants 342px
            against the 305px a 320px viewport leaves after the gutters, and the
            page picks up a real horizontal scrollbar. Two changes buy it back,
            and both are confined to narrow widths:

            - `gap-3` below `sm`, which is 16px across the four gaps and is not
              visible at that size anyway;
            - the FIRST entry drops below 360px. HEADER_LINKS is ordered
              least- to most-transactional for exactly this reason (see the note
              on it in lib/site.ts), so the one the narrow layout can afford to
              lose is the one at the front. It is About, it stays in the footer,
              and the landing page now links to it twice besides.

            360 rather than `sm` (640), and rather than a rounder 400: with
            `gap-3` the row needs 322px of the 328px a 360pt viewport leaves,
            so 360 is the last width that actually fits and every common phone
            from there up keeps all four. `sm` would strip the item from every
            phone and most tablets to solve a problem only the smallest ones
            have, and 400 would strip it from the 390pt iPhones that are the
            single most common size.

            The slack at 360 is 6px, which is thin — so re-measure if a label is
            renamed, a fifth is added, or the display face changes. Nothing here
            fails a build or a test; it just overflows. */}
        <nav className={cn('ml-auto flex items-center gap-3 sm:gap-6')} aria-label="Main">
          <ul className={cn('flex items-center gap-3 sm:gap-6')}>
            {HEADER_LINKS.map((link, i) => (
              <li key={link.href} className={cn(i === 0 && 'max-[359px]:hidden')}>
                <Link
                  className={cn(
                    'rounded-sm text-sm font-medium text-muted-foreground transition-colors hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:ring-offset-2 focus-visible:outline-none',
                  )}
                  href={link.href}
                >
                  {link.label}
                </Link>
              </li>
            ))}
          </ul>
          <Button asChild variant="outline" size="sm" className={cn('shrink-0')}>
            <a href={SIGN_IN_URL}>Sign in</a>
          </Button>
        </nav>
      </div>
    </header>
  );
}
