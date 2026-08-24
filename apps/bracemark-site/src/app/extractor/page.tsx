import type { Metadata } from 'next';
import Link from 'next/link';

import { cn } from '@stxapps/web-ui/lib/utils';

import { PageShell } from '../../components/page-shell';
import { ABUSE_EMAIL, SOURCE } from '../../lib/site';

export const metadata: Metadata = {
  title: 'bracemark-extractor',
  description:
    'What bracemark-extractor is, why it fetched your page, the caps it holds itself to, and how to stop it if you would rather it did not.',
};

// The page every outbound fetch promises. `bracemark-extractor` identifies itself
// as `bracemark-extractor/1.0 (+https://bracemark.com/extractor)` on EVERY request
// (apps/bracemark-extractor/src/lib/safe-fetch.ts), so this URL is printed in the
// logs of every site a user has ever saved a link from. It existed as a promise
// before it existed as a route.
//
// The audience is therefore NOT a prospective customer. It is a sysadmin who
// grepped an unfamiliar UA out of an access log at 11pm and wants three things, in
// this order: what is this, what will it cost me, how do I make it stop. The page
// answers them in that order and sells nothing — there is no signup CTA here on
// purpose, because the reader did not come to us, we came to them.
//
// Three rules hold this page, and each has a way of being violated silently:
//
//   - EVERY NUMBER IS A CONSTANT IN THE REPO. The timeout, the redirect cap, the
//     HTML ceiling, the image ceiling and the batch cap below are
//     FETCH_TIMEOUT_MS, MAX_REDIRECTS, MAX_HTML_BYTES, MAX_IMAGE_BYTES and
//     MAX_EXTRACT_URLS. They are written out as prose rather than imported
//     because the extractor is a separate app this site does not depend on — so
//     if one of those constants moves, THIS PAGE IS THE THING THAT BREAKS, with
//     no type error to say so. A published cap that the code exceeds is not a
//     stale doc, it is a false statement to someone who is deciding whether to
//     trust us.
//
//   - THE ROBOTS.TXT PARAGRAPH STAYS HONEST. We do not read robots.txt, and the
//     temptation to fudge that on the one page where operators look for it is
//     exactly why it is stated first and plainly. If the extractor ever learns to
//     read it, this section changes from a disclosure to a claim — and not before.
//
//   - THE BLOCKING ADVICE HAS TO MATCH `verdictForStatus`. 403 → retried up the
//     backoff ladder, then permanent; 404/410 → permanent immediately; 429/5xx →
//     transient forever (paced, but it does come back). Telling an operator to
//     send a 429 when they want us gone would be advice that quietly fails.
//     → packages/shared/src/extract/retry.ts.
//
//   - FACTS ARE BEHAVIOUR, `NEVER` IS INVARIANTS — and the line between them is
//     the roadmap. FACTS describes the build that is running: it may change in a
//     release, and changing it is a normal edit to this file. NEVER is the
//     committed invariant list from docs/link-extraction.md (separate app,
//     separate origin, anonymous, plaintext-return-only, stream-don't-store,
//     never-log-the-URL) — the things that cannot change without changing what
//     this service IS. Sorting a claim into the wrong list is how a page like
//     this starts lying: a behaviour promoted to "never" is a promise nobody
//     agreed to make.
//
//     Two consequences, both live:
//
//       WHAT IT TAKES FROM A PAGE IS A FACT, NOT A NEVER. Server-tier extraction
//       is `titleImage` today, and `readMode` is already in the planned response
//       shape (docs/link-extraction.md — _server extraction_). It is the one
//       further facet this tier can produce: screenshot and page copy need a
//       browser actually rendering the page, which is why they are the
//       active-context tiers' work (apps/bracemark-extension/utils/capture.ts).
//       So the payload is named in ONE row of FACTS ("Takes") and nowhere in
//       NEVER — when read-mode ships here, that row plus the four prose mentions
//       (the lede, the log card, the crawler section, the blocking consequence)
//       are the whole edit, and no promise on this page moves. Do NOT re-describe
//       the payload inside NEVER, however true it is today.
//
//       "IT RUNS NO JAVASCRIPT" IS ALSO ONLY A FACT. Eventual Browser-Rendering
//       JS execution is an open scope call in that same doc, and a headless page
//       capturer is deferred rather than ruled out — so the row below says "not
//       executed" (what the build does) and there is no bullet promising it never
//       will be. If that ever ships, this page changes in the same release and
//       the robots.txt section is re-argued from scratch — a renderer costs a
//       host what a crawler costs it, which is the one thing that section's
//       argument cannot absorb.
//
//     The robots.txt section is deliberately written to the axis that survives
//     all of this: WHO CHOSE (one person, one address, one request), never HOW
//     MUCH IS READ. Read-mode therefore needs it re-checked, not rewritten. What
//     is genuinely still open is the BEHAVIOUR — whether server-side read-mode
//     should honour robots.txt, and in which form — which is a decision for the
//     extractor, not for this file, and is tracked in docs/link-extraction.md
//     (_deferred / open_). Settle it there; this page only ever reports it.

