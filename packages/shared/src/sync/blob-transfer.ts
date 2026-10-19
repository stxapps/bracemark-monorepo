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
// the next cycle retries it. An entity blob stays at about the base allowance
// either way — only a `files/` blob's deadline grows (5 MB ≈ 12 min).
export const BLOB_MIN_BYTES_PER_SEC = 8 * 1024;

export function blobTransferTimeoutMs(bytes: number): number {
  return BLOB_BASE_TIMEOUT_MS + Math.ceil((bytes / BLOB_MIN_BYTES_PER_SEC) * 1000);
}
