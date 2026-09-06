import type { Metadata } from 'next';
import Link from 'next/link';

import { PLAN_LABELS } from '@stxapps/shared';
import { cn } from '@stxapps/web-ui/lib/utils';

import { PageShell } from '../../components/page-shell';
import { COMPANY, PRIVACY_UPDATED, SOURCE, SUPPORT_EMAIL } from '../../lib/site';

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
      lede="The short version: we hold encrypted files we cannot open, and the smallest account record that makes signing in possible. Everything else — a subscription record if you buy one, the request data any web service processes, an email you send us — is inventoried below."
      meta={`Effective ${PRIVACY_UPDATED}`}
      width="document"
    >
      <div className={cn('legal-prose')}>
        <p>
          This policy explains what {COMPANY.legalName} (“{COMPANY.shortName}”, “we”, “us”) collects
          when you use Bracemark, why, and what happens to it. It covers bracemark.com,
          app.bracemark.com, the Bracemark applications for iOS, Android, Chrome and Firefox, and
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
            no tracker and no data sold or shared for marketing.
          </li>
          <li>
            The only way we make money is the optional subscription — which is why our incentives
            and yours point the same way.
          </li>
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
            the absolute, and unlike the absolute it is true. */}
        <p>
          We do not collect an email address, a phone number, a name, or any other identifier at
          sign-up. If you never write to us and never subscribe, the account itself holds nothing
          that names you — what remains is the ordinary request data described under{' '}
          <em>Technical and security data</em> below, which we do not join to your account.
        </p>
        <p>
          Signing in creates a <strong>session record</strong> — a hashed token, the account it
          belongs to, and timestamps — so your device stays signed in and you can sign other devices
          out.
        </p>

        <h3>Your library</h3>
        <p>
          Each saved link, list, tag and setting is stored as its own{' '}
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
          an email address and payment details, which the provider collects and holds; the record
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
            `invocation_logs: false` because its request line is the one place a
            saved address would appear. Both are in the two Workers' wrangler.jsonc
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

            If either setting changes, this paragraph and /security move with it. */}
        <p>
          That data lives in <strong>Cloudflare</strong>’s and <strong>Amazon Web Services</strong>’
          own logs, under their retention periods rather than any we set, and we read it to diagnose
          a fault or an attack. We run no analytics over it, we do not join it to your account, and
          we keep no separate copy of our own.
        </p>
        <p>
          Two of the choices that decide what reaches those logs are ours rather than theirs, and we
          have made both the same way. Our servers do not forward their request logs to any outside
          destination, so there is no copy of that stream sitting in a third party’s storage under a
          retention period of its own. And the link-preview service — the one part of Bracemark that
          is ever handed a page address — runs with the log that would record its request line
          switched off, because that line is where the address would appear. Both are settings in
          the configuration files in{' '}
          <a href={SOURCE.url} rel="noreferrer">
            {SOURCE.label}
          </a>
          , with the reasoning written out beside them.
        </p>

        <h3>What Apple and Google tell us</h3>
        <p>
          As the publisher of the mobile apps we can see the figures Apple and Google compile for
          us: installs, which versions are in use, and the crash and performance reports their
          operating systems collect. They arrive as counts and anonymous reports — they carry no
          account, and we cannot connect one to a person. Neither app ships an analytics or
          crash-reporting library of ours.
        </p>

        <h3>Link previews, if you turn them on</h3>
        <p>
          Titles and preview images are normally fetched by the device that saved the link — the
          browser extension reads the tab you are on, and the mobile apps fetch the page themselves.
          Neither involves our servers. The browser extension asks for the narrowest permission that
          does that job: it can read a tab only in the moment you click to save it, it holds no
          standing access to your browsing, and the only site it talks to is our own API.
        </p>
        <p>
          For links saved in the web app, browsers do not allow a page to fetch another site, so
          there is an <strong>opt-in {PLAN_LABELS.plus} setting</strong> that lets our extraction
          service fetch the page on your behalf. It is off unless you turn it on. When it is on,
          that service receives the address you saved, fetches the page, returns what it read there
          — the title and the preview image — and keeps nothing: it stores no URLs, writes none to
          its logs, holds no key, and is not told which account asked. Its rate limiter does record
          IP addresses, so that a single source cannot abuse it. The same service is described from
          the other side — for the people who run the sites it fetches — on{' '}
          <Link href="/extractor">its own page</Link>, including the caps it holds itself to and how
          to turn it away.
        </p>

        <h3>If you contact us</h3>
        <p>
          When you email support we receive your message, your email address and whatever you choose
          to put in it. We keep the correspondence so we can follow up, and we use it only to help
          you.
        </p>
        <p>
          Your library can hold whatever you want it to, and we cannot see it — that is the point. A
          support email is different: it reaches us in the clear. Please leave out anything you
          would rather we did not hold. And never send us your password or your recovery code:
          nobody at Bracemark will ever ask you for either, and either one would open your library.
        </p>

        <h2>Cookies and on-device storage</h2>
        <p>
          This website sets <strong>no cookies</strong> and loads no third-party scripts; the fonts
          are served from this domain rather than fetched from a font provider. There is no cookie
          banner here because there is nothing to ask you about — we set nothing that needs your
          consent.
        </p>
        <p>
          The app loads one script from anyone else, and only on one screen: <strong>Paddle</strong>
          ’s, fetched when you open Settings → Subscription so it can look up the price in your
          local currency, and used again to run the checkout if you go on to subscribe. Paddle sets
          its own cookies to do that, under its privacy policy. Nothing else in Bracemark loads code
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
          <li>To answer you when you write to us.</li>
          <li>To meet legal, tax and accounting obligations.</li>
        </ul>
        <p>
          We do not use your information for advertising, we do not sell or rent it, and we do not
          share it for anyone else’s marketing. There is no automated decision-making that produces
          legal effects for you.
        </p>

        <h2>Our legal bases</h2>
        <p>
          Where the GDPR, the UK GDPR or Thailand’s PDPA applies, we have to name the legal basis
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
          <li>
            <strong>Cloudflare</strong> — hosts the API and stores the encrypted files and the
            account records.
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
          each of them holds is the line beside its name above.
        </p>

        <h2>How long we keep it</h2>
        <ul>
          <li>
            <strong>Your account and library</strong> — until you delete them. Deleting all data
            wipes the stored files; deleting your account also destroys the encrypted key blobs,
            after which nothing could open the data even if a copy survived.
          </li>
          <li>
            <strong>Sessions</strong> — until they expire or you sign that device out.
          </li>
          <li>
            <strong>Subscription records</strong> — for as long as the subscription is live, and
            afterwards for as long as tax and accounting law requires.
          </li>
          <li>
            <strong>Support email</strong> — until it is no longer useful for supporting you.
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
          Depending on where you live, you may have rights to access, correct, delete, restrict or
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
            <strong>Access and portability</strong> — Settings → Data → Export, which gives you your
            whole library in open formats. A list you have locked is left out of the file until you
            unlock it.
          </li>
          <li>
            <strong>Correction</strong> — edit anything in the app; it is your data on your device.
          </li>
          <li>
            <strong>Erasure</strong> — Settings → Data deletes your library; Settings → Account
            deletes the account itself.
          </li>
          <li>
            <strong>Withdrawing consent</strong> — the only thing you consented to is server-side
            link previews, and Settings → Link Previews switches it back off.
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
          gives you rights of access, correction, erasure, restriction, portability, objection and
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
          which are faster. Exercising a right never costs you service, features or a worse price.
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
          perfectly secure, and we do not claim otherwise — but the design deliberately limits how
          much a breach of ours could reveal, because what we hold is not readable.
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
