import Link from 'next/link';

import {
  APP_STORE_URL,
  BRAND,
  CHROME_WEB_STORE_URL,
  entitlementsOf,
  FIREFOX_ADDONS_URL,
  PLAN_LABELS,
  PLAN_USD_PER_YEAR,
  PLAY_STORE_URL,
  TRIAL_DAYS,
} from '@stxapps/shared';
import { AppStoreIcon } from '@stxapps/web-ui/components/icons/app-store-icon';
import { ChromeWebStoreIcon } from '@stxapps/web-ui/components/icons/chrome-web-store-icon';
import { FirefoxAddonsIcon } from '@stxapps/web-ui/components/icons/firefox-addons-icon';
import { PlayStoreIcon } from '@stxapps/web-ui/components/icons/play-store-icon';
import { Button } from '@stxapps/web-ui/components/ui/button';
import { cn } from '@stxapps/web-ui/lib/utils';

import { ArrowGlyph } from '../components/glyphs';
import { CREATE_ACCOUNT_URL } from '../lib/site';

// Moved here from bracemark-web when the apex became this app. Two things changed
// with the move, both consequences of the site being a different origin from the app:
//   - the `AuthedHomeRedirect` that bounced signed-in visitors to /links is gone —
//     this origin has no session to read. bracemark-web's own `/` handles that now.
//   - every account CTA is a cross-origin <a> to app.bracemark.com, not a next/link.
//
// THE COPY RULE, the same one the pricing page follows: only promise what ships.
// Numbers — the free link cap, the Plus price, the trial length — are read from
// `@stxapps/shared` rather than typed, so this page can't quote a cap the app
// doesn't enforce.
//
// THE DESIGN, in one line: achromatic except for a single petrol accent
// (`text-signal`, defined in globals.css), because "the server sees nothing" is
// easier to feel on a page that shows almost nothing. The one thing it does show
// is the hero panel below.

const FREE_LINKS = entitlementsOf('free').maxLinks;

// --- the signature: what you see, and what we store ------------------------
// The whole product argument as one object. The top half is a bookmark the way
// the app renders it; the bottom half is everything that reaches our storage — a
// path, a size, and bytes. Illustrative rather than a screenshot, but not
// invented: `links/{id}.enc` is the real path shape (shared `sync/paths`), and
// the server really does hold nothing else about a link.
//
// Static, deliberately. An animated encrypt/decrypt toggle was the obvious move
// and it is the wrong one — it turns the product's central claim into a toy, and
// it would need a client component on an otherwise fully static export.
const CIPHERTEXT =
  'k7QpV0sZ4mL8xR1cGf9tYb2NwJ3hD6aE5uT0iO8pA1sD4fG7hJ2kL5nM8qR3tV6x' +
  'Z9yB2nM5kJ8hG1fD4sA7pO0iU3tE6rW9qY2xC5vB8nM1kL4jH7gF0dS3aP6oI9uY' +
  '2tR5eW8qA1zX4cV7bN0mK3jH6gF9dS2aP5oI8uY1tR4eW7qZ0xC3vB6nM9kJ2hG5';

