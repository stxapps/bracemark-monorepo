import type { Metadata } from 'next';
import Link from 'next/link';

import { cn } from '@stxapps/web-ui/lib/utils';

import { ArrowGlyph } from '../../components/glyphs';
import { PageShell } from '../../components/page-shell';
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
// The "what we can't do" block is the most useful thing on the page. Password
// recovery is the single most common support request an E2E app receives, 
// and the answer is always no — so it is stated before someone writes in hoping 
// otherwise.

const INCLUDE = [
  'What you were doing, and what happened instead.',
  'Which app — the web app, iOS, Android, or the browser extension — and its version.',
  'Your username, if the problem is with your account. Never your password or recovery code.',
];

const ELSEWHERE: { href: string; title: string; body: string }[] = [
  {
    href: '/faq',
    title: 'Read the FAQ first',
    body: 'Encryption, the account model, plans and the day-to-day questions — most answers are already there.',
  },
  {
    href: '/pricing',
    title: 'Plans and what they include',
    body: 'What the free plan covers, what Plus adds, and how the trial works.',
  },
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
        <section className={cn('border-signal-line bg-signal-soft/60 rounded-2xl border p-8')}>
          <p className={cn('eyebrow text-signal')}>Support</p>
          <a
            className={cn(
              'text-signal-strong decoration-signal-line hover:decoration-signal focus-visible:ring-ring/50 mt-3 block rounded-sm font-mono text-xl break-all underline underline-offset-8 focus-visible:ring-3 focus-visible:outline-none sm:text-2xl',
            )}
            href={`mailto:${SUPPORT_EMAIL}`}
          >
            {SUPPORT_EMAIL}
          </a>
          <p className={cn('text-muted-foreground mt-5 text-[0.9375rem] leading-7')}>
            Bugs, billing, imports, exports, anything at all. We are a small team in one timezone,
            so a reply can take a day or two — but every message gets one.
          </p>

          <h2 className={cn('mt-8 text-sm font-semibold')}>Worth including</h2>
          <ul className={cn('mt-3 space-y-2')}>
            {INCLUDE.map((line) => (
              <li
                key={line}
                className={cn(
                  'text-muted-foreground before:bg-signal-line flex gap-3 text-[0.9375rem] leading-7 before:mt-3 before:size-1 before:shrink-0 before:rounded-full',
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
          <p className={cn('text-muted-foreground mt-4 text-base leading-7')}>
            These aren’t policies we could be talked out of — they are consequences of an app where
            the key never reaches us.
          </p>
          <dl className={cn('mt-8 space-y-6')}>
            <div className={cn('border-border border-t pt-5')}>
              <dt className={cn('text-base font-semibold')}>Recover a lost password</dt>
              <dd className={cn('text-muted-foreground mt-2 text-[0.9375rem] leading-7')}>
                If you still have your recovery code, use it to sign in and then set a new password.
                If both are gone, the library cannot be opened by anyone — including us. There is no
                override, no support escalation, and no exception.
              </dd>
            </div>
            <div className={cn('border-border border-t pt-5')}>
              <dt className={cn('text-base font-semibold')}>See or fix your data for you</dt>
              <dd className={cn('text-muted-foreground mt-2 text-[0.9375rem] leading-7')}>
                We can’t read a link, restore one you deleted, or look at your library to debug it.
                If something looks wrong, an export is the fastest way to show us the shape of the
                problem without sending us your contents.
              </dd>
            </div>
            <div className={cn('border-border border-t pt-5')}>
              <dt className={cn('text-base font-semibold')}>Refund a store purchase directly</dt>
              <dd className={cn('text-muted-foreground mt-2 text-[0.9375rem] leading-7')}>
                Subscriptions bought inside the iOS or Android apps are handled by Apple and Google,
                and refunds have to go through them. For a subscription bought on the web, write to
                us — we can help with those.
              </dd>
            </div>
          </dl>
        </section>

        {/* Security reports get their own address so they don't queue behind
            "how do I import from Raindrop". */}
        <section className={cn('border-border rounded-2xl border p-8')}>
          <h2 className={cn('font-display text-xl font-semibold tracking-tight')}>
            Reporting a security problem
          </h2>
          <p className={cn('text-muted-foreground mt-3 text-[0.9375rem] leading-7')}>
            Please write to{' '}
            <a
              className={cn(
                'text-signal decoration-signal-line hover:decoration-signal rounded-sm font-mono underline underline-offset-2',
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
          <ul className={cn('bg-border mt-6 grid gap-px overflow-hidden rounded-xl')}>
            {ELSEWHERE.map(({ href, title, body }) => (
              <li key={href} className={cn('bg-background')}>
                <Link
                  className={cn(
                    'group hover:bg-muted/50 focus-visible:ring-ring/50 flex items-start justify-between gap-6 p-6 transition-colors focus-visible:ring-3 focus-visible:outline-none',
                  )}
                  href={href}
                >
                  <span>
                    <span className={cn('block text-base font-semibold')}>{title}</span>
                    <span
                      className={cn(
                        'text-muted-foreground mt-1.5 block text-[0.9375rem] leading-7',
                      )}
                    >
                      {body}
                    </span>
                  </span>
                  <ArrowGlyph
                    className={cn(
                      'text-muted-foreground mt-1 size-4 shrink-0 transition-transform group-hover:translate-x-0.5',
                    )}
                  />
                </Link>
              </li>
            ))}
          </ul>
        </section>
      </div>
    </PageShell>
  );
}
