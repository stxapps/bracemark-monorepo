## link extraction

How bracemark fills in a saved link's **title, image, read-mode text, screenshot,
and saved page copy** — the metadata a bare URL doesn't carry. (The **favicon**
is deliberately absent from that list — a device-local, per-host cache, never a
facet and never synced; see _favicons_ below.) See
[local-first-sync.md](./local-first-sync.md) for the encrypted-file data path
this rides on (one entity per `*.enc` blob, file-level LWW), the `pins/`
precedent for the LWW-isolation move repeated here, and the `links/` vs `files/`
split; [architecture.md](./architecture.md) for package layering;
[browser-extension.md](./browser-extension.md) for the bracemark-extension auth flow
the privileged client builds on; and [account.md](./account.md) for the data key
that protects every blob written here.

**Naming — "page copy", never "archive".** The saved-page capture is the
`pageCopy` facet, stored as `extraction.pageCopyId`, metered by
`entitlements.maxPageCopies`, and shown to users as "page copy". The word
**archive is reserved for the ARCHIVE_ID system list** (`sync/system-lists.ts`)
— a link the user filed away, which has nothing to do with capturing page
bytes. The two senses shared the word until they were split (the meter was
`maxArchivedLinks`, which read like a cap on the Archive list and was not).
Keep them apart in code, comments, and UI copy.

### the shape of the problem

A saved link starts as just a URL. To enrich it you must **fetch the page** (for
title/image/read-mode) or **render it** (for screenshot/page-copy). Two hard
constraints decide where that can happen:

- **CORS.** A `fetch()` to an arbitrary third-party URL from a web app — main
  thread _or_ a Web Worker, same rules — is blocked for almost every site. The
  browser tab in `bracemark-web` simply **cannot** retrieve arbitrary page HTML. A
  Web Worker doesn't change this; it only helps with CPU-bound parsing of HTML
  something else already fetched.
- **Rendering.** Screenshots and full page copies need a real rendering engine
  (headless browser). A tab can't screenshot a remote URL it isn't displaying.

The contexts that escape CORS are the ones that aren't a web-app `fetch`:

- a **browser extension** with host permissions (background fetch — raw HTML —
  or, on the active tab, the live DOM);
- a **native mobile app** (no CORS on native HTTP; a WebView to render);
- a **server** that fetches on the user's behalf.

So extraction is inherently a **multi-client** concern, and the central design
question is _who does the work_ — which is also a **privacy** question, because
whoever fetches the URL learns the URL.

### the stance: privacy-first, off by default, clients do the work

bracemark is a **privacy-focused** bookmark manager: the api never sees your
library in plaintext (see [local-first-sync.md](./local-first-sync.md) — _crypto
boundary & what the server still learns_). Extraction is the one feature that wants to break that,
so the posture is deliberately conservative:

- **Everything un-gestured is OFF by default.** The axis is **gestured vs.
  un-gestured**, not client vs. server. Fetching the page the user _just saved on
  this device, in this gesture_ is covered by the save itself — the same reason
  the extension's active-tab capture has never carried a toggle — so an `expo:fg`
  save-time extraction needs no opt-in. What is off by default is every fetch the
  user did **not** just ask for: back-filling links that arrived by sync from
  another device, draining a bulk import, and the per-host favicon cache that
  rides along. Each of those is a **new** disclosure of this device's IP to a site
  the user never pointed it at, so each waits for expo's `deviceExtractionMode` to
  reach `all` (see _expo drains in the foreground_). Extraction in the **web** app is gated
  regardless of the gesture — not because a newly saved link is un-gestured, but because the
  only way the browser can extract any pending link is through a **server**. The separate,
  stricter `serverExtraction` opt-in covers both a new save once its row is visible and older
  pending links as they come into view (see _the web drains in-page_). So "we leak as little as possible"
  stays the default, and no setting has to be found to get a title for the link
  you just saved on the device in your hand.
- **…but "needs no opt-in" is not "cannot be declined."** The gestured path has
  its own off position — `deviceExtractionMode: 'off'`, the bottom of the ladder
  (_expo drains in the foreground_). It exists because everything else here is
  built for the user who chose an end-to-end-encrypted bookmark app precisely so
  that nobody sees their library, and "this app always fetches the pages you save,
  from your IP, and you can't stop it" would be the one hole in that. It is not
  the default (a fresh install that previewed nothing would look broken, and would
  push people toward the _broader_ setting), and it is not offered by the first-run
  banner — but it is always one tap away in Settings, and every fetching path
  honors it: the page, the preview image, and both favicon paths.
- **The clients do the work, never the sync server.** `bracemark-api` stays a blind
  sync broker — it never fetches a user's URLs, so it never learns them. All
  extraction runs in clients the user already installed and trusts: the
  **browser extension** and the **Expo app** — or `bracemark-web` _orchestrating_
  the opt-in `bracemark-extractor` for the pending links it displays (it holds the
  key and writes the result back; see _who extracts and what wakes it_).
  `bracemark-api` never fetches a URL either way.
- **No third-party extraction service.** A separate blind service can't write
  results back under E2E (it has no key), so it could only offer poll-and-hope;
  and it would leak every URL to a new party. Rejected on both privacy and cost.

The accepted cost of "clients only" is spelled out under _the web-only gap_
below. This supersedes any earlier sketch of a `bracemark-api`-assisted title fetch:
weighed against the privacy stance, having the server fetch URLs — even
transiently, even unstored — is a leak we choose not to take by default.

> **Why not `bracemark-api` even though Workers _could_ do it?** A Worker `fetch` +
> `HTMLRewriter` would extract title/image cheaply (Workers bill CPU-ms, not
> wall-clock, so awaiting a slow remote site is mostly un-billed I/O — cost is a
> non-issue), and "synchronous endpoint" need not block the UI (fire-and-forget
> after the save, patch the title in when it lands). So the blocker is **not**
> latency or cost — it's that the server would see the URL. That's why server
> extraction never lives in `bracemark-api`: it's its own explicit, second opt-in,
> distinct from client extraction, in a **separate app on a separate origin**
> (`bracemark-extractor`) — never a route in the blind sync broker — because its
> privacy profile is strictly worse. See _server extraction_.

### capability tiers — not every client can do every job

Fetching a URL is easy wherever there's no CORS; **screenshots and page copies are
the hard part, and only an _active page context_ does them well.** This
asymmetry drives the whole result/queue design.

| client / mode                          | title + image      | read mode   | screenshot             | page copy |
| -------------------------------------- | ------------------ | ----------- | ---------------------- | --------- |
| extension — **icon click, active tab** | ✅ live DOM        | ✅ live DOM | ✅ `captureVisibleTab` | ✅        |
| ~~extension — background, queued URL~~ | —                  | —           | —                      | —         |
| mobile — **share sheet**               | ⚠️ host-provided   | ❌          | ❌                     | ❌        |
| mobile — **foreground**                | ✅                 | ✅ WebView  | ✅                     | ✅        |
| mobile — **background queue**          | ⚠️ best-effort     | ⚠️          | ❌                     | ❌        |
| `bracemark-extractor` Worker           | ✅                 | ✅          | ❌ needs Browser Rndr. | ❌        |
| import                                 | ⚠️ export-provided | ❌          | ❌                     | ❌        |

The struck row is the **decision below**: the extension _could_ bg-fetch queued
URLs with an `<all_urls>` host grant, but we **don't** — that capability moves to
`bracemark-extractor` / mobile background.

The two mobile rows split a real platform seam. The **share sheet** is a
memory-constrained, short-lived share _extension_ — it can't reliably stand up a
WebView to render, fetch, or screenshot — so it captures only **host-provided
metadata** (a title the originating app hands it) as a **provisional
`extraction.title`** and leaves the actual extraction to the queue; it is a save
context, not an extractor (the same provisional-seed pattern a Brace.to import
uses for its extractor's title — see _imported links_ — so it emits **no `extractedBy` tier of its own**, and the
`extractedBy` enum stays `expo:fg | expo:bg`, no share-sheet value). The
**foreground** (the full app open) is mobile's true active-context tier: native
fetch / a controllable WebView give it title+image, read-mode, screenshot, and
page copy — the `expo:fg` active-page tier, peer to the extension's active tab.

The **`import`** row is the same shape one step further out: a bulk import does
**no fetch of its own** — it seeds a provisional `extraction.title` from the
export (a title only, never an image, hence `⚠️ export-provided` not
`best-effort`: nothing is _fetched_, so nothing can be "best effort") and hands
every link to a drain, later worked by `bracemark-extractor` or Expo at
`deviceExtractionMode: 'all'` (see _imported links_). The extension has no
background drain and merely opening an already-saved link does not recapture it.
So the share sheet and `import` are both **save contexts that seed a title, never
extractors** — the ✅ rows are the contexts that actually fetch.

Two consequences baked into the design:

- **Background queue processing (where it exists) is metadata + read-mode only.**
  A queued URL has no open tab, so it can't be screenshotted without opening one
  (heavy, flaky). On mobile, background time is a few unreliable seconds. So:
  **screenshot/page-copy are best-effort, captured only from the active context**
  (icon click / foreground share). Don't fight the platforms to background them.
- A link extracted at a **low tier** (background raw-HTML, no screenshot) should
  be **upgradable** when a **higher-tier** client later sees it — which means the
  system must record _who_ produced the current result (`extractedBy`, from which the
  tier is derived). See
  _the extraction entity_.

#### the extension is active-context only (no `<all_urls>`)

The extension deliberately **does not** do background bg-fetch extraction, even
though it technically could. Background fetching of arbitrary saved URLs requires
a broad host grant (`<all_urls>` in `host_permissions`), and that grant is a poor
trade:

- **Install warning.** A required `<all_urls>` grant shows Chrome's scariest
  install warning — _"Read and change all your data on all websites"_ — before the
  user has any context for why a bookmark saver needs it. Worst-case install
  conversion. `optional_host_permissions` only defers the prompt to a contextual
  moment; it doesn't remove it, and still draws review scrutiny.
- **Store review.** A required broad host grant trips heightened review on both
  the Chrome Web Store and Firefox AMO (mandatory source review + a written
  justification). "We background-fetch pages you saved elsewhere" is exactly the
  pattern reviewers read as possible exfiltration/injection.
- **It buys the extension's _weakest_ tier.** `<all_urls>` unlocks only the
  background **bg-fetch** tier (title+image from raw HTML, no screenshot/page-copy).
  The extension's _unique, irreplaceable_ value — active-tab DOM,
  `captureVisibleTab`, page copy — needs only **`activeTab` + `scripting`**, which
  carry **no broad-host warning at all**. So the broad grant costs the biggest
  install-funnel hit to add the lowest-quality capability.
- **That capability has a better home.** The background/bg-fetch residual
  (cross-device pickups, bulk-import draining) is what the
  **`bracemark-extractor`** server path owns anyway — _"interactive saves justify
  avoiding `bracemark-extractor`; imports justify building it"_ (see _imported links_,
  _server extraction_). Paying `<all_urls>` to build a flaky,
  MV3-ephemeral version of that is the wrong split — and dropping it is part of why
  `bracemark-extractor` is now a **necessary** app, not a someday one.

So the extension extracts **only from the focused active tab** (`extractedBy:
'extension:fg'`, active-page tier) and runs **no headless background extraction
sweep** — its background service worker does sync only. The tier/queue machinery
below (`extractedBy`, the facet bookkeeping, the pending-work query) stays
tier-agnostic and shared; it's the _bg-fetch arm in the extension_ that's dropped,
not the model. The accepted cost: a link saved on another device isn't silently
back-filled by a desktop extension in the background, and opening that already-saved
link in the extension does not trigger a recapture. It needs Expo set to `all` or
`bracemark-extractor` (if opted in); otherwise it stays the _web-only gap_.

