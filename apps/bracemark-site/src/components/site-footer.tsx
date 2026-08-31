import Link from 'next/link';

import { BracemarkIcon } from '@stxapps/web-ui/components/icons/bracemark-icon';
import { cn } from '@stxapps/web-ui/lib/utils';

import { COMPANY, FOOTER_LINKS, SUPPORT_EMAIL } from '../lib/site';

// The company's legal name sits here as well as in /terms and /privacy, and all
// three read it from `COMPANY` — a footer that names a different entity than the
// terms it links to is the kind of thing a store reviewer does catch.
//
// `pb-safe` is the one inset on this site that fixes an interaction rather than a
// clipped glyph: the last row is the copyright line, and above it the link columns
// end within a thumb's reach of the home indicator, whose swipe region wins every
// contested tap. It belongs here and NOT on the <body> — the min-h-dvh column in
// layout.tsx is body's child, so padding one level up adds to that column instead
// of insetting it (docs/safe-area.md, _applying safe area_).
export function SiteFooter() {
  return (
    <footer className={cn('band mt-24 px-safe pb-safe')}>
      <div className={cn('mx-auto max-w-6xl px-4 py-14 md:px-6 lg:px-8')}>
        <div className={cn('grid gap-10 sm:grid-cols-2 lg:grid-cols-5 lg:gap-8')}>
          <div className={cn('lg:col-span-2')}>
            <div className={cn('flex items-center gap-2.5')}>
              <BracemarkIcon className={cn('h-6 w-auto')} aria-hidden="true" />
              <span className={cn('font-display text-base font-semibold tracking-tight')}>
                Bracemark
              </span>
            </div>
            <p className={cn('mt-4 max-w-xs text-sm leading-6 text-muted-foreground')}>
              An end-to-end encrypted bookmark manager. Your links are encrypted on your device
              before they sync — we hold the ciphertext, and no key that opens it.
            </p>
            <a
              className={cn(
                'mt-4 inline-block rounded-sm font-mono text-sm text-signal underline decoration-signal-line underline-offset-4 hover:decoration-signal focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:ring-offset-2 focus-visible:outline-none',
              )}
              href={`mailto:${SUPPORT_EMAIL}`}
            >
              {SUPPORT_EMAIL}
            </a>
          </div>

          {FOOTER_LINKS.map((group) => (
            <div key={group.heading}>
              <h2 className={cn('eyebrow')}>{group.heading}</h2>
              <ul className={cn('mt-4 space-y-3')}>
                {group.links.map((link) => {
                  const className = cn(
                    'text-muted-foreground hover:text-foreground focus-visible:ring-ring/50 rounded-sm text-sm transition-colors focus-visible:ring-3 focus-visible:ring-offset-2 focus-visible:outline-none',
                  );
                  return (
                    <li key={link.href}>
                      {/* An off-origin link is a plain <a>: next/link would
                          prefetch a route that isn't ours and client-navigate
                          into a hard load anyway. Same choice the CTAs make for
                          the app origin. No target="_blank" — the rest of this
                          footer navigates in place, and one link that doesn't is
                          a surprise, not a courtesy. */}
                      {link.external ? (
                        <a className={className} href={link.href} rel="noreferrer">
                          {link.label}
                        </a>
                      ) : (
                        <Link className={className} href={link.href}>
                          {link.label}
                        </Link>
                      )}
                    </li>
                  );
                })}
              </ul>
            </div>
          ))}
        </div>

        <div
          className={cn(
            'mt-12 flex flex-col gap-2 border-t border-border pt-6 text-xs text-muted-foreground sm:flex-row sm:items-center sm:justify-between',
          )}
        >
          <p>
            © {new Date().getFullYear()} {COMPANY.legalName}. All rights reserved.
          </p>
          <p className={cn('font-mono')}>Bangkok, Thailand</p>
        </div>
      </div>
    </footer>
  );
}
