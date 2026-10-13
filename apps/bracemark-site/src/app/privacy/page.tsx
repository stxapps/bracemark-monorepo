import type { Metadata } from 'next';
import Link from 'next/link';

import { PLAN_LABELS, SESSION_RETENTION } from '@stxapps/shared';
import { cn } from '@stxapps/web-ui/lib/utils';

import { PageShell } from '../../components/page-shell';
import {
  BACKUP_RETENTION_DAYS,
  COMPANY,
  PRIVACY_UPDATED,
  SOURCE,
  SUPPORT_EMAIL,
} from '../../lib/site';

export const metadata: Metadata = {
  title: 'Privacy Policy',
  description: 'What Bracemark stores, what it cannot read, and what it never collects.',
};

// Every store requires a reachable privacy-policy URL, so this route must carry
// real content before submission.
//
// The substance was already decided and written down, and this page is a faithful
// reading of it rather than a template:
//   - the api never sees your library in plaintext — it holds the ciphertext, the
//     account row and the wrapped keys, and nothing readable from a link
//     (docs/local-first-sync.md, docs/account.md). Deliberately not "only ever sees
//     ciphertext": that shorthand is false of a Worker that also serves auth and
//     billing, and the paragraphs below are the surface where the difference shows;
//   - bracemark-extractor is the ONE component that fetches user URLs. It holds no
//     key, persists nothing, and its rate limiter logs IP addresses but never URLs
//     (docs/link-extraction.md). What that service RETURNS is a fact that moves and
//     the promise beside it is not: server-tier extraction is `titleImage` today
//     and `readMode` is already in the planned response shape, so the em-dash
//     clause in that paragraph ("the title and the preview image") is an
//     enumeration to extend when read-mode ships, while "keeps nothing" and the
//     three clauses after it are invariants that must not move. /extractor's
//     header comment keeps the same split and the same change-list;
//   - subscription rows come from the payment providers, never from card data we
//     hold, because we never hold any (docs/iap.md). The paragraph admitting that
//     paying deanonymizes is traceable the same way, to that doc's _privacy note_:
//     it is only true that the cost stops at anonymity while bracemark-api keeps
//     the binding to `userId ↔ subscription id ↔ ctm_…` and nothing more. Widening
//     that row falsifies this page.
//   - the third-party-script claim is a claim about TWO properties and they differ:
//     this site loads nothing (fonts are self-hosted by next/font at build time),
//     while bracemark-web loads Paddle.js — lazily, on Settings → Subscription —
//     and that is the only one, since the Google favicon call was replaced by the
//     extractor's image proxy (bracemark-web `lib/paddle.ts`,
//     `links/_layouts/shared/link-media.tsx`). Adding any script to either
//     property falsifies this page. The same sentence is in the FAQ
//     (`content/faq.tsx`, _trackers_); the two move together. WHEN it loads is
//     part of the claim too, and it has moved once already: the section now looks
//     up the buyer's local price on mount (Paddle.PricePreview), so the script
//     arrives with the screen rather than with the checkout. Narrowing that back
//     — or widening it to another screen — falsifies the paragraph below.
//     THE COOKIE HALF SPANS BOTH PROPERTIES TOO, and it was the half left unsaid:
//     neither property sets a cookie of ours — nothing in bracemark-web or
//     bracemark-api touches `document.cookie` or `Set-Cookie`, the session being a
//     local-storage row — so Paddle's are the only cookies in Bracemark, on that
//     one screen. Saying it only of the website left the app's paragraph admitting
//     Paddle's cookies with no way to tell whether they were the first of ours or
//     the only ones anywhere. If a cookie is ever set on either property, this is
//     the sentence that falsifies first.
//     THE PUBLISHED SENTENCES NOW STATE ALL OF THIS AS ONE ENTITY — "Bracemark",
//     not this-website-then-the-app — and the per-property fact above is kept here
//     because it is what makes the published form true, not because a reader is
//     given it. Nobody arrives knowing app.bracemark.com is a second origin, so
//     the split made them hold two subjects and count separately, and the count
//     then read as a retraction of the absolute before it ("no third-party
//     scripts… one script"). The one-entity form is also the stronger claim. What
//     it costs: docs/iap.md (_currency_) and the /pricing note justify the
//     dollars-only marketing site by citing THIS claim, and the constraint now
//     hangs on the SCREEN rather than on the property — loading Paddle.js on
//     /pricing would make a second place the exception, which is still falsified,
//     but the sentence no longer says "this site loads none" for them to quote.
//
//   - BACKUPS ARE A 30-DAY WINDOW, and the window is a number in code on our side
//     and a platform fact on Cloudflare's. D1 Time Travel and SQLite-backed DO
//     point-in-time recovery are 30 days, and our own off-Cloudflare copies are
//     pruned from the same number. Every "30 days" below is
//     `BACKUP_RETENTION_DAYS` (lib/site.ts), and "held by us" under _Where your
//     data is_ is that copy. /delete-account says the same thing twice and moves
//     with it (docs/server-backups.md, _Retention is a public promise_).
//     "HELD BY US, NOT BY A PROVIDER" IS TRUE ONLY WHILE IT IS. It answers the
//     reader who notices the copy is missing from the provider list above. The
//     day a provider holds a backup (docs/server-backups.md, _later_), it goes on
//     that list, its lifecycle rules have to fit inside the window, and this
//     sentence is rewritten rather than left to read as if nothing changed.
//     "NOTHING COULD OPEN THE DATA" WAITS FOR THE WINDOW. Until the backup
//     copies of the key blobs expire, a user's password still opens the backup
//     copies of their files. The sentence was true the moment deletion ran,
//     until backups existed, and now only holds once they have expired.
//     "Daily" is deliberately absent: a run is skipped while the backup machine
//     is off, and the reader is promised the window, not the cadence.
//
//   - THE NOTICE CHANNEL IS THIS WEBSITE, and only this website. The paragraph
//     under _Changes to this policy_ used to promise we would highlight a material
//     change "in the app" — a delivery mechanism neither client has: there is no
//     announcement surface, no what's-new pane and no banner slot in bracemark-web
//     or bracemark-expo, so the promise had nothing behind it and nothing would
//     have failed if it stayed. /terms carried the same promise in three places
//     and lost it in the same change. If an in-app notice ever ships, these are
//     the sentences that may widen again — not before.
//
// The rule this page follows: describe what the system does, not what we intend.
// If a claim here is ever falsified by a change to the code, the change is wrong
// or this page is — either way it is a release blocker, which is why each claim
// is traceable to a doc above.
export default function Page() {
  return (
    <PageShell
      eyebrow="Legal"
      title="Privacy Policy"
      // "and nothing else" was falsified by this page's own table of contents:
      // a subscription record, request data including an IP address, and any
      // support mail you send us are all inventoried below it. A lede that closes
      // a list the document then reopens costs more than the fields it was
      // hiding — the reader disproves it without leaving the page, and then
      // reads the rest looking for the next one. It now ENDS BY OPENING: the two
      // things worth saying in a sentence, and a pointer down the page for the
      // remainder, which is the move `Our blindness` on the landing page already
      // makes ("The privacy policy inventories every field of it"). This is the
      // surface that pointer points AT, so it is the one place on the property
      // that must never claim to be shorter than it is.
      lede="We hold encrypted files we cannot open, and an account record: your username, the public key your sign-ins are checked against, the encrypted copies of your key, and a session for each signed-in device. Everything else — a subscription record if you buy one, the request data any web service processes, an email you send us — is inventoried below."
      meta={`Effective ${PRIVACY_UPDATED}`}
      width="document"
    >
      <div className={cn('legal-prose')}>
        <p>
          This policy explains what {COMPANY.legalName} (“{COMPANY.shortName}”, “we”, “us”) collects
          when you use Bracemark, why, and what happens to it. It covers bracemark.com,
          app.bracemark.com, the Bracemark applications for iOS, Android, Chrome, and Firefox, and
          the services behind them.
        </p>
        <p>
          {COMPANY.legalName} is the <strong>controller</strong> of the personal data described here
          — the company that decides what is collected and why. We are a Thai company serving people
          all over the world, so this policy is written to satisfy Thailand’s Personal Data
          Protection Act, the EU and UK GDPR, and the privacy laws of the US states, whichever
          applies to you. The last few sections say what each of those adds.
        </p>

        <h2>The short version</h2>
        <ul>
          <li>
            We cannot read your saved links. They are encrypted on your device with a key your
            password unlocks, and the password never reaches us.
          </li>
          <li>
            We do not ask for your email address, and there is no advertising, no analytics product,
            no tracker, and no data sold or shared for marketing.
          </li>
          <li>We make money one way: the optional subscription.</li>
          {/* NOT "delete everything", which this page disproves twice below it —
              a deleted username is retired rather than released (the last line
              of _How long we keep it_) and the subscription record outlives the
              account for as long as tax law says. Same failure as the lede's
              old "and nothing else": an absolute the reader disproves without
              leaving the document, in a summary bullet where it buys nothing,
              since the two actions named plainly are what the reader came for.
              So it does what the lede does — states the pair, then points at the
              section carrying the residual. */}
          <li>
            You can export your library, and delete it — or the whole account — from inside the app.
            What outlives a deletion is listed under <em>How long we keep it</em>.
          </li>
        </ul>

        <h2>What we collect</h2>

        <h3>Your account</h3>
        <p>
          Creating an account stores three things: the <strong>username</strong> you chose, a{' '}
          <strong>public key</strong> used to verify that a sign-in request really comes from you,
          and one <strong>encrypted key blob</strong> for each way you can open the account (your
          password, and a recovery code if you made one). The blobs are locked with a key derived
          from your password or recovery code on your device — they are useless to us and to anyone
          who obtains them.
        </p>
        {/* The second sentence used to end "we hold nothing that identifies you as
            a person", which the Technical and security data heading two sections
            down disproves in its first line: our infrastructure processes your IP
            address and user agent, as any web service must. An absolute a reader
            can disprove without leaving the document is the most expensive kind —
            it converts a page whose whole standing is precision into one that
            overstates when it thinks nobody is checking, and the field it was
            hiding was never worth that.

            The repair is to SCOPE the claim to the thing it is actually true of —
            the account record, which really does hold no name — and then to hand
            the reader the residual and where it is described, rather than waiting
            to be caught with it. The clause that survives ("we do not join it to
            your account") is the one that carries the meaning a reader wanted from
            the absolute, and unlike the absolute it is true.

            ⚠ IT IS TRUE OF THE LOG LINES TOO, AND THAT HALF IS HELD UP BY CODE.
            For a stretch three pre-auth lookups were GETs with the username in
            the query string, so Cloudflare's log entry for one of them held a
            username beside an IP with nobody joining anything — and this clause
            was false of exactly those requests. They are POSTs now. What keeps
            it that way is described under _Technical and security data_ below
            and in docs/api-contracts.md, _a GET's query string reaches the
            request log_.

            ONE RESIDUAL, AND IT IS STATED RATHER THAN COVERED BY THIS CLAUSE:
            the api's own error lines write an opaque account or purchase id
            into that same log. "Do not join" is what we do with the data, not
            a description of every line in it, so the paragraph about the api's
            log says those lines exist. */}
        <p>
          We do not collect an email address, a phone number, a name, or any other identifier when
          you create an account. If you never write to us and never subscribe, the account itself
          holds nothing that names you — what remains is the ordinary request data described under{' '}
          <em>Technical and security data</em> below, which we do not join to your account.
        </p>
        <p>
          Signing in creates a <strong>session record</strong> — a hashed token, the account it
          belongs to, and timestamps — so your device stays signed in and you can sign other devices
          out.
        </p>

        <h3>Your library</h3>
        <p>
          Each saved link, list, tag, and setting is stored as its own{' '}
          <strong>encrypted file</strong>. For each one we hold the file’s path, its size in bytes,
          and when it last changed — the minimum needed to sync your devices. We hold no titles, no
          web addresses, no tags, no notes, and no index over any of it, because none of that exists
          in a readable form on our side.
        </p>

        <h3>If you subscribe</h3>
        <p>
          Payments are processed by <strong>Paddle</strong> for web purchases and by{' '}
          <strong>Apple</strong> or <strong>Google</strong> for purchases made inside the apps. They
          collect and hold your payment details under their own privacy policies; we never receive
          or store your card number.
        </p>
        <p>
          What we store is a <strong>subscription record</strong>: the provider, that provider’s
          identifier for your subscription and customer, the plan, its status, and the dates it runs
          between. It is linked to your account so the app knows which features to unlock.
        </p>
        <p>
          Subscribing is the one thing in Bracemark that attaches a real identity to you, and we
          would rather state it than let you find it at checkout. Charging a card requires a name,
          an email address, and payment details, which the provider collects and holds; the record
          above is the link between that customer and your account. It costs you anonymity, not
          confidentiality — your library is encrypted exactly as before, so we can tell that an
          account pays and still cannot read anything in it. The free plan requires no payment, so
          none of this arises.
        </p>

        <h3>Technical and security data</h3>
        <p>
          Our infrastructure processes ordinary request data — including your{' '}
          <strong>IP address</strong>, the time of the request and your user agent — as any web
          service must in order to answer it. We use it to keep the service running and to apply
          rate limits against abuse, and we do not use it to build a profile of you or to track you
          between visits.
        </p>
        {/* WHAT WE CONFIGURE, NOT HOW LONG THEY KEEP IT. A compliance reader asked
            for a log-retention period and the tempting answer is a number. A
            number is the one thing that must not go here: the windows belong to
            Cloudflare and AWS, differ per product, and move without telling us, so
            a figure published on this page would be a commitment that goes false
            on someone else's release schedule — silently, with no lint error, type
            error or test that could notice. "The short window our providers keep
            them" (the retention list further down) is vague and stays TRUE, which
            on this page is the better trade.

            The facts that ARE ours are better than a number anyway, and they were
            sitting in the repository unpublished: Logpush is deliberately off on
            both Workers (it would ship the request line off Cloudflare into
            third-party storage), and bracemark-extractor additionally runs with
            `invocation_logs: false`. Its request line WAS the one place a saved
            address would appear, which is where that setting came from and what
            the sentence used to give as its reason ("because that line is where
            the address would appear"). It no longer is — both of its endpoints
            are POSTs and the address is in the body — so the reason clause is
            gone and the setting is stated bare: the log is off, which is ours
            to keep true, where "a body is not logged" would be Cloudflare's.
            Both settings are in the two Workers' wrangler.jsonc
            files with the reasoning written out, so this paragraph cites a
            configuration a reader can open rather than an adjective they have to
            accept. (A glob for those two paths is exactly the thing that cannot be
            written in a JSX block comment: the star-slash closes it and the build
            fails on the prose underneath.)

            ⚠ SCOPE IT TO OUR SETTINGS AND STOP. "Two of those settings are ours"
            deliberately does not say they are the only logging controls that
            exist: zone-level Logpush is a third channel, configured in a
            Cloudflare dashboard rather than in this repo, and the extractor's own
            comment says plainly that nothing here can assert it is off. A widened
            claim — "we do no request logging anywhere" — would be the same
            enumeration-that-closes failure the privacy claims were rewritten to
            avoid, one level down in the stack.

            The forwarding sentence shipped wider than that for a stretch, in two
            ways. It read "do not forward… so there is no copy of that stream",
            which is an OUTCOME, and the outcome is exactly what the zone-level
            channel could falsify from a dashboard; it now says what the setting
            is and what switching it on would do. And it called the destination
            "a third party's storage under a retention period of its own" one
            paragraph after naming Cloudflare as the holder of these logs under
            its own retention — a description of the thing the reader had just
            been told exists. "Someone else's" is the party that is not already
            in the sentence.

            If either setting changes, this paragraph and /security move with it. */}
        <p>
          That data lives in <strong>Cloudflare</strong>’s and <strong>Amazon Web Services</strong>’
          own logs, under their retention periods rather than any we set, and we read it to diagnose
          a fault or an attack. We run no analytics over it, we do not join it to your account, and
          we keep no separate copy of our own.
        </p>
        <p>
          Two of the choices that decide what reaches those logs are ours rather than theirs, and we
          have made both the same way. Neither of the two services we run on Cloudflare is set to
          forward its request log to another destination, which would put a copy of that stream in
          someone else’s storage under a retention period of its own. And one of the two, the
          link-preview service — the one part of Bracemark that is ever handed the address of a page
          you saved — runs with the log that would record its request line switched off. Both are
          settings in the configuration files in{' '}
          <a href={SOURCE.url} rel="noreferrer">
            {SOURCE.label}
          </a>
          , with the reasoning written out beside them.
        </p>
        {/* THE OTHER WORKER'S LOG IS ON, AND THE PARAGRAPH ABOVE MAKES A READER
            ASK. Saying the extractor's request-line log is off and stopping there
            leaves bracemark-api's to be assumed off too — and it is on
            (apps/bracemark-api/wrangler.jsonc, `observability`), with a reader
            one click from the file that says so.

            What an entry holds was read back from the stored log of both
            deployed tiers on 2026-10-13, not inferred from the config: the whole
            request URL, query string included, beside the client IP. So the
            claim is about ADDRESSES, which are ours, and it is a rule the code
            keeps: nothing a person chose rides in a URL. The lookups that name an
            account are POSTs for exactly this sentence (they were GETs with
            `?username=` until that read found them), and
            packages/shared/src/api/query-inventory.spec.ts fails on any new GET
            field until someone has decided it is not one.

            It claims NOTHING about what Cloudflare leaves out — not that a body
            is unlogged, not that the bearer token reads back masked. Both were
            true when read and both are their behaviour on their release
            schedule, the same reason no retention number is on this page. "In
            the body of the request" says where WE put the username and stops.

            ⚠ ORDER OF DEPLOY. This is true of a tier once its api and every
            client calling it carry the POST lookups, and of its stored log about
            a week after that. Publish this page after them, not before.
            docs/api-contracts.md, _a GET's query string reaches the request
            log_.

            THE LAST TWO SENTENCES ARE THE LINES WE WRITE OURSELVES. The same
            log stores the api's `console.*` output, and some of its error lines
            interpolate a user id or a provider's purchase id
            (`services/iap.ts`, `services/account.ts`). An id we mint is not a
            username, so nothing above is false of them — but "we do not join it
            to your account" two paragraphs up invites a reader to assume no
            line in that log names an account at all, and a reader with the
            source open can find the ones that do. "Some of those lines" is
            deliberately not a closed list: the unexpected-error handler prints
            the error whole (`lib/errors.ts`), and its message is not ours to
            enumerate. */}
        <p>
          Our API — the service behind sign-in, sync, and billing — runs with that log on, so the
          address of every request it receives is recorded alongside the request data above. None of
          those addresses contains your username. A request that has to name an account — checking
          whether a username is free, or the first step of signing in — sends the username in the
          body of the request instead, and once you’re signed in a request identifies you with a
          session token. When something fails, the API also writes a line to that log saying what
          went wrong, and some of those lines include our internal identifier for the account, or
          the payment provider’s identifier for the subscription involved — not your username. We
          read them to find the fault.
        </p>
        {/* THE THIRD ADDRESS, AND THE ONE THAT IS NOT A WORKER'S. Everything
            above is about what a request to Cloudflare carries. The web app's
            own page URL goes to AWS, and it is the single source of truth for
            a search: a plain search word is a param value (docs/search.md,
            _the query is the URL_). A page load asks the network first
            (docs/offline-mode.md, _what answers a navigation_), so loading a
            results URL hands the CDN those words as part of the request.

            THE CLAIM IS "WE KEEP NO COPY", NEVER "IT DOES NOT LEAVE". The CDN
            terminates the connection, so it sees the address — the same reason
            the paragraphs above never say Cloudflare cannot see a request body.
            The landing page's trade row said "no search you type leaves it" for
            a stretch and was false of exactly this request; it now makes the
            hold-claim instead (`app/page.tsx`, TRADE).

            ⚠ "NO COPY" IS A SETTING OUTSIDE THIS REPO. It holds while request
            logging stays off on the distributions and their buckets, which is
            AWS configuration that no file here declares and no test can read.
            docs/hosting.md, _request logging on the static hosts_, has what was
            read back, when, and the two channels that read could not reach.

            Scoped to the web app on purpose: on expo the "URL" is route params
            that never become a request (docs/search.md). */}
        <p>
          The web app’s own address can carry something you typed. A search is kept in that address,
          so that it survives a reload and the back button, and loading it sends the words you
          searched for to <strong>Amazon Web Services</strong>, the provider that serves the app’s
          files, as part of the request data above. We keep no copy of them, and the search itself
          runs on your device.
        </p>

        <h3>What Apple and Google tell us</h3>
        <p>
          As the publisher of the mobile apps we can see the figures Apple and Google compile for
          us: installs, which versions are in use, and the crash and performance reports their
          operating systems collect. They arrive as counts and anonymous reports — they carry no
          account, and we cannot connect one to a person. Neither app ships an analytics or
          crash-reporting library of ours.
        </p>

        <h3>How link previews are fetched</h3>
        <p>
          The browser extension reads the live tab and tries to fill in its title and preview image
          every time you save. The mobile apps fetch pages themselves: by default they cover links
          saved on that device, and the All links setting also covers links synced from another
          device or added by import as they come into view. With All links selected, Generate all
          works through every pending link. Neither path involves our servers. The browser extension
          asks for the narrowest permission that does its job: it can read a tab only in the moment
          you click to save it, and it holds no standing access to your browsing. Its background
          service talks only to our API; during the save, code in that tab may fetch the preview
          image named by the page.
        </p>
        <p>
          Browsers do not allow one web page to fetch another site, so the web app has an{' '}
          <strong>opt-in {PLAN_LABELS.plus} setting</strong> that lets our extraction service do it.
          It is off unless you turn it on. When it is on, newly saved links and older pending links
          are sent as they come into view while you browse; Generate all sends every pending link.
          The service receives the address, fetches the page, returns the title and preview image,
          and keeps no page data: it stores no URLs, writes none to its logs, holds no key, and is
          not told which account asked. Its rate limiter briefly holds the requesting IP address so
          that a single source cannot abuse it. The same service is described from the other side —
          for the people who run the sites it fetches — on{' '}
          <Link href="/extractor">its own page</Link>, including the caps it holds itself to and how
          to turn it away.
        </p>

        <h3>If you contact us</h3>
        {/* SUPPORT MAIL HAS TWO USES, AND THE SECOND IS BOUNDED BY WHAT WE KEEP.
            This paragraph used to end "we use it only to help you", which a help
            page written from a recurring question falsifies. The second use is
            stated by what survives it — the question in our words, never who asked
            or what they wrote verbatim — because that is the part a reader can hold
            us to. "Never publish or quote without asking" rules out a testimonial
            lifted from a support thread; it does not rule out a help page, which
            is the reason the paraphrase is kept. */}
        <p>
          When you email support we receive your message, your email address, and whatever you
          choose to put in it. We keep the correspondence so we can follow up. We use it to answer
          you, and to learn what is unclear or broken: a question more than one person asks becomes
          a help page or a fix.
        </p>
        <p>
          What we keep for that second use is the question in our own words — not your name, your
          email address, your username, or what you wrote word for word. We never publish your
          message or quote you without asking first.
        </p>
        {/* NO VENDOR IS NAMED, here or in the provider list. Which company runs the
            model can change without anything a reader relies on changing, so the
            published fact is the ROLE — a provider processing on our behalf — and
            the one promise that holds whichever it is: a person writes or approves
            every reply. Naming a vendor would make a routine switch a policy
            change. */}
        <p>
          An AI model may help us read support email and draft replies. The company that runs the
          model processes your message on our behalf, as our other providers do. A person at
          Bracemark reads every message and writes or approves every reply we send.
        </p>
        <p>
          Your library can hold whatever you want it to, and we cannot see it — that is the point. A
          support email is different: it reaches our mailbox, and any model that helps us answer it,
          in readable form. Please leave out anything you would rather we did not hold. And never
          send us your password or your recovery code: nobody at Bracemark will ever ask you for
          either, and either one would open your library.
        </p>

        <h2>Cookies and on-device storage</h2>
        <p>
          Bracemark sets <strong>no cookies</strong> of its own, and loads no third-party code
          except in one place, described below; the fonts come from us rather than from a font
          provider. There is no cookie banner on this website because there is nothing to ask you
          about — we set nothing that needs your consent.
        </p>
        <p>
          That one place: opening Settings → Subscription loads <strong>Paddle</strong>’s script, so
          it can look up the price in your local currency, and again to run the checkout if you go
          on to subscribe. Paddle sets its own cookies to do that, under its privacy policy — they
          are the only cookies you will get from Bracemark. Nothing else in Bracemark loads code
          from another origin.
        </p>
        <p>
          The app stores data in your browser or device — your library, your session, and your
          preferences — using local storage and IndexedDB. That is what makes it work offline. It
          stays on your device, is not readable by us, and is cleared when you sign out or clear
          your browser data.
        </p>

        <h2>How we use what we collect</h2>
        <ul>
          <li>
            To provide the service: authenticate you, sync your encrypted files, unlock the plan you
            paid for.
          </li>
          <li>To keep it running and safe: diagnose faults, prevent abuse, enforce rate limits.</li>
          <li>
            To answer you when you write to us, and to turn the questions people ask into help pages
            and fixes — keeping the question, not who asked it.
          </li>
          <li>To meet legal, tax, and accounting obligations.</li>
        </ul>
        <p>
          We do not use your information for advertising, we do not sell or rent it, and we do not
          share it for anyone else’s marketing. There is no automated decision-making that produces
          legal effects for you.
        </p>

        <h2>Our legal bases</h2>
        <p>
          Where the GDPR, the UK GDPR, or Thailand’s PDPA applies, we have to name the legal basis
          for each use rather than just describe it. Ours are:
        </p>
        <ul>
          <li>
            <strong>Performing our contract with you</strong> — the account record, the session that
            keeps you signed in, the encrypted files we sync between your devices, and the
            subscription record that unlocks what you paid for.
          </li>
          <li>
            <strong>Our legitimate interests</strong> — keeping the service up and abuse off it:
            answering requests, applying rate limits, diagnosing faults. The interest is running a
            service that works; the data involved is what any web server handles to reply at all.
            The same interest covers working out, from the questions people send us, which parts of
            Bracemark need fixing or explaining better.
          </li>
          <li>
            <strong>Your consent</strong> — the one optional thing, the {PLAN_LABELS.plus} setting
            that lets our extraction service fetch a page for you. It is off until you turn it on,
            and turning it off again withdraws that consent for everything after.
          </li>
          <li>
            <strong>A legal obligation</strong> — the payment and tax records that accounting law
            requires us to keep.
          </li>
        </ul>

        <h2>Who else processes it</h2>
        <p>
          We use a small number of providers to run the service. They act on our instructions and
          receive only what their function requires.
        </p>
        <ul>
          {/* The link-preview service is named here because this list is where
              a reader checks who RECEIVES something, and with the opt-in on
              Cloudflare is handed a saved address in readable form — the one
              thing it sees that it does not also store. _How link previews are
              fetched_ calls it "our extraction service", which is true and does
              not say whose machines it runs on. Two sentences, not one with a
              comma before "and": two predicates are a pair (docs/brand-assets.md,
              _the mechanics_). */}
          <li>
            <strong>Cloudflare</strong> — hosts the API and the link-preview service. It stores the
            encrypted files and the account records.
          </li>
          <li>
            <strong>Amazon Web Services</strong> — serves this website and the web app as static
            files.
          </li>
          <li>
            <strong>Paddle</strong> — sells and processes web subscriptions as merchant of record,
            including tax.
          </li>
          <li>
            <strong>Apple</strong> and <strong>Google</strong> — distribute the mobile apps and
            process any subscription bought inside them.
          </li>
          <li>
            <strong>Namecheap (Private Email)</strong> — hosts the mailbox that receives your
            support email.
          </li>
          <li>
            <strong>An AI model provider</strong> — runs the model that helps us read support email
            and draft replies to it.
          </li>
        </ul>
        <p>
          Beyond these, we disclose information only where we are legally required to — in response
          to a valid legal request — or where it is necessary to protect our rights or someone’s
          safety. What we can disclose is bounded by what we hold: encrypted files we cannot
          decrypt, and the account record described above. If we are ever part of a merger or sale
          of assets, this policy travels with the data and you will be told before it moves.
        </p>

        <h2>Where your data is</h2>
        <p>
          We are established in Thailand and the providers above operate globally, so your encrypted
          files and account records are stored and processed in countries other than the one you
          live in, including the United States. Which countries depends on which provider, and what
          each of them holds is the line beside its name above. The backup copies we keep outside
          Cloudflare are held by us, not by a provider.
        </p>

        <h2>How long we keep it</h2>
        <ul>
          <li>
            <strong>Your account and library</strong> — until you delete them. Deleting all data
            wipes the stored files; deleting your account also destroys the encrypted key blobs, and
            their backup copies follow within {BACKUP_RETENTION_DAYS} days. After that, nothing
            could open the data even if a copy survived.
          </li>
          <li>
            <strong>Backups</strong> — up to {BACKUP_RETENTION_DAYS} days. Cloudflare keeps a
            rolling history of our databases, and we keep our own encrypted copies of your files and
            account records outside Cloudflare. Neither reaches back further than that, so anything
            you delete is gone from both within the same window.
          </li>
          <li>
            <strong>Sessions</strong> — while the device stays signed in, then for{' '}
            {SESSION_RETENTION.label}
            after it is signed out or its session expires, so a device that connects late can still
            be told whether to erase its copy.
          </li>
          <li>
            <strong>Subscription records</strong> — for as long as the subscription is live, and
            afterwards for as long as tax and accounting law requires.
          </li>
          <li>
            <strong>Support email</strong> — until it is no longer useful for supporting you. The
            questions we paraphrase from it for help pages and fixes carry no name, email address,
            or username, and we keep those.
          </li>
          <li>
            <strong>Infrastructure logs</strong> — for the short window our providers keep them,
            after which they age out on their side. We keep no copy.
          </li>
          <li>
            <strong>Abandoned accounts</strong> — we reserve the right to delete data for an account
            unused for two or more years, rather than hold it indefinitely.
          </li>
        </ul>
        <p>
          Deleted usernames are retired rather than released, so nobody can register a name and be
          mistaken for its previous owner.
        </p>

        <h2>Your rights</h2>
        <p>
          Depending on where you live, you may have rights to access, correct, delete, restrict, or
          port your personal data, and to object to processing. Most of them you can exercise
          yourself, immediately, without asking us:
        </p>
        <ul>
          {/* The lock clause is here because this bullet answers a RIGHT rather
              than describing a feature: the export policy excludes a locked
              list with everything under it (`export-all-data.ts`, POLICY), and
              a portability answer that quietly drops the user's own hidden
              content is the one place that omission costs something. The
              exclusion is stated in full once, in /faq `import-export`; this is
              the deliberate second copy and the only one. */}
          <li>
            <strong>Access and portability</strong> — Settings → Data → Export all data, which gives
            you your whole library in open formats. A list you have locked is left out of the file
            until you unlock it.
          </li>
          <li>
            <strong>Correction</strong> — edit anything in the app; it is your data on your device.
          </li>
          <li>
            <strong>Erasure</strong> — Settings → Data deletes your library; Settings → Account
            deletes the account itself.
          </li>
          <li>
            <strong>Withdrawing consent</strong> — the only thing you consented to is server
            previews, and Settings → Link previews switches them back off.
          </li>
        </ul>
        <p>
          For anything else — restricting or objecting to a use, asking us to reconsider a refusal,
          or complaining about how we have handled your data — write to{' '}
          <a href={`mailto:${SUPPORT_EMAIL}`}>{SUPPORT_EMAIL}</a>. You also have the right to
          complain to your local data protection authority. Note that we cannot help you reach the
          contents of your library: we have no key, so that is a request only you can fulfil.
        </p>
        <p>
          One consequence of collecting nothing: we have no email address or identity document to
          check a request against, so <strong>your account is the proof</strong>. Signing in and
          using Settings answers an access or erasure request immediately and more completely than
          we could. If you write to us instead, we may have to ask you to prove control of the
          account before we act, and we will say so rather than act on a name alone.
        </p>

        <h2>If you are in the EEA or the UK</h2>
        <p>
          {COMPANY.legalName} is the controller, and the legal bases we rely on are listed above.
          Beyond the rights already described, you may ask us to restrict a use, object to any use
          we base on a legitimate interest, and withdraw a consent you have given — withdrawing it
          does not undo what was done while it stood. We make no decisions about you by automated
          means.
        </p>
        <p>
          Your data does leave Europe — see <em>Where your data is</em> above. Where a transfer out
          of the EEA or the UK needs a safeguard, our providers rely on the European Commission’s
          standard contractual clauses, the UK addendum to them, or an equivalent mechanism. You can
          complain to the data protection authority where you live — in the UK, the Information
          Commissioner’s Office — though we would rather you wrote to us first.
        </p>

        <h2>If you are in Thailand</h2>
        <p>
          We are a Thai company, so the Personal Data Protection Act applies to us directly. It
          gives you rights of access, correction, erasure, restriction, portability, objection, and
          withdrawal of consent — the same set described above, exercised the same way. If we have
          not put something right, you can complain to the Office of the Personal Data Protection
          Committee.
        </p>

        <h2>If you are in the United States</h2>
        <p>
          Several states give their residents privacy rights, and the three practices those laws are
          most concerned with simply do not happen here.{' '}
          <strong>
            We do not sell your personal information, we do not share it for cross-context
            behavioural advertising, and we do not profile you
          </strong>{' '}
          — not for advertising, and not for any decision that affects you. That has been true for
          every one of the last twelve months, and there is no revenue model here that would make it
          stop being true.
        </p>
        <p>
          Where your state grants them, you have the right to know what we hold, to receive a copy,
          to correct it, to delete it, and to appeal if we refuse. Ask at{' '}
          <a href={`mailto:${SUPPORT_EMAIL}`}>{SUPPORT_EMAIL}</a>, or use the in-app tools above,
          which are faster. Exercising a right never costs you service, features, or a worse price.
        </p>
        <p>
          Some browsers send a Do Not Track or Global Privacy Control signal. There is nothing here
          for one to switch off — no tracking, no sale, no sharing — so we treat any such signal as
          already satisfied. California residents may also ask, under the Shine the Light law, what
          personal information we disclosed to third parties for those parties’ own direct
          marketing: the answer is none, and it is none every year.
        </p>

        <h2>Security</h2>
        <p>
          Your library is encrypted on your device with AES-256-GCM, under a random key that your
          password unlocks via Argon2id; connections use TLS; and the keys that open your account
          are stored only in a form that your password or recovery code can unlock. No system is
          perfectly secure, and we do not claim otherwise — but the design limits what a breach of
          ours could reveal: your library would be ciphertext, and the account around it holds no
          name, email address, or payment details. Email you send to support is the exception, and{' '}
          <em>If you contact us</em> above says what it holds.
        </p>
        <p>
          The code behind all of this is public, at{' '}
          <a href={SOURCE.url} rel="noreferrer">
            {SOURCE.label}
          </a>{' '}
          under the {SOURCE.license} — so the claims on this page can be read against the software
          that makes them, rather than taken on our word. Reading the source shows what the code
          does; it does not by itself prove which build you were served, which would need
          reproducible builds we do not publish yet.
        </p>
        <p>
          If a breach ever affects personal data we hold, we will tell the people affected and the
          regulators that require telling, within the time the applicable law sets. What such a
          notice could say is bounded by what we hold: your library would still be ciphertext.
        </p>
        <p>
          If you believe you have found a vulnerability, please see the{' '}
          <Link href="/support">support page</Link> for how to report it.
        </p>

        <h2>Children</h2>
        <p>
          Bracemark is not directed at children under 13, and we do not knowingly collect data from
          them. In the EEA and the UK, where the age of consent for online services is set between
          13 and 16 country by country, you need to meet whichever age applies where you live. If
          you believe a child has created an account, write to us and we will remove it.
        </p>

        <h2>Changes to this policy</h2>
        <p>
          We may update this policy. The date at the top of the page shows when it last changed, and
          we will highlight any material change on this website. Continuing to use Bracemark after a
          change means you accept the updated policy.
        </p>

        <h2>Contact</h2>
        <p>
          Questions about privacy go to <a href={`mailto:${SUPPORT_EMAIL}`}>{SUPPORT_EMAIL}</a>, or
          by post to:
        </p>
        <p className={cn('font-mono text-sm')}>
          {COMPANY.legalName}
          <br />
          ATTN: {COMPANY.attn}
          <br />
          {COMPANY.addressLines.map((line) => (
            <span key={line}>
              {line}
              <br />
            </span>
          ))}
        </p>
      </div>
    </PageShell>
  );
}
