## reader — reading a kept copy, highlights and notes

The screen that shows a link's read-mode copy, and what the user adds to it:
highlights, a note on a highlight, a quote taken from it.

**State today.** Both apps' readers are built — _the web reader_ and _the expo reader_
below. Highlights, notes, quotes and the Markdown export are planned. The copy it reads, and when one is taken, is
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
**Read**, under the rule in _the way in_ below: on a link that has a copy, on every
plan, and on one that has none only on a plan that can take one — the empty state
then says how. The ✕ returns to the links view the user left
(`lib/links-return.ts`, as Settings' does).

- **A query parameter, not a segment.** A static export can't build a page per id;
  the one exported `/read` answers every link, and the service worker's precache
  ignores query strings, so the reader opens offline for any copy this device holds
  ([offline-mode.md](./offline-mode.md)). The id is a random token, never the URL.
- **Locks come first.** A link in a locked list is that list's contents, so the page
  swaps in the unlock pane before reading the copy — and drops the _Open page_
  link, since the host is contents too ([locks.md](./locks.md), _the two enforcement
  edges_). Otherwise a `/read?link=` URL in the history would be a way round a lock.
- **Two ways out, in the top bar.** _Open page_, the live page, and _Wayback
  Machine_ — the Internet Archive's capture nearest the day the link was saved, for
  the page that has changed or gone ([link-extraction-keep.md](./link-extraction-keep.md),
  _when the page is gone_). Below `sm` the second is its icon alone, under the full
  accessible name; the words are in the empty state, which also says in a sentence
  what the Wayback Machine may have. The row menu has no Wayback item — on web this
  screen is where it lives. The address is built on the
  device and nothing is asked of the archive before the click. Behind a lock both are
  gone.
- **The line under the title** is the site, the author, _Published_ and the date the
  page gave (`readerPublishedAt` — dropped when the page gave none, one that can't be
  read, or one later than the copy), and _Kept_ with the day the copy was taken. The
  last is the one a kept copy is for: this is the page as it was that day.
- **Deleting a copy.** Under each copy, _Delete this read-mode copy_ / _Delete this
  screenshot_, behind a confirmation ([link-extraction-keep.md](./link-extraction-keep.md),
  _removal, cleanup, export_). Bulk edit's _Delete copies_ does the same for a
  selection. Like reading, never gated.
- **Reading is never gated.** A copy that exists is shown on every plan; only the
  empty state reads `keptCopies`, to offer Plus beside the way a copy is taken (open
  the page, save it with the browser extension) — iap/plans.ts, the `keptCopies` note.
- **Taking a read-mode copy here.** With _Server read mode_ on (`serverReadMode`, its
  own opt-in, not Link previews') and a plan with `keptCopies`, the empty state offers
  _Keep a read-mode copy_, with _Include images_ beneath it — and only that button's press
  asks. With the opt-in off, it offers _Turn on server read mode_ in place, beside the
  sentence saying what is sent; turning it on fetches nothing and hands focus to _Keep_
  ([link-extraction-keep.md](./link-extraction-keep.md), _per client_, bracemark-web). The row menu's **Read** lands a paid plan's link with no copy here, and a press
  that says "Read" is not an ask to have the server fetch the page; nor is an address,
  so a reload or a history entry never fetches by itself. The answer is shown in place:
  the copy (the screen swaps to it), or why there is none — no article, not a web page,
  the site's robots.txt says no, or try later
  ([link-extraction-keep.md](./link-extraction-keep.md), _bracemark-web_).
- **Bytes on demand.** `useReaderDoc` (web-react) asks `FileContentProvider` for the
  blob at once — no settle delay, the reader is a deliberate open — then gunzips and
  parses it; bytes that aren't a copy settle as "can't be read", never a throw. A copy
  this device never downloaded, opened offline, says so after a few seconds instead
  of spinning.

### the expo reader — `/read?link=<id>`

`apps/bracemark-expo/src/app/(app)/read.tsx` over `features/reader/reader-screen.tsx`:
the same address as web's, a pushed Stack screen behind the (app) gates, reached from
the row menu's **Read** on a link with a copy (a link without one goes to the capture
screen instead — _the way in_). Same three
rules as web — locks first, reading and deleting never gated, text only — the same two
ways out in the top bar (the Wayback Machine as an icon at every width, a phone's bar
having no room for a second label), the same line under the title, and the same
states, read through expo-react's `useReaderDoc`, which reads the decrypted file off
disk and gunzips it with fflate (Hermes has no DecompressionStream). The screenshot is
expo-image over the same file. Unlike web it has no empty-state upsell: a link only
reaches the screen with a copy, and taking one is the capture screen's job
(`/capture?link=<id>` — [link-extraction-keep.md](./link-extraction-keep.md), _per
client_, bracemark-expo), so there would be nothing to offer here. What it has
instead, on a plan with `keptCopies`, is a top-bar way across to that screen —
_Update from the page_, for a page that has changed since the copy.

### the way in — one **Read** in the row menu

Decided 2026-11-11, on both apps. The row menu carries one entry to everything about
a link's page — **Read** — and the screens behind it carry the rest: keeping a fresh
copy, re-reading the preview, and the Wayback Machine. Before, the expo menu had
_Read_, _Keep a copy_, _Update preview_ and _Open in Wayback Machine_ as four rows,
two of them opening the same screen and none of them saying which want they served;
it was the menu's clutter.

| the link has… | plan with `keptCopies`                                  | free        |
| ------------- | ------------------------------------------------------- | ----------- |
| a copy        | the reader                                              | the reader  |
| no copy       | expo: the capture screen; web: the reader's empty state | no **Read** |

- **A copy is read on every plan.** The free column's first row is the no-hostage
  rule (`iap/plans.ts`, the `keptCopies` note): a copy kept on an earlier plan stays
  the user's, so a lapsed plan must not take its only way in.
- **No copy and no plan, no item.** Behind it there would be only a screen saying what
  the account can't have. A free account sets a link's title and image by hand in the
  editor; _Update preview_ is a `keptCopies` action, like the capture screen's _Keep a copy_.
- **On expo the two screens are one place with two faces.** The reader's _Update from
  the page_ goes to the capture screen; the capture screen's _Read_ (while the link
  has a copy) and its _Kept — read it_ come back. Each move is a `router.replace`, so
  the two trade places and Back always leaves to the links view, however often the
  user crossed.