function HeroPanel() {
  return (
    <div className={cn('border-border bg-card overflow-hidden rounded-2xl border shadow-sm')}>
      {/* Plaintext half — the only place the accent carries real content. The
          extra bottom padding keeps the tag row clear of the AES chip below. */}
      <div className={cn('p-5 pb-8 sm:p-6 sm:pb-9')}>
        <p className={cn('eyebrow text-signal')}>On your device</p>
        <div className={cn('mt-4 flex gap-3.5')}>
          <div
            className={cn(
              'bg-signal-soft ring-signal-line mt-0.5 size-11 shrink-0 rounded-lg ring-1 ring-inset',
            )}
            aria-hidden="true"
          />
          <div className={cn('min-w-0')}>
            <p className={cn('text-[0.9375rem] leading-snug font-medium')}>
              Local-first sync: the hard parts
            </p>
            <p className={cn('text-muted-foreground mt-1 font-mono text-xs')}>
              martin.kleppmann.com
            </p>
            <div className={cn('mt-2.5 flex flex-wrap gap-1.5')}>
              {['Reading list', 'crdt', 'offline'].map((tag) => (
                <span
                  key={tag}
                  className={cn(
                    'bg-muted text-muted-foreground rounded-md px-1.5 py-0.5 font-mono text-[0.6875rem]',
                  )}
                >
                  {tag}
                </span>
              ))}
            </div>
          </div>
        </div>
      </div>

      {/* The seam. The chip names the mechanism rather than describing it. */}
      <div className={cn('border-border relative border-t')}>
        <span
          className={cn(
            'border-border bg-background text-muted-foreground absolute -top-2.5 left-5 rounded-full border px-2 py-0.5 font-mono text-[0.625rem] tracking-wider uppercase sm:left-6',
          )}
        >
          AES-256-GCM
        </span>
      </div>

      {/* Ciphertext half — inverted, because this is the side we live on. */}
      <div className={cn('bg-foreground text-background px-5 pt-7 pb-6 sm:px-6')}>
        <p className={cn('eyebrow text-background/60')}>What our servers store</p>
        <div className={cn('mt-4 flex items-baseline justify-between gap-4 font-mono text-xs')}>
          <span className={cn('truncate')}>links/01JD7QK2X8N4WYB3F0.enc</span>
          <span className={cn('text-background/50 shrink-0')}>2.1 KB</span>
        </div>
        <p
          className={cn(
            'text-background/45 mt-3 font-mono text-[0.6875rem] leading-5 break-all select-all',
          )}
        >
          {CIPHERTEXT}
        </p>
        <p className={cn('text-background/70 mt-5 text-sm leading-6')}>
          A path, a size, and bytes we hold no key for. Not the title, not the address, not the tags
          — there is nowhere for them to be.
        </p>
      </div>
    </div>
  );
}

// --- band scaffolding ------------------------------------------------------
// Sections are separated by a full-width hairline and named by a mono eyebrow.
// One component, so the rhythm is set once instead of re-spaced per section.
//
// `px-safe` on the <section> and the numeric gutter on the inner div: the tint
// reaches the physical edge, the type stays clear of a landscape notch. Every
// full-bleed section on this page is built this way (docs/safe-area.md).
function Band({
  label,
  title,
  lede,
  children,
  className,
}: {
  label: string;
  title: React.ReactNode;
  lede?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <section className={cn('band px-safe', className)}>
      <div className={cn('mx-auto max-w-6xl px-4 py-20 md:px-6 md:py-24 lg:px-8')}>
        <p className={cn('eyebrow')}>{label}</p>
        <h2
          className={cn(
            'font-display mt-4 max-w-2xl text-3xl leading-[1.1] font-semibold tracking-tight text-balance md:text-4xl',
          )}
        >
          {title}
        </h2>
        {lede && (
          <p className={cn('text-muted-foreground mt-4 max-w-xl text-lg leading-8')}>{lede}</p>
        )}
        <div className={cn('mt-12')}>{children}</div>
      </div>
    </section>
  );
}

// --- the capture surfaces --------------------------------------------------
// Ordered by how good the extraction is, which is also the order we want people
// to adopt them in: the extension and the phone read the page the device is
// already holding, so the preview comes from the user's own browser and free
// accounts get it (docs/link-extraction.md, _who extracts_). The web app can't —
// CORS — which is the honest reason server extraction is a Plus opt-in.
const CAPTURE = [
  {
    name: 'Browser extension',
    where: 'Chrome · Firefox',
    body: 'One click on the tab you are already reading. The extension takes the title and preview image from your own browser, so nothing has to fetch the page on your behalf.',
  },
  {
    name: 'Phone and tablet',
    where: 'iOS · Android',
    body: 'Share into Bracemark from any app — a browser, a podcast player, a group chat. Same capture, same encryption, finished before it leaves the handset.',
  },
  {
    name: 'The web app',
    where: 'Any browser',
    body: 'Paste a URL and it is saved. Browsers stop a web page from fetching another site, so previews for web saves are the one thing that needs a server — opt-in, on Plus.',
  },
  {
    name: 'Import',
    where: 'One file',
    body: 'Bring the library you already have: a browser bookmarks export, a Raindrop CSV, or a plain list of URLs. It is read on your device, so the file never uploads.',
  },
];