const USER_AGENT = 'bracemark-extractor/1.0 (+https://bracemark.com/extractor)';

// The operational facts, in the order a capacity question gets asked — what we
// want, then what it costs to give it. Deliberately includes the numbers that make
// this cheap to host rather than only the ones that make us look careful.
//
// `Takes` is the row read-mode moves; see the fourth rule above before editing it.
const FACTS: [string, string][] = [
  ['Takes', 'a title · a preview image'],
  ['Method', 'GET · no cookies, no credentials'],
  ['Timeout', '8 seconds per hop'],
  ['Redirects', '5 maximum'],
  ['HTML read', 'first 1 MB, then cancelled'],
  ['Images', '10 MB ceiling · never resized'],
  ['Per request', '20 URLs at most'],
  ['JavaScript', 'not executed'],
  ['Runs on', 'Cloudflare Workers'],
];

// The invariants, not the behaviour — see the fourth rule above. Every entry here
// is a property of what this service IS, so none of them moves when the thing it
// extracts changes. If you find yourself wanting to add a row that begins "it only
// takes…", it belongs in FACTS.
const NEVER: [string, string][] = [
  [
    'Keep what it read',
    'Nothing is buffered to disk, cached, indexed or stored. What it finds goes straight back to the device that asked and the bytes are gone — there is no copy of your page at our end to leak, subpoena or change our mind about.',
  ],
  [
    'Write down the address',
    'The whole reason this service is separate from the rest of Bracemark is that the URL it sees stays transient. Observability is counts, latency and error rates — the address never reaches a log line.',
  ],
  [
    'Know who asked',
    'Requests carry no account and no session. It cannot tell you which user saved your page, because it was never told.',
  ],
  [
    'Come back for the rest of your site',
    'One saved link is one document. It has no queue to add the rest of your pages to, no schedule to revisit this one on, and nothing that turns a link it found in your markup into a second request.',
  ],
  [
    'Feed a dataset or a model',
    'Nothing fetched here trains anything, is resold, or is retained to be resold later. It is fetched for one person, delivered to their device, and encrypted there before it is written down anywhere.',
  ],
];

