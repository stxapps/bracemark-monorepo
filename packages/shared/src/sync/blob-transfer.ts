import { DEFAULT_RETRY_MAX_DELAY_MS, jitteredDelayMs } from '../api/retry';

// The deadline for one R2 blob transfer over a presigned URL (sync/r2.ts on both
// platforms). Those transfers bypass the contract client, so they don't get its
// default deadline (api/client.ts), and `fetch` has none of its own: a stalled
// PUT would hold the sync engine's single-flight cycle, and with it every later
// sync, until the page reloads or the app restarts (docs/local-first-sync.md).
//
// Two kinds of deadline, and which one a transfer gets depends on whether it can
// see its own progress.
//
// A transfer that CAN — a web GET, reading its body as a stream — gets an IDLE
// deadline: BLOB_BASE_TIMEOUT_MS for R2 to answer, then BLOB_IDLE_TIMEOUT_MS
// restarted on every chunk. It fails only when nothing moves, never for being
// slow, so no link is too slow for it and no body too big. That is the same
// contract the native stacks keep, and the better of the two.
//
// A transfer that CAN'T gets a TOTAL deadline scaled by size
// (`blobTransferTimeoutMs`): a browser's fetch reports no upload progress, and
// React Native's resolves only once the whole body is in. One flat number can't
// fit both ends — an entity blob is a few KB, a `files/` blob (a page copy, a
// screenshot) can be megabytes on a phone's uplink — so a fixed allowance
// covers connecting and the server's answer, and on top of it the body may move
// as slowly as BLOB_MIN_BYTES_PER_SEC. That floor is a stalled-transfer
// detector, not a speed expectation, but unlike an idle deadline it has a cost
// when wrong: a link slower than it for a whole body fails that transfer on
// every cycle, not once. It bites only the web PUT of a `files/` blob — expo's
// JS transfers carry entity blobs alone.
//
// expo's native file transfers (`File.downloadFileAsync`, the legacy
// `uploadAsync`) need neither: URLSession's 60 s request timeout on iOS and
// OkHttp's read/write timeouts on Android are idle deadlines already.

export const BLOB_BASE_TIMEOUT_MS = 60_000;
// URLSession's default request timeout, the idle deadline the expo file
// transfers already live by on iOS.
export const BLOB_IDLE_TIMEOUT_MS = 60_000;
// Per TRANSFER, not per link: the web engine runs at most FILE_CONCURRENCY (8)
// large `files/` PUTs at once over one uplink, so 8 KB/s each is ~512 kbps when
// they are all MB-sized. Small ones run beside them at the full fan-out, each
// under LARGE_CONTENT_BYTES and so inside the base allowance (sync/engine.ts).
// Set low on purpose, because the two ways to be wrong don't cost the same. Too
// high fails a slow-but-healthy upload on every cycle, so that blob never syncs;
// too low only holds a cycle longer behind a PUT that has truly stalled, and
// the set's second pass retries it (sync/retry.ts). An entity blob stays at about the base allowance
// either way — only a `files/` blob's deadline grows (5 MB ≈ 12 min).
export const BLOB_MIN_BYTES_PER_SEC = 8 * 1024;

export function blobTransferTimeoutMs(bytes: number): number {
  return BLOB_BASE_TIMEOUT_MS + Math.ceil((bytes / BLOB_MIN_BYTES_PER_SEC) * 1000);
}

// --- what a transfer throws ---------------------------------------------------
//
// One set of classes for both platforms' transports (web-react and expo-react
// sync/r2.ts re-export them), so what a failure MEANS — retry it here, in a
// second pass, on a timer, or never (sync/retry.ts) — is decided once.

// The host answered, with a status that is not a success. Carries the status so
// callers can branch on it — a GET 404 (the object was deleted between the op
// pull / listing and the fetch) is skipped rather than failing the cycle — and a
// 429's Retry-After, which the retry below waits out.
export class BlobRequestError extends Error {
  constructor(
    readonly method: 'PUT' | 'GET',
    readonly status: number,
    readonly retryAfterSeconds?: number,
  ) {
    super(`R2 ${method} failed (${status})`);
    this.name = 'BlobRequestError';
  }
}

// A transfer that outlived its deadline (`blobTransferTimeoutMs` above). No
// status — the host never answered — so its own class rather than a
// BlobRequestError a caller could mistake for a 404.
export class BlobTimeoutError extends Error {
  constructor(
    readonly method: 'PUT' | 'GET',
    readonly timeoutMs: number,
  ) {
    super(`R2 ${method} timed out after ${timeoutMs} ms`);
    this.name = 'BlobTimeoutError';
  }
}

// The connection failed under a transfer: no answer, and no deadline spent. The
// transport raises it where it can tell — expo's, whose fetch and native file
// upload fail without a type to tell one by anywhere else (expo-react
// sync/r2.ts). A browser's fetch already says so with a TypeError, which the web
// engine reads as this.
export class BlobNetworkError extends Error {
  constructor(
    readonly method: 'PUT' | 'GET',
    cause: unknown,
  ) {
    super(`R2 ${method} failed: ${cause instanceof Error ? cause.message : String(cause)}`, {
      cause,
    });
    this.name = 'BlobNetworkError';
  }
}