// What the library does once things are in it. Deliberately unglamorous — these
// are the daily-loop basics, and every one is free.
// The Plus levers get one honest footnote instead of four asterisks.
const LIBRARY: [string, string][] = [
  ['Lists and tags', 'File a link where you will look for it, or tag it and find it later.'],
  ['Pins', 'The handful you are working from right now, held at the top.'],
  ['Search', 'Across titles, addresses and hosts — every link, on every plan.'],
  ['Card and list layouts', 'A wall of previews, or a dense list. Per device, if you like.'],
  ['Previews', 'Titles and images, pulled by the device that saved the link.'],
  ['Export', 'Your whole library, in formats other apps read. Free, always.'],
];

const GUARANTEES: [string, string][] = [
  [
    'Your key',
    'Derived from your password on your device, with Argon2id. The password never leaves the device, and neither does the key it unlocks.',
  ],
  [
    'Our blindness',
    'The sync server stores a path, a size and an encrypted blob. It cannot index your library, search it, or hand it to anyone in a readable form.',
  ],
  [
    'Your exit',
    'Export everything, in open formats, on every plan, forever. Charging you to leave would defeat the point of building it this way.',
  ],
];

const STORES = [
  { href: PLAY_STORE_URL, label: 'Google Play', Icon: PlayStoreIcon, width: 'w-6' },
  { href: APP_STORE_URL, label: 'App Store', Icon: AppStoreIcon, width: 'w-6' },
  { href: CHROME_WEB_STORE_URL, label: 'Chrome Web Store', Icon: ChromeWebStoreIcon, width: 'w-6' },
  { href: FIREFOX_ADDONS_URL, label: 'Firefox Add-ons', Icon: FirefoxAddonsIcon, width: 'w-7' },
];

