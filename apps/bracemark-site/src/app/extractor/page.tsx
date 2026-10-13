import type { Metadata } from 'next';
import Link from 'next/link';

import { cn } from '@stxapps/web-ui/lib/utils';

import { MailLink } from '../../components/mail-link';
import { PageShell } from '../../components/page-shell';
import { ABUSE_EMAIL, SOURCE } from '../../lib/site';

export const metadata: Metadata = {
  title: 'bracemark-extractor',
  description:
    'What bracemark-extractor is, why it fetched your page, the caps it holds itself to, and how to stop it if you would rather it didn’t.',
};

// The page every outbound fetch promises. `bracemark-extractor` identifies itself
// as `bracemark-extractor/1.0 (+https://bracemark.com/extractor)` on EVERY request
// (apps/bracemark-extractor/src/lib/safe-fetch.ts), so this URL is printed in the
// logs of every site this service fetches. It existed as a promise
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
//     THE SNIPPET STAYS 403, THE PROSE NAMES 410. 403 is the honest refusal and
//     what Cloudflare's Block emits anyway, so it is what an operator should
//     paste; but the ladder costs them NINE 403s across ~42h (BASE 10 min
//     doubling to the 24h cap) where a 410 settles on the first response, and
//     the closing line used to say "send the 403 if you want it gone" —
//     backwards by the paragraph's own two preceding sentences. Do NOT print
//     that arithmetic on the page: unlike the five caps above, it is DERIVED
//     from two constants plus the ladder rule, so it rots three ways instead of
//     one.
//
//     And do NOT "simplify" the app side by settling 403 permanent on the first
//     response to match 404/410. The verdict is SYNCED and has no user-facing
//     undo (per-link manual capture is still deferred — docs/link-extraction.md,
//     _deferred / open_), and this service leaves from a SHARED Workers IP pool,
//     where a 403 is frequently another tenant's reputation rather than a
//     decision about us. The failure modes are not symmetric: a wrong
//     `permanent` silently costs a user that link's preview on every device
//     forever, a wrong `failed` costs an operator eight requests over two days
//     and then settles itself. `Will retry` never gives up is also a property
//     three other surfaces state (docs/link-extraction.md, and retry.spec.ts's
//     `403 — the bot-wall ladder`), none of which would fail if you changed it.
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
//       The REQUEST COUNT moves with it, and is the half this list used to miss.
//       "It is a fetcher, not a crawler" prices a save at TWO requests to the
//       reader's server — one document fetch, plus one image fetch if the markup
//       names a preview image — and a second facet asked for later is another
//       fetch of a page you already answered for. The three nevers in that
//       paragraph survive — no link-following, no self-initiated second page, no
//       revisiting to see what changed, all still true, because the second fetch
//       is still one person's one save. The arithmetic beside them does not, so
//       re-read BOTH paragraphs of that section in the same change.
//
//       COUNT ONLY THE HOPS THAT REACH THE READER'S SERVER, which is what that
//       paragraph got wrong for a while: it added "one more again to relay that
//       image to their browser" to the same additive series, billing an operator
//       for a hop that never touches them — the relay is our Worker answering the
//       person's browser. It is usually not a separate request at all: an
//       interactive save sends `inlineImage`, so the extractor fetches the image
//       and returns the bytes in the SAME extract response (routes/extract.ts);
//       only a bulk import gets a URL string and makes the second POST /v1/fetch-image.
//       Two is the number either way, and the clause that used to do the
//       miscounting now spends itself on WHY the second one is ours — the
//       cross-origin wall — which is the question an operator actually has.
//
//       Do NOT tighten that into "never more than two". If the inline fetch is
//       attempted and fails, the client falls back to the proxy
//       (packages/web-react/src/lib/server-extraction.ts, `loadImage`), and the
//       live case is size: MAX_INLINE_IMAGE_BYTES is 2 MB against the proxy's
//       10 MB ceiling, so a larger preview image is pulled from the operator
//       twice. Narrow, but this page's own standard is that a published cap the
//       code exceeds is a false statement, not a stale doc.
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
//     TWO ABSOLUTES CAME OUT OF THE PROSE IN THE SAME PASS, both of them NEVERS
//     that had never been agreed to. "It is the only part of Bracemark that ever
//     visits another site" was false as written and in the reader's own terms: the
//     browser extension reads the tab it is on, and the mobile apps fetch the page
//     themselves, so Bracemark visits other sites constantly — just from the
//     person's device and their address, which is exactly the distinction an
//     operator cares about and the sentence was throwing away. It now says the only
//     SERVER of ours, which is the true claim and the more useful one. And "the
//     mobile apps … never involve us at all" was an eternal where a present tense
//     does the same work: `bracemark-expo` calls no server of ours TODAY, which is
//     a fact about the build this page reports on, not a promise about every build
//     after it (docs/link-extraction.md, _expo drains in the foreground_).
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
  ['Rate limit', 'per calling IP address · a counter, not a log'],
  ['JavaScript', 'not executed'],
  ['Runs on', 'Cloudflare Workers'],
];