**Why this _doesn't_ extend to the mobile app (`bracemark-expo`).** The instinct is
that the same logic forbids background extraction on mobile too — it doesn't,
because the reason above is **permission-shaped, and mobile has no equivalent
cost**. A native app has **no CORS and no host-permission model**: it `fetch`es any
URL without declaring per-host access, so there is **no `<all_urls>`-equivalent
install warning** and no broad-host store-review flag (the native-HTTP escape hatch
this doc opens with). The entire load-bearing argument against the extension's
background sweep — the warning + the review — is simply **absent** on mobile, so
reusing the conclusion would be cargo-culting it without its premise. What _does_
limit mobile background is **reliability/battery, not permissions** — iOS
`BGAppRefreshTask`/`BGProcessingTask` windows are opportunistic and unpredictable,
Android has Doze/WorkManager throttling — and that's a reason to cap it at
**best-effort**, not to forbid it. Privacy doesn't argue against it either: a
background mobile fetch is a trusted, key-holding client doing local E2E work, the
same privacy profile as the extension's _foreground_ capture — no new party learns
the URL. So `bracemark-expo` **keeps** background extraction (`expo:bg`, bg-fetch tier),
best-effort: the **foreground** (full app) is its active-context tier — the share
sheet is only a constrained save context that seeds a host-provided provisional
title — an opportunistic background drain handles the residual, and the
bulk-import drain still belongs to
`bracemark-extractor` (don't promise mobile-background throughput). One-line contrast:
**the extension's background is dropped for a permission cost mobile doesn't pay;
mobile's background stays, capped at best-effort for a reliability limit the
extension's design never turned on.** The shape of expo's drain — foreground
first, `expo:bg` after, and why it never calls `bracemark-extractor` at all — is _expo
drains in the foreground_.

### who extracts and what wakes it

Capability tiers say what each client _can_ do; the trigger says which pending
links it actually works. There is deliberately no universal "only at save time"
rule:

| client / context                 | what wakes title+image extraction                                                 | tier        | cost / privacy                                                         |
| -------------------------------- | --------------------------------------------------------------------------------- | ----------- | ---------------------------------------------------------------------- |
| **browser extension save**       | every successful save kicks a capture from the live active tab                    | active-page | free, private, best                                                    |
| **mobile / foreground save**     | `extractNow` fetches the link just saved; the share sheet hands it off to the app | active-page | free, private                                                          |
| **mobile / foreground browse**   | at mode `all`, pending displayed links are fetched as they come into view         | active-page | free; each site sees the device's request                              |
| **web app / visible links**      | with `serverExtraction` on, pending displayed links wake the in-page drain        | server      | server sees the URL — opt-in, off by default (see _server extraction_) |
| **web or mobile / Generate all** | an explicit full-library pending scan                                             | server / fg | finite user-driven job                                                 |

The web row corrects two easy misreads of _the stance_. First, "the web app
can't extract" is true only of **fetching** — a `bracemark-web` tab can't `fetch`
an arbitrary URL (CORS). But the web app **holds the data key**, so it can still
_orchestrate_ extraction: `POST` the URL to `bracemark-extractor`, get plaintext
title+image back, encrypt, and write the result into `extractions/`/`files/`
itself. Second, that work is **not attached only to the save call**. The
`ExtractionProvider` observes pending state; once server extraction is enabled it
works the pending rows currently displayed. A new save is covered when its row
appears, and so are older, synced, and imported links as the user browses.
**Generate all** switches the same provider to a finite full-library scan. With
the opt-in off, all of those rows remain in the documented _web-only gap_.

A mobile save reaches the active-page row above only from the **foreground** app.
The mobile **share sheet** is the one save context that **doesn't** extract inline
— it's a constrained share _extension_, so it captures only host-provided metadata
as a provisional `extraction.title`, leaves the `titleImage` facet **pending**, and
lets the foreground/background queue do the real extraction later (the same
provisional-seed pattern as a Brace.to import's extracted title — see _imported
links_, _capability tiers_).

Note what the mobile/foreground row does **not** carry: an opt-in. The fetch is
local, to a host the user just handed the app, in the gesture that asked for the
link to be saved — so the save _is_ the consent, exactly as it is for the
extension's active-tab capture (the gestured/un-gestured split in _the stance_).
Expo's `deviceExtractionMode` gates the un-gestured residual — links that arrived
by sync or import, and their favicons — at `all`; this row rides the default
`saves`. Only the bottom position, `off`, stops it.

**The save surface determines the immediate path.** Saving through the browser
extension is the most private and highest-quality route: that save always kicks
the active-tab capture. Saving through `bracemark-web` creates a pending link; if
server extraction is on, the visible-row drain sends it to
`bracemark-extractor`. There is no implemented web-to-extension handoff or
presence preference that reroutes a web-app save through the extension. Both
clients still participate in the synced bus: the web app is the primary,
full-sync client, and the extension is a **selective-sync** client (see _what each
client syncs_).

Two consequences:

- **Pending state is the shared handoff.** The extension and Expo save paths kick
  their own capture, while the web and Expo browse drains observe the same
  missing `titleImage` facet. That is what lets one loop cover a new visible save,
  a cross-device pickup, and a **bulk import** without a separate queue (see
  _imported links_).
- **No web→extension _save handoff_.** It's tempting to route a web-app save
  _directly_ to a same-browser extension so the extension extracts it. The
  current product has no such channel: the web app writes the link, its own
  displayed-row drain handles it when enabled, and ordinary sync eventually
  puts the link in the extension's store. The extension is active-context only
  and does not headlessly extract that synced URL. A future content-script
  presence bridge is deferred; it may announce that the extension is installed,
  carry a cheap "sync now" nudge, or return bytes already in the browser's favicon
  cache (see _favicons_), but it must never carry the URL or the save itself.

### the data model: user data in `links/`, everything machine-derived in `extractions/`

The split is **by writer**, and getting the axis right is the whole game:

1. **`links/{id}.enc` — user-authored only.** `url`, `listId`, `tagIds`,
   `customTitle`, `customImageId`, `note`. Every field is written by a user gesture
   (save, edit, tag, move, annotate). Nothing a background actor produces touches
   this file.
2. **`extractions/{id}.enc` — everything a machine derives.** Both the **display
   result** (`title`, `imageId`, `pageCopyId`, `screenshotId`) _and_ the
   **coordination/provenance** bookkeeping (the per-facet who/when/quality/retry
   map). `{id}` repeats the link's id; one file per link, shadowing `links/{id}.enc`.

Why this beats the older "display result in `links/`, bookkeeping in `extractions/`"
split (which divided by _render-need_, not writer): with title/image in `links/`,
completing an extraction did a **read-merge-write on the user's file**, which under
file-level LWW could **silently clobber a concurrent user edit** — change list,
retag, set `customTitle`. The two-field `customTitle ?? title` rule prevented a
_field_ collision but not the _file_-level one, and the damaging direction
(extraction overwriting a user's list/tags/title) is the **one unrecoverable race in
the whole design** — extraction never re-derives a user's list assignment. The
writer-split makes it **impossible by construction**: extraction writes only
`extractions/`, so it can never overwrite a `links/` field.

Two things fall out, both wins:

- **No more two-file completion.** Extraction completion now writes **one** file
  (`extractions/`, result + bookkeeping together), not two. A 5 000-link import is
  ~5 000 sync ops, not ~10 000.
- **Races that remain are self-healing.** The only LWW races left inside
  `extractions/` are between two extraction writes (e.g. two devices finishing two
  facets in one sync window) — idempotent, re-extract fixes them. No user data is
  ever on the losing side.

One **deletion race** survives the split and is handled by a **janitor, not
accounting**: destroy deletes `links/` + `extractions/` + `files/` together, but a
concurrent extraction write-back from another device can land after them,
resurrecting the machine half without its link — a **dangling extraction**. Nothing
ever reads it (every join goes link → extraction), but it skews the facet counts
(its outcome token counts against no link, so `pending` under-counts) and leaks
storage — the blob plus the `files/` content it references, in R2 against the quota
and in every device's local store, with no other reclamation path. So it's fixed by
deletion: `sweepDanglingExtractions` (web-react) scans extraction paths against
their co-keyed links (keys only — blobs are read only when a dangling is actually
found) and tears each one down content-before-entity through the normal delete
mutations, queuing the server deletes. **bracemark-web** fires it once per session,
after the session's first **completed** sync cycle — never mid-pull, where absence
proves nothing (the fallback listing walks in path order and `extractions/` sorts
before `links/`) — and only a **full-sync** client may run it: the test is "link
absent locally" and the remedy is a remote delete, so a selective-sync client (see
_what each client syncs_ below) would judge healthy extractions dangling and delete
them for every device. If a sweep races an edit-vs-delete link resurrection, the
loss is the machine half only: the link re-queues as pending and re-extracts.

The cost is a **render-time join**: drawing a row needs both files, co-keyed by the
same `{id}` (the UI resolves `customTitle ?? extraction.title ?? host(url)` and
`customImageId ?? extraction.imageId`). For the virtual-scrolled window that's a
primary-key batch get + one extra decrypt per visible row — cheap; and sort/filter
(date/list/tag) is unaffected because those keys all stay on the `links/` record.
The one real edge is **title search**, which now spans two stores — see
[client-queries.md](./client-queries.md).

> **One source of truth per field still holds.** The displayed title resolves
> `customTitle ?? extraction.title`; each value lives in exactly one file
> (`customTitle` in `links/`, `title` in `extractions/`), never copied across.

**The write edge enforces that split, because nothing downstream would report a
breach of it.** The join produces a `LinkView` — `title`, `imageId`, `pageCopyId`,
`screenshotId` on top of the stored link — and that view is what every UI call
site hands to a mutation whose signature says `LinkItem`. The two are assignable,
so there is no type error; `linkSchema` is a `looseObject`, so the extra keys pass
validation and are PRESERVED (that is what lets a newer client's field round-trip
through an older one); the projector indexes none of those names; and `toView`
overwrites all four on read. So a view written into `links/{id}.enc` is invisible
on the device that wrote it while being encrypted and pushed to every other one,
re-spread by each later write of that link — and it squats on names a future
`linkSchema` could claim, `title` above all, since that name lived in this
namespace before the split. `writeLink` and `bulkWriteLinks` therefore strip the
join first (`toItem`, kept beside `toView` so the two lists of names cannot
drift). Only one path could reach it — the recreate fallback, where a link deleted
on another device is rewritten from the caller's snapshot because there is no
stored blob to merge onto — which is exactly why it went unnoticed.

### the preview image is a downloaded blob, never the remote URL

Extraction discovers the preview image as a **URL** (og:image / lead image). The
tempting shortcut is to store that URL and render `<img src>` straight from it —
no download, no `files/{id}.enc`, no quota, faster first paint. **Don't.**
`extraction.imageId` is a downloaded, encrypted `files/{id}.enc` blob; the URL is
only an _input to the fetch_, never persisted. **Who runs that fetch splits by
client:** an extension/mobile save downloads the og:image directly (native /
no-CORS); a web-app save **can't** — JS can't read cross-origin image bytes, an
`<img>` would only _render_ the URL (the per-paint leak this section forbids,
below) — so the bytes come through `bracemark-extractor`'s image proxy (see _server
extraction_). Either path ends with the bytes as an encrypted `files/{id}.enc`
blob, never the remote URL. Three reasons, heaviest first:

- **It would reintroduce the exact leak this whole doc avoids.** A remote URL in
  the always-resident `extractions/` blob means every device that renders the list
  `fetch`es that third-party host on every paint — beaconing the user's IP, that
  they saved the page, and timing to an arbitrary party (and its CDN/trackers),
  on _every viewing device, forever_, including the web-only client that
  otherwise never touches the URL. The **asymmetry** is the point: the
  _extracting_ client already fetched the page and already learned the URL — it's
  paid the privacy cost (see _the stance_) — so _it_ downloading the image bytes
  costs nothing extra, and once it writes the encrypted blob every other device
  reads only ciphertext through sync. Download = pay the privacy cost **once, at
  the client that already knows**; remote URL = pay it on **every render, on every
  device**.
- **It would break the offline / local-first promise.** An encrypted
  `files/{id}.enc` image is stable, synced, and offline-available — and
  lazy-fetched on scroll, so storing it costs nothing up front (see
  [local-first-sync.md](./local-first-sync.md) — _metadata vs content_; same
  heavy-media rule as `pageCopyId`/`screenshotId`/`customImageId`). A remote
  URL rots, gets hotlink-protected, silently changes content, needs the network,
  and is dark offline.
- **It would break the blob convention.** `imageId` is typed as a bare
  `files/{id}.enc` ref — "a field name types its blob" (see
  [local-first-sync.md](./local-first-sync.md) — _plaintext typing_) — the same
  rule as `screenshotId` / `pageCopyId` (its siblings in `extractions/`) and the
  user's `customImageId` in `links/`. A plaintext,
  externally-mutable `https://…` string is a new pattern the sync encryption path
  never sees, and a stored pointer-to-plaintext the encrypted blob isn't.

