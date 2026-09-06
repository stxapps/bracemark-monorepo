import type { Metadata } from 'next';
import Link from 'next/link';

import {
  AES_GCM_IV_BYTES,
  ARGON2_PARAMS,
  PASSPHRASE_BITS_PER_WORD,
  PASSPHRASE_DEFAULT_WORDS,
  RECOVERY_CODE_BYTES,
} from '@stxapps/shared';
import { cn } from '@stxapps/web-ui/lib/utils';

import { MailLink } from '../../components/mail-link';
import { PageShell } from '../../components/page-shell';
import {
  SECURITY_ACK_WINDOW,
  SECURITY_EMAIL,
  SECURITY_TRIAGE_WINDOW,
  SOURCE,
} from '../../lib/site';

export const metadata: Metadata = {
  title: 'Security',
  description:
    'How the key works, the parameters it uses, what someone who took our server would have, and the two things we have not done.',
};

// The page for the reader who accepts the architecture and wants the mechanism.
// Every fact on it was already published — scattered across the landing page's
// hero panel and claim band, /about's colophon, /privacy's processor list, the
// FAQ's privacy group and the repository's SECURITY.md — and not one of them was
// assembled. That was the finding: not "these facts are missing" but "nothing
// puts them together", which is why the answer is a page and not a sixth place to
// scatter them.
//
// WHAT THIS PAGE IS NOT. It is not the inventory (/privacy is, and this page
// points at it rather than restating it), not the legal position (/faq
// `compelled` itemises what an order yields), and not the reporting policy
// (SECURITY.md is, and /.well-known/security.txt points a researcher's tooling at
// this page, which points on to it). Each of those was written where it lives and
// is linked from here, because a fact described twice in two voices is how "four
// formats" came to be claimed five times and described once.
//
// EVERY NUMBER IS READ, NOT TYPED — and this page is the one place on the site
// where that rule has teeth, because the numbers are the entire reason to read
// it. `bracemark-site` imports `@stxapps/shared` already (lib/site.ts takes
// COMPANY, SOURCE and SOCIAL from it), so the derivation parameters come from the
// same `crypto/params.ts` the clients derive with. A typed "64 MiB" would keep
// rendering on the day the constant moved. Note the contrast with /extractor,
// which writes its caps out as prose because bracemark-site does not depend on
// bracemark-extractor and cannot import them — that page carries the risk
// deliberately and says so; this one does not have to.
//
// THE VERB IS "UNLOCKS". docs/account.md, _the model_: the root of an account is
// a random DEK, and the password derives only a KEK that unwraps a copy of it —
// which is exactly how a recovery code opens the same library. "A key derived
// from your password" is false and refutes itself one clause later, and it
// reached eight surfaces out of one compressed heading. This page describes the
// derivation in more detail than any other, so it is also the page where the
// wrong verb would look most authoritative. "Password-derived" is correct for the
// KEK itself, and is used that way below and nowhere else.
//
// THE OFFLINE-ATTACK SECTION IS THE POINT OF THE PAGE, not an aside. The wrapped
// password door is served to anyone who names a username — it has to be, the
// client cannot derive anything without it — so a weak password is attackable
// with no round-trip and no rate limit to slow it (docs/account.md, _why the
// wrapped DEK is served pre-auth_). Volunteering that is the same move as the
// hero panel's metadata concession, which is the best-received writing on the
// property: a reader who can already derive it from an AGPL repository trusts the
// claims they cannot check more, not less, when we say it first. It must not be
// softened into "your data is safe if you use a strong password", which is the
// same sentence with the mechanism removed.
//
// WHAT IT MUST NOT DO. No enumeration that closes — the server-breach list names
// what it names and then points at /privacy, never "that is all of it". No
// commitment /terms does not already carry — the durability section restates
// clause seven and stops, because a retention period or a shutdown window is a
// decision to make in /terms first, not a sentence to write here. And no date,
// "yet" or "coming soon" on the audit or the reproducible-builds absence: those
// two paragraphs work on /about precisely because they are unhedged, and three
// readers said the admission was worth more than the report would have been.

// Derived rather than written down, from the frozen cross-platform contract in
// `@stxapps/shared` (`crypto/params.ts`, `crypto/passphrase.ts`,
// `crypto/recovery-code.ts`) — the same constants web-crypto and expo-crypto
// derive with, pinned by golden vectors in both packages' specs.
const ARGON2_MIB = ARGON2_PARAMS.memorySize / 1024;
const MASTER_SECRET_BITS = ARGON2_PARAMS.hashLength * 8;
const IV_BITS = AES_GCM_IV_BYTES * 8;
const PASSPHRASE_BITS = PASSPHRASE_DEFAULT_WORDS * PASSPHRASE_BITS_PER_WORD;
const RECOVERY_CODE_BITS = RECOVERY_CODE_BYTES * 8;

