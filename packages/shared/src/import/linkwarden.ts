import { decodeHtmlEntities } from '../html/entities';
import { normalizeUrl } from '../url/url';
import type { ImportedLink, ImportObserver } from './bundle';
import { parseEpoch } from './epoch';
import { IMPORT_MAX_FOLDER_DEPTH } from './resolve';
import { PARSE_CHUNK, runSteps } from './steps';

// LinkWarden backup parser — the second importer (with brace.ts) whose input is a
// foreign app's whole BACKUP rather than a bookmarks file, and the one that exists
// because LinkWarden has no bookmarks file to offer: its only export is
// `backup.json` (linkwarden#587 and #951 are the standing asks for an HTML one).
//
// Before this file, that backup sniffed as plain text and the URL-extracting
// parser mined the raw JSON — the same failure the Brace.to probe was written to
// stop, on a service our own import copy named as supported. It doesn't error;
// it produces a flat pile of URLs with every collection, tag, note, date and pin
// gone, which looks enough like success that the user finds out months later.
//
// THE SHAPE, and how it is known. `exportData.ts` in LinkWarden returns the
// user's Prisma row minus `password` and the user's own `id`:
//
//   { …user scalars…,
//     collections: [ { id, name, parentId, …, links: [ { id, name, url,
//                        description, createdAt, tags: [ { name, … } ] } ] } ],
//     pinnedLinks: [ { id, … } ] }
//
// So `collections` is NOT the first key (the user's scalar columns come first),
// which is what the detection probe in detect.ts has to survive, and the ids the
// path walk needs ARE present — only the USER's id is stripped (`ownerId` and
// `createdById` still sit on every collection, link and tag, so "minus the user's
// id" is a TOP-LEVEL claim only). There is now a real specimen —
// `__fixtures__/linkwarden-export.json`, run end to end by
// `linkwarden-export.spec.ts` — and the two rules below it contradicted are
// marked where they sit.
//
// WHAT IS DELIBERATELY DROPPED:
//  - `rssSubscriptions` — feeds, not links; nothing here models one.
//  - `icon`/`iconWeight`/`color` — LinkWarden's per-collection and per-link
//    decor, with no counterpart (the same call brace.ts makes about `decor`).
//  - `preview`/`image`/`pdf`/`monolith`/`readable`/`textContent` — LinkWarden's
//    archived copies. They ARE in the export, which this file used to deny: a
//    `pinnedLinks` row carries all six (the collection rows carry none of them,
//    so the two row shapes DIFFER — a pinned row also has no `tags`). What they
//    carry is a server-side PATH, `archives/341597/4842862.jpeg`, never bytes:
//    the specimen was re-exported after uploading a custom image and the file
//    contains no `data:` URI and no base64 run of any length. So nothing crosses
//    even when we want it to, and a link's image would have to be RE-FETCHED,
//    which is the one thing import must never do — it would announce the user's
//    whole library to every host in it. `bundle.images` is empty for this format
//    because the producer leaves it no choice.
//  - the top-level user scalars — another product's account. `collectionOrder`
//    is among them: it ranks the root collections (partially — the specimen's
//    lists 3 of its 5) and nothing here models folder order, which the
//    resolver assigns by encounter instead.
//  - a collection's `description`. Our `List` has a name and nothing else
//    (sync/entities.ts), so there is nowhere to put it.
//  - `collectionId` on a link. Membership comes from the NESTING, which is the
//    only one of the two the file guarantees is consistent.

// The default collection LinkWarden files everything into is just a collection
// (named "Unorganized" on the instances we have looked at) — it carries no flag,
// so it CANNOT be recognized structurally, and matching it by name is exactly
// what `systemList` exists to avoid (see bundle.ts): a name match would swallow a
// real folder someone named the same, and it would miss the renamed default. It
// crosses as an ordinary folder, which is the honest reading of a file that says
// nothing more.
//
// The specimen does NOT attest that name, and it is worth saying so before
// someone "corrects" this from it: its first collection was minted in the same
// millisecond batch as the two beside it, 15 minutes after the account — it came
// from a Raindrop import (it was called "Unsorted", then renamed), not from
// signup. A file whose default was never used contains no default to look at.
//
// What the specimen DOES pin, one rung downstream: a collection named `archive`
// resolves INTO the system Archive list, because ListResolver matches by
// case-insensitive name and excludes only Trash (resolve.ts) while `readLists`
// merges the system defaults in. That is the intended reading — a folder called
// Archive is an archive — and `linkwarden-export.spec.ts` holds it, since
// nothing else did.

