import type { MDXComponents } from 'mdx/types';
import Link from 'next/link';

import {
  APP_STORE_URL,
  BRAND,
  CHROME_WEB_STORE_URL,
  entitlementsOf,
  FIREFOX_ADDONS_URL,
  PLAN_LABELS,
  PLAY_STORE_URL,
  SCREENSHOT_CAPTIONS,
  SIGNATURE,
} from '@stxapps/shared';
import { cn } from '@stxapps/web-ui/lib/utils';

import { APP_URL } from '../lib/site';

// Everything a /docs page or /blog post may use beyond plain Markdown. The pages
// import nothing (docs.spec.ts and blog.spec.ts hold that), so this map is the
// whole vocabulary, and a tag not in it fails the build rather than rendering
// blank.
//
// Plain elements are NOT restyled here: `.mdx-prose` in globals.css styles
// h2/p/ul/table/code as a document, the way `.legal-prose` does for /terms and
// /privacy, so a page reads as Markdown to whoever edits it. The overrides are
// only for behaviour.

// An on-site path goes through next/link; anything else is a plain anchor. The
// app is NOT on-site — it is another origin, and next/link across origins is the
// mistake docs/hosting.md, _crossing an origin_, describes. `AppLink` below is
// how a page links into it.
function Anchor({ href = '', children, ...rest }: React.ComponentProps<'a'>) {
  if (href.startsWith('/') && !href.startsWith('//')) {
    return <Link href={href}>{children}</Link>;
  }
  return (
    <a href={href} {...rest}>
      {children}
    </a>
  );
}

/**
 * A link into bracemark-web, e.g. `<AppLink path="/settings/data">Settings →
 * Data</AppLink>`. The origin differs per tier (APP_URL, lib/site.ts), which is
 * why a page can't type it.
 */
function AppLink({ path, children }: { path: string; children: React.ReactNode }) {
  return <a href={`${APP_URL}${path}`}>{children}</a>;
}

const STORE_URLS = {
  chrome: CHROME_WEB_STORE_URL,
  firefox: FIREFOX_ADDONS_URL,
  ios: APP_STORE_URL,
  android: PLAY_STORE_URL,
} as const;

/**
 * A store listing, e.g. `<StoreLink store="chrome">Chrome Web Store</StoreLink>`,
 * read from shared's stores/listings.ts rather than typed, so it moves with the
 * landing page's badge row.
 */
function StoreLink({
  store,
  children,
}: {
  store: keyof typeof STORE_URLS;
  children: React.ReactNode;
}) {
  // tsc never reads the MDX, so the `store` union guards nothing there: a typo
  // must fail the build rather than ship href="undefined".
  const href = STORE_URLS[store];
  if (!href) throw new Error(`StoreLink: unknown store "${store}"`);
  return <a href={href}>{children}</a>;
}

/** The free plan's link cap, read from the plan table rather than typed. */
function FreeLinks() {
  return entitlementsOf('free').maxLinks;
}

/** A plan name, kept in step with the app and pricing page. */
function PlanName({ plan }: { plan: keyof typeof PLAN_LABELS }) {
  return PLAN_LABELS[plan];
}

// The demo clip: 1920x1080, silent, about eighteen seconds. The mp4 and its
// poster are generated artifacts in `public/video/`, stamped in
// assets.stamp.json — every line of type in the film is a constant from
// `@stxapps/shared`, and `npm run check:assets` fails when one of them moves
// (docs/brand-assets.md, _the generated pictures_). Nothing fails when a file is
// simply swapped for another name, so the two paths below are the join.
//
// SAME-ORIGIN, and not an embed. /privacy and the FAQ say Bracemark loads no
// third-party code outside one screen of the app, and the apex CSP has no
// `frame-src` and no `media-src`: a file under `public/` plays under
// `default-src 'self'` with the policy untouched, where a hosted player would
// falsify both sentences and widen the header (docs/hosting.md, _security
// headers_).
export const DEMO_CLIP = {
  src: '/video/demo.mp4',
  poster: '/video/demo.poster.png',
  width: 1920,
  height: 1080,
  // The film has no sound, so its type is all of it to a reader who can't see
  // the picture: this is every line it shows, in the order it shows them, built
  // from the constants it is set in rather than typed again. The one bend is
  // the signature panel. Its server half read out field by field is a file id
  // and a byte count, which describes nothing, so it is the sentence the
  // landing page sets under the same panel; and the device half, which is a
  // photograph of a row, gets three words for what the row is.
  alt:
    [
      `${BRAND.name} — ${BRAND.tagline}`,
      `${SIGNATURE.deviceLabel}: a saved link`,
      `${SIGNATURE.serverLabel}: ${SIGNATURE.caption.replace(/\.$/, '')}`,
      SCREENSHOT_CAPTIONS.saveTab,
      SCREENSHOT_CAPTIONS.encryptedBeforeSync,
      SCREENSHOT_CAPTIONS.searchNotOurs,
    ].join('. ') + `. ${BRAND.slogan}`,
} as const;

/**
 * The demo clip, e.g. `<DemoClip />` above a post's first heading.
 *
 * It plays when the reader presses play and not before: its argument is set in
 * type from the first frame, so a film already running when it scrolls into
 * view has lost its opening line, and motion on this site answers a person
 * (globals.css, on page-load animation). `preload="none"` follows from that —
 * the poster is frame 0, so the box is complete without a byte of the mp4. No
 * `<track>`: there is no audio to caption, and the text alternative is the
 * label.
 */
function DemoClip() {
  return (
    <figure
      className={cn(
        'mt-8 overflow-hidden rounded-2xl border border-border bg-card shadow-sm first:mt-0',
      )}
    >
      <video
        src={DEMO_CLIP.src}
        poster={DEMO_CLIP.poster}
        width={DEMO_CLIP.width}
        height={DEMO_CLIP.height}
        aria-label={DEMO_CLIP.alt}
        controls
        playsInline
        preload="none"
        className={cn('block aspect-video h-auto w-full')}
      />
    </figure>
  );
}

export const MDX_COMPONENTS: MDXComponents = {
  a: Anchor,
  AppLink,
  DemoClip,
  FreeLinks,
  PlanName,
  StoreLink,
};
