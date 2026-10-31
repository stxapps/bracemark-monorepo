## reader — reading a kept copy, highlights and notes

The screen that shows a link's read-mode copy, and what the user adds to it:
highlights, a note on a highlight, a quote taken from it.

**State today.** bracemark-web's reader is built: _the web reader_ below. Highlights,
notes, quotes, the Markdown export and the expo reader are planned. The copy it reads, and when one is taken, is
[link-extraction-keep.md](./link-extraction-keep.md); the encrypted-file data path
the highlights ride is [local-first-sync.md](./local-first-sync.md); the editors'
conventions this screen should follow are [editors.md](./editors.md); and what
"readable" must mean for a screen of long text is [accessibility.md](./accessibility.md).

### why our own reader, not the browser's

Every browser has a reader view, and none of it is usable here. It reads the live
page, so it is gone when the page is — the case a kept copy exists for. It stores
nothing, syncs nothing, works offline only by accident, holds no highlights, and
does not exist inside the expo app at all. The reader is what turns the read-mode
facet from bytes into something a person opens; the highlights are what make a copy
_theirs_ rather than a cache.

### the web reader — `/read?link=<id>`

`apps/bracemark-web/src/app/(app)/read/`. One route, one link, a tab per kept copy it
has (Read mode, Screenshot) and no tabs for one. Reached from the link row menu's
**Read**, which appears only on a link that has a copy (`link-row-menu.tsx`) — the
reader has nothing else to show, and an item leading to an empty page is a promise
the row can't keep. The ✕ returns to the links view the user left
(`lib/links-return.ts`, as Settings' does).

- **A query parameter, not a segment.** A static export can't build a page per id;
  the one exported `/read` answers every link, and the service worker's precache
  ignores query strings, so the reader opens offline for any copy this device holds
  ([offline-mode.md](./offline-mode.md)). The id is a random token, never the URL.
- **Locks come first.** A link in a locked list is that list's contents, so the page
  swaps in the unlock pane before reading the copy — and drops the _Open page_
  link, since the host is contents too ([locks.md](./locks.md), _the two enforcement
  edges_). Otherwise a `/read?link=` URL in the history would be a way round a lock.
- **Reading is never gated.** A copy that exists is shown on every plan; only the
  empty state reads `keptCopies`, to offer Plus beside the way a copy is taken (open
  the page, save it with the browser extension) — iap/plans.ts, the `keptCopies` note.
- **Bytes on demand.** `useReaderDoc` (web-react) asks `FileContentProvider` for the
  blob at once — no settle delay, the reader is a deliberate open — then gunzips and
  parses it; bytes that aren't a copy settle as "can't be read", never a throw. A copy
  this device never downloaded, opened offline, says so after a few seconds instead
  of spinning.

### rendering — text nodes only

A `ReaderDoc` is blocks of plain strings (`@stxapps/shared` `reader/reader-doc.ts`),
and the renderer's whole job is to keep it that way:

- **web**: one React component per block kind, strings as children — web-ui's
  `components/reader/reader-article.tsx`, whose spec pins that markup in a copy is
  printed, not parsed. Never `dangerouslySetInnerHTML`, never an iframe's `srcdoc`.
  The page's `<h1>` is the article title, so the copy's own headings shift down a
  level; consecutive list items become one real `<ul>`/`<ol>`.
- **expo**: native `<Text>` per block — selectable, scaled by the system font size,
  no WebView.
- **an unknown `kind`** renders nothing, and the rest of the document renders: a
  newer client's block must not blank an older client's screen.
- **links** open only through `isReaderHref` (absolute http(s)), as an ordinary
  cross-origin navigation ([hosting.md](./hosting.md), _crossing an origin_) — the
  same exit a link row takes.
- **figures** are placeholders with the alt text and caption. No image loads,
  because there is no image in the copy and the remote URL was never kept
  ([link-extraction-keep.md](./link-extraction-keep.md), the format tripwire).
- **direction and language** come from the document's `dir` and `lang`, so an RTL
  article lays out right and a screen reader picks the right voice.

Type size, measure and theme follow the app's own settings — [theme.md](./theme.md)
for colour, [accessibility.md](./accessibility.md) for scaling — not a separate set
of reader preferences to sync.

**Reading position** is device-local (`localSettings`): it changes on every scroll,
is worthless on another screen size, and syncing it would write a blob per minute of
reading.

### highlights are user data — `highlights/`, one file each

A highlight is written by a person, so by the writer-split it can't live in
`extractions/` ([link-extraction.md](./link-extraction.md), _the data model_) — a
re-extraction would own it and LWW could lose it. It isn't a field on the link
either: `links/{id}.enc` is small, inline metadata, and a list of highlights would
make every highlight a rewrite of the user's link record and race every list or
tag edit on it.

So a new id-keyed namespace, **one file per highlight**:

```ts
highlights/{highlightId}.enc  →  {
  id, linkId,                  // the link it belongs to
  blockId, start, end,         // the anchor: a block of the copy, an offset range in its text
  quote, prefix?, suffix?,     // the text it covered, and a little either side
  note?,                       // the user's note on it
  color?,                      // a free string, narrowed at read like linksLayout
  createdAt, updatedAt,
}
```

One file each, not one file per link, because file-level LWW decides a concurrent
write by discarding one side. Two devices highlighting the same article in one sync
window would lose one of them, and a highlight is user data — the class of loss the
writer-split exists to prevent. Highlights are few and made by hand, so the extra
objects cost little.

Wiring is the standard three steps (`paths.ts` header, _adding a namespace_), plus
the satellite rules every co-owned entity follows: a link's destroy deletes its
highlights, the dangling sweep learns the namespace, the backup carries it, and an
import drops a highlight whose link is in neither the archive nor the library. A
`.max()` on `note` is a writer cap, never a schema one ([data-limits.md](./data-limits.md)).

### re-anchoring

`blockId` and the offsets are exact only for the copy they were made on. A
re-capture numbers its blocks afresh, and a page edited between captures moves its
words. So the anchor is three layers, tried in order:

1. `blockId` + `start`/`end`, accepted only if the text there still equals `quote`;
2. otherwise, `quote` searched for across the document, `prefix`/`suffix` breaking
   ties — the W3C Web Annotation _text quote selector_ shape;
3. otherwise, the highlight is **detached**: shown in a list under the copy with its
   quote and note, never dropped.

Which is why [link-extraction-keep.md](./link-extraction-keep.md) never replaces a
copy that has highlights on its own: layer 2 recovers most of them, but "most" is not
a thing to do to someone's notes without asking.

### quotes, notes, and getting them out

- **A quote** is a highlight's text sent somewhere — copied, shared — with the
  link's title and URL. Nothing is stored for it.
- **A note** lives on its highlight. A link's own note stays `links.note`; this does
  not replace it.
- **Export**: the Bracemark backup carries `highlights/` as it carries every entity.
  A **Markdown export** — one file per link, the read-mode text with its highlights
  marked and notes beneath — is the interop answer, for the notes apps a
  research-minded library ends up in; the no-lock-in stance asks for it.

### search

Under E2E, search over the copy and the highlights is the client's
([client-queries.md](./client-queries.md)). Highlights are small metadata blobs
every device syncs eagerly, so searching their quotes and notes is cheap. Searching
the copies needs them downloaded, and `files/` is lazy — see
[link-extraction-keep.md](./link-extraction-keep.md), _deferred_.

### open

- On expo: where the reader sits in the router, and whether a row with a copy
  opens it directly. (On web it is the row menu's _Read_; a row's own click stays
  the page itself.)
- Highlight colours: one, a few, or user-defined.
- Whether a quote can be a highlight's own share target on expo (the share sheet
  going the other way).
