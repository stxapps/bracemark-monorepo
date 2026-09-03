import type { Metadata } from 'next';
import Link from 'next/link';

import { entitlementsOf, PLAN_LABELS, PLAN_USD_PER_YEAR } from '@stxapps/shared';
import { Button } from '@stxapps/web-ui/components/ui/button';
import { cn } from '@stxapps/web-ui/lib/utils';

import { ArrowGlyph } from '../../components/glyphs';
import { PageShell } from '../../components/page-shell';
import { COMPANY, CREATE_ACCOUNT_URL, PREDECESSOR, SOURCE, SUPPORT_EMAIL } from '../../lib/site';

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

// What the architecture costs, stated by us rather than discovered later. Every
// entry but the last is a direct consequence of the line above it in
// docs/local-first-sync.md; the last one has its own note.
//
// NO COUNT, HERE OR IN THE LEDE ABOVE THE LIST. The lede read "Four things" for
// as long as there were five, and the note below opened "The fourth" about an
// entry that had since moved to the end. A number in prose beside a list is a
// second copy of the list's length with nothing keeping the two in step — no
// lint error, no type error, no failing test — so the copy is gone rather than
// corrected. Add an entry here and nothing else needs touching.
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
  // Placed next to sharing because it is the same shape one step out: both are
  // "get this to something that is not you", and both run into the fact that the
  // only thing we hold is unreadable.
  //
  // WHY IT BELONGS IN THIS LIST AND NOT IN THE FAQ. Two readers evaluating the
  // product went to the REPOSITORY to find out whether there was an API, because
  // no page said. That is a failure of the list whose stated purpose is "we would
  // rather you knew now" — a fit question answered nowhere is exactly what this
  // section exists to prevent, and it is asked before an account exists, which is
  // the wrong end of the funnel for a FAQ organised around using the product. One
  // canonical statement, here; anything else that needs it links to it.
  //
  // THE REASON IS THE ENTRY. "We have not built one" is a status; the architecture
  // is the durable half and it is genuinely interesting — a server-side API of
  // ours can only ever serve ciphertext, so a useful one needs the key somewhere
  // it currently never goes. That framing also survives the day an API ships in
  // some form, because it names the constraint any such thing would have to answer
  // rather than promising there will never be one.
  //
  // "TODAY", NEVER "YET" OR "NOT ANY MORE". Same rule as /faq `self-hosting`:
  // today describes where things stand and carries no roadmap in it, while "yet"
  // and "coming soon" are commitments nobody made — and this list's standing rests
  // on volunteering costs, which a hedged cost is not. Do NOT attach a date or a
  // plan here, and do not let it drift into an apology: the export is a real
  // answer to most of what an API would be asked for, and it is already shipped.
  [
    'No public API',
    'There is no public API today, and nothing to hang an integration or an automation off. Part of that is simply unbuilt, and part of it is the architecture: anything we could serve from our side is ciphertext, so a useful API would mean putting your key somewhere it currently never goes. The export is the seam that does work — a readable backup, free on every plan, as often as you like.',
  ],
  // The sync cost, which belongs in a list of things we would rather you knew
  // now and had been left to docs/local-first-sync.md. It is the counterpart of
  // the landing page's `One link, two devices` trade row and /faq `two-devices`;
  // all three state the shipped last-writer-wins policy, and none of them
  // mentions the deferred conditional-write upgrade, because a list whose
  // standing rests on volunteering costs cannot start volunteering fixes.
  //
  // Phrased as NO VERSION HISTORY rather than "edits can be lost", because the
  // absent feature is the durable fact and the lost edit is the symptom. It is
  // also the one framing that stays true if the winner ever changes: whichever
  // side wins a conflict, there is no readable copy of your links at our end to
  // have kept the other one in.
  //
  // A FOURTH surface carries the same fact without the conflict: /faq
  // `undo-edit` answers it for one device (an edit you regret, nobody else
  // involved) and is the only one of the four that names Trash and the export
  // backstop. The three listed above all condition the loss on two devices,
  // which is why it was worth adding rather than repeating.
  [
    'No version history',
    'Each link is its own encrypted file and the newest write is the one that survives. We hold no readable copy of your links to keep earlier versions in, so an edit you regret cannot be rolled back from our side — a backup export is the answer if that matters to you.',
  ],
  // The one entry that is NOT a consequence of the encryption — which is exactly
  // why it was missing. Every other cost in this list is architectural, so the
  // boundary that actually decides fit for a read-it-later reader was left to
  // /terms, where the people it disqualifies never reach it. A section whose
  // stated purpose is "we would rather you knew now" does not get to leave out
  // the one a whole category of visitor needs.
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
                So Bracemark is built the other way round. Your password unlocks a key on your own
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
              Each of these is something you can do in an ordinary bookmark manager and cannot do
              here. We would rather you knew now.
            </p>
            {/* Two columns whatever the entry count, and no third: this shell is a
                max-w-3xl prose measure, so a third column would leave each entry
                about 180px wide and break every term across two lines. Two keeps
                them at a readable measure and reads as a list of costs rather
                than a feature grid — including on an odd count, where the last
                entry sits alone on its row, which is what a list does. */}
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
              {/* NO PREREQUISITE IS CLAIMED HERE, and two plausible ones were
                  tried and are both false. The old stack's 24-word secret key is
                  a contrast we are not entitled to draw — our own recommended path
                  is a GENERATED passphrase plus a long recovery code
                  (docs/account.md), so "they made you keep a long secret"
                  describes Bracemark too, and the reader finds that out in the
                  create-account ceremony. And there was no errand: Brace.to
                  generated that key itself, so "go and get an account somewhere
                  else first" never happened. What is left is two reasons that are
                  both about US, which is why the sentence no longer says the old
                  product asked anything of anyone.

                  WE WERE NOT FORCED OUT, and the copy must never imply it. That
                  stack is open source: we could have gone on running it for as long
                  as we liked. Better ways to do the same job turned up and we chose
                  to move — that is the whole of it. Two drafts here got it wrong in
                  the same direction: "an account model we did not own turned out to
                  be one we could not keep", and then "the tools underneath it
                  stopped being maintained". Both read as our predecessor having
                  been killed by a dependency, and the second is the more tempting
                  because it is nearly true — but on the one section whose job is to
                  answer "will this one last?", either hands the reader the
                  objection it was written to settle. A chosen migration is the
                  answer; a forced one is the fear. Note what that costs: with no
                  external cause on the page, the ONLY reason left is that we
                  thought the alternative was better, so the sentence has to be
                  willing to say so plainly.

                  "A blockchain was never the part that kept those bookmarks
                  private" is load-bearing in a way it does not look: a blockchain
                  registered NAMES. The privacy came from client-side encryption,
                  then as now — which is what makes leaving it a simplification
                  rather than a retreat, and what the next paragraph's "ours end to
                  end" then claims.

                  THE NAME CLAUSE GOES FIRST, and it stays. It reads as the outlier
                  beside an engineering reason, and the temptation is to cut it —
                  but it is the only place on the site that explains the
                  RENAME, which is what earns "successor" over "second version";
                  docs/brand-assets.md's terminology row cites this clause by name
                  as the thing that settles it. Last in the list it took the
                  punchline slot and left "Nothing forced the move" answering the
                  item before it rather than the one it is about. First, the pair
                  escalates into the reason that carries, the defence sits against
                  the claim it defends, and the name lands next to the patience it
                  was asking for.

                  Three things it must not become:

                  - Nothing here is retired, sunset or dead. Brace.to is the one
                    predecessor we import from and the docs describe it in the
                    present tense (docs/data-lifecycle.md, _importing from
                    Brace.to_); "it was sunset" would say we discontinued our own
                    product two clauses after saying we have run it for years, and
                    the same word aimed at the stack reintroduces the forced move.
                  - No vendor-blaming, and no naming who did or did not keep what
                    going. It buys nothing and costs the register — every clause
                    here is about our decision.
                  - It stops at the ENCRYPTION AND THE ACCOUNT. It cannot widen
                    into "everything is ours now" — the Worker still runs on
                    Cloudflare's databases and object storage, which the landing
                    page's _If we disappear_ band concedes by name.

                  "Keeps the promise and rebuilds what it rests on" is also the
                  landing page's footnote, verbatim (page.tsx, _If we disappear_).
                  It used to be "drops the prerequisite" on both, and that phrase
                  died with the prerequisite — the two surfaces have to agree
                  (docs/brand-assets.md, the successor row). */}
              {/* THE YEAR AND THE LINK, added together because neither works
                  alone: a date nobody can check is an assertion, and a link with
                  no date makes the reader do the arithmetic we already know the
                  answer to. Three readers in a positioning test went looking for
                  something to click here and found a bare product name.

                  "AND STILL RUN TODAY" IS THE LOAD-BEARING CLAUSE, and it is new
                  rather than a rewording. This paragraph could be read as churn —
                  a team that abandons a product every few years — and one reader
                  did read it that way. A predecessor that is still answering is
                  the exact opposite of churn, and it was true the whole time
                  without being said. Present tense on purpose: it describes what
                  is running, not a commitment about what will be.

                  "Could have STAYED ON IT" replaces "could have kept it running
                  forever", which only parsed while the page left it ambiguous
                  whether the thing still ran. The point was never that we could
                  have kept the lights on — it is that nothing forced the
                  migration, which is what the replacement says without arguing
                  with the sentence above it.

                  Both facts come from PREDECESSOR in @stxapps/shared, shared with
                  the landing page's footnote (page.tsx, _If we disappear_), which
                  names the same product in the same breath. brand.spec.ts pins the
                  name against the URL; nothing can pin that the domain still
                  answers, which is why the constant carries the instruction to
                  pull the link from BOTH surfaces if it ever stops. */}
              <p>
                Bracemark is the successor to{' '}
                <a
                  className={cn(
                    'text-signal underline decoration-signal-line underline-offset-2 hover:decoration-signal',
                  )}
                  href={PREDECESSOR.url}
                  rel="noreferrer"
                >
                  {PREDECESSOR.name}
                </a>
                , a bookmark manager we have run since {PREDECESSOR.since} and still run today, on a
                decentralised identity stack. That one worked, and the people who used it were
                generous with their patience — but it was named after a domain nobody could say out
                loud, and better ways to do the same job arrived. Nothing forced the move: that
                stack is open source and we could have stayed on it indefinitely. We would rather
                build on the best tools for the job than keep a stack going out of loyalty to it —
                and a blockchain was never the part that kept those bookmarks private.
              </p>
              <p>
                This one keeps the promise and rebuilds what it rests on. The encryption is now ours
                end to end: a key your password unlocks, with a recovery code as the second door.
                You sign up with a username. Nothing else.
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
                even if we wanted to, and no investor waiting for us to change that.
              </p>
              {/* "A fraction of a cent a year" was two lines above the price, and
                  every reader who noticed did the same division and arrived at the
                  same place: a margin argument, in our own words, on the one page
                  that has to justify the number. The figure was doing no work the
                  sentence around it wasn't — the CHEAP-TO-RUN argument is what
                  earns the free plan, and it survives intact without a
                  denominator. A precise number invites arithmetic; if the
                  arithmetic argues against you, the precision is a cost.

                  What replaced it is the half that was missing rather than a
                  hedge: the storage is cheap and the SOFTWARE is not, and nothing
                  on this page had ever said what the subscription actually buys.
                  Four clients and two servers is a countable claim a reader can
                  check against the repository, which is the register this page is
                  written in.

                  PLAN_USD_PER_YEAR stays interpolated. The whole method of this
                  property is that it cannot quote a number the app does not
                  enforce, and a typed "$48" ends that the first time the price
                  moves. FREE_LINKS is no longer in this paragraph and the closing
                  CTA is now the page's only site for it — see the note there.

                  THE FREE PLAN'S CLAIM IS ITS DURATION, NOT ITS SIZE. The
                  no-time-limit claim is true, is pinned by the pricing card
                  (page.tsx, "no time limit"), and needs no comparison to land.
                  The cap's real justification is the sentence that follows — the
                  software is what is not cheap — which is also why the cap was
                  never a storage argument to make.

                  DO NOT contrast against "a trial that expires": we ship a
                  TRIAL_DAYS-day one that takes a card (page.tsx, the import card),
                  so that version contradicts us two pages over. */}
              <p>
                It works because the architecture that keeps us out of your library also keeps it
                cheap to run: we store opaque blobs and do no work on their contents. That is why
                the free plan has no time limit on it. What{' '}
                <Link
                  className={cn(
                    'text-signal underline decoration-signal-line underline-offset-2 hover:decoration-signal',
                  )}
                  href="/pricing"
                >
                  {PLAN_LABELS.plus} costs ${PLAN_USD_PER_YEAR.plus} a year
                </Link>{' '}
                pays for is the part that is not cheap: four clients, two servers, and the people
                who keep all of them working on platforms that change every year.
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
          {/* THE PAGE'S ONLY FREE_LINKS SITE, since the pays-for-itself paragraph
              stopped quoting the cap (see the note there for why). It belongs here
              and nowhere else on /about: this is the one place the number is an
              OFFER rather than an argument, so it states a fact the reader is
              about to act on instead of standing as evidence for a claim about
              our costs. Keep it interpolated — a typed "200 links" goes stale the
              first time the entitlement moves, with no lint error, type error or
              failing test to catch it. */}
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