The cost is real and accepted: a one-time download, the bytes against the
per-user quota, and IndexedDB content accumulation (bounded by the deferred
content-cache LRU — see [local-first-sync.md](./local-first-sync.md) _deferred_).
It buys the privacy guarantee, and the cheaper "just use the URL" path is cheaper
**precisely because it leaks**. If first-paint latency ever matters, leave
`imageId` **absent** until the blob lands — the card shows no preview, the same
_web-only gap_ behavior — rather than rendering the remote URL as a placeholder,
because the placeholder _is_ the leak.

### favicons: a device-local host cache — never a facet, never synced

The site icon a row renders beside its host is enrichment, but it deliberately
sits **outside** everything above: not a facet, not in `extractions/`, no
`files/` blob, not synced. It's a **device-local, per-host cache** — on web the
`db.favicons` table (filled by web-react's `FaviconProvider`, read by
`useFaviconUrl`), on expo the sqlite `favicons` table + on-disk icon files
(expo-react's `FaviconProvider` / `useFaviconUri` — the row keeps the verdict,
the render is a derived `file://` uri) — holding
raw icon bytes, or a recorded `none` verdict (with a long retry TTL) so an
iconless host doesn't re-buy its fetch on every reload. A row shows the cached
icon where it has one; nothing ever waits on it. Where it doesn't, the row falls
back **once**, in its preview slot, which fills with the **monogram** — the chip
beside the host line goes to a quiet plate instead. Both boxes resolve the same
host's favicon independently, so each used to escalate on its own and an
image-less, icon-less row drew the same letter on the same hue twice, ~12px
apart. Beside a host string the monogram is never the last identity left: its
letter is the first letter of the text next to it. The escalation rule itself is
unchanged, it is just applied per row rather than per component (bracemark-web
`_layouts/shared/link-media.tsx`'s `Favicon`, bracemark-expo
`features/links/link-media.tsx`). bracemark-extension's popup specimen keeps its
own escalation — it prints no host chip, so its slot really does stand alone
([browser-extension.md](./browser-extension.md), _the page specimen_). Three
decisions, each deliberate:

- **Not a facet — the axis is wrong.** Every `extractions/` field varies per
  **link**; a favicon varies per **host**. A 5 000-link library resolves to a
  few hundred distinct hosts, so a per-link `faviconId` would mint thousands of
  synced, encrypted, quota-charged blobs to represent hundreds of ~1–2 KB icons —
  and drag pure decoration through the facet lifecycle (tiers, backoff,
  `permanent`), machinery that exists to coordinate work that's expensive to
  redo and costly to get wrong. A favicon is cheap to redo and its failure mode
  is a monogram.
- **Not user data.** The bytes are public and re-fetchable, so they earn none of
  the user-data machinery: no encryption, no op-log entry, no quota charge — a
  fresh device just re-fetches. The genuinely private thing is the **set of
  hosts** (the user's browsing shape), which is why the cache is still wiped on
  sign-out / delete-all-data even though no single icon is anyone's secret.
- **Not synced.** This is the one enrichment where a capable client's work does
  **not** reach other devices, and the asymmetry is accepted with eyes open. A
  synced store would have to be **host-keyed** (per-link is ruled out above),
  and a host-keyed namespace costs real machinery: paths are server-visible, so
  `favicons/{host}.enc` — or any plainly-hashed host — hands the sync broker a
  dictionary-attackable copy of the browsing shape, forcing HMAC-keyed paths
  under a user-derived key; garbage collection has no owner (a favicon dangles
  only when **no remaining link** references its host — a full host-set scan,
  not the co-keyed `sweepDanglingExtractions` pattern); and the quota would
  charge users for public bytes. All of that buys an icon instead of a monogram
  for one narrow slice: a web user opted out of server extraction, who still
  sees the synced `extraction.title` and preview image — the enrichment that
  carries information. **Flip condition:** if favicons ever become load-bearing
  (say, the primary visual of a layout), the successor design is a per-host
  `favicons/{hmac(host)}.enc` namespace, written at extraction time by the
  extracting client — split host-keyed, never a per-link facet. Don't pre-pay
  it.

**Who fetches, per client — riding each client's existing extraction opt-in,
never a favicon-specific setting:**

| client                  | source                                                                                                                     | gate                                                                          |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| **bracemark-web**       | `/favicon.ico` guess, bytes through the extractor's `GET /v1/image` proxy                                                  | the `serverExtraction` opt-in                                                 |
| **bracemark-expo**      | direct native fetch (no CORS); the real `<link rel="icon">` when it extracts the page anyway                               | `deviceExtractionMode` (`all` to guess; `saves` captures declared icons only) |
| **bracemark-extension** | **never fetches** — `tab.favIconUrl` in the popup; Chrome's `_favicon` API if a browse UI ever exists; monogram on Firefox | none needed — zero network                                                    |

The gates are the same trust decisions the user already made, so "off by
default" falls out for free — a fresh install fetches no favicons anywhere, per
_the stance_. Per-client notes:

- **web** — the extractor already sees this user's **full URLs** under the same
  opt-in, so per-host favicon requests add nothing to what that party learns.
  The accepted residual vs. the og:image model: og:image pays its disclosure
  **once**, at the extracting client, and every other device reads ciphertext;
  the favicon cache pays **per device** (each device re-asks the extractor per
  host). Host-only, behind the same opt-in — fixing it means the synced
  namespace above, which a cosmetic payoff doesn't justify.
- **expo** — the gate is `deviceExtractionMode` (see _expo drains in the
  foreground_), and it's load-bearing, not ceremony: for a link saved on
  another device, a **standalone** favicon fetch is a **new** disclosure of the
  user's IP to that site (expo never fetched that page), so the host-keyed
  **guess** (`https://{host}/favicon.ico`) needs `all`. The one
  carve-out is the icon expo learns while extracting the page **itself**: it
  already holds the HTML, and the icon URL it declares is on a host this device
  contacted seconds ago in the same gesture — so capturing `<link rel="icon">`
  there costs no disclosure the extraction didn't already pay, and beats the
  `/favicon.ico` guess on accuracy. That capture is therefore allowed exactly
  where its extraction was (a gestured save, or an `all` drain); it is never
  a licence for the host-keyed cache to go fetch on its own. Two limits keep the
  carve-out honest at `saves`, where the licence is one save rather than a
  standing opt-in: a **cross-origin** icon href (a CDN the gesture never implied)
  is skipped, and the guess is fired for the saved link's **own** host only —
  `extractNow` hands those hosts to the queue directly, so the same save that
  buys the page buys its icon, and a link saved here isn't left with a title, a
  picture, and a monogram.
- **two fillers, one cache (expo only).** The guess and the capture write the same
  per-host rows without coordinating, and neither is a superset: only the guess
  serves a host expo never extracts a page for (synced/imported links, links
  settled `permanent`, a settled library being scrolled), and only the capture
  serves a host that ships no `/favicon.ico` at all. So both stay, ordered by one
  rule — **`ok` is never downgraded; `none` is only ever the floor** — which makes
  either interleaving converge on the bytes. Without it the two lose the icon in
  _both_ orders: a late-landing guess-miss would delete a captured icon and stamp
  a `none` that stands for `FAVICON_RETRY_MS`, and a guess-miss that lands first
  would (if the capture deferred to staleness rather than to `ok`) block the more
  accurate source for the same week.
- **what counts as an icon is WIDER than what counts as a preview — and it's the
  CLIENT's call on every platform.** A fetched icon is accepted on a **byte
  sniff**, not on anyone's content-type, and that sniff deliberately takes raster
  formats **plus SVG**, because `<link rel="icon" type="image/svg+xml">` is common
  enough that refusing it left those hosts on the monogram permanently, and
  because an icon is only ever RENDERED — never measured, capped or re-encoded.
  The stored-preview sniff keeps refusing SVG for exactly that reason:
  `probeImageSize`/`resizeImage` are raster-only, so an SVG accepted there would
  sail past the 1024px cap and land whole in the user's quota. Sniffing text needs
  an anchor a magic-byte check doesn't: the root tag must be the document's FIRST
  tag, or the HTML error page a misconfigured host serves at `/favicon.ico` would
  pass on an inline `<svg>` somewhere in its body. The renderer has to hold up its
  end, which is why bracemark-expo's link media is **expo-image** (expo-native-deps.md —
  _expo-image_).

  Both sniffs are `@stxapps/shared` `image/sniff.ts` (`sniffImageMime` +
  `isSvgBytes` — pure byte shapes, no decoder behind them) and the icon verdict
  combining them with the **512 KB cap** is `extract/favicon.ts`
  (`isRenderableIconBytes` / `sniffIconMime`). ONE definition for all three
  fillers — expo's guess, expo's declared-icon capture, and web's proxied guess —
  so no platform can drift on what an icon is. **Web needs it most**, which is why
  it isn't expo's to own: nothing upstream of web's write bounds an icon. The
  proxy's `image/*` check is a passthrough of the site's own declared type (an
  HTML 404 served as `image/x-icon` sails through), and its `MAX_IMAGE_BYTES` is
  the **10 MB og:image** ceiling shared with the preview path — not a statement
  about icons. Either would otherwise land as an `ok` row that never expires
  (`FAVICON_RETRY_MS` ages only `none`), charged to the origin's storage quota.
  Web's render path also has to declare what it decodes: an `<img>` content-sniffs
  raster bytes from a typeless object-URL blob but will NOT sniff SVG, so
  `use-favicon-url.ts` stamps `sniffIconMime`'s result onto the `Blob` — derived
  from the bytes at render time rather than stored on the row.

- **extension** — fetching would be pointless: with no synced store the result
  could feed only its own UI, and the browser already has better sources. The
  save popup renders the current tab's `favIconUrl` (an icon the page the user
  is looking at already loaded), and a future browse UI on Chrome can read the
  browser's own favicon cache via the MV3 `favicon` permission
  (`chrome-extension://<id>/_favicon/?pageUrl=…`) — zero requests, zero new
  party. Firefox has no `_favicon` API, so outside the current tab it shows the
  monogram; acceptable for decoration.

**The `_favicon` bridge — the one upgrade for the opted-out web user
(deferred, with the presence bridge).** A bracemark-web user who declines server
extraction has exhausted every network-shaped source (proxy opted out, direct
fetch rejected below, third parties rejected below, no synced store) — so the
designed answer is the monogram. The single invariant-respecting upgrade is
icons that are **already on the device**: when a same-browser extension is
present, the web app can ask over the **content-script presence bridge** (see
_who extracts and what wakes it_) for a host's icon, and the extension answers with bytes from
the **browser's own favicon cache** (the same MV3 `_favicon` read as above),
which land in `db.favicons` like any other fill. Zero network, zero new party
— the only favicon source strictly more private than the proxy. No new trust
boundary either: the extension eagerly syncs `links/`, so it already knows
every host in the library; the bridge's "never the URL, never the save" rule
is about not routing saves through it, and a favicon reply carries no user
data. Honest limits — why it's an upgrade, not the baseline: coverage is only
hosts the user visited in that browser (synced-from-phone hosts miss →
monogram), it's Chrome-family only, and it needs the `favicon` permission (a
mild "read the icons of the websites you visit" line, nothing like
`<all_urls>`). Rides machinery the bridge needs anyway; don't build it before
the bridge. (Also rejected for this user: a bundled top-N-sites icon pack —
no leak, but bundle weight that goes stale, favoring exactly the sites whose
monograms are most recognizable.)

**Rejected alternatives** — both are versions of "render the remote URL", the
per-paint leak _the preview image is a downloaded blob_ forbids:

