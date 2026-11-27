import type { CollectedMeta } from '@stxapps/shared';
// Values from zod-free subpaths only — see the header's last paragraph.
import { scanHtmlMeta } from '@stxapps/shared/html/scan-meta';
import { canonicalUrlKey } from '@stxapps/shared/url/url';

// The title + preview-image candidates of a LIVE page, read INSIDE that page — the
// live-DOM collector of the three that fill a `CollectedMeta` (the others parse
// markup: bracemark-extractor's `html.ts` over HTMLRewriter, expo-react's
// `parse-html-head.ts` over a bounded regex). Two callers, each injecting it into a
// page the user has open:
//
//   - the browser extension, as a bundled unlisted script
//     (apps/bracemark-extension entrypoints/page-meta.ts) — `captureTitleImage`;
//   - expo's capture screen, inside the script it injects into its WebView
//     (lib/webview-capture.ts, bundled by tools/scripts/generate-reader-capture.ts) —
//     _Update preview_.
//
// Both call `collectLivePageMeta`, which is `collectPageMeta` plus one guard: a head
// that went stale after an in-page move (_a stale head_, below).
//
// One collector for both, so a preview taken from the live page means the same thing
// on a phone as in a browser. It is a DUMB collector: which tag wins is
// `selectTitleImage` (@stxapps/shared extract/select.ts), run by the caller outside the
// page, so every tier means the same thing by "the page's title" and a tier upgrade is
// an improvement rather than a change.
//
// Reached through its own subpath export, never the barrel, for the reason
// reader-doc-from-page.ts gives: it is bundled into scripts that run inside a
// stranger's page. Only a TYPE comes from the barrel, and a whole `import type`
// statement is erased at build; the values come by subpath.
export function collectPageMeta(page: Document): { href: string; collected: CollectedMeta } {
  const collected: CollectedMeta = {};

  // The FIRST non-empty value for each key wins (head order ≈ page intent) — hence
  // the document-order walk below rather than a per-key `querySelector`, which would
  // impose a preference the other two collectors don't have. `property` (OpenGraph)
  // and `name` (Twitter/legacy) are both read, since sites use either.
  //
  // `twitter:image:src` is the legacy spelling of `twitter:image` and aliases onto
  // the same slot — a SPELLING, not a rank, which is why select.ts has no field for
  // it. Keep this switch in step with html.ts / parse-html-head.ts: a tag one
  // collector accepts and another drops is the same tier disagreement as a
  // reordered preference chain.
  //
  // Blank stays absent, never '': select.ts's chains are `??`, so an empty string
  // would win over the fallback behind it.
  //
  // Nothing here decodes character references, and nothing should: `getAttribute`
  // and `document.title` are DOM reads, so `&rsquo;` is already `’` by the time we
  // see it. That is the one thing this collector gets for free — the other two
  // parse markup themselves and have to call `decodeHtmlEntities` (shared
  // html/entities.ts) to reach the same value. Calling it HERE would decode a
  // second time and turn a title that really displays `&amp;` into `&`.
  const setMeta = (key: string | null, content: string | null): void => {
    if (!key || !content) return;

    const value = content.trim();
    if (value === '') return;

    switch (key.toLowerCase()) {
      case 'og:title':
        collected.ogTitle ??= value;
        break;
      case 'og:image':
        collected.ogImage ??= value;
        break;
      case 'og:image:url':
        collected.ogImageUrl ??= value;
        break;
      case 'og:image:secure_url':
        collected.ogImageSecure ??= value;
        break;
      case 'twitter:image':
      case 'twitter:image:src':
        collected.twitterImage ??= value;
        break;
      default:
        break;
    }
  };

  page.querySelectorAll('meta').forEach((el) => {
    setMeta(el.getAttribute('property'), el.getAttribute('content'));
    setMeta(el.getAttribute('name'), el.getAttribute('content'));
  });

  const imageSrc = page.querySelector('link[rel~="image_src"]')?.getAttribute('href')?.trim();
  if (imageSrc) collected.imageSrc = imageSrc;
  if (page.title.trim() !== '') collected.docTitle = page.title;

  // The page's address rides along as the base: it's the FINAL (post-redirect) URL,
  // which is what resolves a relative og:image correctly and what the image fetch
  // re-checks against before fetching.
  return { href: page.location?.href ?? page.URL, collected };
}

// --- a stale head --------------------------------------------------------------
//
// A page that moves in place (`history.pushState` — a single-page app) changes its
// address and, usually, its `<title>`, but nothing makes it rewrite the rest of its
// head. YouTube doesn't: tap another video and `location.href` and `document.title`
// are the new video's while og:title, og:image and og:url are still the first one's.
// Read as they stand, _Update preview_ said "Preview updated" over the first video's
// title and picture, and the browser extension saved the new link with them.
// docs/link-extraction-keep.md, _a page moved in place_.
//
// THE SIGNAL. The navigation entry (`performance.getEntriesByType('navigation')`)
// keeps the address the document was LOADED at, whatever the page has pushed since.
// When it and the address now are the same page (`canonicalUrlKey`), the head is the
// one that came with this address, and is read as it stands. When they differ, the
// head may be the first page's — unless its own og:url names the page shown, which a
// site that does rewrite its head (Next.js metadata, react-helmet) rewrites with the
// rest; that page is read as it stands too, so a site whose server sends one generic
// head for every route keeps the right tags its scripts set.
//
// THE FIX. Otherwise the page fetches ITS OWN ADDRESS again — same origin, so its own
// cookies, and no reload: the video keeps playing and nothing on screen moves — and
// the tags are read from that answer. The response is text, scanned by the shared
// markup collector (scan-meta.ts) rather than parsed: YouTube enforces Trusted Types,
// so `DOMParser` throws in its page. When that fetch can't be had (offline, a slow
// site, a redirect to a sign-in page, not HTML) the stale tags are DROPPED rather
// than trusted: the title falls back to `document.title`, which the page does keep
// current, and there is no image — a missing preview is fixable by a second tap, a
// wrong one says "Preview updated" over the wrong picture.
//
// The GET asks for the address a reload would, on a tap the user made on that page,
// and never runs otherwise. It is a `fetch`, not a navigation (`Sec-Fetch-Mode: cors`,
// only an `Accept` header), so a server that answers on those may answer differently.