- **The Wayback Machine is on the screens, not the menu** — the reader's top bar on
  both apps and the capture screen's on expo, said in words in web's empty state and
  under a page the capture screen couldn't load. It is for the page that has changed
  or gone, and those screens are where a user finds that out
  ([link-extraction-keep.md](./link-extraction-keep.md), _when the page is gone_).
- **Web has no capture screen**, so a paid plan's link with no copy lands on the
  reader's empty state: _Keep a read-mode copy_ with server read mode on, the offer to
  turn it on otherwise, and the browser extension either way. The web reader offers no re-keep of a copy that exists.

### rendering — text nodes only

A `ReaderDoc` is blocks of plain strings (`@stxapps/shared` `reader/reader-doc.ts`),
and the renderer's whole job is to keep it that way:

- **web**: one React component per block kind, strings as children — web-ui's
  `components/reader/reader-article.tsx`, whose spec pins that markup in a copy is
  printed, not parsed. Never `dangerouslySetInnerHTML`, never an iframe's `srcdoc`.
  The page's `<h1>` is the article title, so the copy's own headings shift down a
  level; consecutive list items become one real `<ul>`/`<ol>`.
- **expo**: native `<Text>` per block — selectable, scaled by the system font size,
  no WebView (`features/reader/reader-article.tsx`). Ordered items are counted per
  run, since there is no `<ol>` to number them, and the list markers are hidden from
  VoiceOver/TalkBack, the item's text carrying the content.
- **an unknown `kind`** renders nothing, and the rest of the document renders: a
  newer client's block must not blank an older client's screen.
- **links** open only through `isReaderHref` (absolute http(s)), as an ordinary
  cross-origin navigation ([hosting.md](./hosting.md), _crossing an origin_) — the
  same exit a link row takes.
- **figures** are placeholders with the alt text and caption. No image loads,
  because there is no image in the copy and the remote URL was never kept
  ([link-extraction-keep.md](./link-extraction-keep.md), the format tripwire).
- **a figure that kept its picture** shows it, from the copy's own image pack
  (`extraction.readModeImagesId`; _images in read mode_ there). The reader asks for
  the pack beside the text (`useReaderImages`, on both platforms) and hands the
  renderer a map from key to a local image — a `blob:` URL on web, a `data:` URI on
  expo — so the only source a figure can have is one minted on this device from
  decrypted bytes. Three states: the picture, in a box of the block's stored aspect
  ratio and never wider than the image; the same box empty while the pack is on its
  way, so the text below does not move when it lands; and the words, when the pack is
  read and has no picture for that key, or can't be read at all.
- **tables** are tables: a real `<table>` in a focusable sideways scroller on web, a
  horizontal scroll of fixed-width columns on expo, each cell's strings rendered like
  any other ([link-extraction-keep.md](./link-extraction-keep.md), _tables_). The grid
  is rectangular as stored, and neither renderer trusts that.
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

A table's cells are not anchorable in the first version: a highlight anchors to a
block with `runs` or `text`, and a `table` block's content is in its `rows`
([link-extraction-keep.md](./link-extraction-keep.md), _tables_).

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

### a row's press opens the page

Decided 2026-11-10, on both apps: **a row's press opens the page itself, whether or
not the link has a copy**, and the reader is reached from the row. Two reasons. Most
links are not articles — something to watch, buy or visit — so the page is what a
press is for. And a press that opens the reader on some rows and leaves the app on
others is one the user cannot predict from the row.

The cost is that a copy is only in the menu (**Read** — _the way in_), which hides the
one thing the copy is for. _Planned, not built_: a visible Read control on a row that has a copy, a
sibling of the row's link like the menu trigger, in every layout on both apps.

The reader is therefore where someone goes when the page let them down, which is why
its top bar carries both ways out — the page, and the Wayback Machine.

### open

- Highlight colours: one, a few, or user-defined.
- Whether a quote can be a highlight's own share target on expo (the share sheet
  going the other way).
