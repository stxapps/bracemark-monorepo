import type { Metadata } from 'next';
import Link from 'next/link';

import { entitlementsOf, PLAN_LABELS, PLAN_USD_PER_YEAR } from '@stxapps/shared';
import { Button } from '@stxapps/web-ui/components/ui/button';
import { cn } from '@stxapps/web-ui/lib/utils';

import { ArrowGlyph } from '../../components/glyphs';
import { PageShell } from '../../components/page-shell';
import { COMPANY, CREATE_ACCOUNT_URL, SOURCE, SUPPORT_EMAIL } from '../../lib/site';

export const metadata: Metadata = {
  title: 'About',
  description:
    'Who makes Bracemark, why it encrypts everything on your device, and how a bookmark manager pays for itself without selling anything.',
};

// Two rules held throughout, because an About page is where marketing copy
// usually starts drifting from the build:
//   - No claim here outruns the code. No roadmap promise and no feature that isn't
//     shipping. This rule is what
//     shapes _See for yourself_ below: the repo is public, so the page says the
//     code can be READ — not that a visitor can verify the bundle their browser
//     just ran came from it, which would need reproducible builds we don't have
//     (docs/brand-assets.md — _the source_).
//   - The trade-offs section is not modesty. An encrypted-by-construction app has
//     real costs — no recovery, no server-side search, no sharing — and a visitor
//     who discovers them after signing up feels misled. Better they read them
//     here, from us.

const FREE_LINKS = entitlementsOf('free').maxLinks;

// What the architecture costs, stated by us rather than discovered later. Each
// one is a direct consequence of the line above it in docs/local-first-sync.md.
const TRADEOFFS: [string, string][] = [
  [
    'No password reset',
    'We hold no key, so there is nothing on our side to reset with. A recovery code is the second door, and saving it is genuinely on you.',
  ],
  [
    'No server-side search',
    'Search runs on your device, over the copy of the library it already holds. That is why it is instant, and why we cannot offer to search for you.',
  ],
  [
    'No shared or public lists',
    'Sharing means handing someone the means to decrypt part of your library. It is real work rather than a button, and we would rather not fake it.',
  ],
];

// The colophon. Named because credit is due and because it tells a technical
// visitor what they are trusting — which, for a product like this one, is part of
// the pitch. Kept to what actually ships in the repo.
const BUILT_WITH: [string, string][] = [
  ['Source', `${SOURCE.license} · ${SOURCE.label}`],
  ['Encryption', 'Argon2id · AES-256-GCM · Ed25519'],
  ['Apps', 'React · Next.js · Expo'],
  ['On device', 'IndexedDB via Dexie · SQLite'],
  ['Server', 'Cloudflare Workers · R2 · D1'],
  ['Interface', 'Tailwind CSS · Radix · shadcn/ui'],
  ['Type', 'Bricolage Grotesque · Inter · IBM Plex Mono'],
];

