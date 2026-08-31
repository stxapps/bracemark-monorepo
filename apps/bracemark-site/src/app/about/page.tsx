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
  // The fourth, and the only one that is not a consequence of the encryption —
  // which is exactly why it was missing. This section's three costs were all
  // architectural, so the boundary that actually decides fit for a read-it-later
  // reader was left to /terms, where the people it disqualifies never reach it.
  // A section whose stated purpose is "we would rather you knew now" does not
  // get to leave out the one a whole category of visitor needs.
  //
  // Phrased as LINK ROT, not as "no copy of the page", and the difference is
  // load-bearing. The second is a promise about something we will never build,
  // and read mode, screenshot and page copy are all planned rather than declined
  // (docs/link-extraction.md, _capability tiers_) — a cost we withdraw a year
  // later reads worse than one we never claimed, and this list's whole standing
  // rests on being the place we volunteer things. Rot is a property of the web
  // and stays true whatever ships: a page copy, when it exists, is a per-link
  // mitigation on a meter, not a guarantee the library outlives the pages in it.
  // The landing hero, /terms and the FAQ's offline answer dropped the same
  // negative in the same change.
  // → docs/link-extraction.md for what a save does capture.
  //
  // Second pass, on the half the first one left exposed. The FRAMING was made
  // future-proof — rot is a property of the web and survives whatever ships — and
  // then the sentence under it closed a LIST: "the address, the title, the preview
  // image and whatever you write about it" is what a save captures TODAY, and it
  // stops being the whole answer the day read mode, a screenshot or a page copy
  // lands. An entry whose standing rests on volunteering things cannot be the one
  // that quietly understates the product a year from now. "Whatever Bracemark could
  // read of the page at the time" is open at the right end and closed at the one
  // that matters: however much a save captures, it is a capture, and the page it
  // came from is still somebody else's to change.
  [
    'A saved link can rot',
    'A save keeps the address and whatever Bracemark could read of the page at the time — its title, its preview image, and anything you write about it. The page itself is on someone else’s server: if it changes or goes away, what the library keeps is your record of the web, not the web.',
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
            <div className={cn('mt-4 space-y-4 text-base leading-7 text-muted-foreground')}>
              <p>
                What you save is a fairly complete picture of what you are reading, buying, worrying
                about and working on. Most bookmark managers hold that picture in readable form on
                their servers, and most of them mean well. But meaning well is a policy, and
                policies change with funding rounds, acquisitions, subpoenas and breaches.
              </p>
              {/* "What the server keeps OF IT" — the scoping clause is the whole
                  repair. The sentence used to end "the server keeps a path, a size
                  and some bytes", which reads as the total and is not: the same
                  Worker holds the account in the clear — username, public key,
                  sessions, and a subscription row if you pay. /privacy has always
                  inventoried those, so the page that sends people there was the one
                  contradicting it. Naming them in the same breath costs a clause
                  and makes the claim checkable rather than merely confident. */}
              <p>
                So Bracemark is built the other way round. Your password derives a key on your own
                device; every link, list and tag becomes its own encrypted file before it is
                uploaded; what the server keeps of it is a path, a size and some bytes. Around that
                sits the account — your username, your sessions, your plan if you buy one — and
                nothing readable from a single link. There is no “we promise not to look” in that
                sentence, because there is no looking available to promise against.
              </p>
            </div>
          </section>

          <section>
            <h2 className={cn('font-display text-2xl font-semibold tracking-tight')}>
              What it costs to build it this way
            </h2>
            <p className={cn('mt-4 text-base leading-7 text-muted-foreground')}>
              Four things you can do in an ordinary bookmark manager, you cannot do here. We would
              rather you knew now.
            </p>
            {/* Two columns, not four: this shell is a max-w-3xl prose measure, so
                a fourth column would leave each entry about 180px wide and break
                every term across two lines. 2×2 keeps the entries at a readable
                measure and reads as a list of costs rather than a feature grid. */}
            <dl className={cn('mt-8 grid gap-8 sm:grid-cols-2')}>
              {TRADEOFFS.map(([term, detail]) => (
                <div key={term} className={cn('border-t border-border pt-5')}>
                  <dt className={cn('text-base font-semibold text-balance')}>{term}</dt>
                  <dd className={cn('mt-2 text-body text-muted-foreground')}>{detail}</dd>
                </div>
              ))}
            </dl>
          </section>

          <section>
            <h2 className={cn('font-display text-2xl font-semibold tracking-tight')}>
              Where it came from
            </h2>
            <div className={cn('mt-4 space-y-4 text-base leading-7 text-muted-foreground')}>
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
            <div className={cn('mt-4 space-y-4 text-base leading-7 text-muted-foreground')}>
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
                    'text-signal underline decoration-signal-line underline-offset-2 hover:decoration-signal',
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
            <div className={cn('mt-4 space-y-4 text-base leading-7 text-muted-foreground')}>
              <p>
                A small team at {COMPANY.legalName} in Bangkok. Small enough that the person who
                answers <span className={cn('font-mono text-sm')}>{SUPPORT_EMAIL}</span> is the
                person who wrote the code you are asking about — which is a support model with
                obvious limits and one real advantage.
              </p>
            </div>
          </section>

          {/* "The two servers behind them", never "the sync server" — the phrase this
              list used to carry, and the one CLAUDE.md's tripwire bars. There is no
              separate sync server to name: `bracemark-api` is ONE Worker serving
              auth, sync AND billing, so the name invents a component a reader
              cannot find and quietly narrows what is in the repository. Two is the
              true count (`bracemark-api` and `bracemark-extractor`) and both are
              here, which is also the honest answer to the reader this section is
              written for — the one checking whether the thing that fetches pages is
              published too. The browser extension joined the list in the same pass;
              it was always in the repo and was the one artefact the sentence left
              out. The landing page's _If we disappear_ band and the FAQ's `source`
              answer carry the same list and moved with it. */}
          {/* Placed after "Who makes it" and before the colophon on purpose: the
              page has just asked you to trust a small team in Bangkok, and this is
              the paragraph that says you don't have to. The colophon under it then
              repeats the repo as a specimen line, where a technical reader looks
              for it. */}
          <section>
            <h2 className={cn('font-display text-2xl font-semibold tracking-tight')}>
              See for yourself
            </h2>
            <div className={cn('mt-4 space-y-4 text-base leading-7 text-muted-foreground')}>
              <p>
                Everything above is a claim about how the software works, made by the people who
                profit from you believing it. So the software is public:{' '}
                <a
                  className={cn(
                    'text-signal underline decoration-signal-line underline-offset-2 hover:decoration-signal',
                  )}
                  href={SOURCE.url}
                  rel="noreferrer"
                >
                  {SOURCE.label}
                </a>
                , under the {SOURCE.license}. The apps, the browser extension, the two servers
                behind them, the key derivation, this page — one repository, all of it.
              </p>
              <p>
                Being precise about what that buys you: you can read exactly what we do, and you can
                check that the encryption happens where we say it does. You cannot, from the source
                alone, prove that the code your browser just ran was built from it — that would take
                reproducible builds, which we do not yet publish. Anyone who tells you otherwise
                about their own app is overselling it. What open source removes here is our ability
                to describe the design as one thing while shipping another.
              </p>
              {/* The same move as the paragraph above it, applied to the other
                  thing a careful reader goes looking for and does not find.
                  Everyone who cared about the encryption claims searched for an
                  outside check — an audit, a transparency report, a named
                  reviewer — and the site's silence read as something being
                  managed. It isn't; there simply hasn't been one. Saying so
                  costs a sentence and is worth more than the silence, and this
                  is the paragraph that has already proved the move works.
                  What this must NOT become is a roadmap promise: no date, no
                  "coming soon". If an audit is ever commissioned, this is where
                  it gets named, and only once it exists. */}
              <p>
                One more absence, since you would find it anyway: no third party has audited this
                code. There is no report to link, no security firm on retainer and no transparency
                report, because none of those exist yet rather than because they say something we
                would rather you missed. What is here instead is the repository, this page, and a
                policy that inventories every field we hold.
              </p>
            </div>
          </section>

          <section>
            <h2 className={cn('font-display text-2xl font-semibold tracking-tight')}>Built with</h2>
            {/* One column, not two: paired at half width the longer values
                ("Bricolage Grotesque · Inter · IBM Plex Mono") wrap mid-list and
                the columns stop lining up, which is the one thing a specimen
                list has to do. */}
            <dl className={cn('mt-6 border-t border-border')}>
              {BUILT_WITH.map(([term, detail]) => (
                <div
                  key={term}
                  className={cn(
                    'flex flex-wrap items-baseline justify-between gap-x-8 gap-y-1 border-b border-border py-3.5',
                  )}
                >
                  <dt className={cn('eyebrow')}>{term}</dt>
                  <dd className={cn('font-mono text-sm text-muted-foreground')}>{detail}</dd>
                </div>
              ))}
            </dl>
          </section>
        </div>
      </PageShell>

      <section className={cn('band mt-24 px-safe')}>
        <div className={cn('mx-auto max-w-3xl px-4 py-20 text-center md:px-6 lg:px-8')}>
          <h2
            className={cn(
              'font-display text-3xl leading-[1.1] font-semibold tracking-tight text-balance md:text-4xl',
            )}
          >
            The best way to judge it is to use it.
          </h2>
          <p className={cn('mx-auto mt-4 max-w-lg text-lg leading-8 text-muted-foreground')}>
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
