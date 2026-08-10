import {
  type CollectedMeta,
  LINK_TITLE_MAX,
  selectTitleImage,
  type TitleImage,
} from '@stxapps/shared';

// Title + preview-image extraction from a page's HTML, using the Workers-native
// `HTMLRewriter` (a streaming SAX-style parser — no DOM, no JS execution, cheap).
// The extractor runs NO JavaScript, so this is raw-HTML / server-rendered tags only
// (docs "server tier is raw-HTML only"); a JS-shell SPA with no server-side og tags
// degrades to the host fallback at the route, not here.
//
// This file only COLLECTS candidates; WHICH of them becomes the title/image is
// `selectTitleImage` in `@stxapps/shared` (extract/select.ts), shared with every other
// extracting client — bracemark-expo parses the same head with a regex scanner on Hermes,
// and the two tiers must mean the same thing by "the page's title" or a tier upgrade
// would read as a change. Preference order + the http(s)-only URL resolution live
// there.

export type { TitleImage };

export async function extractTitleImage(
  html: Uint8Array<ArrayBuffer>,
  finalUrl: URL,
): Promise<TitleImage> {
  const collected: CollectedMeta = {};

  // Accumulate <title> text across its (possibly chunked) text nodes.
  let titleBuffer = '';

  // Pull a meta tag's content into the right slot, keyed by its og/twitter name.
  // `property` (OpenGraph) and `name` (Twitter/legacy) are both checked — sites use
  // either. The FIRST non-empty value for each key wins (head order ≈ page intent).
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

  const rewriter = new HTMLRewriter()
    .on('title', {
      text(chunk) {
        // Bound the buffer so a pathological <title> can't grow unboundedly; the
        // final cap is applied in cleanTitle.
        if (titleBuffer.length < LINK_TITLE_MAX * 2) titleBuffer += chunk.text;
      },
    })
    .on('meta', {
      element(el) {
        setMeta(el.getAttribute('property'), el.getAttribute('content'));
        setMeta(el.getAttribute('name'), el.getAttribute('content'));
      },
    })
    .on('link[rel~="image_src"]', {
      element(el) {
        const href = el.getAttribute('href');
        if (href && href.trim() !== '') collected.imageSrc ??= href.trim();
      },
    });

  // Drive the rewriter by consuming the transformed body. The input is already
  // size-capped (readCappedBytes), so buffering it here is bounded.
  const transformed = rewriter.transform(new Response(html));
  await transformed.arrayBuffer();
  collected.docTitle = titleBuffer;

  return selectTitleImage(collected, finalUrl);
}
