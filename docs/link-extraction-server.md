## link extraction — the server path, `bracemark-extractor`

The opt-in server that fetches pages for the clients that can't: what it is, the
invariants it is built on (separate app, separate origin, anonymous,
plaintext-return-only, stream-don't-store, never-log-the-URL, an honest user
agent with a page behind it), and the public page those invariants are printed
on. Split out of [link-extraction.md](./link-extraction.md), which says **when** a
client calls it (the web drain, _Generate all_, imports) and why the default
never does; this file is what happens on the other end of that call.
[link-extraction-keep.md](./link-extraction-keep.md) has the read-mode facet this
path is next to serve, [api-contracts.md](./api-contracts.md) the contract-first
endpoint shape and the no-cache rule, and [hosting.md](./hosting.md) its origin.

### the service

The escape hatch from [link-extraction.md](./link-extraction.md), _the stance_ —
letting a server fetch URLs when no capable
client is installed — is the **second, explicit opt-in**, never the default. It is
**necessary, not deferred**: once the extension went active-context only (no
background bg-fetch — see [link-extraction.md](./link-extraction.md), _the extension
is active-context only_), `bracemark-extractor`
became the **only** bulk-enrichment path for `bracemark-web`/desktop users and the
realistic one for large imports, so it's a committed app to build, not a someday.
"Necessary to build" is **not** "on by default", though — server extraction stays
the second opt-in below. Its clients are the **web/desktop** ones: `bracemark-expo`
never calls it — that would be a strict downgrade from a client that fetches
natively (see [link-extraction.md](./link-extraction.md), _expo drains in the
foreground_) — so everything here is about the
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
  per-paint leak [link-extraction.md](./link-extraction.md), _the preview image is a
  downloaded blob_ forbids). So
  `bracemark-extractor` doubles as a **stateless image proxy**: a single interactive
  save **inlines** the image bytes in the extraction response (one round trip); a
  bulk import gets URLs only and the client pulls each image from
  `POST /v1/fetch-image`, which **streams the remote bytes through and
  buffers/persists nothing**. The
  client encrypts the streamed bytes into `files/{id}.enc` itself. ⚠ "Persists
  nothing" has to hold on the **receiving** side too, and for a while it did not:
  the proxy answered `Cache-Control: public, max-age=86400, immutable`, on the
  argument that the browser's cache would serve a re-view. No client re-views —
  each reads the bytes once and stores them itself — so what that header bought
  was a second, readable copy in the browser's HTTP cache, keyed by a URL that
  named the image or the saved site's `favicon.ico` (the proxy was a GET then,
  the address in its query string), and outliving a sign-out
  (measured in Chrome: one cache entry per proxied image). Every response of this
  Worker is `no-store` now, by one middleware in its `app.ts`, as bracemark-api's
  is ([api-contracts.md](./api-contracts.md), _no response is cacheable_). The
  cost is the dedupe the cache did by accident: two links sharing one preview
  image are two proxy fetches. We deliberately
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
  latency, error rates), never the URL itself. It was a config footgun rather
  than a code one for as long as the proxy was `GET /v1/image?url=…`: the address
  landed in the request line, so default Cloudflare request logs / Logpush would
  have **persisted** exactly the URLs the design promises not to retain.
  **In the code now:** the proxy is `POST /v1/fetch-image { url }`, so — like
  `/v1/extract` — it takes the address in the body, and no request line this
  Worker receives names a page
  ([api-contracts.md](./api-contracts.md#a-gets-query-string-reaches-the-request-log);
  `routes/image.spec.ts` pins that no GET answers). **Configured, still:**
  `wrangler.jsonc` sets `observability.logs.invocation_logs: false`,
  which drops the automatic request-line log and keeps the deliberate ones (the
  error handler and `extractOne` both log an error's **name** and nothing else —
  the whole error would be one runtime message quoting its input away from
  storing the URL; `lib/errors.spec.ts` pins the handler). The
  zone's Logpush setting is the other half and lives outside this repo.
  ⚠ **This setting is now published.** /privacy's _Technical and security data_
  section cites it — that the one service handed a page address runs with the log
  that would record its request line switched off — as the answer to "how long do
  you keep request logs", in place of a retention period we do not control and
  could not keep true. So flipping `invocation_logs` back on here falsifies a
  live sentence in the privacy policy whatever the request line holds, and
  nothing connects the two: no lint rule, no type error, and no test in either
  runner reads a `wrangler.jsonc` against a page. (The sentence used to end
  "because that line is where the address would appear"; the clause went when
  the proxy became a POST, and the page claims nothing about the body.)
  (`bracemark-api` is the other way round and equally published:
  its invocation log is **on**, and the same section of /privacy says so and
  says no address it logs contains a username —
  [api-contracts.md](./api-contracts.md#a-gets-query-string-reaches-the-request-log).
  What would falsify the page on _either_ Worker is `logpush`, or tracing: both
  `wrangler.jsonc` files pin `observability.traces.enabled` to `false`, because
  a trace is a second stored record with a span per outbound fetch, and here
  that fetch is the saved address.) The claim on that page is scoped to
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

### deferred / open

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
