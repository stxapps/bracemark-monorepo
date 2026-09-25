import type { Metadata } from 'next';
import { Bricolage_Grotesque, IBM_Plex_Mono, Inter } from 'next/font/google';

import { BRAND, SOCIAL } from '@stxapps/shared';
import { cn } from '@stxapps/web-ui/lib/utils';

import { SiteFooter } from '../components/site-footer';
import { SiteHeader } from '../components/site-header';
import { SITE_URL } from '../lib/site';

import './globals.css';

// Three faces, each bound to a CSS variable the site's `@theme` block reads
// (globals.css explains what each voice is FOR). All self-hosted by next/font at
// build time — no runtime request to Google, which matters on a page that sells
// not being tracked.
const inter = Inter({ subsets: ['latin'], display: 'swap', variable: '--font-inter' });
// `axes` is the optical size, and it is not optional decoration. Bricolage
// carries three axes — opsz 12..96, wdth 75..100, wght 200..800 — and asking
// for none of them lands you on the fvar defaults for the two you skipped.
// For opsz that default is NOT 96 despite what the served file's family name
// ("Bricolage Grotesque 96pt ExtraBold") suggests: that string is nameID 1 of
// the whole variable font, carried into the subset unchanged. Measured against
// the variable font swept across opsz, the subset we were shipping matches
// opsz 12-18 — the TEXT cut — which the site was then using for headlines up
// to 48px. Requesting the axis lets `font-optical-sizing: auto` (the browser
// default) pick per size, so headlines get the display cut and the 18px
// wordmark in site-header.tsx keeps the text cut it already had.
//
// `wdth` is deliberately NOT requested; see globals.css for why.
const bricolage = Bricolage_Grotesque({
  subsets: ['latin'],
  display: 'swap',
  axes: ['opsz'],
  variable: '--font-bricolage',
});
const plexMono = IBM_Plex_Mono({
  subsets: ['latin'],
  display: 'swap',
  weight: ['400', '500'],
  variable: '--font-plex-mono',
});

// `themeColor` and `colorScheme` are the light-only decision (see the note above
// RootLayout) expressed at the document level, and they move together.
//
// `#ffffff` is not a loose brand white — it is `--background` (`oklch(1 0 0)`)
// written in a syntax a `<meta>` accepts. It has to be a literal: the tag is
// emitted into `<head>` and cannot read a custom property.
//
// `colorScheme: 'light'` states the same thing for the UA's own painting — the
// canvas before CSS applies, scrollbars, and any form control — so a visitor whose
// OS is dark gets a white page rather than a dark flash that resolves to white.
// web-ui's `:root` already sets `color-scheme: light` in CSS; this repeats it as a
// meta because the commitment belongs to THIS app, and a light-only site should not
// be depending on a shared sheet's default to stay light.
//
// The moment the site gains a theme, both become the two-entry media form
// (`{ media: '(prefers-color-scheme: dark)', color: … }`) — one is not correct
// without the other. → docs/theme.md, _per-app wiring_.
export const viewport = {
  width: 'device-width',
  initialScale: 1,
  viewportFit: 'cover',
  themeColor: '#ffffff',
  colorScheme: 'light',
};

// Kept as a full sentence rather than assembled from BRAND: a meta description is
// its own form (~155 characters, mechanism first, no call to action), and this one
// is the only place the whole argument gets to be prose. Google truncates past
// roughly 160, so the room is already spent.
// Says WHAT WE STORE, and does not name a component. Two rewrites got this wrong
// before landing here, and both failures are worth keeping:
//
//   - "the server holds ciphertext and nothing else" — flatly false, and
//     contradicted by our own /privacy, which inventories a username, a public
//     key, wrapped key blobs, sessions and a subscription row, none of it
//     ciphertext.
//   - "the SYNC server holds only ciphertext" — narrowing to a component reads as
//     precision and is a fiction: there is no separate sync server.
//     `bracemark-api` is ONE Worker serving auth, sync AND billing, over a
//     username directory, an accounts shard, a sessions DB, a purchases table and
//     R2 (apps/bracemark-api/wrangler.jsonc). The same host that holds the
//     ciphertext holds the username in the clear, so scoping the claim to "sync"
//     bought nothing except a component a reader cannot find.
//
//   - "…never a link" — which is what this sentence used to end on, and which is
//     the same error one step subtler: it is a claim about what we SEE, and
//     `bracemark-extractor` sees a plaintext URL by construction. A server that
//     fetches a page on your behalf has to be told which page, so the opt-in Plus
//     path hands ours the address in the clear (docs/link-extraction.md, _server
//     extraction_). The clause was true of `bracemark-api` and false of us.
//
//
//   - "we hold your username, your plan, and ciphertext" — the version this one
//     replaces, and the subtlest of the four. Everything in it is TRUE; what is
//     wrong is the shape. It reads as an inventory and closes at two plaintext
//     fields, when `bracemark-api` also holds the PUBLIC KEY a sign-in signature
//     is checked against and a SESSIONS row per signed-in device — both of which
//     the landing page's `Our blindness` entry and /privacy name out loud. So the
//     most-published sentence we own was the least accurate one, and a reader who
//     went to check found two fields it had left out. A short enumeration invites
//     completeness in a way a scoped claim does not: this slot is ~155 characters
//     and can never carry the real list, so it must not look like it is trying.
//     The fix is to SCOPE rather than to enumerate — the claim is now about the
//     LIBRARY, which is the one thing here that really is ciphertext-only, and it
//     survives any field we ever add to the account record. The workspace tripwire
//     spells the safe form the same way ("never sees your library in plaintext").
//     If you find yourself wanting to name the account fields back into this
//     string, the answer is /privacy, which exists to hold the whole list.
// So: the claim is SCOPED rather than enumerated. It is about the library, which
// is ciphertext whatever the extraction setting says, and it says what we cannot
// do with it rather than reciting what else we happen to hold. A boundary we can
// point at survives any amount of re-architecting behind it, and it cannot be
// falsified by a field being added on the other side of it.
// 158 characters, inside the ~160 Google shows.
//
// ⚠ THE SAME SENTENCE IS IN bracemark-web's `app/layout.tsx`, and the two must
// move together. That app is a separate origin and cannot import this config, so
// a comment in each naming the other is the whole of what holds them — the
// pattern the lockup measurements already use.
const DESCRIPTION =
  'Bracemark is an end-to-end encrypted bookmark manager. Links are encrypted on your device before they sync: of your library we hold ciphertext we cannot open.';

