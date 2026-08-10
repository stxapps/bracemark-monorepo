import { base64ToBytes } from '../crypto/encoding';
import { normalizeUrl } from '../url/url';
import type { ImportedBundle, ImportedLink } from './bundle';

// Brace.to export parser — the one importer whose input is a foreign app's whole
// BACKUP rather than a bookmarks file. Brace.to (this project's predecessor) exports
// a `.txt` holding a pretty-printed JSON array of `{ path, data }`: a raw dump of its
// Gaia files, one entry per file, six path families:
//
//   links/<listName>/<id>.json                              the link itself
//   sslts/<listName>/<updatedDT>/<addedDT>/<id>.json        its CURRENT list
//   pins/<rank>/<updatedDT>/<addedDT>/<id>.json             pinned, at <rank>
//   tags/<tagName>/<rank>/<updatedDT>/<addedDT>/<id>.json   one tag on one link
//   settings<dt>.json                                       incl. the NAME MAPS
//   images/<fname>                                          a `data:` URL
//
// Three properties of that layout are why this file exists instead of letting the
// text parser find URLs in the JSON (which is what happened before it did — the
// regex harvested `extractedResult.image` URLs, favicons, and every dead revision):
//
//  1. HISTORY. An id is `<addedDT>-<r4>-<r4>` with an optional 4th `<updatedDT>`
//     segment, and an EDITED link keeps every revision as its own file. They share
//     a "main id" (the first two segments); only the greatest updatedDT is live.
//     Import them all and a much-edited link lands five times.
//  2. INDIRECTION. A link's list is whatever its newest `sslts/` entry says, not
//     the listName in its own path (which is only where it was first filed).
//  3. OPAQUE NAMES. The `<listName>`/`<tagName>` path segments are ids; the display
//     names live in the newest settings file's `listNameMap`/`tagNameMap`.
//
// Pure, like every parser here: `(text) => ImportedBundle`, no store, no ids minted.
// The whole file is one JSON string parsed at once — the same in-memory ceiling the
// Bracemark backup has, and it fails loudly rather than being guarded.
//
// WHAT IS DELIBERATELY DROPPED (see docs/data-lifecycle.md — import):
//  - `extractedResult.image`/`favicon` — remote URLs, but this library's
//    `extraction.imageId` is a DOWNLOADED blob, and fetching at import would
//    announce the user's whole library to every host in it. Leaving no facets
//    marks the link pending, so our own extractor derives a real one.
//  - `extractedResult.status`/`extractedDT` — another extractor's bookkeeping.
//  - `decor` (Brace's random per-link colours) — no counterpart here.
//  - every settings field EXCEPT the two name maps. Layout, sort order, and
//    theme are another product's preferences; `doExtractContents` is worse than
//    noise — it is a privacy consent, and it has to be given here, not inherited.
//  - tag colours (`tagNameObj.color`) — `tagSchema` has no colour field, and
//    writing one no client models would be speculative.

const LINKS = 'links/';
const SSLTS = 'sslts/';
const PINS = 'pins/';
const TAGS = 'tags/';
const IMAGES = 'images/';
const SETTINGS = 'settings';
const DOT_JSON = '.json';

// Brace's three built-in lists are keyed by these literal strings (a rename
// changes only the displayName), so they're recognizable regardless of the
// account's language or edits.
const BRACE_MY_LIST = 'My List';
const BRACE_ARCHIVE = 'Archive';
const BRACE_TRASH = 'Trash';

// Where a custom image lives inside a link: `cdroot/images/<fname>`. The export
// strips the `cdroot/` prefix when writing the blob's own entry, so this is what
// turns a link's reference back into that entry's key.
const CD_ROOT = 'cdroot/';

