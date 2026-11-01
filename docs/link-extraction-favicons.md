## link extraction — favicons

The site icon a row draws beside its host: where it comes from on each client,
why it is a **device-local, per-host cache** rather than an extraction facet, and
the sources rejected for it. Split out of [link-extraction.md](./link-extraction.md),
which holds everything the per-link facets share — the stance this cache rides
on, the opt-ins it reuses, and the preview image it is deliberately not like.
Its siblings: [link-extraction-server.md](./link-extraction-server.md) for the
extractor's image proxy that web's guess goes through, and
[data-lifecycle.md](./data-lifecycle.md) for the sign-out wipe the cache has to
survive being filled across.

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
  That wipe needed two more things to actually hold, because the cache is
  filled asynchronously by work that can outlive the account: both store writes
  are **fenced on the account** (the table has no owner column to notice with),
  and the provider's **drain ends when it unmounts** — it used to run on through
  its queue after a sign-out, requesting the signed-out account's hosts and
  writing them back. A third, for the account switch that does **not** unmount
  the provider (on web, another tab signs in as someone else and this one
  adopts the session in place): each queued host carries **the account signed
  in when it was admitted**, stamped as it joins the queue. The queue's reset on a new username is
  an effect, so it runs after the render that already changed the account, and
  an owner read as a host _left_ the queue was the new account's — which the
  store's fence accepts. A leftover entry is now dropped unfetched, and a fetch
  already out is written under the name the fence refuses. The unmount half
  holds on every client, though a browser tab never showed it:
  sign-out there leaves the origin and the document goes with the queue, where
  the installed app and expo both stay
  ([data-lifecycle.md](./data-lifecycle.md), _what an empty table does not
  mean_ and _what the wipe cannot reach — web_).
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
| **bracemark-web**       | `/favicon.ico` guess, bytes through the extractor's `POST /v1/fetch-image` proxy                                           | the `serverExtraction` opt-in                                                 |
| **bracemark-expo**      | direct native fetch (no CORS); the real `<link rel="icon">` when it extracts the page anyway                               | `deviceExtractionMode` (`all` to guess; `saves` captures declared icons only) |
| **bracemark-extension** | **never fetches** — `tab.favIconUrl` in the popup; Chrome's `_favicon` API if a browse UI ever exists; monogram on Firefox | none needed — zero network                                                    |

The gates are the same trust decisions the user already made, so "off by
default" falls out for free — a fresh install fetches no favicons anywhere, per
[link-extraction.md](./link-extraction.md), _the stance_. Per-client notes:

- **web** — the extractor already sees this user's **full URLs** under the same
  opt-in, so per-host favicon requests add nothing to what that party learns.
  The accepted residual vs. the og:image model: og:image pays its disclosure
  **once**, at the extracting client, and every other device reads ciphertext;
  the favicon cache pays **per device** (each device re-asks the extractor per
  host). Host-only, behind the same opt-in — fixing it means the synced
  namespace above, which a cosmetic payoff doesn't justify.
- **expo** — the gate is `deviceExtractionMode` (see
  [link-extraction.md](./link-extraction.md), _expo drains in the foreground_), and
  it's load-bearing, not ceremony: for a link saved on
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
  end, which is why bracemark-expo's link media is **expo-image** (expo-dependencies.md —
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
[link-extraction.md](./link-extraction.md),
[link-extraction.md](./link-extraction.md), _who extracts and what wakes it_) for a
host's icon, and the extension answers with bytes from
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
per-paint leak [link-extraction.md](./link-extraction.md), _the preview image is a
downloaded blob_ forbids:

- **A third-party favicon service** (Google's `s2/favicons`, DuckDuckGo icons).
  Leaks the host set to a **new party** — the
  [link-extraction.md](./link-extraction.md), _no third-party extraction service_
  rejection from [link-extraction.md](./link-extraction.md), _the stance_, replayed
  at host granularity. Worse, it
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
`/favicon.ico` — is deferred; see _deferred_ below.

### deferred

- **Favicon accuracy — a two-step ladder, in order.** Step 2 (after the shipped
  `/favicon.ico` guess): **`faviconUrl` in the extract contract.** The
  extractor's HTMLRewriter already scans `link` tags; returning the page's
  declared `rel="icon"` URL from `POST /v1/extract` lets the web app fetch the
  real icon through the image proxy in the same breath as the metadata —
  accuracy up over the guess, zero extra disclosure (that request already
  carried the full URL). It lands in the same device-local per-host cache
  (above); nothing else changes, and it covers every path where the web app
  calls `/v1/extract` (web saves, _enrich all_). Step 3, **only if** monograms
  on synced-from-elsewhere links prove visibly common after step 2: a dedicated
  **`POST /v1/fetch-favicon { host }`** endpoint (a POST: the host is a saved
  site's, so it stays out of the URL) whose cascade is `/favicon.ico` → fetch
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
