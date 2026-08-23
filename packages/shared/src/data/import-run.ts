// The import run's shared vocabulary — what an import REPORTS, not how it runs.
// The orchestration stays platform-bound (web-react / expo-react
// data/import-all-data.ts: the store reads, the zip library, the file API), but
// both platforms' import views render the same progress phases, the same
// outcome counters, and the same quota message, so those live here rather than
// in two copies that can only agree by luck. Beside backup.ts in the
// data-lifecycle namespace (docs/data-lifecycle.md).

// The running phases. `sync` and `parse` are indeterminate; `items` counts entity
// writes and `files` counts blob writes. The two blob-carrying branches order the
// last pair differently, on purpose: a bracemark backup restores its entities and
// then their blobs, while an import that MINTS links (a Brace.to export's custom
// images) writes the blobs first — content before metadata, so a run that dies
// between the two leaves an unreferenced blob rather than a link pointing at bytes
// that never arrived. `files` is skipped entirely when there are none.
export interface ImportProgress {
  step: 'sync' | 'parse' | 'items' | 'files';
  done?: number;
  total?: number;
}

export interface ImportOutcome {
  // Links written (new links; skips and invalid rows are counted separately).
  linkCount: number;
  // Links the file carried that were left out because the plan's cap had no room
  // for them — non-zero ONLY when the user chose "import what fits" at the
  // pre-flight prompt below. An import that was never over the cap, and one that
  // was cancelled there, both report 0 (the cancelled one never returns an
  // outcome at all). Reported prominently: a truncated import is the one outcome
  // where the library does not match the file, and the user has to be told which
  // part of their file is not here.
  notImportedCount: number;
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
        `plan’s limit of ${maxLinks} links (you have ${existingCount}). ` +
        'Upgrade your plan or import fewer links.',
    );
    this.name = 'ImportQuotaError';
  }
}

// --- the over-cap pre-flight ------------------------------------------------
//
// WHY THIS IS A PROMPT AND NOT AN ERROR. The cap and the invitation to bring an
// existing library are in direct tension, and the import is the one moment they
// meet: a free account pointed at a 1,200-link Raindrop CSV is exactly the user
// the import path is FOR. The gate still runs before a single write — the file
// is parsed on the device either way, so the exact count is known while nothing
// has happened yet — but that count is now spent on a decision instead of a
// refusal. The user picks: take what fits, or stop and go get room.
//
// This does NOT reverse the old policy that a partial import is worse than none;
// it scopes it to where it was true. A partial import is indistinguishable from
// a corrupt one only when the file is a BACKUP, whose whole promise is that
// restoring it returns you to a known state — so `assertUnderImportQuota` below
// still refuses those whole, and the backup path never prompts. An interop file
// is a MIGRATION, where "some of it, and here is the number that didn't fit" is
// a coherent thing to want and the far end is a library the user is watching
// fill up, not a state they expect to be restored.
//
// The truncation is deliberately dumb — the first `room` surviving rows in file
// order, after dedupe. Any cleverness (newest first, most-tagged first) would be
// us guessing which of someone's bookmarks matter, and a wrong guess is
// invisible to them.
export interface ImportQuotaPrompt {
  // New links the file would add, after dedupe against the library and itself.
  newCount: number;
  // Links already in the library, counted the server's way (incl. trashed).
  existingCount: number;
  // The plan's cap (never null here — an unlimited plan can't reach this).
  maxLinks: number;
  // How many of `newCount` would fit. Always >= 1: with no room at all there is
  // no choice to offer, so the gate throws instead of prompting.
  room: number;
}

export type ImportQuotaAnswer = 'import-what-fits' | 'cancel';

// Asked once per run, at the gate, with the run suspended until it resolves.
export type ImportQuotaResolver = (prompt: ImportQuotaPrompt) => Promise<ImportQuotaAnswer>;

// The interop gate: returns HOW MANY of the new links to write — `newLinkCount`
// when the whole file fits, `room` when the user chose to take what fits.
// Throws ImportQuotaError when there is no room at all, when the caller passed
// no resolver (the safe default: refuse rather than silently truncate), or when
// the user cancelled. That last one is a throw for control flow, not a failure to
// report: both hooks recognise their own cancel and return the view to idle
// without an error (docs/data-lifecycle.md — _the import's quota gate_).
export async function resolveImportQuota(
  newLinkCount: number,
  existingCount: number,
  maxLinks: number | null,
  onQuotaPrompt?: ImportQuotaResolver,
): Promise<number> {
  if (maxLinks === null || existingCount + newLinkCount <= maxLinks) return newLinkCount;

  const room = maxLinks - existingCount;
  if (room < 1 || onQuotaPrompt === undefined) {
    throw new ImportQuotaError(newLinkCount, existingCount, maxLinks);
  }

  const answer = await onQuotaPrompt({ newCount: newLinkCount, existingCount, maxLinks, room });
  if (answer === 'cancel') throw new ImportQuotaError(newLinkCount, existingCount, maxLinks);
  return room;
}

// The whole-file gate, kept for the BACKUP path only (above for why): `maxLinks`
// null = unlimited. Throws before any write, and it is the ENFORCEMENT rather
// than a courtesy — the free tier's link cap is client-side, so `files/sign`
// will happily take an over-cap import.
export function assertUnderImportQuota(
  newLinkCount: number,
  existingCount: number,
  maxLinks: number | null,
): void {
  if (maxLinks !== null && existingCount + newLinkCount > maxLinks) {
    throw new ImportQuotaError(newLinkCount, existingCount, maxLinks);
  }
}
