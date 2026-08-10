// The import run's shared vocabulary — what an import REPORTS, not how it runs.
// The orchestration stays platform-bound (web-react / expo-react
// data/import-all-data.ts: the store reads, the zip library, the file API), but
// both platforms' import views render the same progress phases, the same
// outcome counters, and the same quota message, so those live here rather than
// in two copies that can only agree by luck. Beside backup.ts in the
// data-lifecycle namespace (docs/data-lifecycle.md).

// The running phases, in order. `sync` and `parse` are indeterminate; `items`
// counts entity writes, `files` counts blob restores (bracemark backup only).
export interface ImportProgress {
  step: 'sync' | 'parse' | 'items' | 'files';
  done?: number;
  total?: number;
}

export interface ImportOutcome {
  // Links written (new links; skips and invalid rows are counted separately).
  linkCount: number;
  // Lists / tags newly created (interop) or restored (bracemark).
  listCount: number;
  tagCount: number;
  // `files/` blobs restored from the zip (bracemark only; 0 otherwise).
  fileCount: number;
  // Interop: URLs skipped as already saved (or repeated in the file).
  // Bracemark: entities skipped because their path already exists locally.
  skippedCount: number;
  // Rows/lines that didn't parse or validate — reported, never fatal.
  invalidCount: number;
  // The pre-import refresh failed (offline / server down); the import carried on
  // against this device's local copy. A warning, not an error — local-first.
  syncFailed: boolean;
}

// The plan's link cap would be exceeded — thrown BEFORE anything is written.
// The message is user-facing (the import view renders it verbatim).
export class ImportQuotaError extends Error {
  constructor(newCount: number, existingCount: number, maxLinks: number) {
    super(
      `Importing ${newCount} new ${newCount === 1 ? 'link' : 'links'} would exceed your ` +
        `plan's limit of ${maxLinks} links (you have ${existingCount}). ` +
        'Upgrade your plan or import fewer links.',
    );
    this.name = 'ImportQuotaError';
  }
}

// The upfront quota gate: `maxLinks` null = unlimited. Throws before any write,
// and it is the ENFORCEMENT rather than a courtesy — the free tier's link cap is
// client-side, so `files/sign` will happily take an
// over-cap import. Refusing the whole file up front, rather than importing to
// the cap and truncating, is the honest reading of what the user asked for: a
// partial import is indistinguishable from a corrupt one at the far end, and
// they can always split the file or upgrade.
export function assertUnderImportQuota(
  newLinkCount: number,
  existingCount: number,
  maxLinks: number | null,
): void {
  if (maxLinks !== null && existingCount + newLinkCount > maxLinks) {
    throw new ImportQuotaError(newLinkCount, existingCount, maxLinks);
  }
}