export default function Page() {
  return (
    <PageShell
      eyebrow="Bot"
      title="Someone saved a link to your page."
      lede="That is the whole reason this fetcher knocked. It read a title and a preview image out of your document, once, because a person asked it to — and here is everything about it that an access log won’t tell you."
    >
      <div className={cn('space-y-14')}>
        {/* The string they searched for, given the weight /support gives its
            address: it is the one thing on the page the reader arrived holding. */}
        <section className={cn('border-signal-line bg-signal-soft/60 rounded-2xl border p-8')}>
          <p className={cn('eyebrow text-signal')}>The line in your log</p>
          <p
            className={cn(
              'text-signal-strong mt-3 font-mono text-sm break-all sm:text-base md:text-lg',
            )}
          >
            {USER_AGENT}
          </p>
          <p className={cn('text-muted-foreground mt-5 text-[0.9375rem] leading-7')}>
            Bracemark is an end-to-end encrypted bookmark manager. When someone saves a link in the
            web app, the browser will not let that page fetch yours, so this service fetches it
            instead — reads the title and the preview image, hands both back to the person’s own
            device, and forgets the address. It is the only part of Bracemark that ever visits
            another site.
          </p>
        </section>

        <section>
          <h2 className={cn('font-display text-2xl font-semibold tracking-tight')}>
            It is a fetcher, not a crawler
          </h2>
          <div className={cn('text-muted-foreground mt-4 space-y-4 text-base leading-7')}>
            <p>
              There is no queue, no schedule and no index behind it. It never follows a link out of
              a page it fetched, never asks for a second page from your site on its own initiative,
              and never returns to see whether anything changed. One person saving one link is one
              request — plus one more if your document names a preview image, and one more again to
              relay that image to their browser, which cannot read it cross-origin any more than it
              could read your page.
            </p>
            <p>
              Once a title has come back successfully it is never fetched again: the answer lives on
              that person’s devices from then on, encrypted, and no later save of the same address
              by the same person re-asks you for it.
            </p>
            <p>
              It also only runs for people who turned it on. Fetching on someone’s behalf means
              seeing an address they chose to save, so it is an opt-in setting that is off until
              they enable it — the browser extension and the mobile apps read the page on the device
              instead and never involve us at all. The full account of that is in the{' '}
              <Link
                className={cn(
                  'text-signal decoration-signal-line hover:decoration-signal underline underline-offset-2',
                )}
                href="/privacy"
              >
                privacy policy
              </Link>
              .
            </p>
          </div>
        </section>

        <section>
          <h2 className={cn('font-display text-2xl font-semibold tracking-tight')}>
            What it costs you
          </h2>
          <p className={cn('text-muted-foreground mt-4 text-base leading-7')}>
            Every one of these is a hard cap in the code rather than a target, and each applies to
            every hop of every request.
          </p>
          <dl className={cn('border-border mt-6 border-t')}>
            {FACTS.map(([term, detail]) => (
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
          <p className={cn('text-muted-foreground mt-6 text-base leading-7')}>
            Because nothing on the page is executed, what it sees is the markup you served and
            nothing more: no stylesheet, script or font is pulled in behind it, and a page that
            assembles its title in the browser yields nothing to find. The ceilings are ours as much
            as yours — this runs anonymously, so the caps are what keep it from being an open proxy
            pointed at your bandwidth. You can read every one of them, and the guard that re-checks
            each redirect before connecting to it, in{' '}
            <a
              className={cn(
                'text-signal decoration-signal-line hover:decoration-signal underline underline-offset-2',
              )}
              href={SOURCE.url}
              rel="noreferrer"
            >
              {SOURCE.label}
            </a>{' '}
            — the service is {SOURCE.license}, like the rest of Bracemark.
          </p>
        </section>

        <section>
          <h2 className={cn('font-display text-2xl font-semibold tracking-tight')}>
            What it never does
          </h2>
          <dl className={cn('mt-8 space-y-6')}>
            {NEVER.map(([term, detail]) => (
              <div key={term} className={cn('border-border border-t pt-5')}>
                <dt className={cn('text-base font-semibold')}>{term}</dt>
                <dd className={cn('text-muted-foreground mt-2 text-[0.9375rem] leading-7')}>
                  {detail}
                </dd>
              </div>
            ))}
          </dl>
        </section>

        <section>
          <h2 className={cn('font-display text-2xl font-semibold tracking-tight')}>
            It does not read your robots.txt
          </h2>
          <div className={cn('text-muted-foreground mt-4 space-y-4 text-base leading-7')}>
            <p>
              Said plainly, because this is the page where you came looking for it. A robots
              directive will not stop this fetcher, and we would rather disclose that than let you
              write a rule that quietly does nothing.
            </p>
            <p>
              The reasoning, for what it is worth, is about who chose — not about how much gets
              read. A robots directive governs automated discovery: something deciding on its own
              what to visit next, at a cadence and a volume you never agreed to. Nothing here
              decides anything. One person put one address into their own library, one request went
              out because of that, and what came back went to their device and nowhere else. There
              is no queue behind it for a directive to shorten and no next page for it to keep us
              away from.
            </p>
            <p>
              That is an argument for why the file is not consulted, not a claim that it is — and it
              is an argument we could lose. It rests entirely on the request being one person’s and
              on there being exactly one of them. If this service ever fetches on its own
              initiative, or at a volume that a single save cannot account for, the argument is gone
              and this section gets rewritten rather than defended. Blocking by user agent works
              either way, which is why that is documented above rather than here.
            </p>
          </div>
        </section>

        <section>
          <h2 className={cn('font-display text-2xl font-semibold tracking-tight')}>
            How to turn it away
          </h2>
          <div className={cn('text-muted-foreground mt-4 space-y-4 text-base leading-7')}>
            <p>
              Match the user agent — every request carries{' '}
              <span className={cn('text-foreground font-mono text-sm')}>bracemark-extractor</span>{' '}
              in that header, and it is never spoofed as a browser — then answer with{' '}
              <span className={cn('text-foreground font-mono text-sm')}>403</span>.
            </p>
          </div>
          <div className={cn('mt-6 space-y-4')}>
            <div>
              <p className={cn('eyebrow')}>nginx</p>
              <pre
                className={cn(
                  'border-border bg-muted/50 mt-2 overflow-x-auto rounded-xl border p-4 font-mono text-xs leading-6',
                )}
              >
                <code>{'if ($http_user_agent ~* "bracemark-extractor") { return 403; }'}</code>
              </pre>
            </div>
            <div>
              <p className={cn('eyebrow')}>Cloudflare WAF</p>
              <pre
                className={cn(
                  'border-border bg-muted/50 mt-2 overflow-x-auto rounded-xl border p-4 font-mono text-xs leading-6',
                )}
              >
                <code>{'(http.user_agent contains "bracemark-extractor")  →  Block'}</code>
              </pre>
            </div>
          </div>
          <div className={cn('text-muted-foreground mt-6 space-y-4 text-base leading-7')}>
            <p>
              <strong className={cn('text-foreground font-semibold')}>
                The status code you pick decides how long we keep trying.
              </strong>{' '}
              A <span className={cn('font-mono text-sm')}>403</span> is retried on a widening
              backoff and then abandoned for good. A{' '}
              <span className={cn('font-mono text-sm')}>404</span> or{' '}
              <span className={cn('font-mono text-sm')}>410</span> settles it immediately, first
              time. A <span className={cn('font-mono text-sm')}>429</span> or a{' '}
              <span className={cn('font-mono text-sm')}>5xx</span> reads as temporary, so it will
              come back — slowly, and at most once a day for that one link, but it will. Send the
              403 if you want it gone.
            </p>
            <p>
              <strong className={cn('text-foreground font-semibold')}>
                Do not block it by address.
              </strong>{' '}
              It runs on Cloudflare Workers, so its requests leave from a shared pool that has
              nothing else to do with us, and banning those addresses costs you traffic you wanted
              while barely inconveniencing this.
            </p>
            <p>
              What blocking does to the person who saved the link: they get your hostname as the
              title and no preview image. The link still works, they are not told why, and nothing
              else about your site is affected.
            </p>
          </div>
        </section>

        {/* No signup CTA closes this page. The reader is not a prospect, and an
            "or you could try Bracemark!" band under a blocking guide would read
            as exactly the kind of bot that ignores robots.txt. */}
        <section className={cn('border-border rounded-2xl border p-8')}>
          <h2 className={cn('font-display text-xl font-semibold tracking-tight')}>
            If it misbehaved
          </h2>
          <p className={cn('text-muted-foreground mt-3 text-[0.9375rem] leading-7')}>
            Write to{' '}
            <a
              className={cn(
                'text-signal decoration-signal-line hover:decoration-signal rounded-sm font-mono underline underline-offset-2',
              )}
              href={`mailto:${ABUSE_EMAIL}`}
            >
              {ABUSE_EMAIL}
            </a>
            . If it arrived more often than this page says it can, exceeded one of the caps above,
            or reached something it had no business reaching, that is a bug and we want it. The
            user-agent line, a few timestamps and the paths are enough to find it at our end. A
            person reads that address, not an auto-responder.
          </p>
        </section>
      </div>
    </PageShell>
  );
}