- **A third-party favicon service** (Google's `s2/favicons`, DuckDuckGo icons).
  Leaks the host set to a **new party** — the _no third-party extraction
  service_ rejection from _the stance_, replayed at host granularity. Worse, it
  can't even be cached: the service sends no CORS headers, so the bytes are
  unreadable and the only integration is a raw `<img src>` — beaconing every
  rendered host to Google on every paint, on every device, forever. An
  unofficial endpoint that can vanish, behind a settings toggle nobody should
  turn on, is not worth its settings surface.
- **Direct `https://host/favicon.ico` from the web app — including as an
  opt-in settings toggle.** An `<img>` would render it, but the response is
  opaque (CORS / tainted canvas), so the bytes can't land in IndexedDB — no
  cache, hence the per-paint leak again, this time to every saved site. On expo
  the same URL is fine: native fetch reads the bytes, caches them, and pays the
  disclosure once per host. The toggle variant ("if no cached icon, render
  direct") has come up more than once and stays rejected; the reasoning is
  non-obvious, so recording it:
  - **"The user already visited that site, so the icon is cached" is false.**
    Browser HTTP caches are **partitioned by top-level site** (Chrome 86+,
    Firefox, Safari): an icon cached while browsing `github.com` lives in a
    different partition than a request from the app's origin, so bracemark-web
    fetches every host cold, on every device, regardless of browsing history.
    (The intuition itself is sound — and the `_favicon` bridge above is its
    correct realization: it reads the icon that actual visit cached, from the
    right cache, with zero requests.)
  - **The hybrid degenerates.** A direct `<img>` can never populate the store
    (opaque bytes), and a miss can never record `none` — so with the extractor
    off, "direct only as fallback" is direct **always**, and iconless hosts
    re-request indefinitely (404s aren't cached). The `ok`/`none`-with-TTL
    model this section is built on is exactly what this path cannot have.
  - **What each request discloses is more than a visit.** By default it
    carries `Referer: app.bracemark.com`, so every saved site learns "this IP saved
    me in bracemark and is viewing their library right now", on a recurring cadence
    that maps usage rhythm — a per-host tracking beacon
    (`referrerpolicy="no-referrer"` trims the referer; IP + timing remain).
    The one honest point in its favor — disclosure goes to the saved site
    itself, not a new party, and no single party sees the whole library —
    doesn't outweigh a recurring, uncacheable beacon bought for decoration,
    and "we never render remote URLs, except this toggle" would gut the
    invariant's teachability.

The accuracy upgrade — `POST /v1/extract` returning the page's declared
`faviconUrl` so the web app fetches the real icon instead of guessing
`/favicon.ico` — is deferred; see _deferred / open_.

### manual overrides: `customTitle` / `customImageId`

A user can manually set a link's title and image. The override is a **pair of
optional fields on `linkSchema`** — `customTitle` and `customImageId` (a
`files/{id}.enc` ref to a user-picked image) — **not a new entity**. They sit in
`links/` beside `tagIds`/`listId` because a manual override is a **low-frequency
user edit** made in the same gesture as editing those; a separate
`customTitle/{id}.enc` would force one user edit to write two files and race them
under LWW. (The extracted counterparts, `title`/`imageId`, are the _opposite_ — a
machine writer on its own schedule — which is exactly why they live in
`extractions/`, not here.)

**Two fields across two files, so extraction and the user can never collide.** The
two halves split cleanly by writer _and_ by file:

- **extraction owns `extraction.title` / `extraction.imageId`** — the
  discovered/provisional values, in `extractions/`. It writes them unconditionally on
  completion or tier-upgrade, and **never reads or writes the `custom*` fields** (it
  doesn't even open `links/`).
- **the user owns `links.customTitle` / `links.customImageId`** — written only by the
  explicit "edit title/image" action, in `links/`.

The UI renders **`customTitle ?? extraction.title ?? host(url)`** and
**`customImageId ?? extraction.imageId`**, so a manual edit always wins. Three
properties fall out for free:

- **Re-extraction is safe.** A higher-tier client re-extracting `titleImage`
  rewrites `extraction.title`/`imageId` and the override — in a different file — is
  untouched. No "is this user-set?" flag, no conditional in the write path: the
  extractor stays a blind writer. This is why the separate-field shape beats a single
  `title` + `titleSource` provenance flag.
- **Revert is trivial.** Clearing `customTitle` (delete the field) falls back to the
  still-present `extraction.title` — the discovered value was never destroyed; if
  extraction never ran, it falls through to `host(url)`.
- **No shared LWW point at all.** A manual override writes `links/`; a concurrent
  extraction backfill writes `extractions/`. Different files — so unlike the old
  layout there is **no clobber window between them whatsoever**, not even a bounded
  one.

> **Save-time title is sticky.** Any title the user types — whether **at save** or in
> a later edit — goes into `customTitle` and is **never** overwritten by extraction.
> `extraction.title` holds only the **provisional** value, filled when `titleImage`
> lands (or pre-seeded from a Brace.to import — see _imported links_). An unnamed link
> shows `host(url)`, derived at render, until extraction fills `extraction.title` (or
> stays a bare host on a web-only client — the _web-only gap_). So a user-named link
> keeps its name forever; an unnamed one upgrades from host → og:title when extraction
> runs.
>
> **A _provided_ title is sticky whenever the user could have typed it.** The
> test is not whether a source _marks_ a title user-authored — almost none can —
> but whether the user had the chance to rename it there:
>
> - **An imported title → `customTitle`**, from every interop format. A browser
>   bookmark, a Raindrop or Pocket row and a LinkWarden `name` are all renamable
>   in their source, and none of their files says whether that happened: a real
>   Raindrop export carries a renamed title exactly as it carries a fetched one
>   (see [data-lifecycle.md](./data-lifecycle.md), _importing from Raindrop.io_).
>   Only a source that keeps both halves (Brace.to) splits them, the extractor's
>   half going to `extraction.title`. A title that only restates the address is
>   dropped rather than frozen — it is what a producer writes when it has none.
> - **A share-sheet host hint → `extraction.title`**, provisional. The host app
>   hands over the page's title at the moment of sharing; nobody named it, so a
>   later og:title or a higher tier may replace it.
>
> The asymmetry that decides it: a wrongly-frozen title is one edit away from
> fixed — clearing `customTitle` falls through to the extracted title, which
> extraction still fills underneath — whereas overwriting a provisional that
> lived only in `extraction.title` is **unrecoverable**. An imported title is also
> rarely the worse one: a browser captured it in a live tab, often signed in, and
> a service like Raindrop ran its own extractor, while an import is only ever
> enriched by a background fetch, which can land on the sign-in page, the consent
> wall or the bot check instead (_imported links_). What the sticky side costs is a bad title in the file ("Amazon") staying until someone
> edits it. Protect a sticky title via `customTitle` (preserved + revertable),
> **never** a "don't-replace" flag on `extraction.title` (which can't tell a seed
> from a low-tier result and would also block legitimate tier upgrades).

### the extraction entity

`extractions/{id}.enc` plaintext (mirrors `pinSchema`: `id` repeats the link's
id, one self-contained file per link). Lives in `@stxapps/shared`
(`sync/entities.ts`), `z.looseObject` so older clients round-trip unknown fields.

The entity holds both halves of the machine-derived state: the **display result**
(the fields the UI renders) and the **bookkeeping**. A link is no longer **one**
extraction with **one** lifecycle: title+image, read-mode, screenshot, page copy,
keywords, tags, summary, and (deferred) vectors are **independent jobs** — each
produced by a different client/tier at a different time, each able to be pending
(no entry) while another is `done`. So the bookkeeping is a **map of facet →
state**, not a flat `status`:

```ts
export const facetSchema = z.looseObject({
  status: z.enum(['done', 'failed', 'permanent']),
  // done → success; failed → transient (retry after backoff);
  // permanent → hard failure (404/410, robots block) — never retry.
  // there is no 'pending': a facet with no entry (or a link with no
  // extractions/ file at all) IS pending — absence is the signal.
  extractedBy: z.string().optional(), // who ran the last attempt — a `platform:env`
  // string (extension:fg | expo:fg | expo:bg | server), NOT a device id. (The extension
  // is active-context only — it emits extension:fg only, never extension:bg; the :bg tier
  // comes from Expo background / bracemark-extractor. See "the extension is active-context only".)
  // Quality (the upgrade axis) is DERIVED from it by the shared tierOf() helper —
  // :fg → active-page beats :bg → bg-fetch beats server. No stored `tier` field: it's a
  // pure function of extractedBy (storing it beside its input is the same drift-prone
  // two-field invariant we avoid with nextEligibleAt). Left a z.string() (not an enum) so
  // a future platform/env round-trips through older clients; tierOf() ranks an unknown
  // value conservatively low.
  extractedAt: z.number().int().optional(), // when the last attempt ran — success time when done, last try when failed
  attempts: z.number().int(), // backoff counter — retry when now >= extractedAt + backoff(attempts)
});

export const extractionSchema = z.looseObject({
  id: z.string(), // = the link's id ({id} of links/{id}.enc)
  // display result — what the UI renders, the machine-written half of a link's
  // display (the user-written half, customTitle/customImageId, is on linkSchema):
  title: z.string().max(LINK_TITLE_MAX).optional(), // discovered/provisional og:title (or a Brace.to import's)
  imageId: z.string().optional(), // og:image preview — a files/{id}.enc ref, never the remote URL
  pageCopyId: z.string().optional(), // saved page copy — files/{id}.enc, from the `pageCopy` facet
  screenshotId: z.string().optional(), // full-page screenshot — files/{id}.enc, from `screenshot`
  // bookkeeping — partialRecord: a missing facet key = pending (not yet done):
  facets: z.partialRecord(
    z.enum([
      'titleImage',
      'readMode',
      'screenshot',
      'pageCopy',
      'keywords',
      'tags',
      'summary',
      'vectors',
    ]),
    facetSchema,
  ),
  createdAt: z.number().int(),
  updatedAt: z.number().int(),
});
export type Facet = z.infer<typeof facetSchema>;
export type Extraction = z.infer<typeof extractionSchema>;
```

**A present display field never implies its facet ran.** The facet map is the
**sole** authority for done/pending — never infer "`titleImage` is done" from a
non-empty `title`. `extraction.title` may legitimately hold a value while
`titleImage` is **absent** (= pending): a **provisional seed** from a Brace.to
import's extracted title or a share-sheet host hint (see _imported links_,
_capability tiers_). This is
deliberate and load-bearing — the seed is left pending **on purpose** so the
normal loop fetches the real og:title and replaces it. Two reasons it's a value
_without_ a facet, not a facet:

- **A facet records an extraction _attempt_** (`extractedBy` = who ran it,
  `extractedAt` = when, `attempts` = the retry count). A seed involves **no
  fetch** — nothing was extracted — so there is nothing truthful to put in those
  fields. Absence is the honest encoding; a `'server'`/`'importer'` `extractedBy`
  would record an attempt that never happened.
- **Marking the facet `done` to capture provenance would be doubly wrong:**
  semantically false (no attempt), and it would move the link off the
  well-defined **pending** path onto the under-specified **upgrade** path (see
  _deferred / open_) — `done` facets aren't re-run by the normal loop, only by a
  higher-tier sighting — which suppresses the very enrichment the import needs.
  And `extractedBy` has no reader but `tierOf()`, which already ranks a pending
  (absent) facet below every real tier, so a seed needs no tier of its own.

Each facet answers the same questions independently:

- **who / when** → `extractedBy` / `extractedAt` — a who/when pair describing the
  **last extraction attempt** (the success on a `done` facet, the last try on a
  `failed` one). `extractedBy` is a **`platform:env` string** (`extension:fg`,
  `expo:fg`, `expo:bg`, `server` — the extension emits `:fg` only, never
  `extension:bg`, being active-context only), **not a device id** — nothing reads
  it for identity (no claim lease, no per-device coordination), only for quality.
  **quality** → **derived** from `extractedBy` by the shared `tierOf()` helper:
  `:fg` → active-page beats `:bg` → bg-fetch beats `server`. There is **no stored
  `tier` field** — it's a pure function of `extractedBy`, and a derived value beside its
  input is the same drift-prone two-field invariant we reject for `nextEligibleAt`.
  `tierOf()` lives in `shared` next to `backoff()` (so every client agrees) and ranks an
  **unrecognized** value conservatively low, so a future `platform:env` a newer client
  emits round-trips through older clients (the `looseObject` rule — an unknown _enum
  value_ would instead fail to parse, which is why `extractedBy` stays a `z.string()`)
  without ever wrongly out-ranking a known active-page result.
- **retry, but not forever** → for a transient `failed`, the deciding client
  computes eligibility itself: retry once `now >= extractedAt + backoff(attempts)`.
  We **don't store a `nextEligibleAt`** — it's fully derived from `extractedAt`
  - `attempts` given the shared `backoff()` curve (which lives in `shared`, so
    every client agrees), and storing a derived value alongside its inputs is the
    same fragile two-field invariant we avoid elsewhere. A hard failure is the
    explicit **`status: 'permanent'`** (404/410, robots block) — never retried, no
    timestamp arithmetic, no implicit "failed-with-no-deadline = permanent" rule to
    get wrong. Because this is **synced**, one device's `permanent` (or fresh
    `failed`) stops _every_ device retrying that facet — not the per-device thrash a
    device-local marker would give. (The extractor's 429 `Retry-After` IS honored,
    but at the transport level — the drain's in-memory retry timer waits it out
    (extraction-provider `scheduleRetry`) and a wholesale transport failure is
    never recorded per-link — so no synced deadline field is needed. If a
    _per-link_ server deadline ever appears, it isn't derivable from `attempts`
    and earns its own field at that point — until then, don't pre-pay it.)
- **`permanent` is a user-facing fact, and three surfaces now say so in prose.**
  The settings pane used to render `done`/`pending`/`failed` as three stats, with
  `readExtractionFacetCounts` folding `permanent` **into `failed`** — one number
  merging a count that moves with one that can't, which is why the settled half
  read as a stuck queue. **The fold was the bug**, and no sentence could sit under
  that stat without being false for the other half of it: a transient `failed`
  past its backoff _is_ picked up again by the ordinary drain, so "we stop
  retrying these" was wrong about part of the very number it explained.
  `ExtractionFacetCounts` now carries four buckets and the panes render a 2×2 —
  `With preview` / `Pending` on top, **`Will retry` / `Won't retry`** paired
  underneath, so the distinction reads as one thing rather than two unrelated
  numbers. The two failure fields are named as a pair too —
  **`failedTransient` / `failedPermanent`** — and neither is the schema's
  spelling: `ExtractVerdict` is `'failed' | 'permanent'`, so copying it faithfully
  would have reused the bare `failed` that caused this bug and left the pair
  reading as two unrelated things. These are display buckets, mapped
  `failed → failedTransient`, `permanent → failedPermanent`, both or neither. The
  old `failed` field was **removed rather than narrowed** so a stale reader fails
  to compile instead of quietly under-counting by the permanent share.

  Three constraints on anything that touches this again. **`pending` must stay
  "no facet at all"** — it is what both panes gate _Generate all_ on and print in
  the confirm line, so folding the cooling-transient links into it (tempting: to a
  user they _are_ pending) would enable a button that drains nothing, the same
  failure the trash exclusion exists to prevent. **Every bucket subtracts its own
  trashed share**, so the four sum to the live library and the "N of M previewed"
  denominator stays honest — and so trashing a link genuinely does drop `Won't
retry`, which is why its copy says the count won't come down _on its own_ rather
  than that it is frozen. **`Will retry` never gives up**: the curve caps at a day
  and a 403 converts itself to `permanent` when the ladder tops out, so links
  migrate out of it on their own. For the whole first public stretch every surface explained a missing
  preview as a **client-or-plan** matter (which device saved it; the web-app
  exception; the opt-in), and not one said a **page** can simply refuse — so a
  user who took the opt-in, ran _Generate all_ and was left on `Failed: 34` had
  nothing anywhere telling them that number was finished rather than broken.
  Three surfaces now carry it and they are pinned to `verdictForStatus` exactly
  the way `/extractor`'s blocking advice is (_server extraction_): /faq's
  `no-title-image` (`apps/bracemark-site/src/content/faq.tsx`) at length, and —
  now that the label carries the "we have stopped" half — one line of causes
  beside the stats in each settings pane
  (`apps/bracemark-web/src/app/(app)/settings/[section]/_extraction/`,
  `apps/bracemark-expo/src/features/settings/extraction-section.tsx`). Widen or
  narrow the permanent set in `extract/retry.ts` and all three describe a product
  that no longer exists, with no lint error, type error or failing test — the
  copy names login/paywall pages, non-HTML targets and hosts that turn away
  automated requests because that is what 401/403/451 and the synthetic `415`
  settle as today. Note the shape of the claim: it says **we stop retrying**, not
  that the page is unreachable — a `permanent` verdict is our decision about a
  ladder that topped out, not a fact about the site, and the honest version is
  the one a user can check by opening the link themselves. The missing half is
  still open: a per-link **manual capture** trigger would turn this from a dead
  end into something the user can act on (_deferred / open_).

- **cross-device dedup** → **none, by design.** There is no claim lease. A lease
  would force an extra _write-claim-then-sync before extraction_ on the critical
  path, yet stay best-effort anyway (two devices waking in the same poll window
  both see "unclaimed" and both extract). The failure it guards against —
  duplicate extraction — is **self-healing**: the same URL yields the same
  title/image (idempotent) and file-level LWW keeps one write; the cost is a
  wasted fetch, not a wrong result. This is the same "don't reach for distributed
  locking" call, taken to its conclusion for a single user with a few devices.
  The one place duplicate work actually stings is a **bulk import** (two devices
  grinding the same thousands of URLs); the answer there is **deterministic
  sharding** (partition by `id` hash so devices self-divide with zero
  coordination), not a synced lease — and it's **deferred** until it proves real,
  since the device the import landed on usually drains it alone (see _imported
  links_).
- **upgrade** → a client whose **derived tier** (`tierOf(extractedBy)`) beats a `done`
  facet's may re-extract it (e.g. you open the real page in the extension —
  `extension:fg` → active-page — after a `server` extraction by `bracemark-extractor`,
  or an `expo:bg` mobile background fetch, only got title + image).

**Path layout — one flat file per link, facets inside; not one prefix per
facet.** We deliberately keep `extractions/{id}.enc` (flat — fits the existing
`{prefix}{id}.enc` / `ID_KEYED_PREFIXES` grammar) rather than splitting to
`extractions/{facet}/{id}.enc`. A per-facet split would fully isolate each facet's
write, but it multiplies extraction objects per link by the facet count (~8×),
turns the single-segment key into a 2-level path the sync engine doesn't parse
today, and only buys protection against a **rare, self-healing** race: two
devices completing two _different_ facets of the _same_ link inside one sync
window file-level-clobber each other, and the lost `done` simply looks pending
and re-extracts (idempotent — and since `extractions/` holds no user data, the
clobber only ever costs re-doable machine work). Keeping every facet in one blob
also makes the cross-facet
**upgrade** decision a single-file read. **Flip condition:** if you later want
**selective sync by facet** (a constrained client syncing only the facets it can
produce) or a facet turns individually high-churn, split _that_ facet out — and
split **facet-first** (`extractions/{facet}/{id}.enc`, the per-facet queue-scan
axis), never link-first. Don't pre-pay it.

Wire it the standard three-step (see `paths.ts` header — _adding a namespace_):
add `EXTRACTIONS_PREFIX = 'extractions/'` to `paths.ts`, add it to
`ID_KEYED_PREFIXES`, add `extractionSchema` here — with the **display fields**
(`title?`, `imageId?`, `pageCopyId?`, `screenshotId?`, all `files/{id}.enc` refs
except the inline `title`, same plaintext-typing rule — see
[local-first-sync.md](./local-first-sync.md) _plaintext typing_) alongside `facets`.
`linkSchema` keeps only the **user-authored** fields, including the manual overrides
`customTitle?` / `customImageId?` (see _manual overrides_); it carries **none** of
the extracted display fields — that's the writer-split (see _the data model_).

#### three collectors, one meaning — and only one of them decodes for free

WHICH tag becomes a link's title/image is `selectTitleImage` in `@stxapps/shared`
(`extract/select.ts`), shared by all three extracting clients so a tier upgrade
is an improvement and not a change. What each client does BEFORE that differs,
because each parses a page with what its runtime has:

| client                | parser                                 | character references     |
| --------------------- | -------------------------------------- | ------------------------ |
| `bracemark-extension` | the live DOM, via `executeScript`      | decoded by the DOM, free |
| `bracemark-extractor` | `HTMLRewriter` (`lib/html.ts`)         | **decoded by us**        |
| `bracemark-expo`      | a regex scanner (`parse-html-head.ts`) | **decoded by us**        |

`HTMLRewriter` decodes **nothing** — not a `text()` chunk (a `<title>` is RCDATA)
and not `getAttribute`, which is the surprising half, since the DOM method of the
same name does. So both raw-HTML parsers run every collected value through
`decodeHtmlEntities` (`shared/html/entities.ts`), which is exactly what the DOM
would have done: without it a blog with no og:title stores
`Kleppmann&rsquo;s blog`, and an og:image spelled `?w=1200&amp;h=630` is fetched
with a literal `&amp;` in its query string. `lib/html.spec.ts` asserts the
runtime behaviour against the real `HTMLRewriter` rather than trusting this
paragraph.

**Decode at the parse boundary, exactly once — never in `cleanTitle`.** The
normalizer is downstream of all three clients, and the extension's value has
already been decoded by the DOM; a page that wants to display `&amp;` writes
`&amp;amp;`, so a second decode there would turn it into `&` for everyone. Same
shape as the selection rule: parse per platform, agree afterwards.

### the queue is a query, not a structure

Extension and Expo saves kick their own extraction, while the web app and Expo at
`all` use this loop for every pending link in scope — including a newly saved row,
cross-device pickups, and bulk imports (see _who extracts and what wakes it_).
There is still
**no separate queue object**: a client's extraction work loop is a query over
synced state:

- **default tier (title + image, read-mode):** a link with no `extractions/` file
  (absence _is_ pending), or a facet whose `status` is `failed` and now past its
  backoff (`now >= extractedAt + backoff(attempts)`). A `permanent` facet is
  skipped; there's no lease to check.
- **best-effort tier (screenshot/page-copy):** an _active-context_ save extracts
  immediately and writes the `files/` blob + the `extractions/` ref; the background
  loop's only job is to spot links **missing** those refs (`extraction.screenshotId`
  / `extraction.pageCopyId` absent) that this client's tier can satisfy — the
  absence _is_ the pending signal, no explicit field needed.

The loop: **extract** → **write back** (the result _and_ bookkeeping into
`extractions/`, heavy bytes into `files/` — never `links/`, which the extractor
never touches) → all of it syncs as ordinary encrypted blobs through the existing
engine. There is no claim step — a rare double-extraction is
resolved by idempotency + file-level LWW, not prevented by a lease (see _the
extraction entity_). The **headless background** drain of this loop belongs to the
clients that can run against a queued URL with no live tab — the **Expo app**
(an alarm sweep) and, for `bracemark-web`/desktop, the **`bracemark-extractor`** server they
call; **`bracemark-web` itself drains in-page** (see _the web drains in-page_ below), and
the **extension does not run a background drain at all** (it's active-context only —
see _the extension is active-context only_), so its only role in this loop is the
**active-context** capture on a save. All run against the **same
contract** — the reason the schema (including the shared `backoff()` curve) lives in
`shared`.

**Cadence is backlog-driven, not a fixed tick.** First separate the two costs the
word "poll" hides: the **local queue scan** (querying synced Dexie state for
pending work) is **free** — run it on every wake; only the **network sync poll**
(`ops/list`, to _discover_ another device's changes) costs anything, and that's
what cadence sizes. Because the loop is a query, a client sizes that sync poll to
how much is pending: **idle (a long alarm — around an hour) when the query is
empty**, ramping up to work a backlog down when it isn't (a fresh import, a batch
of cross-device saves), then settling back. The idle interval is a **ceiling /
backstop, not a fixed tick** — an hour is fine because `title+image` back-fills and
nothing waits on it, but a backlog must _not_ wait an hour between chunks. This
replaces a fixed fast poll — a 1-minute alarm spends a request every minute to
almost always find nothing, the worst case for a single-user app whose data
changes a few times a day. An empty poll returning "nothing pending" is the
**intended** steady state, not waste. Pair it with cheap local wake triggers so
freshness doesn't wait on the long alarm — browser start, popup/icon open, and a save
performed _in_ the extension. A deferred content-script bridge could add a
**"sync now" nudge**, but it is not part of today's path (see _who extracts and
what wakes it_). **Don't reach for server push** for title+image: enrichment is
asynchronous and nothing blocks the save on it. (Push only becomes interesting if the
extension ever becomes the authoritative background worker for a facet — which the
active-page facets aren't.)

#### the web drains in-page, scoped to what's on screen

`bracemark-web` has **no background service worker** — its sync engine already runs
in-page, and so does its drain: the **`ExtractionProvider`** (web-react), the
counterpart of the Expo alarm sweep and the extension's active-context role. Because
it's in-page it isn't alarm-paced; it's **`liveQuery`-reactive** — the pending query
re-runs on every store change (a save, an import, a cross-device link landing) and
wakes the drain, no fixed tick.

The cost shape is different enough from the headless clients to call out. Each
pending link is a **paid `bracemark-extractor` request** (HTML fetch + maybe an image
proxy), and an open tab can be **abandoned** — so the web drain must never bill the
server for work no one is watching. Three gates impose that, all of them UX/cost
**shaping on top of** the extractor's own non-negotiable per-IP caps (see _server
extraction_), never a substitute for them:

