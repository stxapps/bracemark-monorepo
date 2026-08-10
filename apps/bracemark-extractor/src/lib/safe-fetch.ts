import type { ExtractError } from '@stxapps/shared';

import { assertPublicHttpUrl, SsrfError } from './ssrf';

// The arbitrary-URL fetch primitive every endpoint funnels through — the place all
// the hard caps live, so neither route can forget one (docs "Abuse caps are load-
// bearing"). It enforces, on EVERY request and EVERY redirect hop:
//   - the SSRF guard (assertPublicHttpUrl) — re-validated per hop, because a public
//     URL can 30x into private space (the guard's real teeth, per the doc);
//   - a per-request timeout (a slow/hung upstream can't pin a Worker);
//   - a manual redirect cap (no redirect loops, no unbounded chains).
// The per-response BYTE ceiling and the content-type allowlist are applied by the
// caller on the returned body (readCappedBytes for HTML, streamWithLimit for the
// image proxy), because the two endpoints treat them differently: HTML truncates at
// the cap (the og tags are in <head>), the image proxy hard-aborts (never relay a
// 4 GB file).

// --- caps -------------------------------------------------------------------
export const FETCH_TIMEOUT_MS = 8_000; // per-hop upstream deadline
export const MAX_REDIRECTS = 5; // total redirect hops to follow
export const MAX_HTML_BYTES = 1_000_000; // 1 MB of HTML is plenty to find <head>
export const MAX_IMAGE_BYTES = 10_000_000; // 10 MB streamed-proxy ceiling
// Tighter ceiling for the INLINE image path: those bytes are buffered whole and
// base64-inflated (~33%) into a JSON response, so cap them well below the streamed
// proxy's limit — a preview that doesn't fit just falls back to the proxy URL.
export const MAX_INLINE_IMAGE_BYTES = 2_000_000; // 2 MB

// A request `User-Agent` so well-behaved sites don't 403 a blank UA, and an `Accept`
// the caller sets per content type. Identifies the bot honestly (no spoofing a
// browser) — this is a metadata fetcher, not a scraper evading detection.
const USER_AGENT = 'bracemark-extractor/1.0 (+https://bracemark.com/extractor)';

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

// A typed failure carrying the per-URL `ExtractError` the contract speaks, so the
// route maps an internal error straight onto the result entry / response code
// without re-deriving it. NEVER embed the URL in `message` (docs "Never log the URL").
//
// `status` is the UPSTREAM code, set only for `bad_status` — the contract relays it so the
// client can tell a 404 (permanent) from a 503 (retry); see extractResultSchema.status.
// It's the upstream's own status, never anything about our request, so it discloses
// nothing about the caller.
export class SafeFetchError extends Error {
  constructor(
    readonly code: ExtractError,
    readonly status?: number,
  ) {
    super(code);
    this.name = 'SafeFetchError';
  }
}

export interface SafeFetchResult {
  response: Response;
  finalUrl: URL;
}

