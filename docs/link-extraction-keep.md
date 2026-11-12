## link extraction — the kept copies: read mode, screenshot, page copy

The three facets that keep **content** rather than describe a link: the page's
article text (`readMode`), how the page looked (`screenshot`), and a whole copy of
it (`pageCopy`). When each is taken, by which client, in what format, behind which
gate, and how its blob is removed. Part of the link-extraction set: everything the
facets share — who may fetch, the tiers, the writer-split, the extraction entity,
the queue — is [link-extraction.md](./link-extraction.md), and this file assumes it.
[link-extraction-server.md](./link-extraction-server.md) is the server path that also
serves the read-mode facet, and where its robots.txt rule lives; [reader.md](./reader.md) is the screen that shows
a kept copy and the highlights and notes made on it; [data-lifecycle.md](./data-lifecycle.md)
and [data-limits.md](./data-limits.md) carry the export and limit rows for these
blobs.

**State today.** Built end to end on desktop: the browser extension takes read mode
automatically on a save when the plan has `keptCopies`, and offers read mode and a
screenshot as taps on its saved screen (`popup/Editor.tsx`, `popup/KeptCopies.tsx`;
captures in `utils/capture.ts`, `extraction-worker.ts`); bracemark-web reads both at
`/read?link=<id>` ([reader.md](./reader.md), _the web reader_), and the synced save
setting chooses what a save keeps (Settings → Read mode). Server
read mode is built (_per client_, bracemark-extractor) and reached from bracemark-web
as a per-link _Keep a read-mode copy_ in the reader. Removal (one copy, and a selection's in bulk edit) and
the orphaned-file sweep are built (_removal, cleanup, export_), and so are expo's
reader, its iOS share-from-Safari read mode and its capture screen (_per client_,
bracemark-expo) — which also re-reads a link's title and preview image from the live
page, _Update preview_, on a plan with `keptCopies`. A read-mode copy keeps a page's **tables** as tables (_tables_) and
its **images** in a pack beside the text, on every tier that takes a copy (_images in
read mode_), and the reader and the capture screen have a way to the **Wayback
Machine** for the page that is gone (_when the page is gone_). None of it has been released yet — which is why the
table block and the figure's image fields could still go into the format's first
version.

Not built: a per-link _Keep screenshot_ outside the extension's saved screen, the
scoped bulk job, and — within images — SVG
(_images in read mode_, _not yet_). Decided against for now, each with its reason in
_the scope each copy stops at_: a screenshot on expo or on the server, a full-page
screenshot, and page copy anywhere. Everything below marked _planned_ is the design the
unbuilt pieces are built to.

**Naming.** "Page copy", never "archive" — the word is the Archive system list's
([link-extraction.md](./link-extraction.md), the opening note). "Read mode" in prose,
`readMode` in code. "Kept copies" is this file's name for the three together, and
the code's (`keptCopies`); what a user reads is "copies", never "kept copies" as a
label nor "page copies" for the three — [brand-assets.md](./brand-assets.md),
_terminology_.

### why these three, and in this order

A preview tells you what a link was; a kept copy is what you go back for when the
page has moved, gone behind a sign-in, or changed. The three are not equal:

| facet      | what it keeps                        | size as stored, one link                                                                   | built     |
| ---------- | ------------------------------------ | ------------------------------------------------------------------------------------------ | --------- |
| read mode  | the article's words, and its images  | text: median 5.5 KB, p90 42 KB (gzipped); with images, a pack of median 127 KB, p90 1.6 MB | extension |
| screenshot | what was on screen when it was saved | median 135 KB, p90 237 KB, max 271 KB (2× laptop)                                          | extension |
| page copy  | the page, offline, with its assets   | MBs; tens for media-heavy pages (est.)                                                     | not built |

**Measured 2026-11-09** with `measure:kept-copies` ([e2e.md](./e2e.md), _measuring
kept copies_): 62 public pages, 36 chosen as articles and 26 not, each captured
with the browser extension's own code and counted as stored — after gzip or the
re-encode, plus the encryption frame. Read mode was kept on 44 of them: 31 of the
36 articles, and 13 pages Readability took for one. The screenshot depends on the
screen: at 1440×900 on a 2× laptop the capture is re-encoded down to the 1600 px
cap (the figures above); at 1920×1080 on a 1× monitor it is median 105 KB, p90
187 KB, max 206 KB. Articles screenshot larger than other pages (median 161 KB
against 124 KB at 2×): text is detail JPEG keeps. For scale, the **preview image**
every plan stores beside them came to median 32 KB, p90 77 KB, max 217 KB, on the
38 pages that named one the extension could fetch; a link that keeps all three
was median 172 KB, p90 315 KB at 2×. The page-copy row is still an estimate.

The figures settle the order:

- **Read mode first.** It is the copy people come back to read, the one highlights
  and notes need, and the only one search can use. Compressed, it is smaller than
  the preview image every link already stores.
- **Screenshot second, above the fold only.** It is the copy for pages that aren't
  articles — a product page, a listing, a dashboard — which is
  exactly where read mode answers "not an article". The visible viewport is what
  the user actually saw and needs no permission beyond `activeTab`.
- **Page copy not yet.** Read mode plus a screenshot covers "read it later" and
  "how it looked". A real page copy costs far more than either (_page copy_, below),
  so it waits for evidence that people want it on top of them.

### the scope each copy stops at

Decided 2026-11-10, after the three were built or designed and before any was released.
Each line is a place the feature deliberately ends, and the reason, so the next person
does not extend one by reflex.

- **Read mode is the archive.** For an article it is the copy that lasts: small, readable
  on every device, the only one highlights and search can use. So the work on kept
  copies went into what a read-mode copy keeps — tables, then images — and not into
  taking screenshots in more places.
- **The screenshot is the fold, from the browser extension, and nothing more.** It is a
  record of **what was on screen when the page was saved** — a price, a listing, a
  dashboard — for the page where read mode answers "not an article". That is narrower
  than an archive (an article's fold is its headline) and it is not a preview either:
  it shows what the user saw, signed in, that day, where a preview is the picture the
  publisher chose. Every surface says so in those words; a bare "screenshots of pages"
  reads as the whole page, top to bottom.
  - **Not on the server**, for the reasons under _per client_, and one more that makes
    it a non-feature rather than a cost: a server render is what a bot saw later, from a
    data-centre address, signed out and behind the consent banner. It is not the thing
    this copy is — and it fails on exactly the pages a screenshot is for.
  - **Not on expo, for now.** It is the cheapest unbuilt piece (`react-native-view-shot`
    on the capture screen that already exists) and the weakest: the WebView has its own
    cookie store, so a signed-in page shows its login wall; it takes a second, deliberate
    gesture after the save, so it is not "when it was saved"; and a phone's fold is
    mostly header and banner. Build it when people ask, not before.
  - **Not the full page** (_the screenshot is a capped JPEG of the fold_).
- **Page copy is deferred, and may never be built.** It is the expensive one — capture
  on the order of SingleFile, a viewer on an origin of its own, megabytes a page — and
  the two cheaper answers cover most of what it is for: read mode keeps an article's
  content and its pictures, and for a public page the Wayback Machine usually has the page as it was
  (_when the page is gone_). What only a page copy would add is a faithful copy of a
  **signed-in** page, or of a public page the Wayback Machine missed. Revisit if people
  ask for that, in those words.

### ⚠ the read-mode copy is blocks, never HTML

`extraction.readModeId` names a `files/{id}.enc` blob whose plaintext is a
`ReaderDoc` (`@stxapps/shared` `reader/reader-doc.ts`) as gzipped UTF-8 JSON (the
codec is web-react `lib/reader-doc-bytes.ts`). A `ReaderDoc` is a list of typed
blocks — `heading`, `paragraph`, `quote`, `listItem`, `code`, `figure`, `table`,
`rule` — each holding plain strings with inline marks (bold, italic, code, an http(s)
link target). There is no markup in it anywhere.

That is the whole safety argument, and nothing would report its loss. A page is the
least trusted input the product handles, and the copy is rendered inside the app
that holds the data key. The first scaffold stored the article's `innerHTML`; a
reader rendering it would have been script on `app.bracemark.com` for any page that
slipped a handler past a sanitizer, and every `<img>` in it a request to the saved
site on every view — the per-paint leak [link-extraction.md](./link-extraction.md),
_the preview image is a downloaded blob_, exists to forbid. Sanitizing HTML is a
contest with every page ever written; a renderer that turns strings into text nodes
has nothing to sanitize. The same shape renders natively on expo with no WebView,
gives a highlight a stable anchor (a block's `id` plus an offset into its text — see
[reader.md](./reader.md)), and gives search plain text.

So, for anyone tempted to "just keep the HTML" for fidelity:

- **No field of a `ReaderDoc` is markup**, and no renderer may hand one to
  `innerHTML`, `dangerouslySetInnerHTML`, `srcdoc` or a WebView's `source.html`.
  A block the format can't express is flattened at capture or becomes a new block
  kind — a reader skips a kind it doesn't know, which is why a new kind is best added
  before a reader that lacks it has shipped (_tables_ was).
- **No remote URL is rendered.** Images become `figure` placeholders carrying the
  alt text and caption; the bytes are not kept in v1 and the URL never is. A link
  target is data the user may choose to open, re-checked with `isReaderHref`
  (absolute http(s) only) at render as well as at capture, because a backup is an
  outside file.
- **No `.max()` in the schema.** It parses stored bytes; the caps
  (`READER_DOC_MAX_BLOCKS`, `READER_DOC_MAX_CHARS`) are the capture's
  ([data-limits.md](./data-limits.md), the tripwire).

**Gzip before encryption**, because ciphertext doesn't compress and article text
compresses three- to five-fold. The format is gzip, not an API: the extension's
service worker encodes with `CompressionStream`, and expo, which has no such global,
reads the same bytes with fflate.

### tables

A page's data table is **one `table` block**: `rows` of `cells`, each cell the same
inline runs a paragraph holds, with `header` on a `<th>` or on any cell of a `<thead>`
row, the `<caption>` as the block's `runs`, and `truncated` when the capture cut it.
Until 2026-11-10 a table was flattened to one paragraph per row, cells joined by a dot —
readable, and no longer a table. The block went in before any reader was released, so no
shipped client has to skip it.

- **The grid is rectangular as written.** The capture expands every `colspan` and
  `rowspan` into empty cells and pads short rows (`tableBlock`,
  `reader/reader-doc-from-dom.ts`). So a renderer never lays a span out — which matters
  on expo, where there is no table element and a row is a line of Views. The cost is
  that a merged heading reads as its text followed by blanks; that was judged better
  than two renderers each implementing spans.
- **A cell holds runs, never blocks.** Two paragraphs or a list inside one cell become
  one run list with a line break between the pieces (`walkCell`), not nested blocks.
  Nesting would give the format a second tree to walk, cap and anchor highlights into,
  for the few tables that need it.
- **Only a data table is kept as one.** A `<table>` with fewer than two rows or two
  columns, one holding another table, or one wider than `READER_TABLE_MAX_COLUMNS`
  (24) is layout or a spreadsheet, not a figure in an article: its cells are walked as
  ordinary content, so its words are kept and its grid is not. A table nested in such a
  cell is judged on its own.
- **A long table is cut, and says so.** Past `READER_TABLE_MAX_ROWS` (500) the block
  stops and carries `truncated`; both readers print that the rest was not kept. Both
  caps are the capture's, never the schema's ([data-limits.md](./data-limits.md)).
- **Rendering.** Web: a real `<table>` — `<thead>` for the leading all-header rows,
  `scope` on header cells, the caption as its name — inside a focusable sideways
  scroller, since a keyboard can only scroll what it can focus. Expo: a horizontal
  `ScrollView` of rows, each column as wide as its longest line wants (between a floor
  and a ceiling, scaled with the OS text size), laid out in the **copy's** direction,
  not the phone's. Both read `rows` defensively: stored bytes are not trusted to be
  the shape the capture writes, a cell with no readable runs is an empty cell (never
  dropped, which would shift its row a column left), and a table with no readable row
  renders nothing.
- **The schema asks for less than the capture writes.** A row's `cells` and a cell's
  `runs` are optional in `readerDocSchema`, because a parse that fails drops the whole
  copy as unreadable: a newer client that gives a cell something else must cost an
  older reader that cell, not the article.
- **As text** (`readerDocText`, what search would index): the caption, then a line per
  row with a tab between cells.
- **Not yet:** column alignment, a highlight anchored inside a cell
  ([reader.md](./reader.md), _highlights_), and blocks inside a cell.

### images in read mode

A read-mode copy keeps the article's pictures with its words. Built on every tier
that takes a copy, 2026-11-10; before that a figure was only its alt text and caption,
which loses the chart the paragraph is about. **Off by default** (changed 2026-11-12,
before any release carried it): the pack is the largest thing a library holds, ~5× a
link's whole footprint without it (_what it does to storage_), so the default keeps the
words and the switch asks for the pictures. It has a switch of its
own — _Include images in read-mode copies_, on the browser extension's options page,
in Settings → Read mode on the web, and on both phones (`keepReadModeImages`, resolved by
`keepOnSaveOf`). Unlike its neighbours
it is not "on save": it qualifies **every** read-mode copy the account takes, a
per-link _Keep a read-mode copy_ included, because what it answers is how much of an article
a copy keeps, not when one is taken.

**One pack per article, beside the text.** The images are a single second blob,
`files/{id}.enc`, named by **one display field on the extraction**:
`readModeImagesId`, in `EXTRACTION_FILE_REF_FIELDS`. Not inlined into the
`ReaderDoc`, and not a blob per image:

- **Not inside the text copy**, because the text is a few KB and must stay that way: it
  opens at once, parses in a process with little memory (the iOS share drain), and is
  what a device would download in bulk to search. Images are a hundred times the bytes
  and wanted only when the article is on screen.
- ⚠ **Not ids kept only inside the `ReaderDoc`.** The orphaned-file sweep finds a blob's
  references in **entities**; the read-mode copy is a `files/` blob, not an entity, so a
  blob named only in it is unreferenced as far as the sweep can tell and is **deleted
  after the 30-day grace, on every device** (_removal, cleanup, export_). The reference
  has to be a field of the extraction. Nothing would report getting this wrong for a
  month.
- **Not a blob per image.** One field naming one blob rides every rule that already
  exists — destroy, replace, remove a copy, the backup, the sweep — where N ids would
  need an array in the always-resident extraction record and a put (and its server-side
  rows) per image. The cost of a pack is that the first image waits for all of them;
  at the sizes below that is one small download.

**The pack's format** (`@stxapps/shared` `reader/reader-images.ts`,
`encodeReaderImages` / `decodeReaderImages`) is the contract between platforms — web
writes packs expo reads, and the other way round. Four bytes `BMRI`, a version byte,
the index's length, the index as ASCII JSON (`key`, `type`, `width`, `height`,
`length` per image), then each image's bytes end to end. Not gzip, since images don't
compress, and not base64 in JSON, which is a third larger and parsed whole. The index
is ASCII so it decodes without a `TextDecoder`. A pack that isn't one — damaged, or a
newer version — decodes to nothing, never a throw: the article keeps its words.

