## link extraction — the kept copies: read mode, screenshot, page copy

The three facets that keep **content** rather than describe a link: the page's
article text (`readMode`), how the page looked (`screenshot`), and a whole copy of
it (`pageCopy`). When each is taken, by which client, in what format, behind which
gate, and how its blob is removed. Part of the link-extraction set: everything the
facets share — who may fetch, the tiers, the writer-split, the extraction entity,
the queue — is [link-extraction.md](./link-extraction.md), and this file assumes it.
[link-extraction-server.md](./link-extraction-server.md) is the server path the
read-mode facet is next to serve; [reader.md](./reader.md) is the screen that shows
a kept copy and the highlights and notes made on it; [data-lifecycle.md](./data-lifecycle.md)
and [data-limits.md](./data-limits.md) carry the export and limit rows for these
blobs.

**State today.** Built end to end on desktop: the browser extension takes read mode
automatically on a save when the plan has `keptCopies`, and offers read mode and a
screenshot as taps on its saved screen (`popup/Editor.tsx`, `popup/KeptCopies.tsx`;
captures in `utils/capture.ts`, `extraction-worker.ts`); bracemark-web reads both at
`/read?link=<id>` ([reader.md](./reader.md), _the web reader_), and the synced save
setting chooses what a save keeps (Settings → Link previews → Kept copies). Not
built: the per-link and bulk actions,
removal and the orphan sweep, expo, server read mode, and page copy anywhere.
Everything below marked _planned_ is the design those pieces are built to.

**Naming.** "Page copy", never "archive" — the word is the Archive system list's
([link-extraction.md](./link-extraction.md), the opening note). "Read mode" in prose,
`readMode` in code. "Kept copies" is this file's name for the three together.

### why these three, and in this order

A preview tells you what a link was; a kept copy is what you go back for when the
page has moved, gone behind a sign-in, or changed. The three are not equal:

| facet      | what it keeps                        | size, one link (est.)           | built     |
| ---------- | ------------------------------------ | ------------------------------- | --------- |
| read mode  | the article's words                  | ~10–30 KB gzipped               | extension |
| screenshot | what was on screen when it was saved | ~100–250 KB, capped JPEG        | extension |
| page copy  | the page, offline, with its assets   | MBs; tens for media-heavy pages | not built |

The sizes are estimates, not measurements — re-derive them from real captures
before any of them drives a limit. They still settle the order:

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

### ⚠ the read-mode copy is blocks, never HTML

`extraction.readModeId` names a `files/{id}.enc` blob whose plaintext is a
`ReaderDoc` (`@stxapps/shared` `reader/reader-doc.ts`) as gzipped UTF-8 JSON (the
codec is web-react `lib/reader-doc-bytes.ts`). A `ReaderDoc` is a list of typed
blocks — `heading`, `paragraph`, `quote`, `listItem`, `code`, `figure`, `rule` —
each holding plain strings with inline marks (bold, italic, code, an http(s) link
target). There is no markup in it anywhere.

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
  A block the format can't express (a table, today) is flattened at capture or is a
  new block kind — older readers skip a kind they don't know.
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

### the screenshot is a capped JPEG of the fold

`captureVisibleTab` returns the viewport at device pixels — ~2880 px wide on a 2×
laptop — and the first scaffold stored that as PNG, several MB a capture. It now
asks for JPEG and runs the preview path's `resizeImage` with its own ceiling
(`SCREENSHOT_MAX_DIMENSION` 1600, `SCREENSHOT_JPEG_QUALITY` 0.8, `@stxapps/shared`
`image/preview.ts`): wide enough that a price stays legible, a few hundred KB.

**Full page is not captured.** Scroll-and-stitch runs into Chrome's limit of about
two `captureVisibleTab` calls a second, repeats sticky headers, and triggers lazy
loaders and infinite scroll on the page the user is reading; the DevTools protocol's
beyond-viewport capture needs the `debugger` permission, which brings an install
warning and a banner across the tab. If it is ever built, it is capped at a few
screens and is a separate decision, not a change to this one.

### page copy

Not built, and the extension's scaffold for it — `XMLSerializer` over the live DOM
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
   synced save setting `keepReadModeOnSave` / `keepScreenshotOnSave` (entities.ts),
   which every reader resolves through `keepOnSaveOf` (`sync/extraction.ts`) because
   the defaults differ: **read mode on, screenshot off** — the screenshot is ten
   times the bytes and only some pages want it. A save on a plan with `keptCopies`
   asks for what the setting says beside `titleImage`, one message per facet so a
   page with no article costs the title and the screenshot nothing
   (`popup/Editor.tsx`). ⚠ **The setting is read from the store at the save**, not
   from `useSettings`: that hook is a render's copy and answers the defaults until
   the blob's read lands, so a save in the popup's first frames would keep read mode
   for someone who turned it off — and nothing would show it, since the capture
   succeeds. The same reason expo's `extractNow` reads its mode at the gesture; a
   read that fails keeps nothing. The saved
   screen then offers both copies as taps (`popup/KeptCopies.tsx`) — "Keeping…"
   until a facet newer than the ask lands, "Try again" when the background refused
   without writing anything (the tab moved on), and a line suggesting the screenshot
   when read mode came back "not an article", the page a screenshot is for. A free
   account sees the same buttons marked Plus, and a tap opens the web app's
   Subscription section. The setting itself is two switches in bracemark-web's
   Settings → Link previews → _Kept copies_ (`_extraction/kept-copies-group.tsx`):
   shown off and disabled on free beside the upgrade, with the stored value left
   alone so a returning subscriber keeps their choice, and worded so it never claims
   a save made in the web app keeps a copy — it can't, the page isn't open there. It
   applies only to saves made **on the page**; expo's in-app browser and an iOS share
   from Safari will read the same two fields when they capture (_planned_), and expo
   renders no switch until then — a setting with no effect on the device holding it
   is worse than none.
