import type { Metadata } from 'next';
import { Inter } from 'next/font/google';

import { BRAND, SOCIAL, themeInitScript } from '@stxapps/shared';

import { NoScriptNotice } from '../components/no-script-notice';
import { InnerLayout } from './inner-layout';

import './globals.css';

const inter = Inter({ subsets: ['latin'], display: 'swap', variable: '--font-inter' });

export const viewport = {
  width: 'device-width',
  initialScale: 1,
  viewportFit: 'cover',
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#ffffff' },
    { media: '(prefers-color-scheme: dark)', color: 'rgb(17, 24, 39)' },
  ],
};

// This app's own origin, for the card metadata below. It has to be absolute:
// og:image and twitter:image resolve against `metadataBase`, and the card images
// live in THIS app's `public/` — the apex is bracemark-site, a separate app on a
// separate origin (docs/hosting.md), so a relative URL would resolve to the wrong
// host.
//
// Env-configured for the same reason NEXT_PUBLIC_SITE_URL is (lib/site.ts), and
// under the same var name bracemark-site uses for this same origin: it is
// per-tier (`app.bracemark.com`, `app.dryrunbase.com`, or :3000 in dev) and baked
// at build time, so a hard-coded value makes every staging build advertise
// production's URLs in its OG tags. Throws rather than defaulting — a default is
// what let the hard-coded one pass unnoticed.
const appUrl = process.env.NEXT_PUBLIC_APP_URL;
if (!appUrl) throw new Error('NEXT_PUBLIC_APP_URL is not set');

// ⚠ THIS BLOCK CARRIED BRACE.TO v1's COPY THROUGH THE ENTIRE RENAME, in all three
// description slots at once. The string was "…with technology that empowers you to
// truly own your account and data" — the Stacks-era pitch, and false of this
// product: the account is a row in our own D1, not a wallet the user holds.
// Nothing catches a stale string here — no lint rule, no type error, no test that
// reads a meta tag — and a card carrying the wrong product renders exactly as well
// as a right one, which is the failure mode `SOCIAL` exists to prevent for the
// @-handle one level up. The browser-extension manifest carried the SAME sentence for the same
// reason (stores/listing-copy.ts, the header): nobody had a reason to open the
// file.
//
// TITLE is the tagline, verbatim from `BRAND`, so this origin and the apex say one
// sentence rather than two versions of it (docs/brand-assets.md — _the brand
// lines_: the tagline is the line for an OG title). Never retyped here.
//
// It is the CARD title only, and that is the one place this file departs from
// bracemark-site's otherwise-identical block. On the apex the same string is also
// the document `default`, which is right there: the page it names is the pitch,
// and a visitor arriving from a search result is being sold to. Here the default
// covers /links and /settings — screens someone signed in to and works in, often
// with the tab pinned or one of twenty — and a 63-character tagline in that slot
// truncates to "Bracemark — The boo…" in every one of them, which names the
// product and then wastes the rest of the width saying nothing legible. So the
// document default is the bare word and the card keeps the pitch: a tab is
// wayfinding, a card is an introduction, and they are not the same job.
const TITLE = `${BRAND.name} — ${BRAND.tagline}`;

// DESCRIPTION is written to the same rule as bracemark-site's twin in ITS
// `app/layout.tsx`, and the two are the SAME SENTENCE — keep them that way, and
// edit them together. bracemark-web cannot import the apex's config (separate app,
// separate origin), so a comment naming the other copy is the only thing holding
// them, which is the pattern the lockup already uses.
//
// The rule it is written to: name the plaintext we DO hold, in the same breath as
// the encryption, so the claim is one a reader can check rather than one they have
// to take. Two spellings are barred and both read as MORE rigorous than the honest
// one:
//   - "the server sees nothing" / "ciphertext and nothing else" — flatly false of
//     a Worker that also serves auth and billing (docs/local-first-sync.md).
//   - "never a link" — which this sentence used to end on, and which
//     `bracemark-extractor` falsifies by construction: a server that fetches a page
//     for you has to be told which page, so the opt-in Plus path hands it a
//     PLAINTEXT URL (docs/link-extraction.md, _server extraction_). What is true
//     whatever that setting says is that what we STORE of the library is
//     ciphertext.
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
// 158 characters, inside the ~160 Google shows.
const DESCRIPTION =
  'Bracemark is an end-to-end encrypted bookmark manager. Links are encrypted on your device before they sync: of your library we hold ciphertext we cannot open.';

export const metadata: Metadata = {
  metadataBase: new URL(appUrl),
  // `template` is the apex's, spelled the same way (its `app/layout.tsx`) so a grep
  // for the literal finds both — it is what makes the three routes that set a bare
  // title render as "Sign in · Bracemark" rather than as "Sign in", which is what a
  // tab strip full of them said before. Next applies it to CHILD segments only, so
  // `default` is what the untitled screens (/links, /settings/*) still get, and the
  // `openGraph`/`twitter` titles below are set explicitly and are untouched by it.
  //
  // A page adding its own `title` from here on gets the suffix for free. Setting a
  // full "… · Bracemark" string in a page is now the bug — it renders twice.
  title: {
    default: BRAND.name,
    template: '%s · Bracemark',
  },
  description: DESCRIPTION,
  // The card image is a FILE CONVENTION (`opengraph-image.png` and
  // `twitter-image.png` beside this file), the way `icon*.png`, `apple-icon.png`
  // and `favicon.ico` already are here — not a path literal in this object. Next
  // emits `og:image`/`twitter:image` absolute against `metadataBase` and reads the
  // PNG's own `width`, `height` and `type`, so no string here has to stay true to a
  // file on disk. bracemark-site's layout carries the long form of why the path is
  // per-app rather than a constant in shared's brand/brand.ts next to `SOCIAL`;
  // short version, the asset is two files on two origins and shared can hold the
  // string but never the PNG.
  //
  // `twitter-image.png` is a byte-identical copy of the og one, not a redundancy:
  // with only the og file Next emits no `twitter:image` tag at all.
  openGraph: {
    title: TITLE,
    description: DESCRIPTION,
    siteName: 'Bracemark',
    url: appUrl,
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

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    // `data-build`: which build this document is (next.config.js). The update
    // pill reads it once at load and compares it with the build the service worker
    // holds (lib/build-id.ts) — so it has to be in the DOCUMENT, not only in the
    // bundle. The attribute's name is `BUILD_ATTRIBUTE` there; keep them one.
    <html
      lang="en"
      className={inter.variable}
      suppressHydrationWarning
      data-build={process.env.BUILD_ID}
    >
      <body>
        {/* Set the `.dark` class before paint so there's no flash of the wrong
            theme. Runs synchronously ahead of hydration. */}
        <script dangerouslySetInnerHTML={{ __html: themeInitScript() }} />
        <NoScriptNotice />
        <InnerLayout>{children}</InnerLayout>
      </body>
    </html>
  );
}
