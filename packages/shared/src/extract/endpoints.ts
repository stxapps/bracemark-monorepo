import { z } from 'zod';

import { API_V1, defineEndpoint } from '../api/endpoint';
import { LINK_TITLE_MAX } from '../sync/entities';

// bracemark-extractor contract — the title/image metadata fetch + the image proxy.
//
// Defined once here in `shared` (the lowest, platform-agnostic layer), exactly
// like the auth/sync contracts, so the `bracemark-extractor` Worker validates against
// the same schema every client (bracemark-web, the future bracemark-expo) builds its typed
// fetch from. See docs/api-contracts.md and docs/link-extraction.md ("server
// extraction").
//
// bracemark-extractor is a SEPARATE app on its OWN origin (extractor.bracemark.com), distinct
// from the blind sync broker (api.bracemark.com) — so these endpoints are never mounted
// on bracemark-api. They share the `/v1` version prefix (the version is part of the
// wire contract, not the origin); a long-lived client can stay pinned to /v1.
//
// The extractor is a PURE FUNCTION: it returns PLAINTEXT and persists nothing. The
// client (which alone holds the data key) does the E2E write-back into
// `extractions/`/`files/`. The extractor holds no key and writes no blob, so what
// it can leak is transient (a URL it saw mid-fetch), never stored.

// A caller-supplied URL to extract/proxy. http(s) only and length-capped at the
// contract boundary — the first line of the SSRF guard (a non-web scheme is a
// clean 400 here, never reaches the fetch). The `redirect`-hop re-validation and
// private-IP blocking still run server-side on every hop (see the extractor's
// ssrf guard); this is the cheap front gate, not the whole defense.
export const httpUrlSchema = z
  .string()
  .min(1)
  .max(2048)
  .refine((value) => {
    let parsed: URL;
    try {
      parsed = new URL(value);
    } catch {
      return false;
    }
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  }, 'expected an http(s) URL');

// Plural by design: a bulk import sends chunks, never thousands of singletons
// (docs "imported links" — batch and pace). Capped so one request can never fan
// out to more than this many arbitrary-URL fetches (each one a Workers subrequest
// + egress), the same abuse-gate role `MAX_COMMIT_OPS`/`MAX_SIGN_PATHS` play for
// sync — over the cap the whole request 400s at the contract before any fetch runs.
export const MAX_EXTRACT_URLS = 20;

// Per-URL failure reasons. An enum (not a free string) so the client can branch:
//  - 'blocked'          — SSRF guard rejected the URL or a redirect hop (private
//                         IP, non-http(s) scheme). Permanent: don't retry.
//  - 'bad_status'       — upstream returned a non-2xx. The code itself is relayed in
//                         `status` (404/410 → the link's facet records `permanent`;
//                         5xx/429 → transient `failed`), since the enum alone can't
//                         split those and the verdict SYNCS to every device.
//  - 'unsupported_type' — content-type not in the allowlist for this endpoint.
//  - 'too_large'        — upstream body exceeded the per-response byte ceiling.
//  - 'timeout'          — upstream didn't respond within the cap.
//  - 'fetch_failed'     — the fetch threw (DNS, TLS, connection reset).
// The client maps these onto the facet's `failed`/`permanent` status + backoff.
export const extractErrorSchema = z.enum([
  'blocked',
  'bad_status',
  'unsupported_type',
  'too_large',
  'timeout',
  'fetch_failed',
]);
export type ExtractError = z.infer<typeof extractErrorSchema>;

