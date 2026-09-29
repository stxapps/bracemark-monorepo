import {
  ApiError,
  ApiTimeoutError,
  callEndpoint,
  DEFAULT_CALL_TIMEOUT_MS,
  parseRetryAfterSeconds,
} from '../api/client';
import { withDeadline } from '../async/with-deadline';
import {
  extractEndpoint,
  type ExtractResult,
  imageProxyEndpoint,
  imageProxyRequestSchema,
} from './endpoints';

// The client binding to `bracemark-extractor` — the web app's server-tier CAPTURE
// SOURCE, the counterpart of the extension's active-tab `capture.ts`. It is NOT the
// `@stxapps/shared` auth client (`createAuthApiClient`): `bracemark-extractor` is a
// SEPARATE app on a SEPARATE origin (`extractor.bracemark.com`, not `api.bracemark.com`) and is
// ANONYMOUS — no bearer token (attaching the account's token would convert the leak
// from "the server saw this URL" into "the server tied this URL to this account",
// the strictly-worse leak the design forbids — docs/link-extraction.md "server
// extraction"). So this is a plain `createApiClient`-style fetch with no auth.
//
// Only the base URL is app-specific (Next inlines `NEXT_PUBLIC_EXTRACTOR_URL`, wxt
// `WXT_PUBLIC_EXTRACTOR_URL`), so — like `createAuthApiClient` — the app resolves it
// from its own env and passes it in; the wiring lives here once. A client whose env
// doesn't configure an extractor origin simply builds none (the caller passes
// `null`), and server extraction stays inert.
export interface ExtractClient {
  // Interactive single-URL extract with the image inlined — POST /v1/extract,
  // `inlineImage: true` (honored only for a single URL, so the web app skips the
  // second GET /v1/image round trip when the image fetch succeeds). Returns that
  // URL's own per-URL result (partial success, never all-or-nothing).
  extract(url: string, signal?: AbortSignal): Promise<ExtractResult>;
  // Batch extract — POST /v1/extract with the full `urls` array (no inline: the
  // contract honors `inlineImage` only for a single URL, and a batch deliberately
  // returns `imageUrl` strings so the response stays small and memory-flat — the
  // image bytes come later through the streaming proxy). The SERVER resolves the
  // URLs CONCURRENTLY (its own bounded `Promise.all`), so a page of N pending links
  // gets all N titles/imageUrls back in ~one round trip instead of N sequential
  // ones — the latency win the displayed-scoped / extract-all drains are built on.
  // Returns the per-URL result array verbatim; the caller correlates by `result.url`
  // (partial success, order not guaranteed). De-dupe URLs before calling — the server
  // fetches each entry it's given.
  extractMany(urls: string[], signal?: AbortSignal): Promise<ExtractResult[]>;
  // Pull the discovered og:image's bytes through the streaming image proxy — GET
  // /v1/image — for the case the extract response carried only `imageUrl` (no inline
  // bytes). The web app can't read cross-origin image bytes itself (CORS), so the
  // proxy streams them through; the bytes are encrypted into `files/{id}.enc` here.
  // Bounded by the contract's deadline (`imageProxyEndpoint.timeoutMs`), rejecting
  // with ApiTimeoutError — the same as a JSON call, since this one can't ride
  // `callEndpoint`.
  fetchImage(url: string, signal?: AbortSignal): Promise<Uint8Array>;
}

export function createExtractClient({
  baseUrl,
  fetch: fetchImpl = fetch,
}: {
  baseUrl: string;
  fetch?: typeof fetch;
}): ExtractClient {
  return {
    async extract(url, signal) {
      const { results } = await callEndpoint(
        { baseUrl, fetch: fetchImpl },
        extractEndpoint,
        { urls: [url], inlineImage: true },
        { signal },
      );
      // Single-URL request → exactly one result (the server maps one input URL to one
      // entry), so it's just `results[0]`. No `url`-correlation needed — that matters
      // only for the N-result `extractMany`, where order isn't guaranteed.
      const result = results[0];
      if (!result) throw new Error('extract: empty result array');
      return result;
    },

    async extractMany(urls, signal) {
      // No `inlineImage`: the server ignores it for N > 1 anyway, and a batch wants the
      // small metadata-only response (imageUrl strings) — images stream via the proxy.
      const { results } = await callEndpoint(
        { baseUrl, fetch: fetchImpl },
        extractEndpoint,
        { urls },
        { signal },
      );
      return results;
    },

    async fetchImage(url, signal) {
      // Re-run the contract's front SSRF gate (http(s) + length) before the network,
      // exactly as `callEndpoint` does for the JSON endpoints — the proxy success
      // body is a binary STREAM, not JSON, so it can't ride `callEndpoint`.
      imageProxyRequestSchema.parse({ url });
      const target = new URL(imageProxyEndpoint.path, baseUrl);
      target.searchParams.set('url', url);
      // The deadline `callEndpoint` would have applied, applied here: the whole call,
      // body included, and the fetch gets the deadline's own signal, linked to the
      // caller's.
      return withDeadline(
        async (deadlineSignal) => {
          const res = await fetchImpl(target.toString(), {
            method: 'GET',
            signal: deadlineSignal,
          });
          if (!res.ok) {
            throw new ApiError(
              res.status,
              await res.text().catch(() => ''),
              parseRetryAfterSeconds(res),
            );
          }
          return new Uint8Array(await res.arrayBuffer());
        },
        imageProxyEndpoint.timeoutMs ?? DEFAULT_CALL_TIMEOUT_MS,
        (ms) => new ApiTimeoutError(ms),
        signal,
      );
    },
  };
}
