import type { Metadata, ResolvingMetadata } from 'next';

import { STATUS } from '@stxapps/shared';
import { cn } from '@stxapps/web-ui/lib/utils';

import { ElsewhereList } from '../../components/elsewhere-list';
import { MailLink } from '../../components/mail-link';
import { PageShell } from '../../components/page-shell';
import { type ElsewhereCard, PRICING_CARD } from '../../content/elsewhere';
import { pageMetadata } from '../../lib/metadata';
import {
  SECURITY_ACK_WINDOW,
  SECURITY_EMAIL,
  SECURITY_TRIAGE_WINDOW,
  SOURCE,
  SUPPORT_EMAIL,
} from '../../lib/site';

export function generateMetadata(_: unknown, parent: ResolvingMetadata): Promise<Metadata> {
  return pageMetadata(parent, {
    title: 'Support',
    description:
      'How to get help with Bracemark: one email address, what to put in it, and the things we genuinely can’t do for you.',
    path: '/support',
  });
}

// A reachable support URL is a store-listing requirement, so this
// page has a second job beyond helping people: an App Store or Play reviewer will
// open it and look for a real contact route. Hence a plain, visible address
// rather than a form — this is a static export with no backend to post one to,
// and an obfuscated mailto is a worse experience for everybody including the
// reviewer.
//
// Deliberately NOT promised for SUPPORT mail: a response time. We are one small
// team across a single timezone, and an SLA on a marketing page is a commitment
// nobody remembers making at 2am on a Sunday. What is promised is that a person
// reads every message, which is true and is the part people actually want. The
// security block below DOES name two intervals, which is not an exception to this
// so much as the paragraph after next applied: see the comment on that section.
//
// An AI model may help draft a reply, and this page says so in the same sentence
// as the promise it could otherwise seem to break: the lede's "no chatbot" and
// "someone who works on Bracemark reads it" stay true because a person writes or
// approves every reply we send. /privacy, _If you contact us_, is the long form.
//
// "Every message gets one" was the same SLA in a different coat, and it went the
// same way. A reply to EVERY message is not a thing a team can hold: spam, abuse,
// a thank-you that needs nothing back, a report we cannot act on. The promise is
// now split at the line that is actually keepable — a person READS every message
// (true, checkable, and the whole reason to write to a small team) and anything
// that NEEDS an answer gets one. Note which two survive unhedged and why: a
// security report (below) and a network-abuse report on /extractor are narrow
// enough categories that we can commit to answering every one, and both are
// addressed to people who took the trouble to tell us something first. A
// commitment that names its own scope is worth more than one that covers
// everything and quietly does not.
//
// The "what we can't do" block is the most useful thing on the page. Password
// recovery is the single most common support request an E2E app receives,
// and the answer is always no — so it is stated before someone writes in hoping
// otherwise.

const INCLUDE = [
  'What you were doing, and what happened instead.',
  'Which app — the web app, iOS, Android, or the browser extension — and its version.',
  'Your username, if the problem is with your account. Never your password or recovery code.',
];

const ELSEWHERE: ElsewhereCard[] = [
  {
    href: '/faq',
    title: 'Read the FAQ first',
    body: 'Encryption, the account model, plans, and the day-to-day questions — most answers are already there.',
  },
  PRICING_CARD,
  {
    href: '/privacy',
    title: 'What we store about you',
    body: 'The complete inventory, including the parts that aren’t encrypted.',
  },
];