- **Visibility gate (automatic drain).** The _incidental_ drain runs only while the
  tab is **visible**; a hidden/backgrounded tab spends nothing on enrichment the user
  never asked for. **"Enrich all" is exempt** — it's explicit and finite (see below).
- **Displayed-scoped automatic drain.** The automatic drain works **only the pending
  subset of the links currently on screen** — the page the main pane has rendered,
  reported into the provider — not a blind walk of the whole library. So **work
  tracks attention**: a 30 000-link bulk import left in an open tab never enriches
  past what the user actually scrolled into view. This is still _the queue is a
  query_ — it's the **same `titleImage`-pending facet**, just queried over the
  displayed paths instead of the full library. A per-session **backstop cap** still
  trips for a user who deep-scrolls a huge library in one sitting, surfacing
  "enrich the rest?" rather than draining unbounded.
- **Explicit "enrich all".** Draining the **whole** library is a conscious,
  user-driven job — a full-library pending scan, lifted out of the displayed scope
  and the backstop cap. Unlike the automatic drain it **keeps running while the tab is
  hidden**, so the user clicks once and walks away instead of babysitting the tab. It
  isn't visibility-bounded because it's bounded by being **finite**: the cursor walk
  drains to the end of the library and then **ends the job** (it does _not_ stay armed
  to re-fire on later synced/imported links), with the extractor's per-IP caps as the
  hard floor; `pause()` stops it early. This is the **opt-in moment** a bulk import
  names ("enrich my whole library?" — see _imported links_), so the app **confirms at
  the button** ("Enrich all _X_ links?") and surfaces progress + controls rather than
  running behind the user's back.

