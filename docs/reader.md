## reader — reading a kept copy, highlights and notes

The screen that shows a link's read-mode copy, and what the user adds to it:
highlights, a note on a highlight, a quote taken from it. **Planned — nothing here
is built.** The copy it reads, and when one is taken, is
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

### rendering — text nodes only

A `ReaderDoc` is blocks of plain strings (`@stxapps/shared` `reader/reader-doc.ts`),
and the renderer's whole job is to keep it that way:

- **web**: one React component per block kind, strings as children. Never
  `dangerouslySetInnerHTML`, never an iframe's `srcdoc`.
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

- Where the reader sits in each app's routing, and how it is reached from a row
  (a menu item, the row itself when a copy exists).
- Highlight colours: one, a few, or user-defined.
- Whether a quote can be a highlight's own share target on expo (the share sheet
  going the other way).
