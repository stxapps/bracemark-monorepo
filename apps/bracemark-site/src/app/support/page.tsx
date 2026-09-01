import type { Metadata } from 'next';

import { cn } from '@stxapps/web-ui/lib/utils';

import { ElsewhereList } from '../../components/elsewhere-list';
import { PageShell } from '../../components/page-shell';
import { type ElsewhereCard, PRICING_CARD } from '../../content/elsewhere';
import { SECURITY_EMAIL, SUPPORT_EMAIL } from '../../lib/site';

export const metadata: Metadata = {
  title: 'Support',
  description:
    'How to get help with Bracemark: one email address, what to put in it, and the things we genuinely cannot do for you.',
};

// A reachable support URL is a store-listing requirement, so this
// page has a second job beyond helping people: an App Store or Play reviewer will
// open it and look for a real contact route. Hence a plain, visible address
// rather than a form — this is a static export with no backend to post one to,
// and an obfuscated mailto is a worse experience for everybody including the
// reviewer.
//
// Deliberately NOT promised here: a response time. We are one small team across a
// single timezone, and an SLA on a marketing page is a commitment nobody
// remembers making at 2am on a Sunday. What is promised is that a person reads
// every message, which is true and is the part people actually want.
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
    body: 'Encryption, the account model, plans and the day-to-day questions — most answers are already there.',
  },
  PRICING_CARD,
  {
    href: '/privacy',
    title: 'What we store about you',
    body: 'The complete inventory, including the parts that are not encrypted.',
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
          <a
            className={cn(
              'mt-3 block rounded-sm font-mono text-xl break-all text-signal-strong underline decoration-signal-line underline-offset-8 hover:decoration-signal focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none sm:text-2xl',
            )}
            href={`mailto:${SUPPORT_EMAIL}`}
          >
            {SUPPORT_EMAIL}
          </a>
          <p className={cn('mt-5 text-body text-muted-foreground')}>
            Bugs, billing, imports, exports, anything at all. We are a small team in one timezone,
            so a reply can take a day or two. A person reads every message, and anything that needs
            an answer gets one.
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
            <div className={cn('border-t border-border pt-5')}>
              <dt className={cn('text-base font-semibold')}>See or fix your data for you</dt>
              <dd className={cn('mt-2 text-body text-muted-foreground')}>
                We can’t read a link, restore one you deleted, or look at your library to debug it.
                If something looks wrong, an export is the fastest way to show us the shape of the
                problem without sending us your contents.
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
            "how do I import from Raindrop". */}
        <section className={cn('rounded-2xl border border-border p-8')}>
          <h2 className={cn('font-display text-xl font-semibold tracking-tight')}>
            Reporting a security problem
          </h2>
          <p className={cn('mt-3 text-body text-muted-foreground')}>
            Please write to{' '}
            <a
              className={cn(
                'rounded-sm font-mono text-signal underline decoration-signal-line underline-offset-2 hover:decoration-signal',
              )}
              href={`mailto:${SECURITY_EMAIL}`}
            >
              {SECURITY_EMAIL}
            </a>{' '}
            rather than posting publicly, and give us a reasonable window to fix it before you do.
            Tell us what you did and what you saw; you will get a reply from a human, not an
            auto-responder.
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