On a **retryable** transport failure (a `429` from the extractor's per-IP cap, a
`5xx`, a network blip) the drain doesn't fail the job — it schedules a backed-off
**re-entry** into the loop (`scheduleRetry`). It deliberately does **not** use the
sync engine's `withRetry` wrapper (see [api-contracts.md](./api-contracts.md) —
_transport retry_): that blocks inline, but this loop must stay cancellable by
`pause()`, gated on tab visibility, and single-flighted — so it reuses the shared
retry _policy_ (`isRetryableTransportError` / `retryAfterMsOf` / `jitteredDelayMs`)
with its own _mechanism_. The scheduled re-wake is load-bearing for _enrich all_: a
failed batch writes no facets, so nothing else re-wakes the loop — the retry timer
is the only thing that resumes it after a `429`.

#### expo drains in the foreground — and never calls `bracemark-extractor`

`bracemark-expo` runs the same loop as the web drain above, with the platform swapped
in three places and one hard exclusion.

**It never calls `bracemark-extractor`.** Not "not yet" — permanently. The extractor
exists to buy back a capability its caller lacks, and expo lacks nothing here:
native HTTP has no CORS, so the app fetches the page's HTML and the og:image bytes
itself. Routing through the server would be a strict **downgrade on every axis** —
the result would land at `extractedBy: 'server'` (the floor of `tierOf`) written by
a client that can produce `expo:fg` (the ceiling); it would spend a paid,
rate-limited request on work the phone does for free; it would disclose the URL to
a party that would otherwise never see it; and it sits behind the
`entitlements.serverExtraction` plan gate, so free mobile users would get nothing
where on-device extraction serves everyone. So `serverExtraction` is **not an expo
setting**: expo round-trips it (`looseObject`) for the web clients that honor it
and never reads it, and never renders it — a toggle whose effect is invisible on
the device holding it is worse than no toggle. The one thing expo forgoes is
**bulk-import throughput** (a Worker fans out; a phone does not) — a speed
difference on a back-fill nothing waits on, not a missing capability.

**The gate is `deviceExtractionMode`, expo's own setting.** A synced account
preference beside `serverExtraction` in `settingsGeneralSchema` — and a **ladder**,
not a boolean, because the gestured/un-gestured split it encodes has three
positions worth naming rather than two:

| mode    | what this device fetches                                             |
| ------- | -------------------------------------------------------------------- |
| `off`   | nothing, ever — not even for a link saved right here                 |
| `saves` | **the default** — links saved on this device, and their favicons     |
| `all`   | also the residual: synced/imported links, and the host favicon guess |

`saves` is exactly where the old boolean's `false` sat and `all` where its `true`
did, so the only new behavior is `off` (_the stance_ — "needs no opt-in" is not
"cannot be declined"). It is **synced**, not device-local, because it's the same
account-level trust decision `serverExtraction` is ("my devices may fetch the pages
I save"), and a second phone should inherit it rather than re-ask; if a
metered-connection qualifier is ever wanted, that's a device-local companion (the
theme / links-layout sync-vs-device precedent), never a second copy of this
preference. Defaulting to `saves` is not the same as burying `all`: the app should
offer it at the first moment it means something — the links screen showing
un-previewed links — so the honest default costs one tap rather than a settings
expedition.

The persisted value is a free `z.string()` narrowed by `coerceDeviceExtractionMode`
at the read edge, like `linksLayout`/`sortOn` — so a mode a newer client invents
round-trips here instead of dropping the whole settings blob. The difference is
that this fallback has a **direction**: unknown coerces to `saves`, never up to
`all`, so a blob from the future can't become network activity nobody agreed to.
A stricter mode added later must therefore be one old clients coerce _down_ to.

**`expo:fg` is the tier that's built; `expo:bg` is the extra.** The foreground
drain is the direct analogue of the web provider — expo-react's
`contexts/extraction-provider.tsx` over `lib/device-extraction.ts`, with
`AppState === 'active'` in place of the visibility gate, FlashList's viewable rows
in place of the virtualizer window feeding `reportDisplayedLinkPaths`, and the same
explicit "Generate all" / `pause()` pair. It covers save-time extraction,
cross-device back-fill of what the user is actually looking at, and the
whole-library job. Two honest platform notes on it. First, the gestured save gets
its own entry point, `extractNow(linkPaths)` — outside the queue, the budget and
the opt-in (the gestured/un-gestured split in _the stance_); the add screen calls
it after a create, and ShareBridge after the outbox drain, since a
share-extension save reaches the app only there. Second, web's "extract-all keeps
running while the tab is hidden" is **not literally available** on iOS: a
backgrounded app is suspended, so the drain isn't cancelled on background (a quick
app switch resumes from the in-memory cursor) but progress can't be promised. The
`expo:bg` sweep (`BGAppRefreshTask` / WorkManager) is a genuinely separate, weaker
thing — native task wiring, opportunistic windows, metadata-only — and is worth
building **after** the foreground drain, not instead of it.

**The gates stay; what they bound changes.** On web the three cost layers exist to
bound a **bill** — every pending link is a paid extractor request. Here every fetch
is free, so the same layers survive for different reasons: battery and cellular
data, politeness to the hosts being fetched (pace per-host; don't trip bot
protection), and not doing invisible work for an app the user backgrounded. Two
calibration consequences: "Generate all" needs **no cost confirmation** (nothing is
billed — it gets a button, a progress readout, and Pause, and says it uses the
connection), and the per-session auto backstop can sit looser than web's, since
overshooting spends the user's battery rather than the project's money. The
_settings section_ shape follows from the same swap: expo gets the section
bracemark-web's `_extraction/extraction-section.tsx` header anticipates being dropped —
same "Link previews" surface, but no plan gate and no upsell branch (on-device
extraction is free on every plan), no two-step confirm, and in place of a toggle it
renders `deviceExtractionMode` as three radios. The default is also **offered**
rather than buried: the links screen shows a one-time, dismissible banner when the
mode is still `saves` and links are actually waiting for a preview (the raw pending
count less what the save path is fetching right now, not the gated exact tally — the
banner exists to ask the question the gate would otherwise silence; see _the
links-page offer_). It arms on `saves` **specifically**, not on "anything
below `all`": `saves` is the default nobody chose, which is what an offer is for,
whereas `off` is a decision, and re-asking someone who picked "never contact these
sites" is nagging. The dismissal is device-local while the setting it offers is
synced, so a second phone still gets its one offer.

⚠ **"The device that saved the link" describes the Expo DEFAULT, not the product.**
`all` is the position where a
device fetches pages for links it never saved — synced, imported, saved in the web
app — as they come into view, so a sentence scoped to the save is wrong in two
directions at once: it under-describes what leaves the phone (a privacy claim), and
it sells a paid server for work a free phone already does. Both halves had shipped.
The corrected set, which is also the list to re-read before adding another claim:
the store description and paid-plan card; /faq's `previews` and `no-title-image`;
/privacy's _Link previews_; the home page's screenshot caption, capture card,
Previews feature bullet, and trade-band Previews row; the /pricing previews pair;
/extractor's opening paragraph; the web links-page offer, settings pane, and
free-plan subscription line; and Expo's preview offer, settings pane, and
free-plan subscription line. The rule any of them can be rebuilt from:
**the extension attempts extraction on its successful saves; Expo covers its own
saves by default and displayed pending links at `all`; web covers displayed pending
links when server extraction is enabled; and Generate all is the explicit full scan**.
Wherever a surface says what covers imports and web saves, the phone at `all` is the
free answer beside the paid one. Nothing catches a regression: the copy type-checks,
lints, renders, and reads plausibly, which is how it survived the first public
stretch.

#### the links-page offer — same banner, two different asks

Both apps put a one-time, dismissible banner on the links screen, armed on nearly the
same condition (previews still off, undismissed here, and a pending count above zero,
from `readRawPendingTitleImageCount` — the over-count, since the exact tally is gated
on the very thing being asked about) and retired by the same device-local flag
(`previewsPromptDismissed` in each app's `localSettings`, so a second browser or phone
still gets its one offer). What each banner OFFERS is not the same thing, and
bracemark-web's `_components/previews-prompt.tsx` is therefore a sibling of
bracemark-expo's, not a port of it:

- **expo** offers `deviceExtractionMode: 'all'` — free, on-device, no new party — so
  the banner flips it in place: one tap puts the count it just quoted in reach of the
  foreground drain, rather than sending the user on a settings expedition. It is
  explicit about HOW that backlog gets worked, though, because the drain it arms is the
  **displayed-scoped** one: the links fill in as they come into view, capped by
  `AUTO_BUDGET` per session, and "Generate all" in Settings → Link previews is what does
  the library in one go. That is the same truth-in-advertising point the Plus bullet
  below makes; the difference is that nothing here is billed, so the banner can flip the
  setting AND say what follows, where web's has to hand the user to the toggle instead.
- **bracemark-web, Plus/Pro** offers `serverExtraction`, which admits `bracemark-extractor`
  to the URLs it fetches. The banner **does not flip it**: the button goes to
  Settings → Link previews. Two reasons, and either alone is sufficient. Consent —
  a list-chrome button is a thinner surface than the toggle that names the service
  (this is the doc's _second, explicit opt-in_, not a default nobody chose). And
  truth in advertising — enabling the opt-in alone starts only the
  displayed-scoped auto drain, so the quoted N would barely move; the thing that
  clears it is "Generate all", which is confirm-gated **because each link is a paid
  request**, and that confirm belongs next to the toggle, not in a banner.
- **bracemark-web, free** can't take that opt-in at all (`serverExtraction` is a Plus
  entitlement), and free/web-only is exactly the population with the most
  un-previewed links — so hiding the banner there would hide it where it matters
  most, while making it a bare paywall would turn an honesty affordance into an
  upsell. It offers the **browser extension** instead: free, local, and the best
  extractor there is (_capability tiers_) — the same nudge _the web-only gap_ already
  calls the right answer for this user. The copy is explicit that installing it
  previews links **as you save them** rather than back-filling these, since it's
  active-context only; Plus is named once, second, as what does the back-fill.

**What the two banners COUNT parted company as well, and `extractNow` is why.** On
bracemark-web nothing extracts until the opt-in flips, so the raw count is a fair proxy
for "links waiting": a pending link stays pending until the user acts. On expo it is
not — the gestured path fetches a link saved on this device at `saves`, outside the
gate, so that link is raw-pending for the length of its own fetch (15s page + 20s image)
and then settles itself. Counting it put the banner on screen for a few seconds after
every save on a single-device account and then took it away again: an offer flashing in
and out, quoting a link `all` was never needed for. So expo renders the **residual** —
raw pending minus what the gestured path holds right now (`gesturedInFlightCount` on the
extraction context: counted from the paths handed to `extractNow`, incremented before
its first await so the window between the row landing and the claim is covered too),
required to hold for a short settle window so the order the live read and the context
update land in can't matter. What survives that subtraction is exactly the set `saves`
will never touch — synced from another device, saved on the web app, imported — which is
what the banner is offering to cover. bracemark-web needs none of it and keeps the raw
count.