interface BraceEntry {
  path: string;
  data: unknown;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// The revision-collapsing key: the first two id segments. `<addedDT>-<r4>` is
// stable across every edit of one link, where the full id is not.
function mainIdOf(id: string): string {
  return id.split('-').slice(0, 2).join('-');
}

// An id's two timestamps. Brace encodes creation in the id's first segment and
// (for an edited link) the edit time in an optional fourth — so a revision can be
// ordered against its siblings without opening the file.
function stampsOf(id: string): { addedDT: number; updatedDT: number } {
  const parts = id.split('-');
  const addedDT = /^\d+$/.test(parts[0]) ? parseInt(parts[0], 10) : 0;
  const updatedDT = parts.length === 4 && /^\d+$/.test(parts[3]) ? parseInt(parts[3], 10) : addedDT;
  return { addedDT, updatedDT };
}

// `<a>/<b>/<c>.json` → its segments plus the trailing id, or undefined if the
// shape doesn't match. `count` is the expected segment count including the
// namespace, so each caller states the arity its family has.
function splitFPath(path: string, count: number): { parts: string[]; id: string } | undefined {
  const parts = path.split('/');
  if (parts.length !== count) return undefined;
  const fname = parts[count - 1];
  if (!fname.endsWith(DOT_JSON)) return undefined;
  const id = fname.slice(0, -DOT_JSON.length);
  // 3 segments, or 4 with a trailing updatedDT — anything else isn't a link id.
  const idParts = id.split('-');
  if (idParts.length !== 3 && idParts.length !== 4) return undefined;
  if (!/^\d+$/.test(idParts[0])) return undefined;
  return { parts, id };
}

// --- settings: the two name maps -----------------------------------------------------

// Brace's listNameMap is a tree of `{ listName, displayName, children? }`. Flatten it
// to one root-first chain of DISPLAY names per listName — what a folder path is here.
// The built-in three are excluded: they're handled by identity, not by name.
function walkListNameMap(
  objs: unknown,
  prefix: string[],
  out: Map<string, string[]>,
  depth = 0,
): void {
  // A cyclic/absurdly deep map would otherwise recurse forever; Brace's own UI
  // nests a handful deep at most.
  if (!Array.isArray(objs) || depth > 20) return;
  for (const obj of objs) {
    if (!isObject(obj)) continue;
    const { listName, displayName, children } = obj;
    if (typeof listName !== 'string' || listName === '') continue;
    const name = typeof displayName === 'string' && displayName !== '' ? displayName : listName;
    const chain = [...prefix, name];
    out.set(listName, chain);
    walkListNameMap(children, chain, out, depth + 1);
  }
}

function readTagNameMap(objs: unknown): Map<string, string> {
  const out = new Map<string, string>();
  if (!Array.isArray(objs)) return out;
  for (const obj of objs) {
    if (!isObject(obj)) continue;
    const { tagName, displayName } = obj;
    if (typeof tagName !== 'string' || tagName === '') continue;
    out.set(tagName, typeof displayName === 'string' && displayName !== '' ? displayName : tagName);
  }
  return out;
}

// The newest settings file wins — Brace keeps every revision, named
// `settings<dt><random>.json`, and only the latest reflects the account. The
// leading digits are the timestamp; a name that has none sorts to the bottom
// rather than being dropped (an unreadable map is worse than an old one).
function latestSettings(entries: BraceEntry[]): Record<string, unknown> | undefined {
  let bestDt = -1;
  let best: Record<string, unknown> | undefined;
  for (const entry of entries) {
    if (!isObject(entry.data)) continue;
    const digits = /^\d+/.exec(entry.path.slice(SETTINGS.length));
    const dt = digits ? parseInt(digits[0], 10) : 0;
    if (dt < bestDt) continue;
    [bestDt, best] = [dt, entry.data];
  }
  return best;
}

// --- the parse ------------------------------------------------------------------------

export function parseBraceExport(text: string): ImportedBundle {
  const empty: ImportedBundle = { links: [], images: new Map() };

  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return empty;
  }
  if (!Array.isArray(json)) return empty;

  const entries: BraceEntry[] = [];
  for (const value of json) {
    if (!isObject(value) || typeof value.path !== 'string') continue;
    entries.push({ path: value.path, data: value.data });
  }

  // The live revision per link, in file order (the export writes links first, so
  // this is Brace's own listing order — preserved so the import reads familiar).
  const linkIndex = new Map<string, number>();
  const linkRows: { id: string; listName: string; updatedDT: number; data: unknown }[] = [];
  // mainId → the newest sslt/pin says, and every tag name on the link.
  const listByMainId = new Map<string, { updatedDT: number; listName: string }>();
  const pinByMainId = new Map<string, { updatedDT: number; rank: string }>();
  const tagsByMainId = new Map<string, { rank: string; tagName: string }[]>();
  const settingsEntries: BraceEntry[] = [];
  const images = new Map<string, Uint8Array>();