interface Named {
  name?: unknown;
}

interface LwLink extends Named {
  id?: unknown;
  url?: unknown;
  description?: unknown;
  tags?: unknown;
  importDate?: unknown;
  createdAt?: unknown;
  updatedAt?: unknown;
}

interface LwCollection extends Named {
  id?: unknown;
  parentId?: unknown;
  links?: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function nonEmpty(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed;
}

// An ISO 8601 string is what Prisma serializes a DateTime to; a bare number is
// accepted for the same reason csv.ts accepts one — it costs a line and a
// hand-edited or re-serialized file is a real thing.
function timestamp(value: unknown): number | undefined {
  if (typeof value === 'number') return parseEpoch(String(value));
  const raw = nonEmpty(value);
  if (raw === undefined) return undefined;
  const parsed = Date.parse(raw);
  return Number.isNaN(parsed) ? undefined : parsed;
}

function tagNames(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((tag) => (isRecord(tag) ? nonEmpty(tag.name) : undefined))
    .filter((name): name is string => name !== undefined);
}

export function parseLinkwardenExport(text: string, observer?: ImportObserver): ImportedLink[] {
  return runSteps(parseLinkwardenExportSteps(text, observer));
}

// The parse as a generator, yielding after every PARSE_CHUNK link records
// (steps.ts). The `JSON.parse` in front of it is one native call and can't be
// split; it is the records after it that cost.
export function* parseLinkwardenExportSteps(
  text: string,
  observer?: ImportObserver,
): Generator<void, ImportedLink[]> {
  const root: unknown = JSON.parse(text);
  if (!isRecord(root) || !Array.isArray(root.collections)) return [];

  const collections = root.collections.filter(isRecord) as LwCollection[];

  // id → collection, for the parent walk. A collection whose id isn't a number
  // can still hold links; it just can't be anyone's parent.
  const byId = new Map<number, LwCollection>();
  for (const collection of collections) {
    if (typeof collection.id === 'number') byId.set(collection.id, collection);
  }

  // The folder chain, root first — settled ONCE per collection. A collection's
  // path is its parent's path plus its own name, so the walk climbs only as far
  // as the first collection already settled and extends from there. Walking the
  // whole chain again for every collection, as this did, costs the chain's
  // length per collection (and building each path front-first cost its length
  // again per name): half a megabyte of nothing but nested empty collections
  // took 25 seconds to parse — before the depth rule, which reads the ROWS this
  // parse returns, had anything to refuse.
  //
  // `onWalk` is not defensive dressing: a parentId cycle (a hand-edited file, a
  // restore that reparented two collections into each other) makes the climb
  // NON-TERMINATING, and an import that hangs with no error is worse than one
  // that files a link in the wrong place. The cycle is cut where the climb
  // re-enters it. A parent that isn't in the file — LinkWarden can share a
  // collection whose parent belongs to someone else — simply ends the chain.
  const paths = new Map<LwCollection, string[]>();
  function folderPath(collection: LwCollection): string[] {
    const walk: LwCollection[] = [];
    const onWalk = new Set<LwCollection>();
    let current: LwCollection | undefined = collection;
    while (current !== undefined && !paths.has(current) && !onWalk.has(current)) {
      onWalk.add(current);
      walk.push(current);
      current = typeof current.parentId === 'number' ? byId.get(current.parentId) : undefined;
    }

    // Back down, nearest the root first, each collection extending the path
    // above it. A path already PAST the import's depth limit is not extended:
    // one name over is all it takes to refuse the file, wherever a row or the
    // converter's observer meets it (resolve.ts), so the names below would never
    // be read — and copying them is what made a long chain quadratic.
    let path = (current !== undefined ? paths.get(current) : undefined) ?? [];
    for (let i = walk.length - 1; i >= 0; i--) {
      const name = nonEmpty(walk[i].name);
      if (name !== undefined && path.length <= IMPORT_MAX_FOLDER_DEPTH) path = [...path, name];
      paths.set(walk[i], path);
    }
    return path;
  }

  // The pinned links are a SEPARATE relation on the user, holding the same rows
  // that already sit in their collections — so they are read as a set and never
  // as extra links, or every pinned link would import twice. Their order in the
  // array is the only ordering the file carries, and `pinRank` is opaque and
  // sorted by the orchestrator (bundle.ts), so the index is a legitimate key —
  // zero-padded, because '10' sorts before '2' otherwise and a library's pins
  // would come back shuffled.
  const pinRankById = new Map<number, string>();
  if (Array.isArray(root.pinnedLinks)) {
    let index = 0;
    for (const pinned of root.pinnedLinks) {
      if (!isRecord(pinned) || typeof pinned.id !== 'number') continue;
      pinRankById.set(pinned.id, String(index).padStart(6, '0'));
      index += 1;
    }
  }

  const links: ImportedLink[] = [];
  let position = 0;
  for (const collection of collections) {
    const path = folderPath(collection);
    observer?.folder(path);
    if (!Array.isArray(collection.links)) continue;

    for (const raw of collection.links) {
      if (position > 0 && position % PARSE_CHUNK === 0) yield;
      position++;
      if (!isRecord(raw)) {
        observer?.row(position, 'Invalid bookmark record');
        continue;
      }
      const row = raw as LwLink;
      // `url` is null on LinkWarden's uploaded files (`type: 'pdf' | 'image'`) —
      // those are documents in its archive, not addresses, and there is nothing
      // to import. normalizeUrl also drops anything non-web on the same rule the
      // other parsers use.
      const url = typeof row.url === 'string' ? normalizeUrl(row.url) : null;
      if (url === null) {
        observer?.row(position, 'No web address (possibly an uploaded document)');
        continue;
      }
      observer?.row(position);

      const link: ImportedLink = { url, tagNames: tagNames(row.tags), folderPath: path };

      // LinkWarden's `name` is the row's display title and can be empty, in
      // which case its UI shows the URL. It crosses as customTitle
      // (docs/data-lifecycle.md): nothing in the file says whether a human typed
      // it or a fetch did, and only the second is safe to overwrite.
      //
      // DECODED, which a JSON field has no business needing — the value is
      // LinkWarden's own scrape of the page's `<title>`, stored without decoding
      // it, so the entity is the producer's artifact and not the transport's.
      // The specimen carries the control IN ONE ROW: `name` reads
      // `Marketing &amp; Technology` while that row's `metaDescription` — same
      // page, same scrape — has a bare `&`. Untouched, two of its 25 rows import
      // with a visible `&amp;` in the title. This is the parse boundary, which is
      // where html/entities.ts says to do it and exactly once (never in
      // cleanTitle, downstream of every client). Only the title: `description` is
      // the user's typed note and a collection/tag name is their own word, so
      // decoding those would corrupt an ampersand somebody meant.
      const title = nonEmpty(decodeHtmlEntities(typeof row.name === 'string' ? row.name : ''));
      if (title !== undefined) link.customTitle = title;

      // `description` is the note the user typed under the link — the field our
      // own CSV column and the Netscape <DD> carry, one product over.
      const note = nonEmpty(row.description);
      if (note !== undefined) link.note = note;

      // `importDate` WINS over `createdAt` when the file carries one, and the
      // specimen is why. `createdAt` is when the ROW was made in LinkWarden; a
      // library that arrived there through an import (a bookmarks file, another
      // service) has every row stamped with the minute of the import run —
      // literally two values across all 25 rows of the specimen, matching its two
      // import batches — while `importDate` holds the date each link was
      // originally saved, spread across the real days. Reading `createdAt` alone
      // flattens a user's whole history onto the day they moved apps, and
      // nothing about the result looks wrong: the links are all there, sorted
      // newest-first, all dated the same afternoon. This is the same field a
      // Netscape `ADD_DATE` becomes, one import chain further back.
      const createdAt = timestamp(row.importDate) ?? timestamp(row.createdAt);
      if (createdAt !== undefined) link.createdAt = createdAt;
      const updatedAt = timestamp(row.updatedAt);
      if (updatedAt !== undefined) link.updatedAt = updatedAt;

      const pinRank = typeof row.id === 'number' ? pinRankById.get(row.id) : undefined;
      if (pinRank !== undefined) link.pinRank = pinRank;

      links.push(link);
    }
  }

  return links;
}
