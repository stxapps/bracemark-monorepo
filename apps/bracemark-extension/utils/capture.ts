// The active-tab capture functions (`tier: 'active-page'`). Each runs against the
// CURRENTLY FOCUSED tab — valid because every capture is triggered by a popup the
// user opened on that tab (auto on save for the cheap facets, a button click for the
// heavy ones). All the privileged work lives here in the background: content scripts
// get no CORS exemption, so the page-reading is done via `scripting.executeScript`
// (injected on demand — no persistent content script) and the screenshot via
// `tabs.captureVisibleTab` (only callable from an extension context).
//
// An injected `func` is a dumb COLLECTOR, never a decider: what a page's title/image
// MEAN is `@stxapps/shared` extract/select.ts's call, shared with the other extracting
// tiers — see captureTitleImage's header for why that survives the page/bundle split.
//
// READMODE NOTE: a compact inline reader for now (clone → strip non-content → take
// the article/main/body HTML). The planned upgrade is @mozilla/readability (already
// a dependency) injected as a bundled content-script file and run over the live DOM;
// kept inline here so the scaffold needs no extra entrypoint.

import { type CollectedMeta, selectTitleImage, sniffImageMime, utf8 } from '@stxapps/shared';

// Ceiling on a preview image we'll carry back from the page. The in-page fetch has already
// buffered the blob by the time we can measure it (same limitation the expo worker
// documents), so this doesn't abort a transfer — it bounds what gets base64-inflated into
// a data URL and handed across the injection boundary, and what we'd store. Matches the
// expo worker's cap so no tier stores a preview another would have refused.
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;

// A `data:`/blob URL → raw bytes. The service worker can fetch `data:` URLs, so this
// is the simplest decode for the base64 the in-page funcs hand back.
async function dataUrlToBytes(dataUrl: string): Promise<Uint8Array> {
  return new Uint8Array(await (await fetch(dataUrl)).arrayBuffer());
}

// --- titleImage --------------------------------------------------------------