// The tagline itself, verbatim from shared's brand/brand.ts, so the OG
// title, the hero, and every store listing say one sentence rather than four
// versions of it. 63 characters — past where Google truncates a title in results,
// which is accepted here: the tagline IS the pitch, and the brand name and the
// category both land inside the first 40.
const TITLE = `${BRAND.name} — ${BRAND.tagline}`;

export const metadata: Metadata = {
  // This app serves the APEX (docs/hosting.md) — bracemark-web serves `app.` and
  // sets its own metadataBase. Card images, which must be absolute, resolve against
  // this origin and live in this app's `src/app/` (see the note above `openGraph`).
  metadataBase: new URL(SITE_URL),
  title: {
    default: TITLE,
    template: '%s · Bracemark',
  },
  description: DESCRIPTION,
  // The card image is a FILE CONVENTION, not a path in this object:
  // `opengraph-image.png` and `twitter-image.png` sit beside this file, the way
  // `icon*.png`, `apple-icon.png` and `favicon.ico` already do. Next emits
  // `og:image`/`twitter:image` absolute against `metadataBase` and reads `width`,
  // `height` and `type` off the PNG itself, so nothing here has to stay true to a
  // file on disk.
  //
  // It WAS a literal — `/twitter-card-image-pattern1.png`, twice here and twice in
  // bracemark-web's layout, over a byte-identical PNG in each app's `public/`. It
  // is deliberately NOT hoisted into shared's brand/brand.ts beside `SOCIAL`: that
  // file holds facts with exactly ONE truth (one handle, one repo, one company),
  // and a second spelling is a wrong spelling. A card image is not that — it is two
  // assets on two origins, and `platform:agnostic` shared can hold the string but
  // can never hold the PNG. A shared constant would have pinned the PATH while
  // pinning nothing about either FILE, and turned a rename into a three-place edit
  // where getting two of them breaks the app you did not touch.
  //
  // `twitter-image.png` is a byte-identical copy of the og one, and not redundant:
  // with only the og file Next emits no `twitter:image` tag at all. X does fall
  // back to `og:image`, but that is X's behaviour to change and not ours, and this
  // block published both tags before.
  openGraph: {
    title: TITLE,
    description: DESCRIPTION,
    siteName: 'Bracemark',
    url: SITE_URL,
    type: 'website',
  },
  twitter: {
    title: TITLE,
    description: DESCRIPTION,
    card: 'summary_large_image',
    // The @-form, from `SOCIAL` in @stxapps/shared — never retyped here.
    site: SOCIAL.handle,
  },
};

// No ThemeProvider and no pre-paint theme script here, unlike bracemark-web's root
// layout. The theme's source of truth is the user's synced settings, read through
// `@stxapps/web-react` (Dexie) — a data layer this site must not pull in, and could
// not read anyway: it's a different origin, so it doesn't even share bracemark-web's
// localStorage mirror. The marketing pages are **light-only**, and that is a decision
// rather than a gap: the other three properties all support the four-mode theme
// (docs/theme.md), this one deliberately does not.
//
// The pages are nonetheless written against the shadcn TOKENS (`bg-background`,
// `text-muted-foreground`, `border-border`) rather than literal greys, so the
// GREYSCALE half of a theme would come free. What would not is the site's own accent
// ramp — `--color-signal*` in globals.css is authored for a white ground and inverts
// badly (signal falls from 7.88:1 to 2.51:1 on the dark background; the two tints
// become a white panel and a glaring rule) — and the three inverted slabs, whose
// whole rhetoric is that dark is what the server sees. Numbers, and the mechanism to
// use if this is ever revisited, are in docs/theme.md, _per-app wiring_.
export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={cn(inter.variable, bricolage.variable, plexMono.variable)}>
      {/* Page-level canonical metadata replaces `metadata.alternates`, so keep
          the RSS discovery link in the shared document head. */}
      <head>
        <link
          rel="alternate"
          type="application/rss+xml"
          title="Bracemark blog"
          href={`${SITE_URL}/feed.xml`}
        />
      </head>
      <body>
        <div className={cn('flex min-h-dvh flex-col bg-background text-foreground antialiased')}>
          <SiteHeader />
          <main className={cn('flex-1')}>{children}</main>
          <SiteFooter />
        </div>
      </body>
    </html>
  );
}