export default function Page() {
  return (
    <PageShell
      eyebrow="Help"
      title="One address, and a person on the other end."
      lede="No ticket queue, no chatbot, no phone tree. Write to us and someone who works on Bracemark reads it."
    >
      <div className={cn('space-y-14')}>
        {/* The primary route, given the weight it deserves. */}
        <section className={cn('rounded-2xl border border-signal-line bg-signal-soft/60 p-8')}>
          <p className={cn('eyebrow text-signal')}>Support</p>
          <MailLink
            address={SUPPORT_EMAIL}
            variant="specimen"
            className={cn(
              'mt-3 block text-xl break-all text-signal-strong underline-offset-8 sm:text-2xl',
            )}
          />
          <p className={cn('mt-5 text-body text-muted-foreground')}>
            Bugs, billing, imports, exports, anything at all. We are a small team in one timezone,
            so a reply can take a day or two. A person reads every message, and anything that needs
            an answer gets one — an AI model may help draft it, but a person writes or approves
            every reply we send.
          </p>
          {/* Before the "worth including" list, because it can save the email
              altogether. No interval in the sentence: the check cadence lives in
              the status repo's config, and a number here would go stale there
              without anything in this repo noticing. */}
          <p className={cn('mt-4 text-body text-muted-foreground')}>
            If something stopped working all at once, check{' '}
            <a
              className={cn(
                'rounded-sm text-signal underline decoration-signal-line underline-offset-2 hover:decoration-signal',
              )}
              href={STATUS.url}
              rel="noreferrer"
            >
              {STATUS.label}
            </a>{' '}
            first. It shows whether each part of Bracemark is answering, checked from outside our
            own servers.
          </p>

          <h2 className={cn('mt-8 text-sm font-semibold')}>Worth including</h2>
          <ul className={cn('mt-3 space-y-2')}>
            {INCLUDE.map((line) => (
              <li
                key={line}
                className={cn(
                  'flex gap-3 text-body text-muted-foreground before:mt-3 before:size-1 before:shrink-0 before:rounded-full before:bg-signal-line',
                )}
              >
                {line}
              </li>
            ))}
          </ul>
        </section>

        {/* The three things that are genuinely impossible, said early. */}
        <section>
          <h2 className={cn('font-display text-2xl font-semibold tracking-tight')}>
            What we can’t do
          </h2>
          <p className={cn('mt-4 text-base leading-7 text-muted-foreground')}>
            These aren’t policies we could be talked out of — they are consequences of an app where
            the key never reaches us.
          </p>
          <dl className={cn('mt-8 space-y-6')}>
            <div className={cn('border-t border-border pt-5')}>
              <dt className={cn('text-base font-semibold')}>Recover a lost password</dt>
              <dd className={cn('mt-2 text-body text-muted-foreground')}>
                If you still have your recovery code, use it to sign in and then set a new password.
                If both are gone, the library cannot be opened by anyone — including us. There is no
                override, no support escalation, and no exception.
              </dd>
            </div>
            {/* NOT "send us an export". The clause here read "an export is the
                fastest way to show us the shape of the problem without sending
                us your contents", and it is false in the one direction that
                matters: there is no shape-only format. netscape / csv / text
                carry URLs, titles, tags and notes, and `bracemark` is the whole
                library in the clear — Trash included, plus the decrypted file
                bytes (data-lifecycle.md, EXPORT). The sentence therefore invited
                the reader to mail us their library, two lines under a heading
                that promises we never see it, over ordinary mail, where it then
                sits. What we can act on is their description of the problem,
                which the "Worth including" list above already asks for — hence no
                third "tell us what you saw" here; the security block below has
                the second.

                The export stays, as the precaution it is on every other surface:
                a copy of what is on THEIR device, taken before anything else
                changes. Do not let it drift into a remedy. Restoring fills gaps
                rather than overwriting (/faq `undo-edit`, /about's
                no-version-history entry, both of which spell that out at
                length), so it covers what goes missing NEXT and never the bug
                itself — and "a copy of whatever is going wrong" is the version
                of this line that says nothing, because nobody wants the fault
                backed up. */}
            <div className={cn('border-t border-border pt-5')}>
              <dt className={cn('text-base font-semibold')}>See or fix your data for you</dt>
              <dd className={cn('mt-2 text-body text-muted-foreground')}>
                We can’t read a link, restore one you deleted, or look at your library to debug it.
                What we have to work from is your description of it. If something looks wrong, take
                an export first: it costs nothing, and it leaves you a copy of what is on your
                device before anything else changes.
              </dd>
            </div>
            <div className={cn('border-t border-border pt-5')}>
              <dt className={cn('text-base font-semibold')}>Refund a store purchase directly</dt>
              <dd className={cn('mt-2 text-body text-muted-foreground')}>
                Subscriptions bought inside the iOS or Android apps are handled by Apple and Google,
                and refunds have to go through them. For a subscription bought on the web, write to
                us — we can help with those.
              </dd>
            </div>
          </dl>
        </section>

        {/* Security reports get their own address so they don't queue behind
            "how do I import from Raindrop".

            THE WINDOWS ARE NAMED HERE, and this is not the SLA the page comment
            above refuses. "A reasonable window to fix it" asked a researcher to
            wait an interval we would not state — which is the one audience that
            reads an unstated interval as a stall, and the reason a coordinated
            disclosure goes public early. The numbers are not new: SECURITY.md in
            the repository has committed to three working days and ten since it
            was written, along with the no-bounty statement, and they were simply
            never published anywhere a researcher looks before they mail us. This
            is the narrow, keepable kind of commitment the page comment allows —
            a category we can answer every one of, made to someone who took the
            trouble to tell us something first.

            FOUR surfaces now carry the same commitment: this block, the
            reporting section on /security, SECURITY.md, and — indirectly — the
            `Policy:` line in app/.well-known/security.txt/route.ts, which decides
            which of the others a researcher's tooling reads first and now points
            at /security rather than at SECURITY.md, as it did when this block was
            written. The windows are no longer typed here: both pages read
            SECURITY_ACK_WINDOW / SECURITY_TRIAGE_WINDOW from lib/site.ts, and
            app/security/reporting-terms.spec.tsx holds SECURITY.md and the
            security.txt fields against those same constants — so a window that
            moves on one surface and not the others fails the suite instead of
            publishing two promises. */}
        <section className={cn('rounded-2xl border border-border p-8')}>
          <h2 className={cn('font-display text-xl font-semibold tracking-tight')}>
            Reporting a security problem
          </h2>
          <p className={cn('mt-3 text-body text-muted-foreground')}>
            Please write to <MailLink address={SECURITY_EMAIL} variant="specimen" /> rather than
            posting publicly. Tell us what you did and what you saw; you will get a reply from a
            human, not an auto-responder.
          </p>
          <p className={cn('mt-4 text-body text-muted-foreground')}>
            We aim to acknowledge a report within {SECURITY_ACK_WINDOW}, and to tell you what we
            intend to do about it within {SECURITY_TRIAGE_WINDOW}. We are a small team, so there is
            no bug bounty and we can’t offer payment — we will credit you when a report leads to a
            fix, unless you would rather we didn’t. The scope, the things we are most interested in,
            and the handful of behaviours that are known and by design are in{' '}
            <a
              className={cn(
                'rounded-sm text-signal underline decoration-signal-line underline-offset-2 hover:decoration-signal',
              )}
              href={`${SOURCE.url}/blob/main/SECURITY.md`}
              rel="noreferrer"
            >
              our security policy
            </a>
            .
          </p>
        </section>

        <section>
          <h2 className={cn('font-display text-2xl font-semibold tracking-tight')}>
            Faster than an email
          </h2>
          <ElsewhereList cards={ELSEWHERE} className={cn('mt-6')} />
        </section>
      </div>
    </PageShell>
  );
}