// The invariants, not the behaviour — see the fourth rule above. Every entry here
// is a property of what this service IS, so none of them moves when the thing it
// extracts changes. If you find yourself wanting to add a row that begins "it only
// takes…", it belongs in FACTS.
//
// ⚠ THE IP CLAUSE IN `Write down the address you saved` IS LOAD-BEARING AND MUST
// NOT BE TIGHTENED BACK INTO AN ABSOLUTE. `middleware/rate-limit.ts` keys
// Cloudflare's native rate-limit binding on `{cf-connecting-ip}:{path}`, so it does
// hold the caller's address — for the 10 or 60 seconds of a counter window, never
// in a log line and never beside the URL. The workspace tripwire is explicit that
// /privacy and /extractor must both name it, and /privacy has all along ("Its rate
// limiter does record IP addresses"); this page, written for the operators owed the
// disclosure, was the one omitting it. The word `address` does double duty on this
// page — the URL a person saved, and the IP a request came from — which is exactly
// why the TERM itself now says which one it means — the heading above this list
// reads "What it never does", so a bare `Write down the address` is read as the
// never-claim and the body cannot walk it back. An anonymous endpoint
// that fetches any URL has to cap something per caller, so a reader who thinks
// about it for ten seconds derives the IP anyway: the closed version was
// falsifiable by its own audience.
const NEVER: [string, string][] = [
  [
    'Keep what it read',
    'Nothing is buffered to disk, cached, indexed, or stored. What it finds goes straight back to the device that asked and the bytes are gone — there is no copy of your page at our end to leak, subpoena, or change our mind about.',
  ],
  [
    'Write down the address you saved',
    'The whole reason this service is separate from the rest of Bracemark is that the URL it sees stays transient. Observability is counts, latency, and error rates — that address never reaches a log line. The one you connect FROM is a different thing and we do hold it, briefly: the rate limiter counts requests against it for a few seconds so that a single source can’t flood the service. It is never written down beside the URL, and the privacy policy inventories it.',
  ],
  [
    'Know who asked',
    'Requests carry no account and no session. It cannot tell you which user saved your page, because it was never told.',
  ],
  [
    'Come back for the rest of your site',
    'One request names one saved document. The fetcher has no queue of its own, never follows links it finds, and never schedules a revisit. It returns only when a person’s Bracemark client asks for a saved address again — for another pending link or a retry of an earlier attempt.',
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
      lede="That is the whole reason this fetcher knocked. A person asked it to look for a title and preview image in your document — and here is everything about it that an access log won’t tell you."
    >
      <div className={cn('space-y-14')}>
        {/* The string they searched for, given the weight /support gives its
            address: it is the one thing on the page the reader arrived holding. */}
        <section className={cn('rounded-2xl border border-signal-line bg-signal-soft/60 p-8')}>
          <p className={cn('eyebrow text-signal')}>The line in your log</p>
          <p
            className={cn(
              'mt-3 font-mono text-sm break-all text-signal-strong sm:text-base md:text-lg',
            )}
          >
            {USER_AGENT}
          </p>
          <p className={cn('mt-5 text-body text-muted-foreground')}>
            Bracemark is an end-to-end encrypted bookmark manager. When someone saves a link in the
            web app — or asks us to fill in ones they saved or imported earlier — the browser won’t
            let that page fetch yours, so this service fetches it instead: reads the title and the
            preview image, hands both back to the person’s own device, and forgets the address. It
            is the only server of ours that fetches a page at all: every other way of saving a link
            reads it on the person’s own device, from their own address.
          </p>
        </section>

        <section>
          <h2 className={cn('font-display text-2xl font-semibold tracking-tight')}>
            It is a fetcher, not a crawler
          </h2>
          <div className={cn('mt-4 space-y-4 text-base leading-7 text-muted-foreground')}>
            {/* "There is no queue" came out, and the sentence that replaced it is
                longer on purpose. The claim was written about the thing this
                section is really denying — that we go looking for pages — and a
                reader with an access log in front of them reads it as a promise
                about VOLUME, which we cannot make: a person who imports a library
                holds a backlog of links nothing has fetched, and draining it sends
                us their addresses in batches (docs/link-extraction.md, _imported
                links_). Two hundred saved pages of one site is two hundred requests
                to it, arriving together, and an operator who was told there is no
                queue would reasonably call that a crawl. One pass over two hundred
                saved pages is two hundred document requests, and transient failures
                can add retries. The paragraph below says it in the other voice
                instead — whose queue it is, and what decides its size — which costs
                us nothing, because every one of those addresses was still chosen by
                a person. This page's own rule applies: a behaviour promoted to a
                never is a promise nobody agreed to make. */}
            <p>
              There is no schedule and no index behind it. It never follows a link out of a page it
              fetched, never asks for a second page from your site on its own initiative, and never
              returns to see whether anything changed. Every address it asks for is one a person
              saved by hand or brought with them from another bookmark manager — nothing here
              discovers a page. One extraction attempt for one saved link makes one document request
              to you, plus one for a preview image if your document names one. A transient failure
              can be retried later. The person’s browser can’t read that image cross-origin any more
              than it could read your page — that’s why we need the second request.
            </p>
            <p>
              There is a backlog, though, and it is theirs rather than ours. Links saved before
              previews were turned on, and anything brought in by an import, sit unfetched until
              their owner asks for them — so a request can arrive long after the save, and several
              can arrive together: a drain hands us addresses in batches — the cap on one request is
              in the table below — and we fetch a batch in parallel. Someone importing two hundred
              of your pages means one request for each page, close together; transient failures may
              be retried later. What decides the initial batch is the size of one person’s library,
              not a crawl or index of ours.
            </p>
            {/* Deliberately NOT "once a title has come back it is never fetched
                again". That was a never about BEHAVIOUR on the one page whose
                own rule (above) is that a behaviour promoted to a never is a
                promise nobody agreed to make — and read-mode falsifies it: a
                link whose title already came back from a device tier, then
                queued for server read-mode, is a second fetch of a page you
                have already answered for. What survives read-mode is the
                property this page is actually built on — the person who asked
                KEEPS the answer, so the same person saving the same address
                again costs you nothing. Stated that way it is about the save,
                not the request count. Keep that subject: the agentless "an
                answer ... is kept" shipped for a stretch and reads as US
                keeping it, one section above a NEVER row whose whole point is
                that we keep nothing. */}
            <p>
              The person who asked keeps what comes back: it lives on their own devices from then
              on, encrypted, so saving the same address again doesn’t re-ask you for it.
            </p>
            <p>
              It also only runs for people who turned it on. Fetching on someone’s behalf means
              seeing an address they chose to save, so it is an opt-in setting that is off until
              they enable it — the browser extension and the mobile apps read the page on the device
              instead, with no server of ours in it. The full account of that is in the{' '}
              <Link
                className={cn(
                  'text-signal underline decoration-signal-line underline-offset-2 hover:decoration-signal',
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
          <p className={cn('mt-4 text-base leading-7 text-muted-foreground')}>
            Every one of these is a hard cap in the code rather than a target, and each applies to
            every hop of every request.
          </p>
          <dl className={cn('mt-6 border-t border-border')}>
            {FACTS.map(([term, detail]) => (
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
          <p className={cn('mt-6 text-base leading-7 text-muted-foreground')}>
            Because nothing on the page is executed, what it sees is the markup you served and
            nothing more: no stylesheet, script, or font is pulled in behind it, and a page that
            assembles its title in the browser yields nothing to find. The ceilings are ours as much
            as yours — this runs anonymously, so the caps are what keep it from being an open proxy
            pointed at your bandwidth. You can read every one of them, and the guard that re-checks
            each redirect before connecting to it, in{' '}
            <a
              className={cn(
                'text-signal underline decoration-signal-line underline-offset-2 hover:decoration-signal',
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
              <div key={term} className={cn('border-t border-border pt-5')}>
                <dt className={cn('text-base font-semibold')}>{term}</dt>
                <dd className={cn('mt-2 text-body text-muted-foreground')}>{detail}</dd>
              </div>
            ))}
          </dl>
        </section>

        <section>
          <h2 className={cn('font-display text-2xl font-semibold tracking-tight')}>
            It doesn’t read your robots.txt
          </h2>
          <div className={cn('mt-4 space-y-4 text-base leading-7 text-muted-foreground')}>
            <p>
              Said plainly, because this is the page where you came looking for it. A robots
              directive won’t stop this fetcher, and we would rather disclose that than let you
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
              That is an argument, and one we could lose. It rests entirely on the request being one
              person’s and on there being exactly one of them. If this service ever fetches on its
              own initiative, or at a volume that a single save can’t account for, the argument is
              gone and this section gets rewritten rather than defended. Blocking by user agent
              works either way, which is why that is documented below.
            </p>
          </div>
        </section>

        <section>
          <h2 className={cn('font-display text-2xl font-semibold tracking-tight')}>
            How to turn it away
          </h2>
          <div className={cn('mt-4 space-y-4 text-base leading-7 text-muted-foreground')}>
            <p>
              Match the user agent — every request carries{' '}
              <span className={cn('font-mono text-sm text-foreground')}>bracemark-extractor</span>{' '}
              in that header, and it is never spoofed as a browser — then answer with{' '}
              <span className={cn('font-mono text-sm text-foreground')}>403</span>.
            </p>
          </div>
          <div className={cn('mt-6 space-y-4')}>
            <div>
              <p className={cn('eyebrow')}>nginx</p>
              <pre
                className={cn(
                  'mt-2 overflow-x-auto rounded-xl border border-border bg-muted/50 p-4 font-mono text-xs leading-6',
                )}
              >
                <code>{'if ($http_user_agent ~* "bracemark-extractor") { return 403; }'}</code>
              </pre>
            </div>
            <div>
              <p className={cn('eyebrow')}>Cloudflare WAF</p>
              <pre
                className={cn(
                  'mt-2 overflow-x-auto rounded-xl border border-border bg-muted/50 p-4 font-mono text-xs leading-6',
                )}
              >
                <code>{'(http.user_agent contains "bracemark-extractor")  →  Block'}</code>
              </pre>
            </div>
          </div>
          <div className={cn('mt-6 space-y-4 text-base leading-7 text-muted-foreground')}>
            <p>
              <strong className={cn('font-semibold text-foreground')}>
                The status code you pick decides how long we keep trying.
              </strong>{' '}
              A <span className={cn('font-mono text-sm')}>403</span> is retried on a widening
              backoff and then abandoned for good. A{' '}
              <span className={cn('font-mono text-sm')}>404</span> or{' '}
              <span className={cn('font-mono text-sm')}>410</span> settles it immediately, first
              time. A <span className={cn('font-mono text-sm')}>429</span> or a{' '}
              <span className={cn('font-mono text-sm')}>5xx</span> reads as temporary, so it will
              come back — slowly, and at most once a day for that one link, but it will. The{' '}
              <span className={cn('font-mono text-sm')}>403</span> in the rule above ends it; send a{' '}
              <span className={cn('font-mono text-sm')}>410</span> instead if you would rather that
              happened on the first request than at the top of the ladder.
            </p>
            <p>
              <strong className={cn('font-semibold text-foreground')}>
                Don’t block it by address.
              </strong>{' '}
              It runs on Cloudflare Workers, so its requests leave from a shared pool that has
              nothing else to do with us, and banning those addresses costs you traffic you wanted
              while barely inconveniencing this.
            </p>
            <p>
              What blocking does to the person who saved the link: they get your hostname as the
              title and no preview image. The link still works, they aren’t told why, and nothing
              else about your site is affected.
            </p>
          </div>
        </section>

        {/* No signup CTA closes this page. The reader is not a prospect, and an
            "or you could try Bracemark!" band under a blocking guide would read
            as exactly the kind of bot that ignores robots.txt. */}
        <section className={cn('rounded-2xl border border-border p-8')}>
          <h2 className={cn('font-display text-xl font-semibold tracking-tight')}>
            If it misbehaved
          </h2>
          <p className={cn('mt-3 text-body text-muted-foreground')}>
            Write to <MailLink address={ABUSE_EMAIL} variant="specimen" />. If it arrived more often
            than this page says it can, exceeded one of the caps above, or reached something it had
            no business reaching, that is a bug and we want it. The user-agent line, a few
            timestamps, and the paths are enough to find it at our end. A person reads that address,
            not an auto-responder.
          </p>
        </section>
      </div>
    </PageShell>
  );
}
