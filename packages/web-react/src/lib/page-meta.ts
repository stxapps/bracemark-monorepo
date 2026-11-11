import type { CollectedMeta } from '@stxapps/shared';

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
// One collector for both, so a preview taken from the live page means the same thing
// on a phone as in a browser. It is a DUMB collector: which tag wins is
// `selectTitleImage` (@stxapps/shared extract/select.ts), run by the caller outside the
// page, so every tier means the same thing by "the page's title" and a tier upgrade is
// an improvement rather than a change.
//
// Reached through its own subpath export, never the barrel, for the reason
// reader-doc-from-page.ts gives: it is bundled into scripts that run inside a
// stranger's page. Only a TYPE comes from the barrel, and a whole `import type`
// statement is erased at build.
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