An upgrade doesn't re-arm the banner (one flag, both variants). That's deliberate:
by the time someone has upgraded they have been through Settings, which is where the
durable surface lives.

### imported links: the bulk path

Bulk import (a `bookmarks.html` export, Pocket/Raindrop/Pinboard, …) is the one
workload _save-time extraction can't own_, and the reason the queue path above
isn't optional. An interactive save is one link, at human pace, on the client
with the most context; an import is the inverse on every axis:

- **volume** — hundreds to thousands at once, not one-at-a-time;
- **no active context** — no live tab per link, so screenshot/page-copy are out and
  title+image is **bg-fetch tier at best** (raw HTML), never active-page;
- **the importer is usually the web app** — a dropped export file — which can't
  `fetch` at all.

So imported links flow through the **queue, not the save-time path**, and they
need **no new structure**: an imported link is a `links/{id}.enc` with **no
`extractions/` file**, which _is_ the pending signal — the normal loop picks it
up, and the `attempts`-driven backoff (retry once `now >= extractedAt +
backoff(attempts)`) already gives retry pacing for free. The one thing the queue
does _not_ give for free here is cross-device dedup: with no claim lease, two
devices draining the same thousands both fetch them (idempotent, so still
correct, just wasteful). If that ever bites, **deterministic sharding** by `id`
hash divides the work with zero coordination — deferred, because the device the
import landed on usually drains it alone (see _the extraction entity_). A title
carried in the export lands as sticky **`customTitle`**, not as a provisional
`extraction.title`: the file can't say whether the user renamed the link, a
rename overwritten is gone for good, and the title it carries came from a live
tab or the source's own extractor — rarely worse than the bg-fetch tier this
path is limited to (see _manual overrides_). Extraction still
runs for every imported link: it is where the image comes from, and the
extracted title it writes underneath is what clearing `customTitle` falls back
to. The exception is a source that keeps the two halves apart — Brace.to, whose
export carries `custom.title` (what the user typed) beside
`extractedResult.title` (what its extractor found), so the two route to
`customTitle` and `extraction.title` respectively (see
[data-lifecycle.md](./data-lifecycle.md), _importing from Brace.to_). That is the
one case an import writes an `extractions/` file up front — the pending signal
then is the **absent `titleImage` facet**, not an absent file (the queue query
already keys on the facet).

**Imports are where `bracemark-extractor` stops being avoidable.** For a one-off web
save it's a nicety; for a bulk import, client-only draining is genuinely weak. A
web-only user gets thousands of bare URLs forever — and the **extension can't help
here at all**: it has no background bg-fetch, and opening its popup on an
already-saved imported link does not start extraction (see _the extension is
active-context only_). That leaves Expo's foreground drain at `all` (plus any
future, opportunistic `expo:bg` drain) or `bracemark-extractor`. A bulk import is
also the natural **opt-in moment** ("enrich my
whole library?" — in `bracemark-web` this is the explicit _enrich all_ drain, see _the
web drains in-page_). So the honest framing: _interactive saves justify **avoiding**
`bracemark-extractor`; imports justify **building** it_ — different workloads, different
answers.

The real concerns for the bulk path are throughput, not latency (enrichment
back-fills; the library is usable immediately):