2. **A per-link action**: _Keep read mode_ / _Keep screenshot_ from a link's menu
   and from the reader. On a client that can't capture that link right now, the
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
fetch: `serverExtraction` on web, `deviceExtractionMode` on expo, and `off` stops
all of it.

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
DOM, then a walk of the article into blocks (`utils/reader-doc-from-page.ts`). It
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

**bracemark-extractor — read mode planned, nothing else.** Readability needs a DOM;
a Worker has none, but `linkedom` gives Readability enough of one, at tens of
milliseconds of CPU a page. The contract grows a facet list on the existing route —
`POST /v1/extract { urls, facets: ['titleImage', 'readMode'] }` — not a second
endpoint: one HTML fetch serves both facets under one SSRF guard and one rate limit,
and the batch cap shrinks when `readMode` is asked for, since each result now carries
an article. Results are `extractedBy: 'server'`, raw HTML only, so a JS-rendered page
settles `permanent`. **Two things first**: the open `robots.txt` question
([link-extraction-server.md](./link-extraction-server.md), _deferred / open_) — the
recommendation is to honour it for `readMode` only, since the article body is what a
publisher sells and the title is what they want in an unfurl — and `/extractor`, which
describes what the service fetches and returns, changes in the same release.

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

1. **iOS, from Safari: the share extension's preprocessing JS.**
   `share-extension/preprocessing.js` already runs inside the page the user is
   sharing, signed in and past any paywall, to read its title. Bundling Readability
   and the block walk into it gives read mode from the live DOM, in Safari's
   process; the share extension only receives the resulting string and hands it to
   the app through the App Group outbox, untouched — it has no memory to spare for
   anything more ([share-sheet.md](./share-sheet.md), the memory note). The app
   writes it as `expo:fg`: it came from a live page, the active-page tier.
2. **An in-app browser screen**, opened from a link's menu, with _Keep read mode_ /
   _Keep screenshot_ — the extension's popup, rebuilt around a WebView. Its cookie
   store persists, so a user signs in to a site once. It can also run a **visible**
   batch over a scoped selection, one page after another, with the screen on.
3. **Later, a Safari Web Extension** in the iOS app: the browser extension itself,
   in Safari.

Never a hidden or background WebView: iOS suspends it, offscreen rendering is
unreliable, and it is invisible work on the user's battery.

**bracemark-web — orchestrates only.** It can't fetch a page (CORS), so its read
mode is the extractor's, under `serverExtraction`, and it has no screenshot or page
copy of its own. A link saved in the web app gets a live-page copy when the user
opens it with the extension or the app.

### the gate — `entitlements.keptCopies`

The kept copies are a Plus feature, `keptCopies` in `iap/plans.ts`, enforced in the
client like every per-feature gate (the server can't tell one `files/` blob from
another); the byte and file ceilings stay the server-hard backstop. It is checked
where a capture is asked for — the browser extension's save and its saved screen —
and the upgrade dialog's words are `PAYWALL_COPY.keptCopies` (`@stxapps/react`).
Two rules:

- **Reading is never gated.** A copy taken while entitled stays readable, exported
  and deletable after a downgrade; only new captures stop. Hiding someone's own data
  behind a lapsed plan reads as holding it hostage.
- **The upgrade card names only what ships**, per `plans.ts`'s copy rule. Read mode
  and the screenshot now ship on desktop, but the plan cards, /pricing and the store
  listings don't name them yet — adding them is a copy change for those surfaces
  (with the brand review it needs), not something this gate implies. Page copy not
  before it exists.

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
  Not on expo yet: it shows no copies.
- **An orphaned-file sweep** (planned) — `files/` paths no link or extraction
  references, beside `sweepDanglingExtractions` and under its conditions (a
  full-sync client, the end of a successful cycle, inside its lock, skipping the
  pull's unreadable paths) plus an **age grace**: content is written before its
  reference, so a fresh blob with no ref yet is normal.
- **Export.** The Bracemark backup carries every kept copy, because it walks
  `extractionFileIds`; the interop formats carry none. A Markdown export of read
  mode with its highlights is the planned interop answer ([reader.md](./reader.md)).
- **Import.** None. No supported source exports article text; Readwise- and
  Omnivore-style highlight files are a later importer.

### ⚠ tripwires

- **A facet's blob is a display field in `EXTRACTION_FILE_REF_FIELDS`**, never a
  facet passthrough — the read-mode copy's first home, which nothing exported,
  restored or deleted ([link-extraction.md](./link-extraction.md), the
  `EXTRACTION_FILE_REF_FIELDS` note).
- **No new value in `facetSchema.status`.** It is a `z.enum`; a value an older
  client doesn't know fails its parse. New states ride as passthrough fields
  (`reason`, `removedAt`) on an existing status.
- **Blocks, never HTML; no remote URL rendered** (above).

### deferred

- **Images in read mode.** v1 keeps placeholders. Downscaled images inlined into
  the copy (or as sibling blobs the document names) is the next step; never the
  remote URL.
- **A `table` block.** Tables flatten to one paragraph per row today.
- **Full-page screenshot** (_the screenshot is a capped JPEG of the fold_).
- **Page copy** (_page copy_).
- **Search over read mode.** Client-only under E2E, and a device can only index a
  copy it has downloaded — `files/` blobs are lazy. A per-device _keep copies
  offline_ option is the prerequisite ([client-queries.md](./client-queries.md)).