// The re-fetch's own deadline — inside the capture screen's wait for the answer
// (META_TIMEOUT_MS, 10 s, in the app's features/capture/use-page-capture.ts).
export const PAGE_REFETCH_TIMEOUT_MS = 6_000;
// How much of the answer is read and scanned. m.youtube.com's watch page is ~700 KB,
// its desktop one ~1.4 MB, and their og tags sit past the middle.
export const PAGE_REFETCH_MAX_CHARS = 3 * 1024 * 1024;

// The fields a head carries — everything `collectPageMeta` reads except `<title>`,
// which the page keeps current.
const HEAD_FIELDS = [
  'ogTitle',
  'ogImage',
  'ogImageUrl',
  'ogImageSecure',
  'twitterImage',
  'imageSrc',
] as const satisfies readonly (keyof CollectedMeta)[];

function samePage(a: string | null | undefined, b: string): boolean {
  if (!a) return false;
  const key = canonicalUrlKey(a);
  return key !== null && key === canonicalUrlKey(b);
}

// The address the document was loaded at, or undefined where the runtime keeps no
// navigation entry — and then nothing can be said, so the head is read as it stands.
function loadedAt(page: Document): string | undefined {
  try {
    const perf = page.defaultView?.performance ?? globalThis.performance;
    const entry = perf?.getEntriesByType?.('navigation')[0];
    return typeof entry?.name === 'string' && entry.name !== '' ? entry.name : undefined;
  } catch {
    return undefined;
  }
}

// Whether the head may describe another page than the one at `href` (the signal above).
export function headMayBeStale(page: Document, href: string): boolean {
  const loaded = loadedAt(page);
  if (loaded === undefined || samePage(loaded, href)) return false;
  let ogUrl: string | undefined;
  for (const el of Array.from(page.querySelectorAll('meta'))) {
    const keys = [el.getAttribute('property'), el.getAttribute('name')];
    const content = el.getAttribute('content')?.trim();
    if (content && keys.some((key) => key?.toLowerCase() === 'og:url')) {
      ogUrl = content;
      break;
    }
  }
  return !samePage(ogUrl, href);
}

// A response's text, decoded as the page itself was and read no further than `maxChars`.
async function readCappedText(res: Response, charset: string, maxChars: number): Promise<string> {
  if (!res.body) return (await res.text()).slice(0, maxChars);
  let decoder: TextDecoder;
  try {
    decoder = new TextDecoder(charset || 'utf-8');
  } catch {
    decoder = new TextDecoder('utf-8');
  }
  const reader = res.body.getReader();
  let text = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    text += decoder.decode(value, { stream: true });
    if (text.length >= maxChars) {
      await reader.cancel().catch(() => undefined);
      break;
    }
  }
  return text.length > maxChars ? text.slice(0, maxChars) : text;
}

// The head tags of `href` as its server sends them today, or undefined when they
// couldn't be had.
async function refetchHead(
  page: Document,
  href: string,
  fetchPage: typeof fetch,
): Promise<CollectedMeta | undefined> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PAGE_REFETCH_TIMEOUT_MS);
  try {
    const res = await fetchPage(href, {
      signal: controller.signal,
      headers: { Accept: 'text/html,application/xhtml+xml' },
    });
    if (!res.ok) return undefined;
    // A redirect elsewhere (a sign-in page, a consent wall) answers for another page.
    if (res.url && !samePage(res.url, href)) return undefined;
    const type = res.headers.get('content-type') ?? '';
    if (!/^\s*(text\/html|application\/xhtml\+xml)/i.test(type)) return undefined;
    const text = await readCappedText(res, page.characterSet, PAGE_REFETCH_MAX_CHARS);
    return scanHtmlMeta(text, { maxChars: PAGE_REFETCH_MAX_CHARS, through: 'document' });
  } catch {
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}

// What both callers inject: the live page's candidates, with a stale head's tags
// replaced by its address's own, or dropped when those couldn't be had. Nothing a server
// sends can make it throw. A PAGE can: the capture WebView's injected script runs in the
// page's own world, where the page may have replaced `querySelectorAll`, `Array.from` or
// `fetch` — so every caller catches (webview-capture.ts, the browser extension's
// `executeScript` result), and the app's own deadline bounds a re-read the page holds.
export async function collectLivePageMeta(
  page: Document,
  fetchPage: typeof fetch = (input, init) => fetch(input, init),
): Promise<{ href: string; collected: CollectedMeta }> {
  const live = collectPageMeta(page);
  if (!headMayBeStale(page, live.href)) return live;

  const collected: CollectedMeta = {};
  const fresh = await refetchHead(page, live.href, fetchPage);
  if (fresh) {
    for (const field of HEAD_FIELDS)
      if (fresh[field] !== undefined) collected[field] = fresh[field];
  }
  // The `<title>` the page keeps current, else the server's: a single-page app's server
  // often sends a generic one (m.youtube.com's is "YouTube" on every video).
  const docTitle = live.collected.docTitle ?? fresh?.docTitle;
  if (docTitle !== undefined) collected.docTitle = docTitle;
  return { href: live.href, collected };
}