- **batch and pace.** `bracemark-extractor` takes `POST { urls }` (plural) and
  IP-rate-limits — send chunks and respect backoff, never thousands of
  singletons. Same for an Expo background drain: pace per-host so one site isn't
  hammered (and bot-protection isn't tripped).
- **watch sync-op volume.** Each completion writes **one** `extractions/` blob
  (result + bookkeeping together — the writer-split removed the second, `links/`
  backfill write), so a 5 000-link import is ~5 000 writes through sync — still a
  burst, but half what the old layout cost.
- **progress is free** — "enriching 4 231 of 5 000…" is a count of links whose
  `extractions/` has no `done` `titleImage` facet, the same query the loop runs.
- **quality is upgradable.** Imports land at `server`/`bg-fetch` tier; opening the
  real page in the extension later upgrades to active-page via the existing tier
  rule. "Import cheap now, improve on first real visit" needs no new mechanism.

### everything is async; nothing blocks the save

The save path is unchanged: writing `links/{id}.enc` makes the link exist
**immediately** (see [local-first-sync.md](./local-first-sync.md) — _push_). All
extraction is **fire-and-forget after that** — the user never waits on a fetch or
a render, on any client. Results arrive later and the UI updates reactively when
the patched `extractions/` blob lands in Dexie (`liveQuery`); the join against the
unchanged `links/` row re-resolves the displayed title/image. This holds regardless
of tier: an active-tab capture and a background catch-up are both post-save, off the
critical path.

### what each client syncs — the extension is a selective-sync client

An extraction worker does **not** need the user's whole library, and the sync
engine already lets it opt out cheaply: `ops/list` returns **metadata only**
(`{ op, path, updatedAt }`), and **downloading a blob is per-path and
client-driven** (see [local-first-sync.md](./local-first-sync.md) — _a sync
cycle_). So a client chooses which namespaces it materializes, with **no new
endpoint and no server change** — it just pulls the op-list and skips the GETs for
prefixes it doesn't care about. This is the selective-sync flip the entity section
flags, realized at the namespace granularity rather than the facet one.

For an extension whose job is extraction + save, the minimum working set is:

- **eagerly: `links/` + `extractions/`.** Both are needed — and `extractions/`
  **alone is not enough**:
  - a freshly-saved link has **no** `extractions/` file (its absence _is_ the
    pending signal), so new work is only discoverable from the `links/` namespace.
    Note the subtlety: **discovering** pending work needs only the link **paths** —
    the set difference (all link ids _minus_ those carrying a `done`/`permanent`
    `titleImage` token), both sides keyed off the op-list + the `*itemFacetStatuses`
    index, a primary-key prefix scan with no blob. So _detection_ alone would let
    `links/` ride at the **metadata-only** disposition (path + `updatedAt`, blob
    deferred — the same `data: undefined` mode `files/` uses). What forces the
    **full** link blob is the next two bullets, not detection. (Note: for the
    _extension_ the URL inside `links/{id}.enc` is **not** an extraction input — it's
    active-context only, so it extracts the focused tab's live DOM, never a synced
    URL. The URL-from-blob need is real only for the bg-fetch clients that drain
    queued URLs headlessly — **Expo background / `bracemark-extractor`** — not for the
    extension);
  - the extension popup's **"is this tab already saved?" dedup** (`readLinkByUrl`)
    is an `itemUrl` index hit, and `itemUrl` is **projected only from the decrypted
    link blob** — so the popup needs `links/` blobs resident, not just paths;
  - write-back of `title`/`imageId` is a **read-merge-write of the `extractions/`
    blob** that must round-trip its unknown fields (the `looseObject` rule), so the
    current extraction blob (if any) has to be in hand — but the link blob is never
    rewritten.
    For 10 000 links this is ~2.5 MB (`links/`) + the `extractions/` set (now holds
    the titles/refs too, no longer tiny, but still small) — trivial. So we keep
    `links/` at **full download**, not metadata-only: the two-line saving isn't worth
    losing popup dedup. (The engine
    _does_ have a latent third disposition — `skip` / metadata-only / full, today
    selected by `pathFilter` + the hardcoded `isContentPath` `files/` rule; promoting
    a namespace to metadata-only is the knob to reach for **only** when a heavy
    namespace is genuinely never read by that client, which `links/` isn't here.)
- **lazily / never: `files/`.** Heavy content is on-demand for **every** client
  already; the extension fetches a `files/` blob only to **upgrade** an existing
  screenshot/page-copy, never routinely.
- **pulled for the popup UI, not for extraction: `settings/` `lists/` `tags/`.**
  None are extraction inputs — they ride along because the popup renders more than a
  headless extractor. `settings/` feeds the ThemeProvider (`useSettings()` →
  `readSettingsGeneral()` resolves the synced theme / links layout). `lists/` and
  `tags/` feed the save **Editor**'s list/tag pickers (the shared `ListSelect` /
  `TagsField`, whose options come from the local store via `useLists()` →
  `readLists()` and `useTags()` → `readTags()`) — without them the editor shows only
  the system lists and zero existing tags. These are the "if the extension grows a
  browse/library UI it'll want these too" namespaces, now realized: a UI decision,
  not an extraction requirement. All three are small blob sets, so the cost is
  negligible.
- **skip entirely: `pins/`** — a browse-only ordering concern the popup never reads,
  and not an extraction input.

The cursor still advances across **all** ops (it's the global high-water mark);
selective sync only changes which blobs get downloaded, not how the cursor moves.

### server extraction: a separate `bracemark-extractor`, anonymous

The escape hatch from _the stance_ — letting a server fetch URLs when no capable
client is installed — is the **second, explicit opt-in**, never the default. It is
**necessary, not deferred**: once the extension went active-context only (no
background bg-fetch — see _the extension is active-context only_), `bracemark-extractor`
became the **only** bulk-enrichment path for `bracemark-web`/desktop users and the
realistic one for large imports, so it's a committed app to build, not a someday.
"Necessary to build" is **not** "on by default", though — server extraction stays
the second opt-in below. Its clients are the **web/desktop** ones: `bracemark-expo`
never calls it — that would be a strict downgrade from a client that fetches
natively (see _expo drains in the foreground_) — so everything here is about the
browser that can't fetch for itself. It is a **separate app**, not a route in
`bracemark-api`:

- **A new nx app, `bracemark-extractor` (`type:app`, `platform:worker`), on its own
  origin `extractor.bracemark.com`** — distinct from the blind sync broker on
  `api.bracemark.com`. The two have **opposite trust and egress postures**: the broker
  only ever touches D1/R2 and ideally reaches nothing outbound; the extractor must
  `fetch` arbitrary, user-supplied URLs. Separate apps let each hold only the
  bindings it needs, keep "`api.bracemark.com` never sees your library in plaintext" a clean,
  code-provable claim, and give server extraction an independent kill switch /
  opt-in / jurisdiction. Workers is a _good_ fit precisely because its sandbox
  can't reach your private network or cloud IMDS (`169.254.169.254`), which
  neutralizes the classic server-side-fetch SSRF.
- **Pure function, never a writer.** `bracemark-extractor` takes
  `POST { urls } → [{ url, ok, title?, image?, readMode?, error? }]` — a **per-URL
  result array** (partial success, never all-or-nothing, so each link's facet records
  its own `done` / `failed` / `permanent`) — **plaintext**, and returns it to
  the requesting client. The **client** (which holds the data key) does the E2E
  write-back into `links` / `files` / `extraction`. The extractor **holds no key,
  persists nothing, writes no blob** — so what it can leak is transient (a URL it
  saw mid-fetch), not stored. Results it produces carry `extractedBy: 'server'`
  (`tierOf` → server, the lowest quality, above nothing), so any active-page client can
  later **upgrade** them.
- **The preview image is streamed through, never stored.** The metadata response
  carries the og:image as a **URL string** (`{ title, image: url, readMode }`), not
  bytes. That string is enough for an extension/mobile client (it fetches the image
  itself, no CORS), but **not** for the web app — the same wall that sends it to
  `bracemark-extractor` for the HTML also stops JS reading cross-origin image bytes
  (an `<img>` would _render_ the URL but tainted-canvas / opaque-response block
  reading it into an encryptable blob — and rendering the remote URL _is_ the
  per-paint leak _the preview image is a downloaded blob_ forbids). So
  `bracemark-extractor` doubles as a **stateless image proxy**: a single interactive
  save **inlines** the image bytes in the extraction response (one round trip); a
  bulk import gets URLs only and the client pulls each image from `GET /image?url=…`,
  which **streams the remote bytes through and buffers/persists nothing**. The
  client encrypts the streamed bytes into `files/{id}.enc` itself. We deliberately
  **don't** have the extractor store the image in R2 and return a signed URL: for a
  one-shot, single-reader download that adds a plaintext-at-rest object, a
  lifecycle/cleanup burden, and _more_ hops
  (fetch→store→GET→re-encrypt→re-upload) — strictly worse than streaming it through
  once (R2's free-egress / CDN benefit needs repeated reads, which this isn't). The
  image fetch is an arbitrary-URL fetch like the HTML, so it carries the **same SSRF
  guard + size/time/`content-type: image/*` caps**. The extractor **never resizes or
  transcodes** — that would force a full-image decode (real CPU + the 128 MB isolate,
  risking OOM) and kill the streaming-is-free property that makes the proxy cheap; any
  thumbnailing is a deferred **client** step done before encrypt, which is also where
  it belongs to bound the storage quota (a capped-dimension re-encode, not the
  full-res original).
- **Anonymous, not session-bound.** Requiring a logged-in session id would
  convert the leak from "the server saw this URL" into "the server can tie this
  URL to _this account_" — a **strictly worse** leak than the one this whole doc
  is built to avoid. So v1 is **anonymous**: IP-based rate limiting (already in
  place) plus an SSRF guard and strict size/time caps; the extractor never learns
  _who_ is asking. The abuse-control upgrade that **preserves** anonymity is blind
  capability tokens (Privacy Pass / VOPRF): `api.bracemark.com` issues unlinkable
  tokens to real logged-in users, `extractor.bracemark.com` verifies validity without
  learning which user — deferred, documented as the direction.
- **Abuse caps are load-bearing, not a v2 nicety.** An anonymous endpoint that
  fetches any URL and streams bytes is an **open proxy / DDoS reflector / bandwidth
  amplifier** by default, and the binary image proxy widens that surface past the
  HTML path. So the caps are part of v1, not hardening-later: a hard **per-response
  byte ceiling** (abort the stream once exceeded — never relay a 4 GB file), a
  **timeout**, a **`content-type` allowlist** (`text/html` for extraction, `image/*`
  for the proxy), and a **per-IP egress budget**. IP rate-limiting alone is weak
  (botnets, shared NAT) — which is the real argument for prioritizing the Privacy
  Pass token path above, not deferring it forever. And the SSRF guard's teeth are
  **redirect handling**, not just the sandbox: a public URL can `30x` →
  `127.0.0.1` / `169.254.169.254`, and decimal/hex-encoded IPs or non-`http(s)`
  schemes slip naive checks — so fetch with `redirect: 'manual'` and re-validate
  **every hop**, on both the HTML fetch and the image proxy.
- **Never log the URL.** The extractor's whole reason to exist is that the URL it
  sees stays transient — so observability must be **aggregate-only** (counts,
  latency, error rates), never the URL itself. This is a config footgun, not a code
  one: the proxy's `?url=` lands in query strings, so default Cloudflare request
  logs / Logpush would **persist** exactly the URLs the design promises not to
  retain. Strip them at the edge; if you can't, don't log the request line.
  **Configured:** `wrangler.jsonc` sets `observability.logs.invocation_logs: false`,
  which drops the automatic request-line log and keeps the deliberate ones (the
  error handler and `extractOne` are already written never to log the URL). The
  zone's Logpush setting is the other half and lives outside this repo.
  ⚠ **This setting is now published.** /privacy's _Technical and security data_
  section cites it — that the one service handed a page address runs with the log
  that would record its request line switched off — as the answer to "how long do
  you keep request logs", in place of a retention period we do not control and
  could not keep true. So flipping `invocation_logs` back on, here or on
  `bracemark-api`, falsifies a live sentence in the privacy policy, and nothing
  connects the two: no lint rule, no type error, and no test in either runner
  reads a `wrangler.jsonc` against a page. The claim on that page is scoped to
  **our settings** on purpose and must stay that way — the zone-level channel
  above is exactly what a widened "we do no request logging" would be wrong
  about.
- **It identifies itself, and the address it gives has to answer.** Every fetch
  carries `bracemark-extractor/1.0 (+https://bracemark.com/extractor)` — honest,
  never a spoofed browser (`lib/safe-fetch.ts`), because a service that fetches
  strangers' sites anonymously and won't say who it is has picked the wrong side
  of its own argument. The consequence is that the UA **publishes a URL into the
  access log of every site this opt-in service fetches**, so `/extractor` is a
  route the marketing site owes them: what it is, why it came, the caps, and how
  to block it (`apps/bracemark-site/src/app/extractor/page.tsx`). Two things that
  page pins, neither of which anything can check for you:
  - **Its numbers are these constants.** The timeout, redirect cap, HTML ceiling,
    image ceiling and batch cap are printed as prose on a public page, and
    `bracemark-site` does not depend on `bracemark-extractor` — so moving
    `FETCH_TIMEOUT_MS`, `MAX_REDIRECTS`, `MAX_HTML_BYTES`, `MAX_IMAGE_BYTES` or
    `MAX_EXTRACT_URLS` silently turns a published commitment into a false one,
    with no failing test. Move the page in the same change.
  - **Its blocking advice is `verdictForStatus`.** The page tells an operator to
    answer `403` because that is what the retry ladder settles as `permanent`;
    `429`/`5xx` stay transient forever by design (`extract/retry.ts`). Change that
    mapping and the advice quietly stops working for the people who took it.
  - **The backlog is disclosed too, and that disclosure depends on the CLIENT.**
    _It is a fetcher, not a crawler_ used to open "there is no queue, no schedule
    and no index behind it" — true of the service, and read by the audience it was
    written for as a claim about volume, which it cannot carry: a drained import
    sends one site as many requests as that person saved pages of it, together. The
    page now says whose queue it is and what bounds a burst (`BATCH` =
    `MAX_EXTRACT_URLS` per request, one request in flight per drain —
    web-react `contexts/extraction-provider.tsx`), which pins it to the web drain's
    SHAPE and not just to a constant: give the drain concurrent batches, or let a
    second surface call the extractor on its own, and the page describes a politeness
    the code no longer keeps. Nothing checks it — `bracemark-site` can't see either
    file.
  - **robots.txt is disclosed, not obeyed.** The extractor does not fetch it —
    these are one-shot fetches a person asked for, the same posture as a chat
    app's link unfurl — and the page says so in those words rather than implying
    compliance. If it ever does read robots.txt, that section becomes a promise
    and has to be rewritten; until then it must not read as one.
    Network-abuse reports land at `abuse@bracemark.com` (`ABUSE_EMAIL`,
    `apps/bracemark-site/src/lib/site.ts`), an address that exists for this service
    specifically — nothing else in the product generates a reason to write to it.

The **app is committed** (a necessary build, see above) and so are the invariants
(separate app, separate origin, anonymous, plaintext-return-only, stream-don't-store,
never-log-the-URL, honest-UA-with-a-page-behind-it); what stays
**off by default** is the _feature_ — server extraction never runs until the user
takes the second, explicit opt-in.

### the web-only gap (a conscious stance)

A user on **`bracemark-web` only** — no browser extension, no phone — **and opted out of
server extraction** gets **no enrichment**: a saved link stays a bare URL with
whatever title they typed. Opted _in_, the web app orchestrates
`bracemark-extractor` for pending links as they appear on screen, including a
newly saved row, and **Generate all** covers the rest (see _who extracts and what
wakes it_); there is no gap. Opted out, the gap is the direct, intended consequence of
"clients do the work, the server stays blind." It is **not** a bug to paper over:

- it keeps the default maximally private (nothing fetches your URLs until you
  install a client that does it locally);
- it's a gentle nudge toward the extension, which is the best extractor anyway
  (active-tab DOM + screenshot) — and on a free account that nudge is the links
  page's own banner, which offers the extension rather than the opt-in this user
  can't take (_the links-page offer_);
- the link-editor popover's promise that "the title is back-filled later" simply
  doesn't apply to this user — they only ever have the title they entered.

For this user the escape hatch is the **server extraction** path — a separate
`bracemark-extractor` app on its own origin (see _server extraction_) — a separate,
explicit opt-in, never the default. The app itself is a committed build (it's how
web/desktop users get any enrichment at all now that the extension is
active-context only); the _gap_ is simply what remains for the user who declines
that opt-in.

### deferred / open

- **Read-mode quality on JS-rendered pages.** Raw-HTML extraction (background
  fetch, or a Worker if ever enabled) is good on server-rendered articles, poor
  on SPAs. Active-tab/WebView extraction (live DOM) is the high-quality path;
  background is best-effort. No fix beyond the tier model — just don't promise
  read-mode parity across tiers.
- **Non-HTML & JS-rendered targets (`bracemark-extractor`).** Saved URLs aren't all
  server-rendered HTML: PDFs, a direct image (which _is_ the preview), and
  oEmbed-only sites (YouTube/Twitter) each need their own handling, and a JS-shell
  SPA may carry no server-side og tags at all (the extractor runs no JS — `server`
  tier is raw-HTML only). v1 should **detect `content-type` and degrade gracefully**
  (fall back to `title = host`) rather than return garbage; richer per-type handling
  (PDF title, oEmbed, eventual Browser-Rendering JS execution) is the open scope
  call.
- **Does server-side read-mode honour `robots.txt`?** Open, and it wants settling
  BEFORE read-mode ships on this tier rather than after: it is a fetch-path change
  (a second request per host, plus somewhere to cache the verdict — the extractor
  is stateless and has no KV, so that means the Workers `caches` API or nothing),
  and it is cheaper designed in than bolted on. Today the extractor does not read
  the file, and `/extractor` **discloses** that rather than claiming compliance
  (`apps/bracemark-site/src/app/extractor/page.tsx`). The disclosure's argument is
  written to the axis that read-mode does not move — one person chose one address,
  one request went out, the result went only to them — so read-mode needs it
  re-checked, not rewritten. What read-mode does change is the OBJECTION: a title
  is promotional and a publisher usually wants it in the unfurl, while the article
  body is the thing they sell, so the population with a reason to complain is
  different from the population `robots.txt` was aimed at. Three ways to land it:
  read the file and honour it for every facet (simplest to explain; blanket
  `User-agent: *` rules aimed at crawlers would start costing users titles on sites
  that never meant to block an unfurl); honour it for `readMode` only and still
  return `titleImage` (defensible, and the split matches the objection); or honour
  only a rule that names **this** UA — treating a deliberate `bracemark-extractor`
  block as authoritative while ignoring blanket ones — which is the current
  disclosure's own distinction made mechanical, and the only option that turns that
  section of the page from a disclosure into a claim. Whichever wins, the page
  changes in the same release.
- **Re-extract / upgrade UX.** The derived tier (`tierOf(extractedBy)`) _enables_
  upgrading a low-tier result, but the trigger (automatic on a higher-tier sighting vs. a manual
  "re-extract" button) is an open product call.
- **Page copy on background tier.** Capturing a full page copy without an open
  page is the weak spot (offscreen/hidden-tab rendering is heavy and flaky). For
  now the page copy is active-context-only; a headless background capturer is
  deferred.
- **expo beyond `titleImage`/foreground.** Two separate follow-ons to the
  foreground drain (_expo drains in the foreground_), neither blocking it: the
  **`expo:bg` sweep** (`BGAppRefreshTask` / WorkManager — best-effort, metadata
  only, and the one place per-host pacing really matters), and the app's
  **active-page facets** — read-mode, screenshot, and page copy off a controllable
  WebView, which is what makes `expo:fg` a true peer of the extension's active tab
  rather than just a better-placed bg-fetch.
- **Manual capture.** A user-facing "fetch metadata / capture now" action for
  links that auto-extraction missed (a `failed` link, or a web-only user who
  installs the extension later) — the loop already supports re-running; this just
  exposes a trigger.
- **Favicon accuracy — a two-step ladder, in order.** Step 2 (after the shipped
  `/favicon.ico` guess): **`faviconUrl` in the extract contract.** The
  extractor's HTMLRewriter already scans `link` tags; returning the page's
  declared `rel="icon"` URL from `POST /v1/extract` lets the web app fetch the
  real icon through the image proxy in the same breath as the metadata —
  accuracy up over the guess, zero extra disclosure (that request already
  carried the full URL). It lands in the same device-local per-host cache (see
  _favicons_); nothing else changes, and it covers every path where the web app
  calls `/v1/extract` (web saves, _enrich all_). Step 3, **only if** monograms
  on synced-from-elsewhere links prove visibly common after step 2: a dedicated
  **`GET /v1/favicon?host=`** endpoint whose cascade is `/favicon.ico` → fetch
  `https://host/` and scan `link[rel~="icon"]` — the residual it serves is
  hosts that arrive via sync (no extract call on this device) _and_ don't serve
  `/favicon.ico`, a small slice whose failure mode is a monogram, which is why
  it's sequenced last. Two rejections that hold even server-side: **never
  Google's favicon service** (forwarding hosts to a third party adds a new
  party to the privacy story — the _no third-party extraction service_
  rejection applies at the server hop too, even though linkability is weaker
  there — to cover a residual the HTML-scan cascade covers anyway), and **no
  edge-caching of favicon responses by host** (tempting, since favicons are
  public and shared across users, but it trades away _persists nothing_ — the
  extractor would start retaining which hosts its users save; don't spend that
  invariant on icons).
