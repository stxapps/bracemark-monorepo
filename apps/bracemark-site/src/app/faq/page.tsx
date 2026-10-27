import type { Metadata, ResolvingMetadata } from 'next';
import Link from 'next/link';

import { entitlementsOf } from '@stxapps/shared';
import { Button } from '@stxapps/web-ui/components/ui/button';
import { cn } from '@stxapps/web-ui/lib/utils';

import { ArrowGlyph, ChevronGlyph } from '../../components/glyphs';
import { JsonLd } from '../../components/json-ld';
import { FAQ_GROUPS } from '../../content/faq';
import { pageMetadata } from '../../lib/metadata';
import { CREATE_ACCOUNT_URL } from '../../lib/site';
import { faqPage } from '../../lib/structured-data';

export function generateMetadata(_: unknown, parent: ResolvingMetadata): Promise<Metadata> {
  return pageMetadata(parent, {
    title: 'FAQ',
    description:
      'How Bracemark’s encryption, account, plans, and features work — including the questions with uncomfortable answers.',
    path: '/faq',
  });
}

// The questions themselves live in `content/faq.tsx`, shared with /pricing. This
// file is only how they are read.
//
// Native <details>/<summary> rather than an accordion component, for three
// reasons that all point the same way: the answers stay in the HTML, so search
// engines and Cmd-F find them; the page needs no JavaScript at all, which suits a
// fully static export; and the keyboard and screen-reader behaviour is the
// platform's rather than ours to re-implement.
export default function Page() {
  const freeLinks = entitlementsOf('free').maxLinks;

  return (
    <div className={cn('pt-14 px-safe pb-4 md:pt-20')}>
      <JsonLd data={faqPage(FAQ_GROUPS)} />
      <div className={cn('mx-auto max-w-6xl px-4 md:px-6 lg:px-8')}>
        <header className={cn('max-w-3xl')}>
          <p className={cn('eyebrow')}>Answers</p>
          <h1
            className={cn(
              'mt-3 font-display text-4xl leading-[1.05] font-semibold tracking-tight text-balance md:text-5xl',
            )}
          >
            Questions, including the ones with awkward answers.
          </h1>
          <p className={cn('mt-5 max-w-2xl text-lg leading-8 text-muted-foreground')}>
            An app built so we can’t read your library also can’t recover it for you. That trade
            runs through most of what follows, so it is stated plainly rather than buried.
          </p>
        </header>

        <div className={cn('mt-14 grid gap-12 lg:grid-cols-12 lg:gap-16')}>
          {/* The index. Sticky on wide screens, a plain chip row on narrow ones —
              with five groups, scrolling past four of them to reach billing is the
              most likely thing a visitor wants to skip. */}
          <nav className={cn('lg:col-span-3')} aria-label="Sections">
            <div className={cn('lg:sticky lg:top-28')}>
              <p className={cn('eyebrow hidden lg:block')}>Sections</p>
              <ul className={cn('flex flex-wrap gap-2 lg:mt-4 lg:flex-col lg:gap-1')}>
                {FAQ_GROUPS.map((group) => (
                  <li key={group.id}>
                    <a
                      className={cn(
                        'inline-block rounded-full border border-border px-3 py-1 text-sm text-muted-foreground transition-colors hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none lg:rounded-sm lg:border-0 lg:px-0 lg:py-1',
                      )}
                      href={`#${group.id}`}
                    >
                      {group.title}
                    </a>
                  </li>
                ))}
              </ul>
            </div>
          </nav>

          <div className={cn('lg:col-span-9')}>
            {FAQ_GROUPS.map((group, index) => (
              <section
                key={group.id}
                id={group.id}
                className={cn(
                  // `scroll-mt` clears the sticky header when a jump link lands.
                  'scroll-mt-24',
                  index > 0 && 'mt-16',
                )}
              >
                <h2 className={cn('font-display text-2xl font-semibold tracking-tight')}>
                  {group.title}
                </h2>
                <p className={cn('mt-2 text-body text-muted-foreground')}>{group.blurb}</p>

                <div className={cn('mt-6 border-t border-border')}>
                  {group.items.map((item) => (
                    <details key={item.id} className={cn('group border-b border-border')}>
                      {/* ⚠ THE ID BELONGS ON THE ANSWER BODY, NOT ON THE
                          <details> AND NOT ON THE <summary>, and the difference
                          is whether a jump link opens anything. A browser reveals
                          a closed <details> only when the fragment lands on
                          something inside the COLLAPSED part of it — the
                          ancestor-details-revealing step of "scroll to the
                          fragment". A summary is never collapsed, so it has
                          nothing to reveal; the <details> itself has no closed
                          ancestor at all. Both scroll to the row and leave it
                          SHUT, and the reader who followed a link to an answer
                          arrives at a question. Measured in Chromium and WebKit,
                          which agree exactly — id on <details>: shut; on
                          <summary>: shut; on this div: open.

                          Nothing catches it. It renders, type-checks and lints,
                          and jsdom has no fragment navigation to fail on, so the
                          spec beside content/faq.tsx pins the part it can see:
                          that the id sits on a node the <summary> does not
                          contain, and that the node carries a scroll margin.

                          `scroll-mt-48` is larger than the sections'
                          `scroll-mt-24` on purpose, and the size is measured
                          rather than picked: this element starts BELOW the
                          question, so its margin has to clear the sticky header
                          (65px, site-header.tsx) *and* the whole summary above
                          it, or the jump lands on an answer with its own question
                          scrolled off the top. The binding case is the narrowest
                          phone against the longest question — `vs-others` wraps
                          to 116px at 320px wide, so 65 + 116 = 181px is the floor
                          and 12rem clears it by 11. It is one wrapped line from
                          being wrong: a longer question, a bigger base font or a
                          taller header eats the margin silently, since nothing
                          here can fail a test. Re-measure at 320px before letting
                          a question grow. */}
                      <summary
                        className={cn(
                          'flex cursor-pointer list-none items-start justify-between gap-6 rounded-sm py-4 focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none [&::-webkit-details-marker]:hidden',
                        )}
                      >
                        <h3 className={cn('text-base leading-7 font-medium text-balance')}>
                          {item.q}
                        </h3>
                        <ChevronGlyph
                          className={cn(
                            'mt-1.5 size-4 shrink-0 text-muted-foreground transition-transform duration-200 group-open:rotate-180',
                          )}
                        />
                      </summary>
                      <div
                        id={item.id}
                        className={cn(
                          'max-w-2xl scroll-mt-48 pb-6 text-body text-muted-foreground',
                        )}
                      >
                        {item.a}
                      </div>
                    </details>
                  ))}
                </div>
              </section>
            ))}

            <section
              className={cn(
                'mt-16 rounded-2xl border border-border bg-muted/40 p-8 sm:flex sm:items-center sm:justify-between sm:gap-8',
              )}
            >
              <div>
                <h2 className={cn('font-display text-xl font-semibold tracking-tight')}>
                  Still stuck?
                </h2>
                <p className={cn('mt-2 max-w-md text-body text-muted-foreground')}>
                  Write to us and a person answers. Or start with {freeLinks} free links and find
                  the question you actually have.
                </p>
              </div>
              <div className={cn('mt-6 flex shrink-0 flex-wrap gap-3 sm:mt-0')}>
                <Button asChild variant="outline">
                  <Link href="/support">Contact support</Link>
                </Button>
                <Button asChild>
                  <a href={CREATE_ACCOUNT_URL}>
                    Create your account
                    <ArrowGlyph data-icon="inline-end" className={cn('size-4')} />
                  </a>
                </Button>
              </div>
            </section>
          </div>
        </div>
      </div>
    </div>
  );
}