const PARAMS: [string, string][] = [
  [
    'Password KDF',
    `Argon2id · ${ARGON2_MIB} MiB · ${ARGON2_PARAMS.iterations} passes · parallelism ${ARGON2_PARAMS.parallelism}`,
  ],
  ['KDF output', `${MASTER_SECRET_BITS}-bit`],
  ['Salt', 'SHA-256 of an app-wide constant and your username'],
  ['Sub-keys', 'HKDF-SHA-256 · one to sign with, one to encrypt with'],
  ['Files', `AES-256-GCM · a fresh ${IV_BITS}-bit IV for every file`],
  ['Sign-in', 'Ed25519 signature · no password leaves the device'],
  ['Generated password', `${PASSPHRASE_DEFAULT_WORDS} words · ${PASSPHRASE_BITS} bits of entropy`],
  ['Recovery code', `${RECOVERY_CODE_BITS} bits from a CSPRNG`],
];

// What a full server compromise yields, and what it still does not. The list is
// the plaintext side of the same inventory /privacy carries — named here so a
// reader can plan against it, and closed with a pointer rather than a completeness
// claim (docs/local-first-sync.md, the callout under _the shape of the problem_:
// name the residual OR point at the inventory, never close the list from a
// surface that is not the inventory).
const BREACH_HAS: [string, string][] = [
  [
    'Every encrypted file, and its shape',
    'One encrypted file per item you keep, each with a path, a size and the time it last changed. That is a count of how many things you keep and a record of when you touch them — it is real, it is what a file-per-item design costs, and no amount of encryption removes it.',
  ],
  [
    'Your username and public key',
    'The name you chose and the Ed25519 public key your sign-ins are checked against. The public key is a credential, not a secret; it verifies a signature and decrypts nothing.',
  ],
  [
    'Your sessions and your subscription row',
    'A hashed token per signed-in device, and — if you pay — the payment provider’s identifier for your subscription. The hash cannot be turned back into a token, but neither row is encrypted with your key: we can see how many devices you are signed in on, when each was last used, and whether you pay. It is why we claim we cannot read your library, rather than that we hold nothing about you.',
  ],
  [
    'The wrapped keys themselves',
    'One locked copy of your key per door — one the password opens, one the recovery code opens. They are ciphertext, and a copy of them is already handed out to anyone who asks; the section below is about what that means.',
  ],
];

const BREACH_LACKS: [string, string][] = [
  [
    'A single address, title, tag or note',
    'All of it is inside the ciphertext, including the references between a link and its preview image. The server never held a key to any of it, so there is no key to take.',
  ],
  [
    'Anything to search',
    'There is no index over your library at our end, because building one would need the plaintext to build it from. Search runs on your own devices.',
  ],
  [
    'A way to sign in as you',
    'Signing in means signing a short, time-stamped message with a private key derived on your device. We hold the public half.',
  ],
];