export default function Page() {
  return (
    <>
      <PageShell
        eyebrow="About"
        title="We built a bookmark manager we can’t be trusted with."
        lede="Not because we plan to misbehave. Because a promise is only as good as the people making it, and an architecture doesn’t change its mind."
      >
        <div className={cn('space-y-16')}>
          <section>
            <h2 className={cn('font-display text-2xl font-semibold tracking-tight')}>
              Why this one exists
            </h2>
            <div className={cn('text-muted-foreground mt-4 space-y-4 text-base leading-7')}>
              <p>
                What you save is a fairly complete picture of what you are reading, buying, worrying
                about and working on. Most bookmark managers hold that picture in readable form on
                their servers, and most of them mean well. But meaning well is a policy, and
                policies change with funding rounds, acquisitions, subpoenas and breaches.
              </p>
              <p>
                So Bracemark is built the other way round. Your password derives a key on your own
                device; every link, list and tag becomes its own encrypted file before it is
                uploaded; the server keeps a path, a size and some bytes. There is no “we promise
                not to look” in that sentence, because there is no looking available to promise
                against.
              </p>
            </div>
          </section>

          <section>
            <h2 className={cn('font-display text-2xl font-semibold tracking-tight')}>
              What it costs to build it this way
            </h2>
            <p className={cn('text-muted-foreground mt-4 text-base leading-7')}>
              Three things you can do in an ordinary bookmark manager, you cannot do here. We would
              rather you knew now.
            </p>
            <dl className={cn('mt-8 grid gap-8 sm:grid-cols-3')}>
              {TRADEOFFS.map(([term, detail]) => (
                <div key={term} className={cn('border-border border-t pt-5')}>
                  <dt className={cn('text-base font-semibold text-balance')}>{term}</dt>
                  <dd className={cn('text-muted-foreground mt-2 text-[0.9375rem] leading-7')}>
                    {detail}
                  </dd>
                </div>
              ))}
            </dl>
          </section>

          <section>
            <h2 className={cn('font-display text-2xl font-semibold tracking-tight')}>
              Where it came from
            </h2>
            <div className={cn('text-muted-foreground mt-4 space-y-4 text-base leading-7')}>
              <p>
                Bracemark is the second version of Brace.to, a bookmark manager we have run for
                years on a decentralised identity stack. That version worked, and the people who
                used it were generous with their patience — but it asked everyone to understand a
                blockchain account before they could save a link, and it was named after a domain
                nobody could say out loud.
              </p>
              <p>
                This version keeps the promise and drops the prerequisite. The encryption is now
                ours end to end: a key derived from a password you choose, with a recovery code as
                the second door. You sign up with a username. Nothing else.
              </p>
            </div>
          </section>

          <section>
            <h2 className={cn('font-display text-2xl font-semibold tracking-tight')}>
              How it pays for itself
            </h2>
            <div className={cn('text-muted-foreground mt-4 space-y-4 text-base leading-7')}>
              <p>
                Subscriptions. That is the whole model. There is no advertising, no data to sell
                even if we wanted to, and no investor expecting one of those to appear later.
              </p>
              <p>
                It works because the architecture that keeps us out of your library also keeps it
                cheap to run: we store opaque blobs and do no work on their contents, so a free
                account costs us a fraction of a cent a year. That is why the free plan can be{' '}
                {FREE_LINKS} links rather than a nag screen, and why{' '}
                <Link
                  className={cn(
                    'text-signal decoration-signal-line hover:decoration-signal underline underline-offset-2',
                  )}
                  href="/pricing"
                >
                  {PLAN_LABELS.plus} costs ${PLAN_USD_PER_YEAR.plus} a year
                </Link>{' '}
                instead of needing to squeeze every user who ever signs up.
              </p>
              <p>
                We intend to keep today’s free features free, and to never show an advertisement. If
                the app is worth paying for, some of you will pay for it.
              </p>
            </div>
          </section>

          <section>
            <h2 className={cn('font-display text-2xl font-semibold tracking-tight')}>
              Who makes it
            </h2>
            <div className={cn('text-muted-foreground mt-4 space-y-4 text-base leading-7')}>
              <p>
                A small team at {COMPANY.legalName} in Bangkok. Small enough that the person who
                answers <span className={cn('font-mono text-sm')}>{SUPPORT_EMAIL}</span> is the
                person who wrote the code you are asking about — which is a support model with
                obvious limits and one real advantage.
              </p>
            </div>
          </section>

          {/* Placed after "Who makes it" and before the colophon on purpose: the
              page has just asked you to trust a small team in Bangkok, and this is
              the paragraph that says you don't have to. The colophon under it then
              repeats the repo as a specimen line, where a technical reader looks
              for it. */}
          <section>
            <h2 className={cn('font-display text-2xl font-semibold tracking-tight')}>
              See for yourself
            </h2>
            <div className={cn('text-muted-foreground mt-4 space-y-4 text-base leading-7')}>
              <p>
                Everything above is a claim about how the software works, made by the people who
                profit from you believing it. So the software is public:{' '}
                <a
                  className={cn(
                    'text-signal decoration-signal-line hover:decoration-signal underline underline-offset-2',
                  )}
                  href={SOURCE.url}
                  rel="noreferrer"
                >
                  {SOURCE.label}
                </a>
                , under the {SOURCE.license}. The apps, the sync server, the key derivation, this
                page — one repository, all of it.
              </p>
              <p>
                Being precise about what that buys you: you can read exactly what we do, and you can
                check that the encryption happens where we say it does. You cannot, from the source
                alone, prove that the code your browser just ran was built from it — that would take
                reproducible builds, which we do not yet publish. Anyone who tells you otherwise
                about their own app is overselling it. What open source removes here is our ability
                to describe the design as one thing while shipping another.
              </p>
            </div>
          </section>

          <section>
            <h2 className={cn('font-display text-2xl font-semibold tracking-tight')}>Built with</h2>
            {/* One column, not two: paired at half width the longer values
                ("Bricolage Grotesque · Inter · IBM Plex Mono") wrap mid-list and
                the columns stop lining up, which is the one thing a specimen
                list has to do. */}
            <dl className={cn('border-border mt-6 border-t')}>
              {BUILT_WITH.map(([term, detail]) => (
                <div
                  key={term}
                  className={cn(
                    'border-border flex flex-wrap items-baseline justify-between gap-x-8 gap-y-1 border-b py-3.5',
                  )}
                >
                  <dt className={cn('eyebrow')}>{term}</dt>
                  <dd className={cn('text-muted-foreground font-mono text-sm')}>{detail}</dd>
                </div>
              ))}
            </dl>
          </section>
        </div>
      </PageShell>

      <section className={cn('band px-safe mt-24')}>
        <div className={cn('mx-auto max-w-3xl px-4 py-20 text-center md:px-6 lg:px-8')}>
          <h2
            className={cn(
              'font-display text-3xl leading-[1.1] font-semibold tracking-tight text-balance md:text-4xl',
            )}
          >
            The best way to judge it is to use it.
          </h2>
          <p className={cn('text-muted-foreground mx-auto mt-4 max-w-lg text-lg leading-8')}>
            {FREE_LINKS} links, no card, no email address.
          </p>
          <Button asChild size="lg" className={cn('mt-8')}>
            <a href={CREATE_ACCOUNT_URL}>
              Create your account
              <ArrowGlyph data-icon="inline-end" className={cn('size-4')} />
            </a>
          </Button>
        </div>
      </section>
    </>
  );
}
