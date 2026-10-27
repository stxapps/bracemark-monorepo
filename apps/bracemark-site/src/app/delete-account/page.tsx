import type { Metadata, ResolvingMetadata } from 'next';
import Link from 'next/link';

import { SESSION_RETENTION } from '@stxapps/shared';
import { cn } from '@stxapps/web-ui/lib/utils';

import { MailLink } from '../../components/mail-link';
import { PageShell } from '../../components/page-shell';
import { pageMetadata } from '../../lib/metadata';
import { APP_URL, BACKUP_RETENTION_DAYS, SIGN_IN_URL, SUPPORT_EMAIL } from '../../lib/site';

export function generateMetadata(_: unknown, parent: ResolvingMetadata): Promise<Metadata> {
  return pageMetadata(parent, {
    title: 'Delete your account',
    description:
      'How to delete your Bracemark account and everything in it, from the Android or iOS app or from any browser, and exactly what is deleted and what is kept.',
    path: '/delete-account',
  });
}

// The URL Google Play's Data safety form asks for ("Delete account URL"), and the
// reason this page exists rather than /faq `delete-account` alone. Play's policy
// wants a page that names the app, puts the STEPS up front, and says what is
// deleted, what is kept and for how long — and it is read by someone who may have
// uninstalled the app, so the browser route has to be on it. The FAQ answer is
// the short version for someone already in the product; this is the full one.
//
// Every fact here is a reading of docs/data-lifecycle.md, _delete account — the
// full teardown_, and moves with it:
//   - STEPS name the real labels: the ⋯ More options menu → Settings on expo
//     (`features/links/more-options-menu.tsx`), Account → Delete account, the
//     password field, the confirm checkbox and the "Delete account forever" button
//     (both apps' account-section.tsx). Tap for the apps, click for the browser
//     (docs/brand-assets.md, _the mechanics_).
//   - BEFORE YOU START is the server's 409 gate stated in advance: a subscription
//     in grace or set to renew blocks deletion, a canceled-but-entitled one does
//     not and its time is forfeited. Deletion never touches the provider, which is
//     why cancelling is the user's step and happens where it was bought.
//   - WHAT IS DELETED is the teardown in order — `deleteAllUserData`, then the
//     doors with the user row, then every session. "Other devices erase their
//     copy" is a `session_revoked` answer running the full `clearData` on that
//     device (docs/sessions.md) — the next time it reaches the server, not at
//     the moment of deletion, and only while its revocation marker exists.
//     "Within a year" is that marker's retention, read from
//     `SESSION_RETENTION` (@stxapps/shared, auth/sessions.ts) like the
//     kept-sessions line below and /privacy's _Sessions_ line.
//   - WHAT IS DELETED is scoped to "the storage your devices sync with", never
//     "our storage": the backups are our storage too, and they are listed two
//     sections down as kept. An unscoped "immediately" is disproved on this page.
//   - WHAT IS KEPT matches /privacy, _How long we keep it_, and must keep
//     matching it: the tombstoned username, the ended sessions' records for a
//     year, subscription records under tax law,
//     support mail and the paraphrased questions kept from it, providers' logs,
//     and backups for their 30-day window
//     (/privacy's header comment, _BACKUPS ARE A 30-DAY WINDOW_). The same
//     window is why WHAT IS DELETED's "nothing could open the data" waits for
//     the backup copies of the key to expire.
//   - IF YOU CAN'T SIGN IN is the cost the design carries: the route requires a
//     fresh password-signed proof and there is no email on file, so nothing we
//     hold can tell the owner from anyone who knows the username. The two-year
//     line is /privacy's "we reserve the right", quoted as a right, not promised
//     as a schedule. "We don't", not "we can't", for deleting on request and for
//     bringing an account back: we could delete a named account, and a backup
//     holds a deleted one for 30 days, so both are things we decline to do. The
//     reason the first is declined is the sentence before it — nothing we hold
//     tells the owner from anyone else who knows the username.

const ACCOUNT_SETTINGS_URL = `${APP_URL}/settings/account`;

const link = cn(
  'rounded-sm text-signal underline decoration-signal-line underline-offset-2 hover:decoration-signal focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none',
);
const h2 = cn('font-display text-2xl font-semibold tracking-tight');
const body = cn('text-body text-muted-foreground');
const bullets = cn('mt-4 space-y-3');
const bullet = cn(
  'flex gap-3 text-body text-muted-foreground before:mt-3 before:size-1 before:shrink-0 before:rounded-full before:bg-signal-line',
);

function Steps({ children }: { children: React.ReactNode }) {
  return (
    <ol
      className={cn(
        'mt-4 list-decimal space-y-2 pl-6 text-body text-muted-foreground marker:text-muted-foreground',
      )}
    >
      {children}
    </ol>
  );
}