**In the document**, a `figure` block that kept its picture carries `image` (its key
in the pack, `i0`, `i1`, …) and the stored `width` and `height`. The dimensions let the
reader hold the space before the pack arrives, so the text does not jump and the
reading position holds. A figure with no `image` is the placeholder it always was.

⚠ **The image addresses travel beside the document, never in it.** A capture that
keeps images runs the walker as `readerCaptureFromArticle` (`readerCaptureFromPage`
in a live page), which returns the `ReaderDoc` and, separately, `images` — a
`{ key, url }` per figure it gave a key to. The client fetches what it can, and the
list is dropped. If the address were a field of the block, a writer that forgot to
strip it would store a remote URL in a copy — the leak the format exists to prevent —
and every test of an ordinary article would still pass. Both renderers take a figure's
picture only from the map their caller built from the pack; a spec on each holds that
nothing a block carries can become a `src`.

⚠ **Every capture settles its document before storing it** — `applyReaderImages`,
called by the one writer on each platform (`storeReadModeCopy`: web-react
`lib/store-read-mode.ts` for the browser extension and bracemark-web, expo-react
`data/store-read-mode.ts`). It gives each kept figure its stored size and takes the
key off every figure whose picture is not in the pack, so with images off, or none
fetched, the stored document names no picture at all. A capture that wrote the
walker's document as it came would promise pictures the pack doesn't hold. The same
writer stores `readModeImagesId` even when it is undefined, so a re-capture **clears**
an earlier copy's pack and `writeExtraction` reclaims it.

