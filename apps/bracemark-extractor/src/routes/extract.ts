import { zValidator } from '@hono/zod-validator';
import { Hono } from 'hono';

import {
  bytesToBase64,
  extractEndpoint,
  type ExtractResponse,
  type ExtractResult,
  hostFromUrl,
} from '@stxapps/shared';

import type { AppEnv } from '../lib/env';
import { extractTitleImage } from '../lib/html';
import {
  MAX_HTML_BYTES,
  MAX_INLINE_IMAGE_BYTES,
  readAllWithLimit,
  readCappedBytes,
  safeFetch,
  SafeFetchError,
} from '../lib/safe-fetch';
import { rateLimit } from '../middleware/rate-limit';

// POST /v1/extract — the title+image metadata fetch (docs "server extraction").
// Anonymous, plaintext-return-only, persists nothing. Takes `{ urls, inlineImage? }`
// (urls plural — a bulk import sends chunks) and returns a PER-URL result array:
// partial success, never all-or-nothing, so each link's facet records its own
// done/failed/permanent.
//
// `imageUrl` is the discovered og:image as a URL STRING — an extension/mobile client
// fetches it directly; the web app normally pulls it through GET /v1/image (the
// proxy). With `inlineImage` on a SINGLE-URL request, the server also fetches that
// image and returns it base64-inlined (`imageBase64`), saving the web app the second
// round trip. The extractor still STORES nothing — inline is a one-shot buffer of one
// small preview, gated + size-capped below.

// `text/html` types we parse. Anything else degrades gracefully to a host fallback
// (docs "detect content-type and degrade gracefully") rather than returning garbage.
function isHtml(contentType: string): boolean {
  return contentType === 'text/html' || contentType === 'application/xhtml+xml';
}

// The bare content-type token, lowercased, without parameters (`; charset=…`).
function contentTypeOf(res: Response): string {
  return (res.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase();
}

// Fetch an og:image and base64-inline it — BEST-EFFORT: any failure (blocked by the
// SSRF guard, non-image content-type, over the inline cap, network error) returns
// null so the caller simply omits the bytes and the client falls back to `imageUrl` +
// the proxy. The image fetch reuses safeFetch, so it carries the SAME SSRF guard +
// redirect re-validation + timeout as every other fetch; the inline byte cap is
// tighter than the streamed proxy's (the bytes are buffered + base64-inflated here).
// The content-type gates the fetch (image/* only) but isn't returned — the client
// sniffs the bytes to resize/render, so no MIME label travels with them.
async function fetchInlineImage(imageUrl: string): Promise<{ imageBase64: string } | null> {
  try {
    const { response } = await safeFetch(imageUrl, 'image/*');
    const contentType = contentTypeOf(response);
    if (!contentType.startsWith('image/')) {
      await response.body?.cancel().catch(() => undefined);
      return null;
    }

    const bytes = await readAllWithLimit(response, MAX_INLINE_IMAGE_BYTES);
    return { imageBase64: bytesToBase64(bytes) };
  } catch {
    return null;
  }
}

// Extract one URL, never throwing — every failure becomes a typed result entry so
// one bad URL can't sink the batch. `requestedUrl` is echoed back verbatim so the
// client correlates results without relying on array order. `inline` is the already-
// gated flag (single-URL request that asked for inlineImage).
async function extractOne(requestedUrl: string, inline: boolean): Promise<ExtractResult> {
  try {
    const { response, finalUrl } = await safeFetch(requestedUrl, 'text/html,application/xhtml+xml');
    const contentType = contentTypeOf(response);

    let result: ExtractResult;
    if (!isHtml(contentType)) {
      // Non-HTML (PDF, a direct image, an oEmbed-only site, a JS-shell SPA): don't
      // return garbage. Fall back to the host as the provisional title; if the
      // target IS itself an image, it's its own preview.
      await response.body?.cancel().catch(() => undefined);
      result = { url: requestedUrl, ok: true, title: hostFromUrl(finalUrl) };
      if (contentType.startsWith('image/')) result.imageUrl = finalUrl.toString();
    } else {
      const html = await readCappedBytes(response, MAX_HTML_BYTES);
      const { title, imageUrl } = await extractTitleImage(html, finalUrl);
      result = {
        url: requestedUrl,
        ok: true,
        // Always provide at least the host as a provisional title (better than a bare
        // URL meanwhile); og:title supersedes it when present.
        title: title ?? hostFromUrl(finalUrl),
        ...(imageUrl ? { imageUrl } : {}),
      };
    }

    // Opt-in inline: fetch the discovered image's bytes so a single interactive save
    // skips the second GET /v1/image. `imageUrl` stays set either way, so an omitted
    // (failed/too-large) inline still leaves the client a working fallback.
    if (inline && result.imageUrl) {
      const inlined = await fetchInlineImage(result.imageUrl);
      if (inlined) {
        result.imageBase64 = inlined.imageBase64;
      }
    }
    return result;
  } catch (err) {
    if (err instanceof SafeFetchError) {
      // Relay the upstream status when there is one (`bad_status`) — it's what lets the
      // client settle a 404 `permanent` and a 503 `failed` instead of retrying both.
      return {
        url: requestedUrl,
        ok: false,
        error: err.code,
        ...(err.status !== undefined ? { status: err.status } : {}),
      };
    }
    // Unexpected — record a generic transient failure, never leak internals/the URL.
    console.error('extractOne failed:', err instanceof Error ? err.name : 'unknown');
    return { url: requestedUrl, ok: false, error: 'fetch_failed' };
  }
}

export const extractRoutes = new Hono<AppEnv>().post(
  extractEndpoint.path,
  // Fetching arbitrary URLs is the expensive/abusable path — stack the tight tier.
  rateLimit('tight'),
  zValidator('json', extractEndpoint.request),
  async (c) => {
    const { urls, inlineImage } = c.req.valid('json');
    // Enforce the inline guard server-side: only a single-URL request inlines (a
    // batch/import gets URLs only — see the contract). The CLIENT decides whether to
    // ask; the server decides whether it's allowed.
    const inline = inlineImage === true && urls.length === 1;
    // The contract caps `urls` at MAX_EXTRACT_URLS, so this fan-out is bounded; each
    // entry resolves independently (partial success).
    const results = await Promise.all(urls.map((url) => extractOne(url, inline)));
    const body: ExtractResponse = { results };
    return c.json(body);
  },
);