export default function Page() {
  return (
    <>
      {/* --- hero --------------------------------------------------------
          The hero has no background of its own, so unlike the bands below it
          gains nothing from bleeding — the wrapper exists purely because
          `px-safe` and the section's own `px-4` are the same two longhands and
          cannot share an element (docs/safe-area.md). */}
      <div className={cn('px-safe')}>
        <section className={cn('mx-auto max-w-6xl px-4 pt-16 pb-20 md:px-6 md:pt-24 lg:px-8')}>
          <div className={cn('grid items-center gap-14 lg:grid-cols-12 lg:gap-16')}>
            <div className={cn('lg:col-span-7')}>
              <p className={cn('eyebrow')}>End-to-end encrypted · Local-first</p>
              <h1
                className={cn(
                  'font-display mt-5 text-[2.75rem] leading-[0.98] font-semibold tracking-tight text-balance sm:text-6xl lg:text-[4.25rem]',
                )}
              >
                {BRAND.tagline}.
              </h1>
              <p className={cn('text-muted-foreground mt-6 max-w-xl text-lg leading-8')}>
                Save anything worth coming back to — articles, docs, threads, products, videos.
                Bracemark encrypts every link on your device before it syncs, with a key only you
                can derive. Not a promise we make. A thing we can’t undo.
              </p>

              <div className={cn('mt-9 flex flex-wrap items-center gap-3')}>
                <Button asChild size="lg">
                  <a href={CREATE_ACCOUNT_URL}>
                    Create your account
                    <ArrowGlyph data-icon="inline-end" className={cn('size-4')} />
                  </a>
                </Button>
                <Button asChild size="lg" variant="ghost">
                  <Link href="/pricing">See pricing</Link>
                </Button>
              </div>

              <p className={cn('text-muted-foreground mt-5 max-w-md text-sm leading-6')}>
                Free for your first {FREE_LINKS} links. No card — and no email address, because the
                account has nowhere to put one.
              </p>

              <div className={cn('mt-10 flex items-center gap-5')}>
                <span className={cn('eyebrow')}>Also on</span>
                <ul className={cn('flex items-end gap-4')}>
                  {STORES.map(({ href, label, Icon, width }) => (
                    <li key={label}>
                      {/* Desaturated at rest, true colour on hover. Four brand
                          marks in full colour are the loudest thing on an
                          otherwise achromatic page, and they are recognised by
                          silhouette anyway — the colour is there when a hand is
                          actually on them. */}
                      <a
                        className={cn(
                          'focus-visible:ring-ring/50 block rounded-sm opacity-80 grayscale transition duration-200 hover:opacity-100 hover:grayscale-0 focus-visible:ring-3 focus-visible:ring-offset-2 focus-visible:outline-none',
                        )}
                        href={href}
                        target="_blank"
                        rel="noreferrer"
                      >
                        <Icon className={cn(width)} aria-label={label} />
                      </a>
                    </li>
                  ))}
                </ul>
              </div>
            </div>

            <div className={cn('lg:col-span-5')}>
              <HeroPanel />
            </div>
          </div>
        </section>
      </div>

      {/* --- the three things a sceptic checks first --------------------- */}
      <section className={cn('band px-safe bg-muted/40')}>
        <div className={cn('mx-auto max-w-6xl px-4 md:px-6 lg:px-8')}>
          <dl
            className={cn('divide-border grid divide-y sm:grid-cols-3 sm:divide-x sm:divide-y-0')}
          >
            {[
              ['No ads, ever', 'The subscription is the entire business model.'],
              ['No trackers', 'No analytics, no fingerprinting, no ad networks.'],
              ['No lock-in', 'Full export on every plan, including the free one.'],
            ].map(([term, detail]) => (
              <div key={term} className={cn('py-8 sm:px-8 sm:first:pl-0 sm:last:pr-0')}>
                <dt className={cn('font-display text-lg font-semibold tracking-tight')}>{term}</dt>
                <dd className={cn('text-muted-foreground mt-1.5 text-sm leading-6')}>{detail}</dd>
              </div>
            ))}
          </dl>
        </div>
      </section>

      {/* --- capture ------------------------------------------------------ */}
      <Band
        label="Getting links in"
        title="Four ways in, all of them one gesture."
        lede="Saving has to be faster than not saving, or the library never happens. Whichever surface you use, the encryption is done before anything leaves the device."
      >
        <ul className={cn('bg-border grid gap-px overflow-hidden rounded-xl sm:grid-cols-2')}>
          {CAPTURE.map(({ name, where, body }) => (
            <li key={name} className={cn('bg-background p-7 md:p-8')}>
              <div className={cn('flex items-baseline justify-between gap-4')}>
                <h3 className={cn('font-display text-xl font-semibold tracking-tight')}>{name}</h3>
                <span className={cn('text-muted-foreground shrink-0 font-mono text-xs')}>
                  {where}
                </span>
              </div>
              <p className={cn('text-muted-foreground mt-3 text-[0.9375rem] leading-7')}>{body}</p>
            </li>
          ))}
        </ul>
      </Band>

      {/* --- the library -------------------------------------------------- */}
      <Band
        label="Finding them again"
        title="A private library is still a library."
        lede="Encryption is the part you don’t see. This is the part you use every day — and all of it is on the free plan."
      >
        <ul className={cn('grid gap-x-10 gap-y-8 sm:grid-cols-2 lg:grid-cols-3')}>
          {LIBRARY.map(([name, body]) => (
            <li key={name} className={cn('border-border border-t pt-5')}>
              <h3 className={cn('text-base font-semibold')}>{name}</h3>
              <p className={cn('text-muted-foreground mt-2 text-[0.9375rem] leading-7')}>{body}</p>
            </li>
          ))}
        </ul>
        <p className={cn('text-muted-foreground mt-10 max-w-2xl text-sm leading-6')}>
          Nested lists, hidden lists, the app lock and the structured search editor are{' '}
          {PLAN_LABELS.plus}. Everything above stays free.
        </p>
      </Band>

      {/* --- the claim -----------------------------------------------------
          The one loud moment on the site, and it is loud with nothing but type
          on an inverted ground. Everything it asserts is architecture, which is
          why the three columns underneath are mechanisms, not values. */}
      <section className={cn('bg-foreground text-background px-safe')}>
        <div className={cn('mx-auto max-w-6xl px-4 py-24 md:px-6 md:py-32 lg:px-8')}>
          <p
            className={cn(
              'font-display text-3xl leading-[1.15] font-semibold tracking-tight text-balance sm:text-5xl lg:text-6xl',
            )}
          >
            We don’t promise not to look.
            <br />
            <span className={cn('text-background/55')}>We built it so we can’t.</span>
          </p>
          <dl className={cn('mt-20 grid gap-10 md:grid-cols-3 md:gap-12')}>
            {GUARANTEES.map(([term, detail]) => (
              <div key={term} className={cn('border-background/20 border-t pt-5')}>
                <dt className={cn('eyebrow text-background/60')}>{term}</dt>
                <dd className={cn('text-background/85 mt-3 text-[0.9375rem] leading-7')}>
                  {detail}
                </dd>
              </div>
            ))}
          </dl>
          <p className={cn('text-background/60 mt-14 text-sm')}>
            The honest cost of building it this way: lose your password and your recovery code, and
            nobody — us included — can get the library back.{' '}
            <Link className={cn('text-background underline underline-offset-4')} href="/faq">
              How the account works
            </Link>
            .
          </p>
        </div>
      </section>

      {/* --- pricing teaser ----------------------------------------------- */}
      <Band
        label="Pricing"
        title="Free until your library outgrows free."
        lede={`Start with ${FREE_LINKS} links and no card. Upgrade when the cap starts to pinch — with a ${TRIAL_DAYS}-day trial, and the same encryption, sync and export on both plans.`}
      >
        <div className={cn('flex flex-wrap items-end gap-x-16 gap-y-8')}>
          <div>
            <p className={cn('eyebrow')}>{PLAN_LABELS.free}</p>
            <p className={cn('font-display mt-2 text-4xl font-semibold tracking-tight')}>$0</p>
            <p className={cn('text-muted-foreground mt-1 text-sm')}>{FREE_LINKS} links, forever</p>
          </div>
          <div>
            <p className={cn('eyebrow text-signal')}>{PLAN_LABELS.plus}</p>
            <p className={cn('font-display mt-2 text-4xl font-semibold tracking-tight')}>
              ${PLAN_USD_PER_YEAR.plus}
              <span className={cn('text-muted-foreground text-lg font-normal')}>/year</span>
            </p>
            <p className={cn('text-muted-foreground mt-1 text-sm')}>
              Unlimited links, locks, advanced search
            </p>
          </div>
          <Button asChild variant="outline" size="lg">
            <Link href="/pricing">
              Compare plans
              <ArrowGlyph data-icon="inline-end" className={cn('size-4')} />
            </Link>
          </Button>
        </div>
      </Band>

      {/* --- close --------------------------------------------------------- */}
      <section className={cn('band px-safe')}>
        <div className={cn('mx-auto max-w-6xl px-4 py-24 text-center md:px-6 md:py-28 lg:px-8')}>
          <h2
            className={cn(
              'font-display mx-auto max-w-2xl text-3xl leading-[1.1] font-semibold tracking-tight text-balance md:text-5xl',
            )}
          >
            Start with an empty library that is already private.
          </h2>
          <p className={cn('text-muted-foreground mx-auto mt-5 max-w-lg text-lg leading-8')}>
            Pick a username, save the passphrase we generate for you, and save your first link a
            minute later.
          </p>
          <Button asChild size="lg" className={cn('mt-9')}>
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