**Which images, and how they are kept** (the constants are in
`reader/reader-doc-core.ts`; all are the capture's, never the schema's):

- **An image alone in its element is a figure; an image among words is not.**
  `<figure>`, `<picture>`, a bare `<img>` between blocks, and the usual wrappers
  (`<p><img></p>`, `<a><img></a>`) become figures. An emoji or an inline icon inside a
  sentence is left out, as every image used to be: promoting it would cut the sentence
  in two around a placeholder.
- **The address** is the smallest `srcset` candidate that still fills the stored
  size, so the fetch is not a 4000 px original thrown away in the resize; then a
  `<picture>` source, skipping types no client is sure to decode (AVIF, HEIC, JPEG
  XL); then `src`, or a lazy-loader's attribute in its place. A `data:` URI is not an
  address. At most `READER_IMAGES_MAX_COUNT` (30) leave the walker, one per distinct
  URL.
- **Raster only**, by the bytes (`sniffImageMime`), as the preview path checks. ⚠ An
  SVG is markup and is refused — see the measurement for what that costs.
- **Not an icon**: smaller than 100 × 100 in area, or thinner than 32 px on a side, is
  dropped after the decode (`isReaderImageTooSmall`). Area, so a wide formula or a
  sparkline is kept and an avatar is not.
- **Re-encoded** to JPEG, at most `READER_IMAGE_MAX_DIMENSION` (1024 px) on its
  longest side at quality 0.8, flattened onto white — even when already within the
  cap, unless it is a JPEG the re-encode did not make smaller. A preview within its cap
  is stored unchanged; an article is thirty images against one budget, and a 900 px PNG
  or an animated GIF is megabytes as it stands.
- **One budget for the pack**: `READER_IMAGES_MAX_BYTES` (4 MiB). Images are taken in
  page order until one doesn't fit, and everything after it stays a placeholder
  (`withinReaderImageBudget`) — "the pictures stop here", not a scatter of gaps.
- **A picture that can't be had is a placeholder, never a failed capture.** The fetch
  runs a few at a time under one deadline for the article; the text is already in
  hand and does not wait on a slow image host.

**Who fetches the bytes** — the same split as the preview image
([link-extraction.md](./link-extraction.md), _the preview image is a downloaded blob_):

| client                     | how                                                                                             | what it can't reach                                    |
| -------------------------- | ----------------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| browser extension          | `fetch` inside the page, one injection per image (`fetchReaderImage`, `utils/capture.ts`)       | an image host that refuses a cross-origin read         |
| bracemark-expo, capture    | `fetch` inside the WebView's page, encoded there; native fetch for whatever the page couldn't   | — each covers the other's gap                          |
| bracemark-expo, share      | native fetch (`lib/reader-images.ts`), from a Safari share's drain                              | an image behind the page's sign-in                     |
| bracemark-web (the server) | the extractor's `readModeImages` list, each through the image proxy (`lib/server-read-mode.ts`) | past 12 images, and anything the proxy's limit refuses |

- **The browser extension** reads the setting from the store at the capture, as the
  popup reads the save setting, and bails on an image if the tab has left the page
  the document came from — a fetch made then would run in another page's context.
- **bracemark-expo**'s capture is `{ doc, images }` as JSON text from both generated
  scripts (the Safari preprocessing file and the WebView capture), so the addresses
  ride the same one string the document does. From a share's drain the fetch is also
  subject to the device's fetch mode — `off` stops it (`share-bridge.tsx`) — since it
  is this app making requests for a link the sheet saved; from the capture screen it
  is an explicit ask on a page the user has open.
- **On the capture screen the page fetches first.** Its WebView asks the page for the
  images (web-react `lib/webview-capture.ts`): fetched there with the page's own
  context — the site's session for an image on its own origin — and re-encoded there
  by `encodeReaderImage`, so each crosses to the app as the 1024 px JPEG it will be
  stored as, not an 8 MB original inflated by base64. The app takes a posted picture
  only as a JPEG whose size it measures itself, within the dimension cap
  (`readerImageFromPage`, expo-react `lib/reader-images.ts`), and fetches every
  address the page couldn't answer natively — no CORS there, so the host that refuses
  the page a cross-origin read answers the app. `credentials` stays at the default:
  `include` would fail every cross-origin read against a host that answers
  `Access-Control-Allow-Origin: *`, which is most image CDNs. With images off the page
  is asked for nothing.
- **bracemark-extractor** returns the addresses and fetches none: thirty images
  inside the extract request would hold it past its deadline and inline megabytes
  into JSON. The proxy is rate-limited per address and shared with a bulk import's
  previews, so the web path asks for at most 12, three at a time. The robots.txt
  answer for `readMode` covers the article's images with it: they are the body.

**Measured 2026-11-10** with `measure:kept-copies` ([e2e.md](./e2e.md)), on the
browser extension's path, over the 42 pages a copy was kept on:

| what                                   | figure                                             |
| -------------------------------------- | -------------------------------------------------- |
| image addresses found per copy         | median 2, p90 14, the cap of 30 on four pages      |
| copies that kept at least one image    | 22 of 42                                           |
| addresses kept                         | 197 of 232 (85%)                                   |
| not kept: SVG                          | 26 (11%)                                           |
| not kept: an icon                      | 5                                                  |
| not kept: the page could not read them | 4 (2% of all, 3% of those on another origin)       |
| one image, as stored                   | median 41 KB, p90 142 KB, max 282 KB               |
| a pack                                 | median 127 KB, p90 1.6 MB, max 4.0 MB (the budget) |
| a link with images on, no screenshot   | median 37 KB, p90 334 KB, mean 216 KB              |