  for (const entry of entries) {
    const { path, data } = entry;

    if (path.startsWith(LINKS)) {
      const split = splitFPath(path, 3);
      if (!split || !isObject(data)) continue;
      const [, listName] = split.parts;
      if (listName === '') continue;

      const mainId = mainIdOf(split.id);
      const { updatedDT } = stampsOf(split.id);
      const at = linkIndex.get(mainId);
      if (at === undefined) {
        linkIndex.set(mainId, linkRows.length);
        linkRows.push({ id: split.id, listName, updatedDT, data });
      } else if (updatedDT > linkRows[at].updatedDT) {
        // A newer revision of a link already seen — replace IN PLACE so the
        // surviving row keeps the position its first revision had.
        linkRows[at] = { id: split.id, listName, updatedDT, data };
      }
      continue;
    }

    if (path.startsWith(SSLTS)) {
      const split = splitFPath(path, 5);
      if (!split) continue;
      const [, listName, updatedDTText] = split.parts;
      if (listName === '' || !/^\d+$/.test(updatedDTText)) continue;

      const mainId = mainIdOf(split.id);
      const updatedDT = parseInt(updatedDTText, 10);
      const current = listByMainId.get(mainId);
      if (current === undefined || updatedDT > current.updatedDT) {
        listByMainId.set(mainId, { updatedDT, listName });
      }
      continue;
    }

    if (path.startsWith(PINS)) {
      const split = splitFPath(path, 5);
      if (!split) continue;
      const [, rank, updatedDTText] = split.parts;
      if (rank === '' || !/^\d+$/.test(updatedDTText)) continue;

      const mainId = mainIdOf(split.id);
      const updatedDT = parseInt(updatedDTText, 10);
      const current = pinByMainId.get(mainId);
      if (current === undefined || updatedDT > current.updatedDT) {
        pinByMainId.set(mainId, { updatedDT, rank });
      }
      continue;
    }

    if (path.startsWith(TAGS)) {
      const split = splitFPath(path, 6);
      if (!split) continue;
      const [, tagName, rank] = split.parts;
      if (tagName === '' || rank === '') continue;

      const mainId = mainIdOf(split.id);
      const list = tagsByMainId.get(mainId) ?? [];
      // One tag can only be on a link once; a re-tag writes a second file at a
      // new rank, and either entry names the same tag.
      if (!list.some((tag) => tag.tagName === tagName)) list.push({ rank, tagName });
      tagsByMainId.set(mainId, list);
      continue;
    }

    if (path.startsWith(IMAGES) || path.includes('/' + IMAGES)) {
      // Brace's mobile export writes an ABSOLUTE on-device path rather than the
      // `images/<fname>` key its own importer expects (its web export gets this
      // right). Re-key off the `images/` tail so a phone-made export isn't
      // silently stripped of every custom image.
      const at = path.startsWith(IMAGES) ? 0 : path.lastIndexOf('/' + IMAGES) + 1;
      const key = path.slice(at);
      const bytes = decodeDataUrl(data);
      if (bytes !== undefined) images.set(key, bytes);
      continue;
    }

    if (path.startsWith(SETTINGS)) settingsEntries.push(entry);
  }

  const settings = latestSettings(settingsEntries);
  const listPaths = new Map<string, string[]>();
  walkListNameMap(settings?.listNameMap, [], listPaths);
  const tagNames = readTagNameMap(settings?.tagNameMap);

  const links: ImportedLink[] = [];
  for (const row of linkRows) {
    if (!isObject(row.data)) continue;
    if (typeof row.data.url !== 'string') continue;
    const url = normalizeUrl(row.data.url);
    if (url === null) continue;

    const mainId = mainIdOf(row.id);
    const stamps = stampsOf(row.id);
    const createdAt = typeof row.data.addedDT === 'number' ? row.data.addedDT : stamps.addedDT;
    const link: ImportedLink = {
      url,
      tagNames: (tagsByMainId.get(mainId) ?? [])
        .sort((a, b) => (a.rank < b.rank ? -1 : a.rank > b.rank ? 1 : 0))
        .map((tag) => tagNames.get(tag.tagName) ?? tag.tagName),
      folderPath: [],
    };
    if (createdAt > 0) link.createdAt = createdAt;
    if (stamps.updatedDT > 0) link.updatedAt = Math.max(stamps.updatedDT, createdAt);

    // The link's list is the newest sslt's if it has one, else where it was filed.
    const listName = listByMainId.get(mainId)?.listName ?? row.listName;
    if (listName === BRACE_ARCHIVE) link.systemList = 'archive';
    else if (listName === BRACE_TRASH) link.systemList = 'trash';
    else if (listName !== BRACE_MY_LIST) {
      // A list the name map doesn't know (deleted after the link was filed) keeps
      // its raw id as a folder name — a visible, recoverable home beats silently
      // dropping the link into the default list.
      link.folderPath = listPaths.get(listName) ?? [listName];
    }

    // The page title Brace's extractor found: provisional, like every other
    // imported title. `custom.title` beside it is the user's own — deliberate.
    if (isObject(row.data.extractedResult) && typeof row.data.extractedResult.title === 'string') {
      link.title = row.data.extractedResult.title;
    }
    if (isObject(row.data.custom)) {
      const { title, image } = row.data.custom;
      if (typeof title === 'string' && title !== '') link.customTitle = title;
      if (typeof image === 'string' && image.includes(CD_ROOT)) {
        link.imageRef = image.slice(image.indexOf(CD_ROOT) + CD_ROOT.length);
      }
    }

    const pin = pinByMainId.get(mainId);
    if (pin !== undefined) link.pinRank = pin.rank;

    links.push(link);
  }

  // Only the blobs a surviving link points at — an image whose link was a dead
  // revision (or never made it out of the parse) is not restored.
  const referenced = new Set(links.map((link) => link.imageRef));
  for (const key of images.keys()) {
    if (!referenced.has(key)) images.delete(key);
  }

  return { links, images };
}

// `data:<mime>;base64,<payload>` → bytes. Anything else (a plain URL, a
// percent-encoded data URL, a non-string) yields undefined and the image is
// simply not restored — the link still imports.
function decodeDataUrl(data: unknown): Uint8Array | undefined {
  if (typeof data !== 'string' || !data.startsWith('data:')) return undefined;
  const comma = data.indexOf(',');
  if (comma === -1 || !data.slice(0, comma).includes('base64')) return undefined;
  try {
    return base64ToBytes(data.slice(comma + 1));
  } catch {
    return undefined;
  }
}
