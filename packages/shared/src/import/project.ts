// Parsed rows → the entities to write. The half of an interop/Brace import that
// is pure: given the file's rows, the library's current lists/tags/pin ranks, and
// an id minter, decide every blob the import produces and in what order. What's
// left for the orchestrators (web-react / expo-react data/import-all-data.ts) is
// only what's genuinely platform-bound — the store reads, the chunked writes, and
// the progress ticks.
//
// It lives here for the reason the resolvers next door do: this logic was about to
// exist twice, once per platform, and the two copies could only agree by luck. The
// import's user-visible behaviour (which list a row lands in, which title is held
// above extraction, how a pin is ranked, whether a custom image is kept)
// must be identical on web and mobile, so it is written once.
//
// `newId` is a constructor argument for the same reason ListResolver takes one:
// minting is `@stxapps/web-crypto` on web and `@stxapps/expo-crypto` on expo, and
// `shared` can import neither.
//
// NOT here, deliberately: dedupe by canonical URL and the quota gate. Both need to
// see the EXISTING library (a store read), and the quota gate must throw before any
// of this runs — see the orchestrators.
//
// ALSO NOT HERE, AND THAT IS THE DECISION: the `nestedLists` entitlement. A folder
// path builds the tree it describes on every plan, so an import is never the thing
// that restructures someone's library. This used to flatten a path to ONE root-level
// list named by the slash join ("Work/Specs") unless the account was entitled, which
// was silent, effectively permanent — the interop dedupe skips by canonical URL, so
// re-importing after an upgrade brings back nothing — and out of step with the two
// other doors into the same state: `importBracemarkBackup` restores `parentId`
// verbatim on any plan, and a lapsed subscription keeps every nested list it made
// (docs/iap.md, _quota_). `nestedLists` gates the CREATE affordances, which is where
// the paywall belongs: reparenting in the lists editor. A free account can hold a
// nested tree, cannot deepen it by hand, and can always flatten it — the same state a
// downgrade produces. See docs/data-lifecycle.md, _the shapes_.

import { isCalendarTime } from '../sync/calendar-time';
import {
  type Extraction,
  extractionSchema,
  type Link,
  LINK_NOTE_MAX,
  linkSchema,
  type Pin,
  pinSchema,
} from '../sync/entities';
import { cleanTitle } from '../sync/extraction';
import {
  EXTRACTIONS_PREFIX,
  FILES_PREFIX,
  LINKS_PREFIX,
  pathFromId,
  PINS_PREFIX,
} from '../sync/paths';
import { ranksBetween } from '../sync/rank';
import { ARCHIVE_ID, TRASH_ID } from '../sync/system-lists';
import { hostFromText } from '../url/url';
import type { ImportedLink } from './bundle';
import {
  IMPORT_MAX_FOLDER_DEPTH,
  ImportFolderDepthError,
  ListResolver,
  type ResolverNode,
  TagResolver,
} from './resolve';
import { runSteps, runStepsWithPauses } from './steps';

// One entity to write, structurally the write edge's RawEntityEntry on both
// platforms (data/mutations.ts) — which is where these go.
export interface ProjectedEntry<T> {
  path: string;
  data: T;
}

export interface ProjectedImport {
  // Lists and tags first so no chunk boundary leaves a link pointing at a list or
  // tag that isn't stored yet, then the links with their extractions, then the
  // pins. (A dangling reference is survivable — the read layer skips it — but
  // it's free to avoid.)
  entries: ProjectedEntry<object>[];
  // The custom-image blobs, one per distinct source reference that a link in
  // `entries` actually names — a row the schema refuses contributes none. Written
  // BEFORE `entries` by the orchestrator (content before metadata: a run that
  // dies between the two leaves an unreferenced blob, never a link pointing at
  // bytes that never arrived) and one at a time, since they can be MB-sized.
  files: ProjectedEntry<Uint8Array>[];
  linkCount: number;
  listCount: number;
  tagCount: number;
  // Rows that didn't validate against their schema — reported, never fatal.
  invalidCount: number;
}

export interface ProjectImportOptions {
  // The surviving rows: already deduped against the library and each other, and
  // already past the quota gate.
  rows: ImportedLink[];
  // The library's current lists/tags, for find-or-create name resolution.
  lists: ResolverNode[];
  tags: ResolverNode[];
  // The ranks of the pins that already exist — imported pins rank AFTER them, so
  // an import never reorders what the user pinned by hand.
  existingPinRanks: string[];
  // Blobs the rows reference by `imageRef`; a row whose ref has no bytes simply
  // imports without its custom image.
  images: Map<string, Uint8Array>;
  newId: () => string;
  now: number;
}