// COLLECT (in-page) → SELECT (here) → FETCH (in-page). Same three steps, and the same
// middle step, as every other extracting client: the injected funcs are dumb collectors
// filling `CollectedMeta`, and WHICH candidate wins is `selectTitleImage`'s call
// (@stxapps/shared extract/select.ts), shared with bracemark-extractor's `HTMLRewriter` pass
// (`html.ts`) and bracemark-expo's head scanner (`parse-html-head.ts`). That's what keeps a
// tier upgrade an improvement rather than a change — `extension:fg` re-extracting a page
// a `server` tier already saw must not rewrite `extraction.title`/`imageId` with a
// DIFFERENT tag's value (docs/link-extraction.md — the extraction entity).
//
// Why the selection can't just happen in-page: `scripting.executeScript`'s `func` is
// serialized into the page's world and can't reach bundle code. But its RESULT comes
// back here, in the background, where the bundle is — so only the byte FETCH is truly
// stuck in the page. And it is stuck there: `host_permissions` is the api origin only
// (no `<all_urls>`, see wxt.config.ts), so a service-worker `fetch` of a third-party
// image host gets no CORS exemption, while the page's own context usually can read it.
// Hence the second injection, with the selected URL passed via `args`.
//
// Returns the SELECTED (already cleanTitle'd — select's last step) title and the raw
// image bytes; the consumer (`extraction-worker.ts`) still runs resizeImage, which needs
// a canvas the injected func doesn't have.
export async function captureTitleImage(
  tabId: number,
): Promise<{ title?: string; image?: Uint8Array }> {
  const [collection] = await browser.scripting.executeScript({
    target: { tabId },
    func: () => {
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

      document.querySelectorAll('meta').forEach((el) => {
        setMeta(el.getAttribute('property'), el.getAttribute('content'));
        setMeta(el.getAttribute('name'), el.getAttribute('content'));
      });

      const imageSrc = document
        .querySelector('link[rel~="image_src"]')
        ?.getAttribute('href')
        ?.trim();
      if (imageSrc) collected.imageSrc = imageSrc;
      if (document.title.trim() !== '') collected.docTitle = document.title;

      // `location.href` rides along as the base: it's the FINAL (post-redirect) URL,
      // which is what resolves a relative og:image correctly and what the second
      // injection re-checks against before fetching.
      return { href: location.href, collected };
    },
  });

  const page = collection?.result as { href: string; collected: CollectedMeta } | undefined;
  if (!page) return {};

  let base: URL;
  try {
    base = new URL(page.href);
  } catch {
    return {};
  }

  // `selectTitleImage` also resolves the winner against `base` and drops it unless it's
  // http(s) — so the URL handed to the in-page fetch below can never be a `data:` or
  // `javascript:` href (and a page's `data:` og:image is skipped by every tier alike).
  const { title, imageUrl } = selectTitleImage(page.collected, base);
  if (!imageUrl) return { title };

  const [download] = await browser.scripting.executeScript({
    target: { tabId },
    args: [imageUrl, page.href, MAX_IMAGE_BYTES],
    func: async (url: string, collectedFrom: string, maxBytes: number) => {
      // The tab can navigate between the two injections; fetching then would attribute
      // ANOTHER page's image to this link. Bail — the facet fails and can be retried.
      if (location.href !== collectedFrom) return '';
      try {
        const res = await fetch(url);
        if (!res.ok) return '';
        const blob = await res.blob();
        // Measured here, in the page, so an oversized image is dropped BEFORE it's
        // base64-inflated and copied across the boundary.
        if (blob.size === 0 || blob.size > maxBytes) return '';
        return await new Promise<string>((resolve) => {
          const reader = new FileReader();
          reader.onload = () => resolve(typeof reader.result === 'string' ? reader.result : '');
          reader.onerror = () => resolve('');
          reader.readAsDataURL(blob);
        });
      } catch {
        // Image on a CORS-hostile origin — skip the image, keep the title.
        return '';
      }
    },
  });

  const dataUrl = (download?.result as string | undefined) ?? '';
  if (!dataUrl) return { title };

  // The bytes are only a preview if they're actually a raster image. `res.ok` is not that
  // check: an og:image URL that 200s with a soft-404 HTML page yields bytes the UI can
  // never render, and `resizeImage` won't catch it either — it deliberately passes an
  // undecodable input straight through rather than throwing. So sniff, and settle
  // title-only when it isn't one, exactly as the expo worker does. This matters more here
  // than anywhere else: `extension:fg` is `tierOf`'s ceiling, so a bad image stored as
  // `done` can never be superseded by a later, better extraction.
  const image = await dataUrlToBytes(dataUrl);
  return { title, image: sniffImageMime(image) !== undefined ? image : undefined };
}

// --- readMode ----------------------------------------------------------------

// Inject a compact reader over the live DOM and return the cleaned article HTML as
// bytes (a `files/{id}.enc` blob).
export async function captureReadMode(tabId: number): Promise<Uint8Array> {
  const [injection] = await browser.scripting.executeScript({
    target: { tabId },
    func: () => {
      const clone = document.cloneNode(true) as Document;
      clone
        .querySelectorAll('script, style, noscript, iframe, svg, link, meta')
        .forEach((el) => el.remove());
      const article = clone.querySelector('article') ?? clone.querySelector('main') ?? clone.body;
      return article ? article.innerHTML : '';
    },
  });
  const html = (injection?.result as string | undefined) ?? '';
  return utf8(html);
}

// --- screenshot --------------------------------------------------------------

// Capture the visible viewport of the focused window as PNG bytes (a `files/{id}.enc`
// blob). The active tab is already focused at icon-click, so the capture reflects
// what the user sees.
export async function captureScreenshot(windowId: number): Promise<Uint8Array> {
  const dataUrl = await browser.tabs.captureVisibleTab(windowId, { format: 'png' });
  return dataUrlToBytes(dataUrl);
}

// --- page copy -----------------------------------------------------------------

// Serialize the live DOM and return it as bytes (a `files/{id}.enc` blob). Starts
// with the inline XMLSerializer; SingleFile-grade inlining (CSS/images/fonts) is a
// later enhancement, per the plan.
export async function capturePageCopy(tabId: number): Promise<Uint8Array> {
  const [injection] = await browser.scripting.executeScript({
    target: { tabId },
    func: () => new XMLSerializer().serializeToString(document),
  });
  const html = (injection?.result as string | undefined) ?? '';
  return utf8(html);
}