Three readings. **The cross-origin gap is small**: 4 of 232, all on one site whose
image host sends no CORS header — tolerable, and the reason the extension does not
route images through the server. **SVG is the real loss**: nearly all of the 26 were
diagrams in technical documentation, and on three of those pages they were every
image the article had. **The encode stays at 1024 px, quality 0.8**: quality 0.7 would have
made the mean pack 14% smaller and 800 px 22% smaller, and neither moves the long
tail, which is the count of images, not their quality.

**What it does to storage.** A link with images switched on (preview, read mode with
images, no screenshot) is a mean of ~216 KB, against ~43 KB with images off, which is
what the defaults give; the pack is the largest thing a library holds once it is on. The readout in Settings →
Subscription and the storage answer in the FAQ say so.

**What stays as it is.** A copy is never replaced on its own to add images: a
re-capture renumbers the blocks highlights are anchored to (_when a copy is taken_), so
adding pictures to a copy taken before this is the user's _Keep a read-mode copy_ again.
Removing a copy removes its pack (`removeKeptCopy` clears both fields). The backup
carries it through `extractionFileIds`. A client from before the field round-trips it
(the extraction is a `looseObject`) and its orphan sweep counts any string in an
entity as a reference, so it never deletes a pack; its own backup would leave the
pack out, and a figure whose pack is missing is a placeholder.

**Not yet:**

- **SVG**, the measured gap. Rasterizing needs an image element, which the browser
  extension's service worker doesn't have; bracemark-web could, and expo's decoder
  might. Never stored as SVG.
- **The server path's reach** — 12 images, and none when the proxy's limit is spent.
  A budget of its own for a read-mode ask would lift both.
- **On expo, unverified on a device**: what `expo-image-manipulator` puts behind a
  transparent image when it writes JPEG — the native path, a Safari share's drain and
  the capture screen's fallback. The web encoder flattens onto white, and the capture
  screen's in-page images go through it.
- **On expo, unverified on a device**: the capture screen's in-page encode needs
  `createImageBitmap` and `OffscreenCanvas` in the WebView (WKWebView, Android's
  Chromium WebView). Where they are missing the page posts nothing and every image
  falls back to the native fetch — no failure, but no sign-in either.
- **Pages whose image wrappers are named `media-…`**, a known limit (found 2026-11-12 on a
  DeepMind blog post: the text copy was whole, and its hero and one in-article picture
  were gone before the walker saw them). Readability weights any class or id containing
  `media` as −25 (its `negative` pattern) and `_cleanConditionally` then removes the
  container, picture and all; that site names every picture wrapper `media-image-block`,
  `media__container` or `media-content-wrapper`. Both capture paths run the same
  Readability, so this is not server-specific, and the text is untouched: only the
  pictures, a switch that is off by default, are lost. **Left on Readability's defaults
  deliberately** — its weights are heuristics tuned across a great many pages, and the
  `media` penalty is there to drop real widgets and embeds. One measured fix exists:
  set `negative` on the instance without `|media` (`readability.REGEXPS = { …, negative }`);
  on that page it returned exactly the two real pictures and nothing else. Measured on
  one page only, so it was not adopted. If it comes up again, run it over the real-page
  set (`measure:kept-copies`) first, counting pages that gain pictures against pages that
  gain junk, and change both Readability call sites together with a fixture spec.
