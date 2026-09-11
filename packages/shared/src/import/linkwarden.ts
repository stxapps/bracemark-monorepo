import { normalizeUrl } from '../url/url';
import type { ImportedLink } from './bundle';
import { parseEpoch } from './epoch';

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
// path walk needs ARE present — only the USER's id is stripped. Two independent
// readers of real backups agree on this subset (karakeep's zod schema for its
// LinkWarden importer, and the community `backup.json` → Netscape converter), and
// the export controller is the source it was checked against. What we have never
// had is a real specimen: see `linkwarden.spec.ts`, which says so at the top.
//
// WHAT IS DELIBERATELY DROPPED:
//  - `rssSubscriptions` — feeds, not links; nothing here models one.
//  - `icon`/`iconWeight`/`color` — LinkWarden's per-collection and per-link
//    decor, with no counterpart (the same call brace.ts makes about `decor`).
//  - `preview`/`image`/`pdf`/`monolith`/`readable`/`textContent` — LinkWarden's
//    archived copies, and they are not IN the export anyway (`exportData` omits
//    them). A link's image here would have to be re-fetched, which is the one
//    thing import must never do: it would announce the user's whole library to
//    every host in it.
//  - the top-level user scalars — another product's account.
//  - `collectionId` on a link. Membership comes from the NESTING, which is the
//    only one of the two the file guarantees is consistent.

// The default collection LinkWarden files everything into is just a collection
// named "Unorganized" — it carries no flag, so it CANNOT be recognized
// structurally, and matching it by name is exactly what `systemList` exists to
// avoid (see bundle.ts): a name match would swallow a real folder someone named
// the same, and it would miss the renamed default. It crosses as an ordinary
// folder, which is the honest reading of a file that says nothing more.

interface Named {
  name?: unknown;
}

interface LwLink extends Named {
  id?: unknown;
  url?: unknown;
  description?: unknown;
  tags?: unknown;
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

export function parseLinkwardenExport(text: string): ImportedLink[] {
  const root: unknown = JSON.parse(text);
  if (!isRecord(root) || !Array.isArray(root.collections)) return [];

  const collections = root.collections.filter(isRecord) as LwCollection[];

  // id → collection, for the parent walk. A collection whose id isn't a number
  // can still hold links; it just can't be anyone's parent.
  const byId = new Map<number, LwCollection>();
  for (const collection of collections) {
    if (typeof collection.id === 'number') byId.set(collection.id, collection);
  }

  // The folder chain, root first. The `seen` set is not defensive dressing: a
  // parentId cycle (a hand-edited file, a restore that reparented two
  // collections into each other) makes this walk NON-TERMINATING, and an import
  // that hangs with no error is worse than one that files a link in the wrong
  // place. A parent that isn't in the file — LinkWarden can share a collection
  // whose parent belongs to someone else — simply ends the chain.
  function folderPath(collection: LwCollection): string[] {
    const path: string[] = [];
    const seen = new Set<LwCollection>();
    let current: LwCollection | undefined = collection;
    while (current !== undefined && !seen.has(current)) {
      seen.add(current);
      const name = nonEmpty(current.name);
      if (name !== undefined) path.unshift(name);
      current = typeof current.parentId === 'number' ? byId.get(current.parentId) : undefined;
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
  for (const collection of collections) {
    if (!Array.isArray(collection.links)) continue;
    const path = folderPath(collection);

    for (const raw of collection.links) {
      if (!isRecord(raw)) continue;
      const row = raw as LwLink;
      // `url` is null on LinkWarden's uploaded files (`type: 'pdf' | 'image'`) —
      // those are documents in its archive, not addresses, and there is nothing
      // to import. normalizeUrl also drops anything non-web on the same rule the
      // other parsers use.
      const url = typeof row.url === 'string' ? normalizeUrl(row.url) : null;
      if (url === null) continue;

      const link: ImportedLink = { url, tagNames: tagNames(row.tags), folderPath: path };

      // LinkWarden's `name` is the row's display title and can be empty, in
      // which case its UI shows the URL. It crosses as customTitle
      // (docs/data-lifecycle.md): nothing in the file says whether a human typed
      // it or a fetch did, and only the second is safe to overwrite.
      const title = nonEmpty(row.name);
      if (title !== undefined) link.customTitle = title;

      // `description` is the note the user typed under the link — the field our
      // own CSV column and the Netscape <DD> carry, one product over.
      const note = nonEmpty(row.description);
      if (note !== undefined) link.note = note;

      const createdAt = timestamp(row.createdAt);
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
