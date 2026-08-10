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
        'border-border bg-background/85 px-safe pt-safe sticky top-0 z-50 border-b backdrop-blur-md',
      )}
    >
      <div className={cn('mx-auto flex h-16 max-w-6xl items-center gap-4 px-4 md:px-6 lg:px-8')}>
        <Link
          className={cn(
            'focus-visible:ring-ring/50 flex shrink-0 items-center gap-2.5 rounded-sm focus-visible:ring-3 focus-visible:ring-offset-2 focus-visible:outline-none',
          )}
          href="/"
        >
          <BracemarkIcon className={cn('h-7 w-auto')} aria-hidden="true" />
          {/* The mark alone is ambiguous at 28px to someone who has never been
              here before, so the apex spells the name out. Below `sm` the nav
              needs the room more than the wordmark does. */}
          <span
            className={cn(
              'font-display hidden text-lg leading-none font-semibold tracking-tight sm:block',
            )}
          >
            Bracemark
          </span>
          <span className={cn('sr-only')}>Bracemark home</span>
        </Link>

        <nav className={cn('ml-auto flex items-center gap-4 sm:gap-6')} aria-label="Main">
          <ul className={cn('flex items-center gap-4 sm:gap-6')}>
            {HEADER_LINKS.map((link) => (
              <li key={link.href}>
                <Link
                  className={cn(
                    'text-muted-foreground hover:text-foreground focus-visible:ring-ring/50 rounded-sm text-sm font-medium transition-colors focus-visible:ring-3 focus-visible:ring-offset-2 focus-visible:outline-none',
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