- **The browser extension's page context that can't read an image host** could be
  covered through the proxy when the user has turned server previews on. Not worth it
  at 2%. (Expo's capture screen covers it with its native fetch.)

### the screenshot is a capped JPEG of the fold

`captureVisibleTab` returns the viewport at device pixels — ~2880 px wide on a 2×
laptop — and the first scaffold stored that as PNG, several MB a capture. It now
asks for JPEG and runs the preview path's `resizeImage` with its own ceiling
(`SCREENSHOT_MAX_DIMENSION` 1600, `SCREENSHOT_JPEG_QUALITY` 0.8, `@stxapps/shared`
`image/preview.ts`): wide enough that a price stays legible, and up to a few hundred KB (median 135 KB, measured above).

**Full page is not captured.** Scroll-and-stitch runs into Chrome's limit of about
two `captureVisibleTab` calls a second, repeats sticky headers, and triggers lazy
loaders and infinite scroll on the page the user is reading; the DevTools protocol's
beyond-viewport capture needs the `debugger` permission, which brings an install
warning and a banner across the tab. If it is ever built, it is capped at a few
screens and is a separate decision, not a change to this one. (Firefox's capture call
is reported to take a rectangle in page coordinates, which would be a one-call
full-page capture there. Not verified, and Chrome would still need the stitch, so it
would be a feature of one browser.)

### page copy

Deferred, and possibly for good (_the scope each copy stops at_). Not built, and the
extension's scaffold for it — `XMLSerializer` over the live DOM
— was removed: a serialized document without its stylesheets, images and fonts is
not a copy of anything offline, and opening it would request every resource it
names from the saved site. A real one needs:

- **SingleFile-grade capture**: inlined CSS, images and fonts, frames, shadow DOM,
  lazy images forced in. SingleFile itself is AGPL-3.0 like this repo — check before
  depending on it.
- **A viewer on a separate origin**: a page copy is the page's own markup, so it
  can't be rendered in the app's origin at all — a sandboxed frame from an origin
  holding nothing (no script, `default-src` none beyond `data:`/`blob:`).
- **A size ceiling of its own.** An upload through the blob route passes through a
  Worker, so Cloudflare's request-body limit for the zone's plan applies to it
  ([local-first-sync.md](./local-first-sync.md), _the blob route_), where a presigned
  PUT straight to R2 had no such bound; a copy of a media-heavy page can reach it.
- **Its meter.** `entitlements.maxPageCopies` exists (`iap/plans.ts`) and is
  enforced by nothing; it is client-side when it is, the byte quota its backstop.

### when a copy is taken

Three triggers, and deliberately not a fourth:

1. **The save that asks for it.** Built in the browser extension, driven by the
   synced save setting `keepReadModeOnSave` / `keepScreenshotOnSave` (entities.ts) —
   and on iOS by a share from Safari, under `keepReadModeOnShare` —
   which every reader resolves through `keepOnSaveOf` (`sync/extraction.ts`) because
   the defaults differ: **read mode on, its images off, screenshot off** — the
   screenshot is ten times the bytes and only some pages want it, and the images are
   a hundred times the text. A save on a plan with `keptCopies`
   asks for what the setting says beside `titleImage`, one message per facet so a
   page with no article costs the title and the screenshot nothing
   (`popup/Editor.tsx`). ⚠ **The setting is read from the store at the save**, not
   from `useSettings`: that hook is a render's copy and answers the defaults until
   the blob's read lands, so a save in the popup's first frames would keep read mode
   for someone who turned it off — and nothing would show it, since the capture
   succeeds. The same reason expo's `fetchPreviewsNow` reads its mode at the gesture; a
   read that fails keeps nothing. The saved
   screen then offers both copies as taps (`popup/KeptCopies.tsx`) — "Keeping…"
   until a facet newer than the ask lands, "Try again" when the background refused
   without writing anything (the tab moved on), and a line suggesting the screenshot
   when read mode came back "not an article", the page a screenshot is for. A free
   account sees the same buttons marked Plus, and a tap opens the web app's
   Subscription section.

   **The setting is shown only where a switch changes something on the client
   holding it** — a setting with no effect there is worse than none. It applies only
   to saves made **on the page**: the browser extension's, and on iOS a share from
   Safari, whose drain reads `keepReadModeOnShare` at the drain. So it is split by
   client — one key per kind of save — and each switch carries the same title
   wherever it appears:

   | switch                                              | key                    | browser extension | bracemark-web | expo iOS | expo Android |
   | --------------------------------------------------- | ---------------------- | ----------------- | ------------- | -------- | ------------ |
   | _Keep a read-mode copy when you save_               | `keepReadModeOnSave`   | yes               | —             | —        | —            |
   | _Keep a read-mode copy when you share from Safari_  | `keepReadModeOnShare`  | —                 | —             | yes      | —            |
   | _Keep a screenshot when you save_                   | `keepScreenshotOnSave` | yes               | —             | —        | —            |
   | _Include images in read-mode copies_ (next section) | `keepReadModeImages`   | yes               | while on ¹    | yes      | yes          |

   ¹ bracemark-web shows it only while _Server read mode_ is on — off, the web app
   takes no copy for it to qualify (_per client_, bracemark-web).

   **One key per kind of save, and one for images.** The two read-mode switches were
   one field, `keepReadModeOnSave`, until 2026-11-12, before any release carried it:
   turning it off on the phone turned it off in the browser too, and each switch's
   description had to warn about the other. Each now governs only the save made where
   it is shown, so neither needs that sentence. Images stay ONE key on purpose: what
   they cost is room in the one library every device syncs, so it is an account-wide
   question, and per-source switches could only disagree about the same copies. Where
   they live:
   - **The browser extension's options page**, section _Keep a copy_
     (`options/CopiesSection.tsx`) — all three, since a save there is the save that
     takes a copy, and _Keep a copy_ is the saved screen's own heading for the same
     two copies. Reached from the gear in the toolbar popup.
   - **bracemark-web's Settings → _Read mode_** (`_read-mode/read-mode-section.tsx`)
     — _Server read mode_, the web app's own opt-in (_per client_, bracemark-web);
     the images switch beneath it while it is on, because the reader's server _Keep a
     read-mode copy_ reads it; and one standing line saying what a save with the
     browser extension keeps and where to choose it. On free, one upgrade row titled
     _Server read mode_ — named for the switch, as Link previews' is. The web app takes no copy on a save and no
     screenshot, so it shows neither switch, and the line says so — it never claims a
     save made in the web app keeps a copy; it can't, the page isn't open there. A
     section of its own rather than a group under Link previews: a preview and a kept
     copy answer different questions, and the previews section's plan gate and drain
     controls say nothing about this one.
   - **expo's Settings → _Read mode_** (`features/settings/read-mode-section.tsx`) —
     the images switch on both platforms (it governs the capture screen's copies too),
     and the Safari one on **iOS only**: an Android share carries no copy, and the
     on-device read that would have given it one is not built (_per client_,
     bracemark-expo). No screenshot switch, since the phone takes none.

   **On free, every surface shows the upgrade instead of the switches** — the
   section's header and one row (on the options page, the section itself), Link
   previews' shape: in `PAYWALL_COPY.keptCopies`' words on the browser extension and
   expo, and on the web titled _Server read mode_ with its own sentence — not switches shown off
   and disabled: a disabled switch says nothing about why
   ([accessibility.md](./accessibility.md)), and one shown off over a stored on reads
   as a setting nobody can trust. Upgrade goes straight to the Subscription section
   (the web app's, from the browser extension), never through the upgrade dialog,
   which would only repeat the row's words. The stored value is left alone so a
   returning subscriber keeps their choice.

2. **A per-link action**: _Keep a read-mode copy_ (the web reader; _Keep a copy_ on
   expo's capture screen, where it shares a row with _Update preview_ and the only kind
   is read mode) / _Keep screenshot_, reached through a
   link's menu — its one **Read** item, which on a link with no copy goes where the
   copy is taken ([reader.md](./reader.md), _the way in_) — and from the reader. On a client that can't capture that link right now, the
   action says what can (open it in the extension, open it in the app).
3. **A scoped bulk job**: the existing _Generate all_ drain, given a facet and a
   scope — a selection, a list, a tag, a search — and the same confirm, progress
   and Pause. It covers "everything in this list" without a standing rule.

**No rules engine** ("keep a copy of every link in list X, or tagged Y"). A rule
acts on links nobody is looking at, which makes every fetch it causes **un-gestured**
— the axis [link-extraction.md](./link-extraction.md), _the stance_, is built on. On
web it could only run through `bracemark-extractor`, and on expo only at
`deviceExtractionMode: 'all'`; a rule would quietly route around both gates. The
bulk job does the same work as a visible, finite, confirmed action. Revisit only if
people keep re-running the same scoped job.

**Gating on the existing ladder.** A save-time capture rides the save's own consent,
exactly as `titleImage` does. Everything else — a bulk job, a per-link action on a
link this device never fetched — is subject to the same switches as any other
fetch: on web `serverExtraction` for previews and `serverReadMode` for a read-mode
copy, `deviceExtractionMode` on expo, and `off` stops all of it.

**"Not an article" is settled.** When Readability's pre-check or parse finds no
article, the facet is written `permanent` with `reason: 'not-an-article'` (a
passthrough field), not `failed`: it is the best tier's answer for the page, and a
`failed` would have every drain ask again. An explicit per-link ask is never gated
on it.

**A copy with highlights is never replaced automatically.** The tier rule lets a
better client re-extract a `done` facet; for read mode that would renumber the
blocks every highlight is anchored to ([reader.md](./reader.md), _re-anchoring_).
An upgrade there is the user's choice, offered, never taken.

### per client

**bracemark-extension — built.** Read mode is Readability over a clone of the live
DOM, then a walk of the article into blocks (web-react `lib/reader-doc-from-page.ts`,
over the shared walker in `@stxapps/shared` `reader/reader-doc-from-dom.ts`). It
has to run in the page — Readability needs a DOM and the background is a service
worker — and it can't be an inline `executeScript` func, which is serialized alone
and can't reach a library. So it is an **unlisted script**
(`entrypoints/read-mode.ts`): WXT bundles it into `/read-mode.js`, lists it nowhere
in the manifest, and returns `main`'s value as the injection's result.
`captureReadMode` parses that result with `readerDocSchema` before anything stores
it. The screenshot is `captureVisibleTab` on the window, after the stale-tab guard
every capture shares. Both need only `activeTab` + `scripting`, the permissions the
extension already holds. `defuddle` (Obsidian Web Clipper's extractor) is worth a
benchmark against Readability on modern pages; the converter is the only part that
would change.

**bracemark-extractor — read mode built, nothing else.** Readability needs a DOM; a
Worker has none, so `linkedom` builds one from the HTML string (`lib/read-mode.ts`),
and the article then goes through the **same walker** every live-page capture uses —
`readerDocFromArticle`, `@stxapps/shared` `reader/reader-doc-from-dom.ts`, which
web-react's `reader-doc-from-page.ts` now calls too — so a server copy reads like an
extension one. It sets the document's base URL first (the page's `<base>` resolved
against the final address, else that address), because linkedom has none and
Readability resolves relative links against it. The contract is a facet list on the
existing route — `POST /v1/extract { urls, facets: ['titleImage', 'readMode'] }`, absent
meaning `['titleImage']` — not a second endpoint: one HTML fetch serves both facets under
one SSRF guard and one rate limit, and a `readMode` request takes at most
`MAX_EXTRACT_READ_MODE_URLS` (5) URLs, since each result carries an article. A result
carries `readMode` (a `ReaderDoc`) or `readModeReason` — `not-an-article`, `not-html`,
`robots-disallowed` (settled, `permanent` with that `reason`) or `robots-unavailable`
(transient) — read through `readModeVerdictOf` (extract/retry.ts). Results are
`extractedBy: 'server'`, raw HTML only, so a JS-rendered page settles `permanent`, and the
read ends at `MAX_HTML_BYTES`. **robots.txt is honoured for `readMode` only** — the
article body is what a publisher sells, the title is what they want in an unfurl — and
`/extractor` says so; the rule, the status handling and why nothing is cached are
[link-extraction-server.md](./link-extraction-server.md), _robots.txt and read mode_,
which also carries the ⚠ CPU note: read mode needs the Workers Paid plan.

**No screenshot or page copy on the server, including Cloudflare's Browser
Rendering.** A headless browser behind an anonymous endpoint is a far better prize
for abuse than an HTML fetcher, and it would bill per render; it lands from data-centre
addresses that bot walls are built to stop; and it still can't see anything behind
the user's sign-in, which is where a copy matters most. Revisit after the blind-token
work ([link-extraction-server.md](./link-extraction-server.md), _anonymous, not
session-bound_) and only on demand.

**bracemark-expo — planned.** A WebView can't borrow the user's browser session:
`WKWebView` has its own cookie store, `SFSafariViewController` can't be scripted,
and Android's WebView has its own `CookieManager`, apart from Chrome's. So, in order:

1. **iOS, from Safari: the share extension's preprocessing JS — built.**
   `share-extension/preprocessing.js` runs inside the page the user is sharing,
   signed in and past any paywall; it is now generated from the same converter the
   browser extension injects (`@stxapps/web-react/lib/reader-doc-from-page`, by
   `tools/scripts/generate-reader-capture.ts`), so it returns the page's `ReaderDoc`
   beside its title — **as JSON text**, serialised once in the page. The share
   extension carries that text on the draft without parsing it (an article as
   objects is memory its process does not have); the app's drain parses and
   stores it at `expo:fg` when the plan and the save setting say so
   ([share-sheet.md](./share-sheet.md), _what the sheet does and doesn't do_).
   ⚠ **Nothing it hands Safari may contain a `null`.** Safari passes the result
   to the share extension as a property list, which has no null: a JS `null`
   becomes `NSNull`, the extension cannot load the representation at all
   (`NSItemProviderErrorDomain -1000`, "Cannot load representation of type
   com.apple.property-list"), and the sheet opens on _No link in this share_ —
   URL and title lost with the copy. So the result is **three strings and
   nothing else** — `title` and `url` coerced, the copy as its JSON text — and
   the copy is **omitted** when there is none. Whatever nulls a `ReaderDoc`
   holds are characters inside that one string, and nothing walks an object on
   the way out: the first fix did (`bracemarkPlistSafe`, a `for…in` that
   dropped nulls), and a `for…in` in a page's own context also copies whatever
   the page has hung on `Object.prototype` — a function is no more a
   property-list value than a null. `reader-capture-generated.spec.ts` holds
   all of it, with such a page. It shipped once as `readMode: null` on every
   page that is not an article, from 2026-11-08 to 2026-11-09, and only a share
   from Safari shows it — jsdom and Chrome both pass the null along happily.
   The WebView path posts JSON text and has no such limit.
2. **A capture screen — built** (`/capture?link=<id>`,
   `features/capture/capture-screen.tsx`), opened by the row menu's **Read** on a
   link with no copy, and from the reader's _Update from the page_ on one that has
   one; its top bar has _Read_ back while the link has a copy, and the two screens
   trade places (a replace, never a push) rather than stack
   ([reader.md](./reader.md), _the way in_). The page in a
   `react-native-webview` WebView with two actions under it. **Keep a copy**
   keeps the article, and its images when the account has them on (_images in read
   mode_ — the page fetches them first); **Update preview** re-reads the title and preview image from the live
   page — the same collector the browser extension injects (web-react
   `lib/page-meta.ts`), `selectTitleImage` in the app, the image fetched in the
   page and natively where the page couldn't, and written at `expo:fg` whatever
   tier held it, since it is a tap (expo-react `data/store-page-preview.ts`). Only
   what was had is written: a page whose image couldn't be fetched keeps the old
   one, and a title or image the user set by hand still wins, which the screen
   says. **Both actions are `keptCopies`'**: no route brings a free account here,
   and one that arrives anyway (a plan lapsing on the screen, an old address) gets
   no _Update preview_ — a free account sets a title and image by hand in the editor
   — and a _Keep a copy_ marked Plus that opens the upgrade. Its top bar also has
   the Wayback Machine, and a page that fails to load offers it in words (_when the
   page is gone_). A locked
   list's page stays unloaded, and both top-bar exits with it; both actions are live only while the WebView is on
   the link's own page (`canonicalUrlKey`) and only while the page actually loaded
   (a failed load shows the WebView's own error page, so both go off and the screen
   says the page didn't load), the address the page reports with its answer is
   checked again, and the page re-checks it before every image fetch.
   The conversation is one injected request at a time, each with a fresh nonce
   its answers must echo (`features/capture/use-page-capture.ts`, the protocol in
   `@stxapps/shared` `reader/page-capture.ts`); the injected script is a second
   generated bundle, apart from the Safari preprocessing file so that one stays
   small (`tools/scripts/generate-reader-capture.ts`). No screenshot, and none
   planned for now (_the scope each copy stops at_) — it would need
   `react-native-view-shot` ([expo-dependencies.md](./expo-dependencies.md),
   _react-native-webview_). Its cookie store persists, so a user signs in to a site
   once — which is what makes it the fallback for every save that couldn't read the
   page as the user sees it: an Android share, an iOS share from an app other than
   Safari, a page behind a sign-in. Not done: a page that redirects on load (an `m.`
   host, AMP, a shortener) lands somewhere `canonicalUrlKey` doesn't match, and the
   buttons stay off. Accepting the address the first load settles on is not the fix
   — a page behind a sign-in redirects to its sign-in page first, and its title would
   become the link's. _Planned_: a **visible** batch over a scoped selection, one
   page after another, with the screen on.
3. **Later, a Safari Web Extension** in the iOS app: the browser extension itself,
   in Safari.

Never a hidden or background WebView: iOS suspends it, offscreen rendering is
unreliable, and it is invisible work on the user's battery.

**An automatic read on save — measured 2026-11-11, not built.** The saves that reach
the app with no live-page copy — an Android share, an iOS share from an app other than
Safari, a link added in the app — could take read mode from the HTML `fetchPreviewsNow`
already fetches for the title: the server's code (`readModeFromHtml`, linkedom +
Readability + the shared walker) run on the device, at `expo:bg`, with no extra request.
A spike ran it over the 62 pages of `measure:kept-copies`, fetched as the app fetches
(its User-Agent, 15 s, 4 MB), on the **app's own Hermes** (the iOS pod's `hermes`,
bytecode from its `hermesc`, after the app's Babel preset), against the live-page
copies of the 2026-11-10 run:

| what                                 | result                                                                         |
| ------------------------------------ | ------------------------------------------------------------------------------ |
| pages that answered the app's fetch  | 55 of 62 — 7 refused it with a 403                                             |
| live-page copies raw HTML also had   | 38 of 42; 29 of the 32 articles fetched. Missed: 1 article, 3 product pages    |
| raw-HTML copies the live page didn't | 1 (a product page)                                                             |
| same result on Hermes as on Node     | 54 of 55 (the other is the harness's missing `canvas` shim)                    |
| Hermes time, one cold run, on an M1  | median 202 ms, p90 1,076 ms, max 4,551 ms; kept articles median 250, p90 1,986 |
| code it adds to the app's bundle     | ~497 KB minified (linkedom and Readability)                                    |

**It works and it covers the gap — and it can't run where it would have to.** Hermes is
about 9.5× slower than V8 here, and a low-end Android phone is several times slower
than an M1 again, so a typical article would hold the JS thread for around a second and
a long one for several, right as the user reopens the app — which is when the drain
runs. No size cap saves it: 100 KB keeps the worst case near 200 ms on the M1 and keeps
10 of the 42 copies. So it waits on a way to run it **off the JS thread**: a worklet
runtime (`react-native-worklets`, already in the app for Reanimated, whose 0.5 "bundle
mode" is what would let a second runtime import a library this size — experimental,
and unverified here) or nothing. Until then the capture screen is the route for those
saves, and the measurement above is what a build on another thread starts from.

Two facts it turned up for whoever builds it. linkedom loads `canvas` with a
`require` it expects to fail, falling back to its own `canvas-shim` — which wrangler's
bundle keeps (in workerd there is no `require`), but Metro resolves every `require` at
build time, so `canvas` has to be aliased to that shim there, or the build breaks or a
page with a `<canvas>` throws. And Readability throws on some pages under linkedom (an
empty or bare-text body), so the call is caught and read as no article — the server's
`readModeFromHtml` does that now. It reads no `robots.txt`, like every capture a device
makes ([link-extraction-server.md](./link-extraction-server.md), _robots.txt and read
mode_).

**bracemark-web — the server's read mode, on a per-link ask.** It can't fetch a page
(CORS), so its read mode is the extractor's, under its own opt-in, `serverReadMode`, and
it has no screenshot or page copy of its own. Built as trigger 2 above for read mode: the
row menu's **Read** opens the reader on a paid plan's link with no copy, and its empty
state has _Keep a read-mode copy_ while `useServerReadMode().available` (signed in, a
ready store, the `serverReadMode` opt-in, an extractor in this build, and `keptCopies`).

**Its own opt-in, not the preview one.** It rode `serverExtraction` at first, and that
made one read-mode copy cost the whole un-gestured preview drain: the two send the same
thing to the same service, but previews send every pending link as it comes into view
and read mode one link per press, so they are two consents (`settingsGeneralSchema`,
entities.ts). Both are off by default, which is what /privacy and /extractor promise —
"off unless you turn it on" — and why per-press consent with no setting was turned down:
it would have made that sentence false. With `serverReadMode` off and everything else in
place (`needsOptIn`), the empty state **offers it in place** — the disclosure sentence,
then _Turn on server read mode_ — not as a link to Settings the way the links page's
previews banner does: that banner has no room for the disclosure and its switch barely
moves the count it shows, where here both hold. Turning it on fetches nothing; it hands
focus to _Keep a read-mode copy_, with _Include images_ beneath it, and that press asks.
Settings → _Read mode_ is the durable surface.

Only that button's press asks — never the arrival: "Read" is not an ask to have the server fetch
the page, and an address can't make one either, so a reload or a history entry never
fetches on its own. The reader says what came back. `runServerReadMode` (web-react `lib/server-read-mode.ts`)
stores the copy exactly as the extension does, at the `server` tier, and **never
replaces a copy that exists** — checked before the request and again after it, since a
live-page capture may land meanwhile — nor overwrites a better tier's settled verdict
with a server `failed`. Not a drain, and not the save: a save in the web app still keeps
no copy on its own (the settings' wording promises exactly that), because a standing
"fetch the article of everything I save" through the server is the un-gestured rule
_when a copy is taken_ turns down. A link saved in the web app still gets a live-page
copy when the user opens it with the extension or the app.

### the gate — `entitlements.keptCopies`

The kept copies are a Plus feature, `keptCopies` in `iap/plans.ts`, enforced in the
client like every per-feature gate (the server can't tell one `files/` blob from
another); the byte and file ceilings stay the server-hard backstop. It is checked
where a capture is asked for — the browser extension's save and its saved screen,
expo's share drain and both of the capture screen's actions (_Keep a copy_ and
_Update preview_ — the row menu's **Read** sends a free account to the reader only, and
only for a copy it has), and bracemark-web's server read mode
(`useServerReadMode`) — and the upgrade dialog's words are `PAYWALL_COPY.keptCopies` (`@stxapps/react`),
one string read on the web and on a phone, so its screenshot clause is scoped to the
browser extension: the phone app takes none (_the scope each copy stops at_).
Two rules:

- **Reading is never gated.** A copy taken while entitled stays readable, exported
  and deletable after a downgrade; only new captures stop. Hiding someone's own data
  behind a lapsed plan reads as holding it hostage.
- **The upgrade card names only what ships**, per `plans.ts`'s copy rule. Read mode
  and the screenshot are built on desktop. /pricing's comparison table names read mode
  alone — the screenshot is the browser extension's, of the fold only, and a row for it
  set the expectation of a page capture — and has to go live with or after the
  release that carries it. The plan cards and the store listings don't name them
  yet — adding them is a copy change for those surfaces (with the brand review it
  needs), not something this gate implies. Page copy not before it exists.

### removal, cleanup, export

- **Destroying a link** deletes every blob its extraction names, through
  `extractionFileIds` — both destroy paths, and the dangling-extraction sweep
  ([link-extraction.md](./link-extraction.md), _the data model_).
- **A replaced copy is reclaimed** by `writeExtraction` on both platforms
  ([link-extraction.md](./link-extraction.md), the replaced-blob paragraph).
- **Removing a copy** — `removeKeptCopy` (web-react `data/mutations.ts`) clears the
  field, leaves the facet `done` with a passthrough `removedAt`, then deletes the
  blob, metadata before content. Not absent: absence reads as "not taken", which a
  bulk job would take again; `done` with no ref is "taken and thrown away", which
  nothing automatic re-takes, while the browser extension's saved screen keys "kept"
  on the ref, so an explicit ask still works. Its write ABORTS (never writes back)
  when the copy is already gone, since writing the earlier extraction back would
  resurrect one deleted meanwhile. Reached from the web reader's _Delete this copy_
  and bulk edit's _Delete copies_ (both confirm first — a copy can't be re-taken
  from a page that changed), through `useKeptCopyMutations`. Never gated on the plan.
  Expo has the same per-copy delete in its reader (expo-react ports
  `removeKeptCopy`); bulk delete is web-only for now.
- ⚠ **The orphaned-file sweep** — `sweepOrphanFiles` (web-react and expo-react
  `data/sweep-orphan-files.ts`, whose rules are ONE copy in shared's
  `sync/sweeps.ts`), run by bracemark-web and bracemark-expo after the dangling
  sweep in the same `afterCycle` slot (each app's
  `components/sync-provider-with-sweep.tsx`). Both apps, because the blobs count
  against the user's byte quota and a library used only on phones had nothing
  else to reclaim them. It
  reclaims `files/` blobs nothing references: a capture race that LWW settled
  against one device, a blob pushed by a device that stalled before its extraction,
  and builds from before the replaced-blob reclaim. **It deletes user data on every
  device when it is wrong**, so it is stricter than the dangling sweep on every
  axis, and each rule is silent if dropped:
  - the dangling sweep's conditions (a full-sync client, a successful cycle, inside
    its lock, **a complete unreadable record** — not before a full listing has run
    with the record in place, [local-first-sync.md](./local-first-sync.md),
    _crypto boundary_), and **no recorded unreadable path at all** — it can't tell which
    blob a skipped entity named (a blob's id is random, never derived from the
    entity that names it, so there is no "that link's files" to spare). The
    unreadable recheck is what keeps a transient skip from holding it off for good
    ([local-first-sync.md](./local-first-sync.md), _crypto boundary_). A path that
    stays unreadable keeps it off on that device, by design;
  - **any string in any entity is a reference** — not just the fields this build
    knows (`EXTRACTION_FILE_REF_FIELDS`, `customImageId`), because a newer client's
    field or namespace may name a blob, and an older device would otherwise delete
    it for everyone. An object's keys count as much as its values (a newer client
    may keep a map keyed by blob id). A record that won't decode, or has no bytes,
    stops the run;
  - never a blob with a **pending op** (a local unpushed write carries `updatedAt:
0`, so age alone can't exclude it), never one younger than **30 days** by its
    server stamp (`ORPHAN_GRACE_MS` — content is written before its reference, and
    a stalled device gets that long to push the rest), and **nothing written during
    the scan** (an entity put queued while it yields aborts the run);
  - at most **weekly** per account per device (`SyncMetaRecord.lastOrphanSweepAt`)
    and **500 deletes** a run. A run the cap cut short comes back in **a day**
    (`ORPHAN_SWEEP_BACKLOG_INTERVAL_MS`; it writes its stamp set back, so the one
    field carries both schedules): at 500 a week, an account full of blobs that
    older builds leaked stayed at its byte ceiling for months.

  The dangling sweep's known gaps (a store missing an entity the server holds) apply
  and cost more here: a blob only that entity names would go. Accepted for the same
  reason, but it is why none of the rules above may be loosened casually.

- **Export.** The Bracemark backup carries every kept copy, because it walks
  `extractionFileIds`; the interop formats carry none. A Markdown export of read
  mode with its highlights is the planned interop answer ([reader.md](./reader.md)).
- **Import.** None. No supported source exports article text; Readwise- and
  Omnivore-style highlight files are a later importer.

### when the page is gone — the Wayback Machine link

Most links have no kept copy: everything imported, everything on a free account,
everything saved before copies existed. For those — and for any page that has since
changed — the answer is not ours to store. It is a link: **Open in Wayback Machine**,
to the Internet Archive's capture of that address nearest the day the link was saved.

- **Where.** The reader's top bar on both apps, beside _Open page_; the web reader's
  empty state, where it is said in a sentence ([reader.md](./reader.md)); and expo's
  capture screen — its top bar, and in words under a page that failed to load. **Not
  the row menu** (decided 2026-11-11): it is for the page that has gone or changed,
  and those are the two screens a user is on when finding that out; a row-menu item on
  every link, for a rare need, was the menu's clutter. So a free account's link with no
  copy, which reaches neither screen, has no way to it in the app. Behind a lock it is hidden with
  _Open page_: the address is the locked list's contents.
- **The address** is `https://web.archive.org/web/{stamp}/{url}`, built by `waybackUrl`
  (`@stxapps/shared` `url/url.ts`): `stamp` is the link's `createdAt` as fourteen UTC
  digits, and the Wayback Machine answers with the capture nearest it — the page as it
  was around the day it was saved, which for an imported link is the day it was first
  bookmarked. The URL goes in raw, as the archive's own links write it.
- **No address for a page a public archive cannot hold** — anything `openableUrl`
  refuses, localhost, an IP literal, a dotless or `.local`-style host. The item is then
  absent, so nothing tells the archive about a host on the user's own network.
- ⚠ **Built on the device, opened only by a press.** Nothing is asked of archive.org
  before the user goes there: no "is there a capture?" lookup, no prefetch, no badge
  that depends on the answer. A lookup per link would hand a third party the library's
  addresses one at a time — the leak [link-extraction.md](./link-extraction.md), _the
  stance_, is built to avoid — and the feature would look better for it, which is why
  it is written down. What the user gets when no capture exists is the archive's own
  page saying so.
- ⚠ **Never submit a page to be archived.** The archive's _Save Page Now_ publishes
  the address for good, share tokens and all, and takes the user's private reading
  list public one URL at a time. Not as a default, not as a setting.
- **The word is "Wayback Machine", never "archive".** _Archive_ is the system list's
  ([link-extraction.md](./link-extraction.md), the opening note) — the row menu's own
  item, and the topbar's title in that view.

**Why it is a complement and not the copy.** The Wayback Machine holds what a crawler
saw of the public web: nothing behind a sign-in, uneven on small sites, poor at pages
built in the browser, gone when a site asks, and not on the device. A kept copy is what
the user saw, encrypted with their key, readable offline. The link costs nothing and
covers the pages we never copied; it is the reason page copy can wait.

### ⚠ tripwires

- **A facet's blob is a display field in `EXTRACTION_FILE_REF_FIELDS`**, never a
  facet passthrough — the read-mode copy's first home, which nothing exported,
  restored or deleted ([link-extraction.md](./link-extraction.md), the
  `EXTRACTION_FILE_REF_FIELDS` note).
- **No new value in `facetSchema.status`.** It is a `z.enum`; a value an older
  client doesn't know fails its parse. New states ride as passthrough fields
  (`reason`, `removedAt`) on an existing status.
- **Blocks, never HTML; no remote URL rendered** (above).
- **A table's grid is rectangular at the writer, and read defensively** — spans are
  expanded at capture, and a renderer trusts neither that nor the row shape (_tables_).
- **Nothing is asked of the Wayback Machine before the press, and nothing is ever
  submitted to it** (_when the page is gone_).
- **The image pack is a field of the extraction, an image's address never enters the
  document, and every capture settles its document with `applyReaderImages` before
  storing it** (_images in read mode_). Break the first and the orphan sweep deletes
  the images a month later; the second stores a remote URL in a copy; the third
  leaves figures naming pictures the pack doesn't hold.
- **No `null` in what Safari's preprocessing hands over — strings only** — a
  property list has none, and one null loses the whole share on iOS. And the
  copy stays JSON **text** until the app's drain: parsed in the share
  extension it is an object graph in a process with no room for one (_per
  client_, the iOS preprocessing entry).

### deferred

- **SVG images, and the server path's reach** (_images in read mode_, _not yet_).
- **More of a table**: column alignment, blocks inside a cell, a highlight anchored in
  a cell (_tables_).
- **A visible Read control on a row that has a copy**, so the copy is not only in the
  menu ([reader.md](./reader.md), _a row's press opens the page_).
- **A screenshot on expo; a full-page screenshot** (_the scope each copy stops at_).
- **Page copy** (_page copy_) — possibly never.
- **Search over read mode.** Client-only under E2E, and a device can only index a
  copy it has downloaded — `files/` blobs are lazy. A per-device _keep copies
  offline_ option is the prerequisite ([client-queries.md](./client-queries.md)).