export default function Page() {
  return (
    <PageShell
      eyebrow="Help"
      title="Delete your Bracemark account"
      lede="You delete your account yourself, from the app or from any browser, and it happens straight away. There is no request to send and nothing for us to approve."
    >
      <div className={cn('space-y-14')}>
        <section>
          <h2 className={h2}>Before you start</h2>
          <ul className={bullets}>
            <li className={bullet}>
              <span>
                <strong className={cn('font-semibold text-foreground')}>
                  Cancel a subscription that renews.
                </strong>{' '}
                Deleting the account doesn’t stop the billing, so it’s refused until you cancel. A
                subscription bought in the Android app is canceled in the Play Store, one bought in
                the iOS app in the App Store, and one bought on the web in Settings → Subscription.
                If a canceled subscription still has paid time left, that time is forfeited.
              </span>
            </li>
            <li className={bullet}>
              <span>
                <strong className={cn('font-semibold text-foreground')}>
                  Export anything you want to keep.
                </strong>{' '}
                Settings → Data → Export all data saves your whole library to a file on your device.
                Once the account is gone, nothing we hold can bring it back.
              </span>
            </li>
            <li className={bullet}>
              <span>
                <strong className={cn('font-semibold text-foreground')}>
                  Have your password ready.
                </strong>{' '}
                You’re asked for it again even though you’re signed in, so a signed-in device on its
                own can’t delete your account. If you’ve forgotten it but still have your recovery
                code, sign in with the code and set a new password first.
              </span>
            </li>
          </ul>
        </section>

        <section>
          <h2 className={h2}>How to delete it</h2>

          <h3 className={cn('mt-8 text-base font-semibold')}>In the Android or iOS app</h3>
          <Steps>
            <li>Tap the ⋯ menu above your links, then Settings.</li>
            <li>Tap Account, then Delete account.</li>
            <li>Enter your password, tick the box to confirm, and tap Delete account forever.</li>
          </Steps>

          <h3 className={cn('mt-8 text-base font-semibold')}>In a browser, without the app</h3>
          <Steps>
            <li>
              Sign in at{' '}
              <a className={link} href={SIGN_IN_URL}>
                {new URL(APP_URL).host}
              </a>
              .
            </li>
            <li>
              Go to{' '}
              <a className={link} href={ACCOUNT_SETTINGS_URL}>
                Settings → Account
              </a>{' '}
              and click Delete account.
            </li>
            <li>Enter your password, tick the box to confirm, and click Delete account forever.</li>
          </Steps>

          <p className={cn(body, 'mt-6')}>
            Uninstalling the app doesn’t delete your account. Deletion is final: there is no grace
            period, and we don’t bring a deleted account back from a backup.
          </p>
        </section>

        <section>
          <h2 className={h2}>What is deleted</h2>
          <ul className={bullets}>
            <li className={bullet}>
              Everything in your library — links, lists, tags, pins, files, and settings — from the
              storage your devices sync with, immediately. Its backup copies follow within{' '}
              {BACKUP_RETENTION_DAYS} days.
            </li>
            <li className={bullet}>
              The encrypted copies of your key, the one your password and recovery code unlock. Once
              their backup copies expire too, within {BACKUP_RETENTION_DAYS} days, nothing could
              open your data even if a copy of it survived.
            </li>
            <li className={bullet}>
              Your account record. Every signed-in session ends with it: the device you delete from
              erases its local copy at once, and your other devices are signed out and erase theirs
              the next time they connect within {SESSION_RETENTION.label}. One that stays offline
              longer keeps its copy until you sign out on it.
            </li>
          </ul>
        </section>

        <section>
          <h2 className={h2}>What is kept</h2>
          <ul className={bullets}>
            <li className={bullet}>
              Your username, forever. It is retired rather than released, so nobody can register it
              later and be mistaken for you.
            </li>
            <li className={bullet}>
              A record of each session that ended — a hashed token, the account it belonged to, and
              timestamps — for {SESSION_RETENTION.label}, so a device that connects late is still
              told to erase its copy. After that it is deleted automatically.
            </li>
            <li className={bullet}>
              Subscription records, for as long as tax and accounting law requires. Apple, Google,
              and Paddle keep their own records of what you paid them.
            </li>
            <li className={bullet}>
              Email you’ve sent to support, until it is no longer useful for supporting you. Ask and
              we’ll delete it sooner. The questions we paraphrase from it for help pages and fixes
              carry no name, email address, or username, and we keep those.
            </li>
            <li className={bullet}>
              Backup copies of your library and account record, including the encrypted copies of
              your key, for up to {BACKUP_RETENTION_DAYS} days, after which they’re deleted
              automatically.
            </li>
            <li className={bullet}>
              Infrastructure logs, for the short window our providers keep them, after which they
              age out on their side.
            </li>
          </ul>
          <p className={cn(body, 'mt-6')}>
            The{' '}
            <Link className={link} href="/privacy">
              privacy policy
            </Link>{' '}
            has the full inventory of what we hold, deleted account or not.
          </p>
        </section>

        <section className={cn('rounded-2xl border border-border p-8')}>
          <h2 className={cn('font-display text-xl font-semibold tracking-tight')}>
            If you can’t sign in
          </h2>
          <p className={cn(body, 'mt-3')}>
            Deleting needs your password because nothing else proves the account is yours: there is
            no email on file, so we can’t tell you apart from anyone else who knows your username,
            and we don’t delete an account on request. If both your password and your recovery code
            are gone, the library can’t be opened by anyone, including us. We also reserve the
            right, in our privacy policy, to delete an account that has gone unused for two years or
            more.
          </p>
          <p className={cn(body, 'mt-4')}>
            For anything else, write to <MailLink address={SUPPORT_EMAIL} />.
          </p>
        </section>
      </div>
    </PageShell>
  );
}