// One URL's result. PARTIAL SUCCESS, never all-or-nothing (docs "Pure function,
// never a writer"): each entry stands alone so the client records that link's own
// facet `done`/`failed`/`permanent`. `url` echoes the request input so the client
// can correlate without relying on array order.
//
// The preview image is reported TWO ways, by a client-signaled tradeoff (see
// `inlineImage` on the request):
//   - `imageUrl` — the discovered og:image as a URL STRING, always present when
//     found. Enough for an extension/mobile client (it fetches the image itself, no
//     CORS); the web app, which can't read cross-origin image bytes, normally pulls
//     it through the image proxy (GET /v1/image) in a second round trip.
//   - `imageBase64` — the og:image fetched + base64-inlined, set ONLY when the client
//     asked for `inlineImage` on a SINGLE-URL request and the fetch succeeded. Saves an
//     interactive web-app save that second round trip; the client base64-decodes,
//     encrypts, and writes `files/{id}.enc` itself. The extractor still STORES nothing
//     (docs "stream-don't-store"); the inline path is a one-shot buffer of one small
//     preview, never the bulk/proxy path. No content-type accompanies the bytes — the
//     client resizes/renders by sniffing them (`<img>` and `createImageBitmap` both
//     detect the format from the bytes), so a MIME label would be dead weight.
// `imageUrl` stays populated even when `imageBase64` is, so a client whose inline
// fetch the server omitted (too large / failed) can still fall back to GET /v1/image.
export const extractResultSchema = z.object({
  url: z.string(),
  ok: z.boolean(),
  // og:title (preferred) or <title>, capped like the entity's `title`
  // (LINK_TITLE_MAX). On graceful degradation (non-HTML target) this is the bare
  // host, mirroring the client's `host(url)` fallback — never garbage.
  title: z.string().max(LINK_TITLE_MAX).optional(),
  // og:image / lead-image, resolved to an absolute URL against the final (post-
  // redirect) page URL. Absent when none was found.
  imageUrl: httpUrlSchema.optional(),
  // The og:image bytes, base64-encoded — present ONLY on an opt-in single-URL
  // `inlineImage` request whose image fetch succeeded (under the SSRF guard + a
  // dedicated inline byte cap); absent otherwise, in which case the client uses
  // `imageUrl` + the proxy. No content-type is returned alongside: the client sniffs
  // the bytes to resize/render them, so a stored MIME would never be read.
  imageBase64: z.base64().optional(),
  // Present iff `ok === false`.
  error: extractErrorSchema.optional(),
  // The UPSTREAM HTTP status, relayed only with `error: 'bad_status'` — the one error
  // whose retryability the enum can't express (404 is permanent, 503 is not). It exists
  // so the server tier reaches the SAME verdict a client fetching the page itself would
  // (`verdictForStatus`, extract/retry.ts): the facet's permanent/failed state syncs, so
  // two tiers disagreeing would make a link's fate depend on which device saw it first.
  // Optional, not required, so a client stays compatible with an extractor that predates
  // it (the fallback is the enum's transient default).
  status: z.number().int().optional(),
});
export type ExtractResult = z.infer<typeof extractResultSchema>;

export const extractRequestSchema = z.object({
  urls: z.array(httpUrlSchema).min(1).max(MAX_EXTRACT_URLS),
  // Opt-in: inline the og:image bytes in the result (base64) so an interactive save
  // skips the second GET /v1/image round trip. HONORED ONLY for a single-URL request
  // — a batch/import gets `imageUrl` only (inlining N images would bloat the JSON and
  // defeat the streaming proxy). The decision is the CLIENT's, never the server's:
  // only the client knows "interactive single save" vs "bulk-import drain"
  // (urls.length is a weak proxy a chunked import would fool). The server merely
  // enforces the single-URL guard + the inline byte cap.
  inlineImage: z.boolean().optional(),
});
export type ExtractRequest = z.infer<typeof extractRequestSchema>;

export const extractResponseSchema = z.object({
  results: z.array(extractResultSchema),
});
export type ExtractResponse = z.infer<typeof extractResponseSchema>;

// POST /v1/extract { urls, inlineImage? }
//   → { results: [{ url, ok, title?, imageUrl?, imageBase64?, error? }] }
export const extractEndpoint = defineEndpoint({
  method: 'POST',
  path: `${API_V1}/extract`,
  request: extractRequestSchema,
  response: extractResponseSchema,
});

// --- GET /v1/image — stateless image proxy ----------------------------------

// The image proxy streams the remote image bytes THROUGH and persists nothing
// (docs "stream-don't-store"): the client encrypts the streamed bytes into
// `files/{id}.enc` itself. It exists because the web app can't read cross-origin
// image bytes (CORS / tainted-canvas), and rendering the remote URL directly is
// the per-paint leak the design forbids.
//
// Same arbitrary-URL fetch as /extract, so it carries the SAME SSRF guard +
// size/time caps, plus a `content-type: image/*` allowlist. Never resizes or
// transcodes (that would force a full decode + risk OOM and kill the streaming-
// is-free property) — thumbnailing is a deferred CLIENT step before encrypt.
export const imageProxyRequestSchema = z.object({
  url: httpUrlSchema,
});
export type ImageProxyRequest = z.infer<typeof imageProxyRequestSchema>;

// GET /v1/image?url=… → the raw image bytes (a streamed binary body, NOT JSON).
//
// Unlike every other endpoint, the success response is a binary STREAM, so the
// client fetches it directly (`res.body` / `res.arrayBuffer()`) rather than
// through `callEndpoint` (which JSON-parses) — same way sync blob bytes go direct
// to R2, never through a JSON contract. The descriptor is still defined here so
// the path/method and the `url` request-validation live in ONE place the server
// and clients share; `response` is `z.unknown()` precisely because there is no
// JSON success body to parse (an error still returns the uniform `{ error }`
// JSON, handled out-of-band by the client's non-2xx branch).
export const imageProxyEndpoint = defineEndpoint({
  method: 'GET',
  path: `${API_V1}/image`,
  request: imageProxyRequestSchema,
  response: z.unknown(),
});
