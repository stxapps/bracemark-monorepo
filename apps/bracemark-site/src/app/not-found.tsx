import type { Metadata } from 'next';
import Link from 'next/link';

import { cn } from '@stxapps/web-ui/lib/utils';

import { ArrowGlyph } from '../components/glyphs';
import { PageShell } from '../components/page-shell';
import { SUPPORT_EMAIL } from '../lib/site';

export const metadata: Metadata = { title: 'Page not found' };

// The apex's 404. Static export, so this prerenders to `404.html` and CloudFront
// serves it for every unmatched path (docs/hosting.md) — meaning it is one page
// answering every wrong address, and it can't say which one was asked for. (It
// could, from `window.location`, but that would make the only 404 on a fully
// static, script-free site a client component to print back a string the reader
// just typed. Not worth the bundle.)
//
// It uses PageShell like every other non-landing page, so a mistyped URL lands
// somewhere that looks deliberate rather than somewhere the site fell over. The
// header and footer come from the root layout and are already the full nav — the
// list below is not a substitute for them, it's the three pages a lost visitor
// actually wants, in the order they want them.
//
// NO joke, no ASCII art, no giant 404. This site's whole argument is that it was
// built carefully by people who don't need your attention; a gag on the error page
// is the cheapest possible way to undercut that.

const ELSEWHERE: { href: string; title: string; body: string }[] = [
  {
    href: '/',
    title: 'Start at the beginning',
    body: 'What Bracemark is, how the encryption works, and where you can save links from.',
  },
  {
    href: '/pricing',
    title: 'Plans and what they include',
    body: 'What the free plan covers, what Plus adds, and how the trial works.',
  },
  {
    href: '/faq',
    title: 'Questions people actually ask',
    body: 'Encryption, the account model, imports and exports — most answers are already there.',
  },
];

export default function NotFound() {
  return (
    <PageShell
      eyebrow="Error 404"
      title="That page isn’t here."
      lede="The address may be mistyped, or it may be from an older version of this site. Nothing is broken — this one just doesn’t exist."
    >
      <ul className={cn('bg-border grid gap-px overflow-hidden rounded-xl')}>
        {ELSEWHERE.map(({ href, title, body }) => (
          <li key={href} className={cn('bg-background')}>
            <Link
              className={cn(
                'group hover:bg-muted/50 focus-visible:ring-ring/50 flex items-start justify-between gap-6 p-6 transition-colors focus-visible:ring-3 focus-visible:outline-none',
              )}
              href={href}
            >
              <span>
                <span className={cn('block text-base font-semibold')}>{title}</span>
                <span className={cn('text-muted-foreground text-body mt-1.5 block')}>{body}</span>
              </span>
              <ArrowGlyph
                className={cn(
                  'text-muted-foreground mt-1 size-4 shrink-0 transition-transform group-hover:translate-x-0.5',
                )}
              />
            </Link>
          </li>
        ))}
      </ul>

      {/* A dead link on our own site is our bug, and this is the one page where
          someone has already proved they hit one. The address is the same
          published support mailbox /support gives, styled the same way. */}
      <p className={cn('text-muted-foreground text-body mt-10')}>
        If a link on this site sent you here, we’d like to know:{' '}
        <a
          className={cn(
            'text-signal decoration-signal-line hover:decoration-signal focus-visible:ring-ring/50 rounded-sm font-mono underline underline-offset-2 focus-visible:ring-3 focus-visible:outline-none',
          )}
          href={`mailto:${SUPPORT_EMAIL}`}
        >
          {SUPPORT_EMAIL}
        </a>
        .
      </p>
    </PageShell>
  );
}