// Fetch `rawUrl`, following redirects MANUALLY so each hop is re-validated by the
// SSRF guard before we connect to it. Returns the final (2xx-range) upstream
// response with its body UNCONSUMED — the caller checks content-type and reads the
// body under a byte cap. Throws SafeFetchError with a contract error code.
export async function safeFetch(
  rawUrl: string,
  accept: string,
  timeoutMs = FETCH_TIMEOUT_MS,
): Promise<SafeFetchResult> {
  let current: URL;
  try {
    current = assertPublicHttpUrl(rawUrl);
  } catch (err) {
    if (err instanceof SsrfError) throw new SafeFetchError('blocked');
    throw err;
  }

  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    let res: Response;
    try {
      res = await fetch(current.toString(), {
        method: 'GET',
        redirect: 'manual', // we follow + re-validate ourselves
        signal: AbortSignal.timeout(timeoutMs),
        headers: {
          'user-agent': USER_AGENT,
          accept,
          // Don't accept compressed encodings we'd have to decode just to re-check
          // size; let the runtime negotiate identity/gzip transparently.
          'accept-language': 'en;q=0.9,*;q=0.5',
        },
      });
    } catch (err) {
      // AbortSignal.timeout aborts with a TimeoutError DOMException.
      if (err instanceof DOMException && err.name === 'TimeoutError') {
        throw new SafeFetchError('timeout');
      }
      throw new SafeFetchError('fetch_failed');
    }

    if (REDIRECT_STATUSES.has(res.status)) {
      const location = res.headers.get('location');
      // Always drain/cancel the redirect response body so the connection is freed.
      await res.body?.cancel().catch(() => undefined);
      // A 3xx with no Location is a MALFORMED response, not a verdict on the URL — so no
      // status is relayed and the client keeps its transient default, rather than reading
      // the 301 as "settled, never retry".
      if (!location) throw new SafeFetchError('bad_status');
      if (hop === MAX_REDIRECTS) throw new SafeFetchError('fetch_failed'); // too many hops

      let next: URL;
      try {
        // Resolve relative Location against the current URL, then re-run the FULL
        // guard on the absolute target — this is the redirect re-validation that is
        // the guard's whole point.
        next = assertPublicHttpUrl(new URL(location, current).toString());
      } catch (err) {
        if (err instanceof SsrfError) throw new SafeFetchError('blocked');
        throw new SafeFetchError('fetch_failed');
      }
      current = next;
      continue;
    }

    if (!res.ok) {
      await res.body?.cancel().catch(() => undefined);
      throw new SafeFetchError('bad_status', res.status);
    }

    return { response: res, finalUrl: current };
  }

  // Unreachable (the loop returns or throws), but satisfies the type checker.
  throw new SafeFetchError('fetch_failed');
}

// Read a response body into memory, TRUNCATING at `maxBytes` and cancelling the rest
// — for HTML, where we only need <head> and never want to buffer a huge page. Stops
// reading once the cap is hit rather than erroring (the og tags are near the top), so
// a giant page still yields its metadata cheaply.
export async function readCappedBytes(
  response: Response,
  maxBytes: number,
): Promise<Uint8Array<ArrayBuffer>> {
  const reader = response.body?.getReader();
  if (!reader) return new Uint8Array(0);

  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;

      const remaining = maxBytes - total;
      if (value.byteLength >= remaining) {
        chunks.push(value.subarray(0, remaining));
        total += remaining;
        break; // hit the cap — stop, cancel below
      }
      chunks.push(value);
      total += value.byteLength;
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }

  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

// Read a response body FULLY into memory, but throw SafeFetchError('too_large') if
// it exceeds `maxBytes` — for the inline image path, where a truncated image is
// useless (unlike HTML, where head-only truncation is fine). Caps total memory at
// `maxBytes` since it stops and throws the moment the cap is crossed.
export async function readAllWithLimit(
  response: Response,
  maxBytes: number,
): Promise<Uint8Array<ArrayBuffer>> {
  const reader = response.body?.getReader();
  if (!reader) return new Uint8Array(0);

  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;

      total += value.byteLength;
      if (total > maxBytes) throw new SafeFetchError('too_large');
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }

  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

// A pass-through TransformStream that HARD-ABORTS once more than `maxBytes` have
// flowed — for the image proxy, where we stream bytes to the client but must never
// relay an oversized body (docs "abort the stream once exceeded — never relay a 4 GB
// file"). The client receives a truncated/errored stream, which it discards.
export function streamWithLimit(maxBytes: number): TransformStream<Uint8Array, Uint8Array> {
  let total = 0;
  return new TransformStream({
    transform(chunk, controller) {
      total += chunk.byteLength;
      if (total > maxBytes) {
        controller.error(new SafeFetchError('too_large'));
        return;
      }
      controller.enqueue(chunk);
    },
  });
}
