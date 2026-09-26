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
// may or may not carry: `title` is a page title the SOURCE's extractor found
// (PROVISIONAL — the orchestrator seeds `extraction.title` with it; see
// sync/entities.ts), `folderPath` is the containing folder chain root-first
// ([] → the importer's default list), `tagNames` are raw names to resolve/create,
// timestamps are epoch ms like everywhere else in the sync system (converted
// from each format's convention — Netscape seconds, CSV ISO 8601).
//
// The four optional fields below the timestamps are the RICHER signal a structured
// export carries and a bookmarks file doesn't. None of them is Brace-shaped —
// they name concepts several services have, which is why csv.ts now sets
// `systemList` from Pocket's `status: archive` column and netscape.ts fills
// `note` from the format's <DD> element, with no new branch anywhere downstream.
// `pinRank` and `imageRef` are still set by structured exports alone (Brace, and
// LinkWarden's pins), because no bookmarks file carries an order or bytes. A
// parser that has nothing to say leaves them undefined.
export interface ImportedLink {
  url: string;
  title?: string;
  note?: string;
  tagNames: string[];
  folderPath: string[];
  createdAt?: number;
  updatedAt?: number;
  // The title the user SAW in the source app — which may be one they typed. It
  // lands in `link.customTitle`, above `extraction.title` in the display fold, so
  // our extractor can fill in underneath it but never replace it. Every format
  // that carries a title sets this one, because in all but one of them the user
  // could have renamed the link and the file doesn't say: a browser bookmark, a
  // Raindrop or Pocket row, a LinkWarden `name`. Overwriting a rename is
  // unrecoverable, while a page title wrongly held here is one cleared field
  // away from the extracted one — and the file's title is rarely the worse of the
  // two: a browser captured it in a live tab and a service ran its own extractor,
  // where an import only ever gets a background fetch (docs/link-extraction.md,
  // _imported links_). Brace is the exception that keeps both fields: its
  // `custom.title` comes here and its extractor's result goes to `title`. A title
  // that only restates the address is dropped by the projection (project.ts).
  customTitle?: string;
  // The link belongs to a SYSTEM list rather than a folder — named, not
  // name-matched: `ListResolver` resolves folders by name, so a `['Archive']`
  // chain would mint a duplicate list on an account whose Archive has been
  // renamed, and Trash is deliberately unmatchable there (right for a bookmarks
  // folder called "Trash", wrong for a real one). When set, `folderPath` is
  // ignored. The orchestrator maps it to ARCHIVE_ID / TRASH_ID.
  systemList?: 'archive' | 'trash';
  // Present ⇒ the link is pinned. The value is an OPAQUE sortable key from the
  // source (Brace stores LexoRank); only its ORDER is meaningful — the
  // orchestrator sorts the pinned rows by it and mints fresh ranks in this
  // library's own keyspace (sync/rank.ts), never stores it.
  pinRank?: string;
  // The user's custom link image, as a key into `ImportedBundle.images`. Kept as
  // a REFERENCE rather than inline bytes so a row stays cheap to copy and two
  // rows can share one blob. The orchestrator writes the bytes as a
  // `files/{id}.enc` and points `link.customImageId` at it.
  imageRef?: string;
}

// What one import FILE yields: its rows plus any blobs they reference. The
// interop parsers (netscape/csv/text) never carry bytes and return an empty map;
// a structured export does. Bundling the two is what lets `parseImportText` stay
// the single dispatch point — the alternative is each orchestrator special-casing
// the formats that have blobs, which is the duplication parse.ts exists to stop.
export interface ImportedBundle {
  links: ImportedLink[];
  // Keyed by whatever the source calls the blob (`ImportedLink.imageRef` holds
  // the same string) — the keyspace is the parser's business, not the caller's.
  images: Map<string, Uint8Array>;
}

// Optional evidence for file inspection. Positions are one-based source records
// (CSV includes its header); a reason means the record did not become a link.
export interface ImportObserver {
  row(position: number, reason?: string): void;
  folder(path: string[]): void;
}