export default function Page() {
  return (
    <PageShell
      eyebrow="Security"
      title="The lock, the numbers, and where it stops."
      lede="Everything here is in the repository already. This is the same account in one place, with the parameters read out of the constants the apps actually derive with — including the part that is uncomfortable to publish."
    >
      <div className={cn('space-y-14')}>
        <section>
          <h2 className={cn('font-display text-2xl font-semibold tracking-tight')}>
            Your password does not make the key. It opens it.
          </h2>
          <div className={cn('mt-4 space-y-4 text-base leading-7 text-muted-foreground')}>
            <p>
              When you create an account, your device generates a random 32-byte key and never sends
              it anywhere. Everything your library is encrypted with comes from that one key, and it
              is not derived from anything you chose or could be made to remember.
            </p>
            <p>
              Your password’s job is narrower: it goes through Argon2id, on your device, to produce
              a second, password-derived key whose only purpose is to <em>wrap</em> — encrypt — a
              copy of the first one. That wrapped copy is what we store. Your recovery code wraps
              its own copy the same way, which is the whole reason a second door is possible at all:
              two locked boxes, one key inside each, and no key of ours anywhere.
            </p>
            <p>
              From the unwrapped key, your device derives two more with HKDF — an Ed25519 keypair
              that signs you in, and the AES-256-GCM key that encrypts every file. Neither the
              password, the random key, nor anything derived from it is ever sent to us.
            </p>
            <p>
              This is also why changing your password is fast and why it is not a remedy for a
              break-in: it re-wraps a 32-byte key and leaves your files untouched, so anything
              already decrypted by someone else stays decrypted. And it is why we cannot reset a
              password — there is no copy of the key on our side to re-wrap it with.
            </p>
          </div>
        </section>

        <section>
          <h2 className={cn('font-display text-2xl font-semibold tracking-tight')}>
            The parameters
          </h2>
          <p className={cn('mt-4 text-base leading-7 text-muted-foreground')}>
            These are a frozen cross-platform contract: the web app, the browser extension and the
            mobile apps must derive identically or a door would not open, so they are pinned by test
            vectors in the repository rather than set per client. Every value below is rendered from
            the constant the apps use, not typed into this page.
          </p>
          <dl className={cn('mt-6 border-t border-border')}>
            {PARAMS.map(([term, detail]) => (
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
            The salt is deterministic and public on purpose — it is derived from your username
            rather than stored, so two people who choose the same password still derive different
            keys, and there is no salt for us to hold. All of it, including the wire format of an
            encrypted file, is in{' '}
            <a
              className={cn(
                'text-signal underline decoration-signal-line underline-offset-2 hover:decoration-signal',
              )}
              href={SOURCE.url}
              rel="noreferrer"
            >
              {SOURCE.label}
            </a>
            .
          </p>
        </section>

        <section>
          <h2 className={cn('font-display text-2xl font-semibold tracking-tight')}>
            What someone who took our server would have
          </h2>
          <p className={cn('mt-4 text-base leading-7 text-muted-foreground')}>
            Worth being specific about, because “end-to-end encrypted” is often said in a way that
            implies there is nothing else on the server. There is.
          </p>
          <dl className={cn('mt-8 space-y-6')}>
            {BREACH_HAS.map(([term, detail]) => (
              <div key={term} className={cn('border-t border-border pt-5')}>
                <dt className={cn('text-base font-semibold')}>{term}</dt>
                <dd className={cn('mt-2 text-body text-muted-foreground')}>{detail}</dd>
              </div>
            ))}
          </dl>
          <p className={cn('mt-8 text-base leading-7 text-muted-foreground')}>
            The{' '}
            <Link
              className={cn(
                'text-signal underline decoration-signal-line underline-offset-2 hover:decoration-signal',
              )}
              href="/privacy"
            >
              privacy policy
            </Link>{' '}
            inventories every field we hold.
          </p>
        </section>

        <section>
          <h2 className={cn('font-display text-2xl font-semibold tracking-tight')}>
            What someone who took our server would not have
          </h2>
          <dl className={cn('mt-8 space-y-6')}>
            {BREACH_LACKS.map(([term, detail]) => (
              <div key={term} className={cn('border-t border-border pt-5')}>
                <dt className={cn('text-base font-semibold')}>{term}</dt>
                <dd className={cn('mt-2 text-body text-muted-foreground')}>{detail}</dd>
              </div>
            ))}
          </dl>
          <p className={cn('mt-8 text-base leading-7 text-muted-foreground')}>
            A legal order is a different route in, and it reaches our providers independently of us
            — that is answered in the{' '}
            <Link
              className={cn(
                'text-signal underline decoration-signal-line underline-offset-2 hover:decoration-signal',
              )}
              href="/faq#compelled"
            >
              FAQ
            </Link>
            .
          </p>
        </section>

        <section>
          <h2 className={cn('font-display text-2xl font-semibold tracking-tight')}>
            The uncomfortable part: a weak password is attackable offline
          </h2>
          <div className={cn('mt-4 space-y-4 text-base leading-7 text-muted-foreground')}>
            <p>
              Your device cannot unlock your key until it has the wrapped copy, and unlocking that
              key is what lets it prove who it is. So we hand the copy to anyone who names a
              username. There is no way around that in this design, and pretending otherwise would
              be worse than saying it.
            </p>
            <p>
              What it means concretely: someone can fetch that box once and then guess at it on
              their own hardware, forever, with no request to us to rate-limit and no failed-login
              counter to trip. Argon2id is what makes each guess expensive — {ARGON2_MIB} MiB of
              memory and {ARGON2_PARAMS.iterations} passes per attempt, which is the difference
              between billions of guesses a second and a slow trickle. But a slow trickle still gets
              there against most passwords people invent.
            </p>
            <p>
              <strong className={cn('font-semibold text-foreground')}>
                Argon2id buys time; only entropy buys safety.
              </strong>{' '}
              This is the reason the app offers to generate your password and the reason we suggest
              taking it: {PASSPHRASE_DEFAULT_WORDS} random words is about {PASSPHRASE_BITS} bits,
              which is not a wall that takes a long time to climb — it is not a climbable wall. What
              decides that is where a password came from, not how it looks: one a person invented
              follows the patterns guessing software already models, so bringing your own is safe
              only if it was generated randomly too. The recovery code is generated with{' '}
              {RECOVERY_CODE_BITS} bits for the same reason.
            </p>
          </div>
        </section>

        <section>
          <h2 className={cn('font-display text-2xl font-semibold tracking-tight')}>
            If our storage fails
          </h2>
          <div className={cn('mt-4 space-y-4 text-base leading-7 text-muted-foreground')}>
            <p>
              The wrapped copies of your key are the most load-bearing rows we hold: lose them and a
              device that has never signed in has no way to open your library, even though the
              password and the recovery code are both still correct. Our storage is redundant, and
              redundancy is not a backup you control — the{' '}
              <Link
                className={cn(
                  'text-signal underline decoration-signal-line underline-offset-2 hover:decoration-signal',
                )}
                href="/terms"
              >
                terms
              </Link>{' '}
              say so and this page is not going to say more than the terms do.
            </p>
            <p>
              The answer that does not depend on us is the export, which is free on every plan and
              is a zip of one JSON line per item with your preview images beside it, decrypted and
              readable with nothing of ours installed. A device that has already synced also holds
              your whole library locally and opens without reaching us at all.
            </p>
          </div>
        </section>

        <section>
          <h2 className={cn('font-display text-2xl font-semibold tracking-tight')}>
            What this page does not prove
          </h2>
          <div className={cn('mt-4 space-y-4 text-base leading-7 text-muted-foreground')}>
            <p>
              No third party has audited any of this, and we do not publish reproducible builds — so
              public source shows you what the code does, and not which build was served to your
              browser. We are not promising either one is coming.{' '}
              <Link
                className={cn(
                  'text-signal underline decoration-signal-line underline-offset-2 hover:decoration-signal',
                )}
                href="/about"
              >
                /about
              </Link>{' '}
              explains what each absence costs you.
            </p>
            {/* AN OBSERVATION, NEVER A VERIFICATION, and the distinction is the
                site's claim boundary rather than a hedge — docs/brand-assets.md,
                _the claim boundary_, which this paragraph is the only surface to
                carry. Public source is about the CODE; a network inspector is
                about the BUILD THAT IS RUNNING, which is the one thing the
                paragraph above concedes the source cannot speak to. That is why
                it earns a place here and why it cannot be sold as proof: a
                request log shows what was sent, not what a key is doing.

                THE SECOND HALF OF THE SENTENCE IS LOAD-BEARING. A reader who
                opens that tab sees the username at sign-up, a session token and
                the R2 host, all readable — and the plaintext URL going to
                `bracemark-extractor` if they turned the `serverExtraction`
                opt-in on (docs/link-extraction.md). So the claim is scoped to
                the LIBRARY PAYLOAD; "nothing readable leaves" would be false and
                falsifiable in the place we just sent them, which is the worst
                available way to lose this page's argument.

                No tool is named — every browser ships one, and naming Chrome's
                dates the copy and reads Chrome-first for a product with four
                clients — and no endpoint, method or request shape either: those
                rot the way a published cap does. */}
            <p>
              One check does survive all that, and it needs nothing from us: your browser’s own
              network inspector shows every request this app makes, and your links leave as bytes
              nobody at our end can read. That is an observation about the build you are actually
              running, not a proof — a request log shows what was sent, not what a key is doing —
              and the account traffic beside it is readable exactly as the privacy policy says.
            </p>
            <p>
              What holding no key does instead is remove the decisions we would otherwise be asking
              you to trust us with. We cannot read a link, hand one over, or reset a password, and
              none of that is a policy we could quietly revise.
            </p>
          </div>
        </section>

        <section className={cn('rounded-2xl border border-signal-line bg-signal-soft/60 p-8')}>
          <p className={cn('eyebrow text-signal')}>Reporting</p>
          <h2 className={cn('mt-3 font-display text-xl font-semibold tracking-tight')}>
            If you find something, tell us first
          </h2>
          <p className={cn('mt-3 text-body text-muted-foreground')}>
            Write to <MailLink address={SECURITY_EMAIL} variant="specimen" /> rather than posting
            publicly. We aim to acknowledge within {SECURITY_ACK_WINDOW} and to tell you what we
            intend to do about it within {SECURITY_TRIAGE_WINDOW}. There is no bug bounty and we
            cannot offer payment; we will credit you when a report leads to a fix, unless you would
            rather we did not.
          </p>
          <p className={cn('mt-4 text-body text-muted-foreground')}>
            The scope, the reports we most want, and the handful of behaviours that are known and by
            design — this page’s offline-attack surface among them — are in{' '}
            <a
              className={cn(
                'text-signal underline decoration-signal-line underline-offset-2 hover:decoration-signal',
              )}
              href={`${SOURCE.url}/blob/main/SECURITY.md`}
              rel="noreferrer"
            >
              our security policy
            </a>
            , which{' '}
            <a
              className={cn(
                'font-mono text-signal underline decoration-signal-line underline-offset-2 hover:decoration-signal',
              )}
              href="/.well-known/security.txt"
            >
              /.well-known/security.txt
            </a>{' '}
            also points at.
          </p>
        </section>
      </div>
    </PageShell>
  );
}
