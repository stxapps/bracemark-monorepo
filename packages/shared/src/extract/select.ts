import { cleanTitle } from '../sync/extraction';

// WHICH tag a page's title / preview image / favicon comes from — the selection rules,
// separated from the PARSING that collects the candidates. Every extracting client
// parses differently (the Workers extractor drives `HTMLRewriter`; bracemark-expo scans the
// head with a bounded regex on Hermes, where there's no DOM; the extension reads the
// live DOM), but they must all MEAN the same thing by "the page's title" — otherwise a
// tier upgrade (docs/link-extraction.md — the extraction entity) would rewrite
// `extraction.title`/`imageId` with a DIFFERENT tag's value and read as a change rather
// than an improvement. So: parse per platform, select here.
//
// The same split, and the same reason, as `cleanTitle` in sync/extraction.ts — which is
// the step AFTER this one (select the raw value, then normalize it once). This file is
// deliberately pure and DOM-free: it takes what a parser collected, never markup.
//
// Preference order, matching what real pages mean:
//   title   → og:title, else <title>
//   image   → og:image(:url|:secure_url), else twitter:image, else <link rel=image_src>
//   favicon → the smallest declared icon at least ICON_MIN_PX across, else the first
//             declared icon, else the apple-touch fallback (see selectFaviconUrl)
// Image and favicon URLs are resolved against the FINAL (post-redirect) page URL and
// dropped unless they're http(s), so a `data:`/`javascript:` href can never reach a
// fetcher or the extract contract's `httpUrlSchema` (where one bad og:image would
// otherwise reject a whole batch).

// One `<link rel=…>` a parser saw in the head. `rel` is the raw attribute (possibly
// multi-token, e.g. `shortcut icon`); `sizes`/`type` are the raw attributes too —
// selectFaviconUrl does the interpreting so parsers stay dumb collectors.
export interface CollectedIcon {
  href: string;
  rel: string;
  sizes?: string;
  type?: string;
}

// The candidate bag a parser fills. Every field is the FIRST non-empty value seen for
// that key (head order ≈ page intent), left undefined when the page declared none —
// which is what makes the `??` chains below express the preference order directly.
// `icons` is the exception: favicon choice needs to compare candidates, so parsers
// collect them all, in document order.
export interface CollectedMeta {
  ogTitle?: string;
  docTitle?: string;
  ogImage?: string;
  ogImageUrl?: string;
  ogImageSecure?: string;
  twitterImage?: string;
  imageSrc?: string;
  icons?: CollectedIcon[];
}

export interface TitleImage {
  title?: string;
  imageUrl?: string;
}

// Resolve a (possibly relative) URL against the page URL and keep it only if it's
// http(s). Returns undefined for unparseable / non-web URLs (e.g. a `data:` URI — we
// don't proxy or download those).
export function resolveHttpUrl(raw: string | undefined, base: URL): string | undefined {
  if (!raw) return undefined;

  let abs: URL;
  try {
    abs = new URL(raw, base);
  } catch {
    return undefined;
  }

  if (abs.protocol !== 'http:' && abs.protocol !== 'https:') return undefined;
  return abs.toString();
}

// The `titleImage` facet's two values. Select first, clean once: `cleanTitle` caps to
// LINK_TITLE_MAX and drops blanks, so the result always satisfies
// `extractionSchema.title` no matter which client produced it.
export function selectTitleImage(collected: CollectedMeta, base: URL): TitleImage {
  const title = cleanTitle(collected.ogTitle ?? collected.docTitle);
  const rawImage =
    collected.ogImage ??
    collected.ogImageUrl ??
    collected.ogImageSecure ??
    collected.twitterImage ??
    collected.imageSrc;

  return { title, imageUrl: resolveHttpUrl(rawImage, base) };
}

// The smallest icon we'd rather have: below this an icon is a 16px favicon that looks
// soft at list-row size on a 3x screen. Not a hard filter — a page that declares only
// a 16px icon still yields it (an exact-size match beats a monogram).
const ICON_MIN_PX = 32;

// Icons we skip rather than fetch, because the fetch could only end in a `none` verdict:
// SVG (no RN-renderable bytes without a vector lib, and favicon-store's sniff rejects
// it) and `mask-icon` (Safari pinned-tab monochrome SVG by definition).
function isRenderableIcon(icon: CollectedIcon): boolean {
  const rel = icon.rel.toLowerCase();
  if (rel.split(/\s+/).includes('mask-icon')) return false;
  if (icon.type?.toLowerCase().includes('svg')) return false;
  return !/\.svg($|[?#])/i.test(icon.href);
}

// The largest dimension a `sizes` attribute declares (`"32x32 16x16"` → 32), or
// undefined when absent/`any`/unparseable — `any` means a scalable icon, which is the
// SVG case we've already dropped, so treating it as unsized is right.
function iconPx(icon: CollectedIcon): number | undefined {
  if (!icon.sizes) return undefined;
  let best: number | undefined;
  for (const token of icon.sizes.toLowerCase().split(/\s+/)) {
    const match = /^(\d+)x(\d+)$/.exec(token);
    if (!match) continue;
    const px = Math.max(Number(match[1]), Number(match[2]));
    if (best === undefined || px > best) best = px;
  }
  return best;
}

// The page's declared favicon — the accuracy upgrade over guessing `/favicon.ico`
// (docs/link-extraction.md — _favicons_). Only ever called by a client that ALREADY
// fetched this page's HTML, so it costs no disclosure the page fetch didn't pay; it is
// not a licence for a standalone favicon fetch, which stays behind the client's
// extraction opt-in.
//
// Choice, in order: the SMALLEST declared icon at least ICON_MIN_PX across (a
// list-row icon wants ~32–64px, not a 512px PWA tile we'd download and shrink), else
// the first icon with no declared size (most pages just say `rel="icon"`), else the
// first renderable candidate at all — which is where a 180px `apple-touch-icon` gets
// picked up as the last resort. Returns undefined when the page declares no usable
// icon; the caller falls back to its `/favicon.ico` guess.
export function selectFaviconUrl(collected: CollectedMeta, base: URL): string | undefined {
  const candidates = (collected.icons ?? []).filter(
    (icon) => icon.href.trim() !== '' && icon.rel.toLowerCase().includes('icon'),
  );
  if (candidates.length === 0) return undefined;

  const renderable = candidates.filter(isRenderableIcon);
  if (renderable.length === 0) return undefined;

  let bestSized: { icon: CollectedIcon; px: number } | undefined;
  let firstUnsized: CollectedIcon | undefined;
  for (const icon of renderable) {
    const px = iconPx(icon);
    if (px === undefined) {
      firstUnsized ??= icon;
      continue;
    }
    if (px < ICON_MIN_PX) continue;
    if (bestSized === undefined || px < bestSized.px) bestSized = { icon, px };
  }

  const chosen = bestSized?.icon ?? firstUnsized ?? renderable[0];
  return resolveHttpUrl(chosen.href, base);
}
