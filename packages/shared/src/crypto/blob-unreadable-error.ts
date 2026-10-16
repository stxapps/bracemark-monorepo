// A blob whose frame this build knows (v1) but which does not open under the path
// it was fetched from — the GCM tag fails: tampered, sealed for another path,
// written by a build from before the path binding, or corrupt. Thrown by both
// JS framers' `decryptEntity` (web-crypto, expo-crypto) so the sync engines can
// tell it from everything else a pull can throw.
//
// Its own class because the engines treat it differently from the rest: a pull
// SKIPS such an entry and carries on, where any other failure rejects the cycle.
// One unreadable path must not stop every other path from syncing, every cycle,
// for good (docs/local-first-sync.md, _crypto boundary_). An UNKNOWN version is
// deliberately not this error: that is a newer client's format, which an update
// fixes — skipping it would advance the cursor past a blob the updated build
// could have read.
export class BlobUnreadableError extends Error {
  constructor(
    public readonly path: string,
    options?: { cause?: unknown },
  ) {
    super(`Blob does not open under its path: ${path}`, options);
    this.name = 'BlobUnreadableError';
  }
}