// --- a transfer the host answered with "try again" --------------------------
//
// The engines retry one blob transfer IN PLACE — an upload or a download — when
// the host answered with a status that means "not this time": a 5xx or a 429.
// Without it, one such answer fails the whole cycle. The cycle keeps what it
// committed, and the failed op (or the entry it was pulling) waits for the
// cycle's second pass or a later cycle (docs/local-first-sync.md, _retrying a
// failure_: this is L1, the first of four layers). On staging, 2026-10-19,
// the R2 binding refused 7 of ~14,000 blob-route PUTs in a 10,000-link push with
// `put: We encountered an internal error. Please try again. (10001)`. A push that
// size is all but certain to meet one, and a first sync's retry starts with a
// whole listing — a minute at that size before the 7 went up again. A pull of
// the same library reads as many objects through the same binding.
//
// Safe to repeat. An upload's bytes are sealed once, before the first attempt,
// and a PUT of the same bytes to the same key leaves the same object; nothing is
// committed until the chunk's uploads are done, so a retry never races its own
// commit. A download changes nothing on the host, and expo's to-file download
// overwrites the temp file a failed attempt left (sync/r2.ts, `idempotent`).
//
// What it does NOT retry, deliberately — each of these is the second pass's
// (sync/retry.ts, `isSecondPassFailure`), not this one's:
//   - any other 4xx. A 403 is an expired or bad token, and the same token fails
//     the same way: the second pass signs a fresh one. A GET 404 is an object
//     deleted since it was listed, which the engines skip; a second try would
//     only 404 again.
//   - a BlobTimeoutError. That attempt already spent its whole deadline, and
//     another straight after it would fire back into whatever stalled it (the
//     same reasoning as an ApiTimeoutError's, api/retry.ts).
//
// It DOES retry a dropped connection, a BlobNetworkError: on web a browser's
// fetch reports every transport failure as a TypeError, and its other ways out
// are typed apart (an abort is a DOMException; the deadline rejects as a
// BlobTimeoutError before it aborts); on expo the transport types it
// (expo-react sync/r2.ts). On staging, 2026-10-19, the connection under a
// 10,000-link push dropped mid-chunk — 35 blob-route PUTs canceled within a
// second — and one of them failed its cycle with that TypeError, which then
// waited a minute for Retry and another for its listing. Not while the device
// says it is offline (the web engine asks `navigator.onLine`): an attempt then
// cannot land, and the set's outage stop counts it at once.
//
// A 429 waits out its Retry-After when it carries one, capped like an api
// call's (api/retry.ts, DEFAULT_RETRY_MAX_DELAY_MS) — the blob route's `blob`
// limiter sends the window's length, and a retry inside it only spends the
// bucket again.
//
// Three tries, about 1 s then 2 s apart: a few seconds, set against a PUT token
// that lives five minutes from its chunk's sign and a GET token that lives an
// hour. It holds its pool slot while it waits, which a handful of retries in a
// sync of thousands can afford.
export const BLOB_TRANSFER_TRIES = 3;
export const BLOB_TRANSFER_RETRY_BASE_MS = 1_000;

export function isTransientBlobStatus(status: number): boolean {
  return status === 429 || status >= 500;
}

export interface BlobRetryOptions {
  /** Total attempts including the first (default BLOB_TRANSFER_TRIES). */
  tries?: number;
  /** The first wait; each later one doubles it (default BLOB_TRANSFER_RETRY_BASE_MS). */
  baseDelayMs?: number;
  /** Test seam. */
  sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

// A transfer the host refused for now, or one the connection under it dropped —
// the platform-free half of what L1 retries. The web engine adds a browser
// fetch's TypeError; neither retries while the device reports itself offline.
export function isTransientBlobError(err: unknown): boolean {
  if (err instanceof BlobNetworkError) return true;
  return err instanceof BlobRequestError && isTransientBlobStatus(err.status);
}

// Run `transfer`, and run it again while it throws something `isTransient`
// accepts — the caller says which, since a browser's TypeError is a network
// error only on web. The last attempt's error propagates unchanged.
export async function retryTransientBlobTransfer<T>(
  transfer: () => Promise<T>,
  isTransient: (err: unknown) => boolean,
  options: BlobRetryOptions = {},
): Promise<T> {
  const {
    tries = BLOB_TRANSFER_TRIES,
    baseDelayMs = BLOB_TRANSFER_RETRY_BASE_MS,
    sleep = defaultSleep,
  } = options;
  for (let attempt = 0; ; attempt++) {
    try {
      return await transfer();
    } catch (err) {
      if (attempt >= tries - 1 || !isTransient(err)) throw err;
      const hinted =
        err instanceof BlobRequestError && err.retryAfterSeconds !== undefined
          ? err.retryAfterSeconds * 1000
          : undefined;
      await sleep(
        hinted !== undefined
          ? Math.min(jitteredDelayMs(hinted), DEFAULT_RETRY_MAX_DELAY_MS)
          : jitteredDelayMs(baseDelayMs * 2 ** attempt),
      );
    }
  }
}
