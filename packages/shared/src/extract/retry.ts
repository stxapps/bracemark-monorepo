import { type Facet } from '../sync/entities';
import { backoff, EXTRACTION_BACKOFF_MAX_MS } from '../sync/extraction';
import { type ExtractError } from './endpoints';

// The PERMANENT/TRANSIENT axis for one link's failed extraction — `permanent` (never
// retry) vs `failed` (retry once cooled past `backoff` — sync/extraction.ts).
//
// This decision is SYNCED, not local: `isFacetEligible` settles `permanent` for every
// device, so if two tiers classify the same outcome differently, a link's fate depends on
// which device happened to see it first. That's why the whole axis lives here in `shared`
// — same reason as `tierOf`/`backoff` — with one rule per input VOCABULARY and one
// adapter to join them:
//
//   isPermanent(error)              — the extract contract's `ExtractError` enum, all the
//                                     extractor can say about a URL it fetched itself.
//   verdictForStatus(status, …)     — a raw HTTP status, what a client that did its own
//                                     fetch has (bracemark-expo's on-device extraction, and
//                                     the extractor's `bad_status` code once it's relayed).
//   verdictForExtractError(…)       — the contract adapter: prefer the status when the
//                                     result carried one, else fall back to the enum.
//
// Callers pass `priorAttempts` as a THUNK because only one branch (403) needs it and
// reading it costs a store hit + a blob decode; the common paths stay decode-free.

// The two terminal states a FAILURE can settle into (`done` is the success half of
// `facetSchema.status`).
export type ExtractVerdict = Exclude<Facet['status'], 'done'>;

// Which extract errors are permanent. `blocked` (SSRF reject) and the content caps
// (`unsupported_type`, `too_large`) won't change on a retry; a timeout or a fetch failure
// might, so those stay transient.
//
// `bad_status` is deliberately NOT classified here — it spans 404 (permanent) and 503
// (transient), and the enum alone can't tell them apart. Prefer `verdictForExtractError`,
// which routes a result carrying `status` to `verdictForStatus`; this function's
// `bad_status` → transient is the fallback for a result without one (an older extractor).
export function isPermanent(error: ExtractError | undefined): boolean {
  return error === 'blocked' || error === 'unsupported_type' || error === 'too_large';
}

// A raw upstream HTTP status → the link's verdict. `permanent` links are never retried by
// ANY device, so the bar for it is "a later attempt cannot succeed".
//
// Synthetic statuses are welcome: a client that couldn't even fetch reports the status the
// server WOULD have (bracemark-expo uses `0` for a non-http(s) URL, `415` for a non-HTML
// content-type, `204` for an empty body), which lands them on the same rules as the real
// ones rather than a parallel vocabulary.
export async function verdictForStatus(
  status: number,
  priorAttempts: () => number | Promise<number>,
): Promise<ExtractVerdict> {
  // Retryable by definition: rate limits, request timeouts, and server faults.
  if (status === 408 || status === 425 || status === 429 || status >= 500) return 'failed';

  // Bot walls are the awkward case: a `403` is frequently PER-IP and transient (a CDN
  // challenge, a shared mobile IP in a penalty box), so retrying is often right — but a
  // site that simply refuses this client will return it forever, and a link retried until
  // the heat death of the app is worse than one settled. So: retry it up the normal backoff
  // ladder, and give up once the ladder has topped out at EXTRACTION_BACKOFF_MAX_MS.
  if (status === 403) {
    const attempts = await priorAttempts();
    return backoff(attempts + 1) >= EXTRACTION_BACKOFF_MAX_MS ? 'permanent' : 'failed';
  }

  // Everything else — 404/410/451, the auth walls, and the synthetic codes above — the
  // server answered on the merits and the answer won't change for us.
  return 'permanent';
}

// One `ExtractResult` failure → the link's verdict, for the server tier. The status is the
// better signal whenever the extractor relayed one (`bad_status` carries the upstream code),
// so a 404 through bracemark-extractor settles exactly as a 404 fetched on-device does; without
// one, the enum is all there is.
export async function verdictForExtractError(
  error: ExtractError | undefined,
  status: number | undefined,
  priorAttempts: () => number | Promise<number>,
): Promise<ExtractVerdict> {
  if (error === 'bad_status' && status !== undefined) {
    return verdictForStatus(status, priorAttempts);
  }
  return isPermanent(error) ? 'permanent' : 'failed';
}
