import type { Metadata } from 'next';

import { cn } from '@stxapps/web-ui/lib/utils';

import { ElsewhereList } from '../components/elsewhere-list';
import { PageShell } from '../components/page-shell';
import { type ElsewhereCard, PRICING_CARD } from '../content/elsewhere';
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

const ELSEWHERE: ElsewhereCard[] = [
  {
    href: '/',
    title: 'Start at the beginning',
    body: 'What Bracemark is, how the encryption works, and where you can save links from.',
  },
  PRICING_CARD,
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
      <ElsewhereList cards={ELSEWHERE} />

      {/* A dead link on our own site is our bug, and this is the one page where
          someone has already proved they hit one. The address is the same
          published support mailbox /support gives, styled the same way. */}
      <p className={cn('mt-10 text-body text-muted-foreground')}>
        If a link on this site sent you here, we’d like to know:{' '}
        <a
          className={cn(
            'rounded-sm font-mono text-signal underline decoration-signal-line underline-offset-2 hover:decoration-signal focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none',
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
