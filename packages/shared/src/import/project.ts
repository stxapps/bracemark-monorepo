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
import { ListResolver, type ResolverNode, TagResolver } from './resolve';

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
  // The custom-image blobs, one per distinct source reference. Written BEFORE
  // `entries` by the orchestrator (content before metadata: a run that dies
  // between the two leaves an unreferenced blob, never a link pointing at bytes
  // that never arrived) and one at a time, since they can be MB-sized.
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

export function projectImportedLinks(options: ProjectImportOptions): ProjectedImport {
  const { rows, images, newId, now } = options;

  const lists = new ListResolver(options.lists, now, newId);
  const tags = new TagResolver(options.tags, now, newId);

  // One blob per distinct reference — two links sharing an image share the file.
  const files: ProjectedEntry<Uint8Array>[] = [];
  const fileIdByRef = new Map<string, string>();
  for (const row of rows) {
    const { imageRef } = row;
    if (imageRef === undefined || fileIdByRef.has(imageRef)) continue;
    const bytes = images.get(imageRef);
    if (bytes === undefined) continue;
    const fileId = newId();
    fileIdByRef.set(imageRef, fileId);
    files.push({ path: pathFromId(fileId, FILES_PREFIX), data: bytes });
  }

  let invalidCount = 0;
  let linkCount = 0;
  const linkEntries: ProjectedEntry<object>[] = [];
  const pinned: { id: string; sourceRank: string; createdAt: number; updatedAt: number }[] = [];

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    // Undated rows get descending stamps from `now`, so the file's order IS the
    // library's newest-first display order after import.
    const createdAt = row.createdAt ?? now - i;
    const updatedAt = Math.max(row.updatedAt ?? createdAt, createdAt);
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
    if (row.imageRef !== undefined) {
      const fileId = fileIdByRef.get(row.imageRef);
      if (fileId !== undefined) link.customImageId = fileId;
    }
    if (!linkSchema.safeParse(link).success) {
      invalidCount += 1;
      continue;
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