// A title that says nothing but where the link points: the URL itself, or the
// host `hostFromText` would display in its place — compared without scheme,
// `www.`, trailing slash or case.
function namesOnlyTheAddress(title: string, url: string): boolean {
  const bare = (text: string) =>
    text
      .toLowerCase()
      .replace(/^[a-z][a-z0-9+.-]*:\/\//, '')
      .replace(/^www\./, '')
      .replace(/\/+$/, '');
  const candidate = bare(title);
  return candidate === bare(url) || candidate === bare(hostFromText(url));
}

// A row's date, or nothing when it is an integer the calendar cannot name
// (sync/calendar-time.ts). A date is the one field a row can lose and still be
// the same bookmark, so the row is kept and dated like an undated one rather
// than refused — what the bookmark converter does with the same value. Anything
// that is not an integer at all is left for the schema to refuse, as before.
function calendarDate(epochMs: number | undefined): number | undefined {
  if (epochMs === undefined || !Number.isInteger(epochMs)) return epochMs;
  return isCalendarTime(epochMs) ? epochMs : undefined;
}

// Refuse a file whose folder chain runs past IMPORT_MAX_FOLDER_DEPTH (resolve.ts)
// — the WHOLE file, by throwing ImportFolderDepthError. A system-list row's path
// is never resolved, so it is not counted.
//
// The orchestrators call this on every parsed row, before the dedupe and before
// the over-cap prompt. Asked only inside the projection it ran after both, and
// the answer then depended on what they had removed: the same file imported or
// was refused according to which rows the library already held, and a user
// could be asked "import what fits?", say yes, and have the file refused.
export function assertImportFolderDepth(rows: readonly ImportedLink[]): void {
  for (const row of rows) {
    if (row.systemList === undefined && row.folderPath.length > IMPORT_MAX_FOLDER_DEPTH) {
      throw new ImportFolderDepthError();
    }
  }
}

// Rows projected between two pauses in `projectImportedLinksInChunks`. The
// per-row cost is URL parsing (`hostFromText`), an id mint and two schema
// checks: about 13 ms per thousand rows on web at a 4x CPU slowdown, so a chunk
// stays well under the 50 ms a long task starts at (docs/data-lifecycle.md,
// _main-thread cost_).
export const PROJECT_CHUNK = 1000;

// The whole import in one synchronous call. What the specs use.
export function projectImportedLinks(options: ProjectImportOptions): ProjectedImport {
  return runSteps(projectSteps(options));
}

// The same projection, handing the thread back between chunks. At 50,000 rows
// the synchronous call held web's main thread for ~0.6 s in one task; `pause`
// is the platform's yield (web-react / expo-react lib/yield-to-main.ts), awaited
// every PROJECT_CHUNK rows. One body for both entry points (steps.ts).
export function projectImportedLinksInChunks(
  options: ProjectImportOptions,
  pause: () => Promise<void>,
): Promise<ProjectedImport> {
  return runStepsWithPauses(projectSteps(options), pause);
}

// Yields (nothing) after every PROJECT_CHUNK rows; the drivers above decide
// whether a yield is a pause.
function* projectSteps(options: ProjectImportOptions): Generator<void, ProjectedImport> {
  const { rows, images, newId, now } = options;

  // Refused whole and FIRST — before a resolver exists, so no list of a
  // too-deep chain is ever minted. The orchestrators have already asked this of
  // the whole file (assertImportFolderDepth, above); asked again here because
  // this is where the lists are made, and a caller that forgot must not make them.
  assertImportFolderDepth(rows);

  const lists = new ListResolver(options.lists, now, newId);
  const tags = new TagResolver(options.tags, now, newId);

  // One blob per distinct reference — two links sharing an image share the file.
  // Filled as links are ACCEPTED, below: a reference enters this map, and its
  // bytes enter `files`, only once a link naming it has passed the schema.
  const files: ProjectedEntry<Uint8Array>[] = [];
  const fileIdByRef = new Map<string, string>();

  let invalidCount = 0;
  let linkCount = 0;
  const linkEntries: ProjectedEntry<object>[] = [];
  const pinned: { id: string; sourceRank: string; createdAt: number; updatedAt: number }[] = [];

  for (let i = 0; i < rows.length; i++) {
    if (i > 0 && i % PROJECT_CHUNK === 0) yield;
    const row = rows[i];
    // Undated rows get descending stamps from `now`, so the file's order IS the
    // library's newest-first display order after import.
    const createdAt = calendarDate(row.createdAt) ?? now - i;
    const updatedAt = Math.max(calendarDate(row.updatedAt) ?? createdAt, createdAt);
    const id = newId();
    const link: Link = {
      url: row.url,
      // A system list is named, never name-matched (see ImportedLink.systemList):
      // resolving `['Archive']` by name would mint a duplicate on an account whose
      // Archive was renamed, and Trash is deliberately unmatchable by name.
      listId:
        row.systemList === 'archive'
          ? ARCHIVE_ID
          : row.systemList === 'trash'
            ? TRASH_ID
            : lists.resolve(row.folderPath),
      tagIds: tags.resolve(row.tagNames),
      createdAt,
      updatedAt,
    };
    if (row.note !== undefined) link.note = row.note.slice(0, LINK_NOTE_MAX);
    // The title the user saw in the source app — possibly one they typed, so it
    // outranks the provisional extraction title below, exactly like one typed
    // here would (see ImportedLink.customTitle). Except when it is only the
    // link's own address, which is what a producer writes when it has no title
    // (Delicious names a bare-domain bookmark after the domain): held as
    // customTitle it would block the real title forever and add nothing the
    // display fallback doesn't already show.
    const customTitle = cleanTitle(row.customTitle);
    if (customTitle !== undefined && !namesOnlyTheAddress(customTitle, row.url)) {
      link.customTitle = customTitle;
    }
    // The row's custom image: the blob an earlier accepted row already claimed
    // for this reference, or a new one that is only PROVISIONAL until this link
    // validates. The orchestrators write `files` before `entries`, so a blob
    // selected for a row that is then refused would be stored, uploaded and
    // counted against the account's storage with no link anywhere naming it.
    // Selecting here, after the check, is the fix; deleting on refusal would not
    // be, since a refused row can share its image with an accepted one.
    let newFile: { ref: string; id: string; bytes: Uint8Array } | undefined;
    if (row.imageRef !== undefined) {
      const claimed = fileIdByRef.get(row.imageRef);
      if (claimed !== undefined) {
        link.customImageId = claimed;
      } else {
        const bytes = images.get(row.imageRef);
        if (bytes !== undefined) {
          newFile = { ref: row.imageRef, id: newId(), bytes };
          link.customImageId = newFile.id;
        }
      }
    }
    if (!linkSchema.safeParse(link).success) {
      invalidCount += 1;
      continue;
    }
    if (newFile !== undefined) {
      fileIdByRef.set(newFile.ref, newFile.id);
      files.push({ path: pathFromId(newFile.id, FILES_PREFIX), data: newFile.bytes });
    }
    linkEntries.push({ path: pathFromId(id, LINKS_PREFIX), data: link });
    linkCount += 1;

    const title = cleanTitle(row.title);
    if (title !== undefined) {
      const extraction: Extraction = { id, title, facets: {}, createdAt, updatedAt };
      if (extractionSchema.safeParse(extraction).success) {
        linkEntries.push({ path: pathFromId(id, EXTRACTIONS_PREFIX), data: extraction });
      }
    }

    if (row.pinRank !== undefined)
      pinned.push({ id, sourceRank: row.pinRank, createdAt, updatedAt });
  }

  // The source's pin ranks are an OPAQUE ordering (Brace stores LexoRank), so only
  // their sequence is carried over — fresh keys are minted in this library's own
  // keyspace, appended after every pin the user already has.
  const pinEntries: ProjectedEntry<object>[] = [];
  if (pinned.length > 0) {
    const sorted = [...options.existingPinRanks].sort();
    const after = sorted.length > 0 ? sorted[sorted.length - 1] : null;
    pinned.sort((a, b) => (a.sourceRank < b.sourceRank ? -1 : a.sourceRank > b.sourceRank ? 1 : 0));
    const ranks = ranksBetween(after, null, pinned.length);
    for (let i = 0; i < pinned.length; i++) {
      const pin: Pin = {
        id: pinned[i].id,
        rank: ranks[i],
        createdAt: pinned[i].createdAt,
        updatedAt: pinned[i].updatedAt,
      };
      if (!pinSchema.safeParse(pin).success) continue;
      pinEntries.push({ path: pathFromId(pin.id, PINS_PREFIX), data: pin });
    }
  }

  return {
    entries: [...lists.created, ...tags.created, ...linkEntries, ...pinEntries],
    files,
    linkCount,
    listCount: lists.created.length,
    tagCount: tags.created.length,
    invalidCount,
  };
}
