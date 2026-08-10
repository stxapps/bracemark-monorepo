// The decoded rows the import parsers produce (netscape.ts / csv.ts / text.ts —
// the read mirrors of the export serializers next door in export/). Pure data,
// no Dexie/React: a parser turns one file's text into ImportedLink[] and decides
// NOTHING about the library — dedup against existing links, folder→list and tag
// name→id resolution, quota, and the actual writes all happen in the client's
// import orchestrator (web-react data/import-all-data.ts), so the parsers stay pure
// `(text) => rows` functions any platform (web today, Expo later) can reuse.
// The Bracemark-backup zip does NOT go through this: it round-trips raw entities per
// path (manifest + items.jsonl), not this interop projection.

// One parsed link. `url` is already normalized (url/normalizeUrl) — parsers emit
// only storable http(s) URLs and silently drop what can't be one (bookmarklets,
// `place:` rows, mailto:). Everything else is optional signal the source format
// may or may not carry: `title` is the file's display title (PROVISIONAL — the
// orchestrator seeds `extraction.title` with it, never `customTitle`; see
// sync/entities.ts), `folderPath` is the containing folder chain root-first
// ([] → the importer's default list), `tagNames` are raw names to resolve/create,
// timestamps are epoch ms like everywhere else in the sync system (converted
// from each format's convention — Netscape seconds, CSV ISO 8601).
export interface ImportedLink {
  url: string;
  title?: string;
  note?: string;
  tagNames: string[];
  folderPath: string[];
  createdAt?: number;
  updatedAt?: number;
}
