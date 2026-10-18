## offline mode

Whether a user can still **reach** their library when the network is down, or
when the server is gone for good. [sessions.md](./sessions.md) makes sure
nothing on a device **wipes** the library by itself. This doc makes sure the
library can still be **opened**: bracemark-web's service worker (when it
registers, what it caches, how it updates), how tabs on different versions stay
safe over one shared local database, and how the same question plays out in
the Expo app and the browser extension.

Neighbours: [sessions.md](./sessions.md) (the no-wipe rule this doc's promise
depends on), [local-first-sync.md](./local-first-sync.md) (what the device holds,
and _schema changes_, which this doc's version-skew rule feeds into),
[hosting.md](./hosting.md) (the CSP the worker registers under, the
never-expire-`_next/` rule that old tabs rely on, and the deploy script's worker
check), [e2e.md](./e2e.md), _the PWA
target_ (`PWA-001`–`013`, the only run that meets the worker),
[data-lifecycle.md](./data-lifecycle.md) (the sign-out teardown),
[brand-assets.md](./brand-assets.md) (the claim this doc makes true or false).

> **STATUS — built, except the Safari measurement.** The worker
> (`apps/bracemark-web/src/sw.ts`, built by `serwist build` after `next build`)
> sends every cross-origin request to the network only, answers a page load
> from the network for three seconds and from its precache after that, takes
> over at once (`skipWaiting: true`) behind an "updated, reload" pill that shows
> only for a page older than the worker, and ignores query strings on precache
> lookups. It registers once a user is signed in, in any
> display mode. Both local databases let go on `versionchange` and raise an
> update-required banner. Sign-out keeps the worker, and as a safeguard drops any
> query-keyed runtime cache entry (none is written today). The app asks for persistent storage after sign-in. The session redesign
> ([sessions.md](./sessions.md)) has landed too, so nothing on the device wipes it
> on a clock. `PWA-001`–`013` and `VERSION-SKEW-WEB-001`/`002` cover it
> ([testing](#testing)), and every deploy checks that its worker can install
> ([`/sw.js` is permanent](#-swjs-is-permanent--three-ways-to-strand-a-device)).
> **Still open:** whether Safari's 7-day storage cap
> spares a site granted persistent storage, measured by hand on real Safari
> ([storage durability](#storage-durability--verify-before-promising)); until
> then the public claim's edge runs through that browser. And the **kill-switch
> worker** is not built — the last resort for a worker no deploy can replace
> (same section).

### the promise

The marketing site's landing page, in its _If we disappear_ band, says: "The
library does not need us to be reachable in order to open." Two things have to
hold for that sentence to be true:

1. **Nothing wipes the library.** That is [sessions.md](./sessions.md)'s rule:
   no clock, and only an explicit `session_revoked` verdict for the current
   session generation may trigger a session-driven wipe. Expired and unknown
   tokens preserve data.
2. **Something can still open it.** That is this doc.

Reachability with the origin gone, per platform. **Every row assumes that the
local library, keys and required app files remain on the device** — browser
eviction, user-cleared data and content never downloaded are the boundaries
(_storage durability_ below).

| platform                          | with the origin gone                                                                    |
| --------------------------------- | --------------------------------------------------------------------------------------- |
| Expo app (iOS, Android)           | opens with retained local data and keys; code ships in the binary                       |
| browser extension                 | opens, but has no export (a stated boundary, see below)                                 |
| bracemark-web, installed PWA      | opens once the worker has installed (`PWA-001`–`003`)                                   |
| bracemark-web, a tab already open | opens any route once the worker has installed, uncached routes included (`PWA-004`)     |
| bracemark-web, fresh tab          | opens once the worker has installed — registered at sign-in in a normal tab (`PWA-004`) |
| bracemark-web, never signed in    | fails, and holds no library to lose                                                     |

A browser that never signed in has no local library. Signing in alone does not
prove offline readiness: the local library must have been created or synced and
the worker installation must have completed. Content never downloaded cannot be
recovered from a dead server.

### ⚠ the worker caches the app, never data

**The worker may cache same-origin app code and pages. It must never cache a
cross-origin response.** The data path already has a durable, per-account,
wiped-on-sign-out home: IndexedDB. A second copy in Cache Storage has none of
those three properties.

`@serwist/next`'s `defaultCache` ends with a catch-all for **cross-origin
GETs**: `NetworkFirst`, cache `cross-origin`, 32 entries, one hour
(`node_modules/@serwist/next/dist/index.worker.mjs`, the `!sameOrigin`
matcher). The earlier asset rules don't take these first — a regex route
handles a cross-origin URL only when the pattern matches from the URL's first
character, so `/\.(?:jpg|png|…)$/i` never matches `https://api.bracemark.com/…`;
only the two Google Fonts rules are anchored to a host. Left in place, that one
rule would cache:

- the api's authenticated reads: `GET /v1/ops/list`, `GET /v1/files/list`,
  `GET /v1/iap/status`;
- the door blobs, while they were GETs (`/v1/auth/password-door`,
  `/v1/auth/recovery-door` — POSTs since, which this rule never matched;
  [api-contracts.md](./api-contracts.md#a-gets-query-string-reaches-the-request-log));
- bracemark-extractor's image proxy, while it was `GET /v1/image?url=…`, whose
  URL **named a third-party image from a page the user saved** (a POST since,
  for the same reason and with the same effect here);
- presigned R2 downloads.

Cache Storage keys on the URL, not on the `Authorization` header, so sign-out
would leave the previous account's `iap/status` — and, while the proxy was a
GET, a list of image URLs from its saved pages — on the device, served to the
next account when the network is
slow or down; and `NetworkFirst` with a 10-second timeout answers from the cache
when the network fails, turning a request that should fail into a stale
success the sync engine and the entitlement fold aren't built for.

**As built:** one `NetworkOnly` route for cross-origin requests, placed **ahead
of `defaultCache`** in `sw.ts`'s `runtimeCaching`. Filtering the `!sameOrigin`
entry out of `defaultCache` would also work today, but that means picking an
upstream list apart by its internals, and it stops holding the day a Serwist
upgrade adds another host-anchored rule. A route ahead of the list doesn't
depend on what the list contains. No rule caches a non-GET request. `PWA-005`
inspects every cache the origin owns after a full online session and finds no
cross-origin key.

**A change that strands account data in an old cache ships its own cleanup.**
Before the first release there were no production installs, so a worker change
only needed a reset development profile. Real installs exist now, and a later
change that leaves account data in old caches must include a cleanup path. A
fresh or reset profile is still the right way to _verify_ the change itself:
unregister the old worker and clear its Cache Storage first.

### when the worker registers — after sign-in, in any display mode

**The worker registers once the auth provider reaches `authenticated`**: after
sign-in, after create-account, or on a load that finds a stored session
(`Initializer`, `apps/bracemark-web/src/app/inner-layout.tsx`). A load that
finds an existing registration re-registers too, signed in or not — the same
script at the same scope, so nothing about the registration changes. **That call
is not what checks for updates**: the browser does that by itself
([below](#when-the-browser-checks-for-a-new-build)), which is why an update
never depends on this code running. The display mode
doesn't matter; it used to be standalone-only, for three reasons that still
hold for an anonymous visitor and don't for a signed-in user:

- **"A visitor who never returns shouldn't download the whole precache."**
  They still won't: a visitor who never signs in never registers. A user who
  signs in has a library worth keeping reachable. The precache is **189
  entries, 1.97 MB gzipped** (measured on a local production build, September
  2026): 1.63 MB of it JS chunks, the rest route HTML, the route RSC payloads
  (below) and icons. The manifest screenshots (`ss-*.png`) and the
  `opengraph-image`/`twitter-image` cards — 1.9 MB the app never shows offline —
  are excluded (`globIgnores` in `serwist.config.mjs`). Later deploys only fetch
  entries whose revision changed.
- **"The worker's update rules shouldn't strand a tab on an old build."** The
  update policy below handles it.
- **"Lean on Next.js before adding machinery."** Next has no way to load a page
  offline from a cold start. Something has to answer the navigation, and
  Serwist is already a dependency.

**The precache carries the RSC payloads, not just the HTML.** A cold launch
needs the route's HTML; an in-app hop needs the route's RSC payload (the
`.txt` files the static export writes beside each page, and Next's per-segment
`__next.*.txt` files), fetched with an `?_rsc=` query. Serwist's default globs
take `.next/static/` and `public/` only, so an offline tab could open `/links`
cold and then go nowhere on a click to a section it had never visited online —
`PWA-004` caught exactly that. `serwist.config.mjs` restates the defaults and
adds `out/**/*.txt` (118 files, ~40 KB gzipped together), with a manifest
transform mapping their `out/…` paths to the URLs they're served at.

**The offline guarantee starts when the install finishes, not when the user
signs in.** Sign-in needs the network, so the first session is always online,
and the precache downloads in the background during it. A user who signs in and
closes the tab within seconds may not have a full precache yet; a later online
visit retries installation.

#### navigations with a query string — verified

Serwist's precache lookup tries the exact URL first, then the URL minus the
query parameters `ignoreURLParametersMatching` names — by default only `utm_*`
and `fbclid`. So a cold offline load of a restored tab or a bookmark at
`/links?list=<id>`, a URL never visited with that exact query online, missed
both the precache and the runtime page cache. Every route in the static export
is one file whatever its query, so `sw.ts` sets
`precacheOptions.ignoreURLParametersMatching: [/.*/]`. That also resolves the
RSC payloads' `?_rsc=` queries to their precached files. `PWA-006` loads a
never-visited query URL cold and offline.

### update policy — immediate takeover, with a pill

The worker takes over at once: **`skipWaiting: true`**, with `clientsClaim:
true`. The alternative, a worker that waits until every tab closes, activates
only once no page uses the old one — and **a reload doesn't count**, because the
reloading page is still a client of the old worker while its navigation is in
flight. People with the PWA installed rarely close every window, so they would
run an old build indefinitely.

Immediate takeover has a real cost, documented in
[Chrome's worker lifecycle guidance](https://developer.chrome.com/docs/workbox/service-worker-lifecycle):
open tabs keep running old code under the new worker. Two things carry it:

**The "updated, reload" pill** (`apps/bracemark-web/src/components/update-pill.tsx`).
A tab that was open when the new worker took over shows a quiet pill. It
appears on `controllerchange` — completed activation, never "a deploy exists" —
and only when two things hold: the page was already controlled when it loaded,
because the first installation fires `controllerchange` too (clientsClaim); and
the new worker holds a **different build** from the one the page loaded as
([which build is this page](#which-build-is-this-page--one-stamp-two-places)),
because a worker catching up with a page the network already handed the new
build is not an update of that page. Its Reload waits for
local writes already started to commit (`flushLocalWrites`, a read-only Dexie
transaction that queues behind every earlier write) and never discards an
editor's unsaved work silently: the three web editors report their dirty flag
(`useUnsavedDraft` — the edit dialog, quick-add, bulk tags), and with one open
the user either keeps editing or explicitly chooses "Discard and reload". A
routine update never reloads a tab by itself. `PWA-007` deploys a new worker
under two open tabs: both show the pill, the one left alone keeps working, and
Reload lands the other on the new worker.

**Chunk-load recovery** (`apps/bracemark-web/src/lib/chunk-error.ts`). An old
tab can ask the new worker for a chunk its own build names; online, hosting
keeps every `_next/` file forever so it loads, but offline the new worker's
activation removed the old precache entries. That failure — webpack's
`ChunkLoadError` or a browser's dynamic-import error — is recognized and routed
to the same pill, or, when it takes the render down, to the error boundary
(`app/error.tsx`), which offers Reload instead of "Try again": the new build is
the fix, and it is in the precache. This is the "explicit recovery to the new
build" option rather than retaining old assets for live clients; nothing
depends on how many deploys a tab has survived.

The same reload serves a schema change only through the update-required banner
below, because an old tab can no longer save to the upgraded database at all.

#### what answers a navigation — the network for three seconds, then the precache

**A page load gets the latest deploy whenever the origin answers, whatever
worker is installed — and the page the device holds when it does not.** Page
loads are not answered by Serwist's routes. `sw.ts` registers its own `fetch`
listener ahead of `serwist.addEventListeners()` for every same-origin
navigation, and stops the event there
(`apps/bracemark-web/src/lib/navigation-response.ts` holds the decision):

| the origin                                 | a page load gets                              |
| ------------------------------------------ | --------------------------------------------- |
| answers within 3 seconds, below 500        | that answer — the latest deploy, a 404, a 30x |
| answers 5xx                                | the installed worker's precached page         |
| fails (offline, refused)                   | the same, at once                             |
| accepts the connection and never answers   | the same, after 3 seconds                     |
| any of the last three, for an unknown path | whatever the network eventually says          |

Everything that is not a page load — route payloads, icons, chunks named in the
manifest — is answered from the installed worker's precache, as before.

**Why the network first.** It is what lets a deploy replace a page without the
installed worker having to update first, and so what keeps a worker that cannot
update from pinning anyone to an old build while they are online. Cache-first
would make each load one coherent build, and make the worker a single point of
failure: a deploy would reach a user one load late, and a broken page would come
back from the precache until its replacement had installed — which
[a failed install](#a-failed-install-hangs-it-does-not-fail) can hold off for
minutes. Two consequences, both measured (`PWA-009`, `PWA-011`):

- **A launch after a deploy is already the new build's page.** The new worker
  follows a few seconds later on the browser's own check, and no pill shows: the
  page is already what that worker holds.
- **A broken page is replaced by the next deploy on the first reload**, with the
  broken build's worker still in control.

**Why a timeout, and why three seconds.** "Reachable" is not "answering". A
connection that is accepted and then stalls — a captive portal, a train, an
origin that is up and wedged — neither fails nor finishes, and a strategy that
waits on it shows a blank window while the whole app sits in the precache.
Serwist's own precache strategy does exactly that: it awaits the navigation
preload response with no timeout. Measured against an origin that accepts
connections and never answers (`PWA-012`): with Serwist answering, the launch
had not opened after **five minutes**; with the listener it opens in **3.1
seconds** (five cold launches, 3.09–3.12 s). The number is short because falling
back costs so little here — the library is local either way, so the worst result
of a wrong guess is a page one deploy old, which the pill reports once the new
worker arrives — and an origin that is answering at all answers this small page
far sooner. Thirty seconds would be thirty seconds of blank window for a user
who already has the app.

**A 5xx falls back; a 404 stands.** A server error is the origin being broken,
and no reason to withhold a page the device holds. A 404 is an answer — the
worker must not turn every unknown path into the app — and so is a redirect
(`PWA-013`).

`navigationPreload: true` stays on, for a narrower reason than before: it starts
the network request alongside the worker's own start-up, so the listener does
not pay for one before it can ask for the other. Serwist's use of the preload
response never runs for a page load.

**Not covered:** the timeout is on the response **starting**. An origin that
sends headers and then stalls mid-body still stalls the page. And between a new
page's load and the new worker's activation — seconds normally, longer if the
new worker cannot install — a new page runs over the old worker's precached
**route payloads** (the `.txt` files an in-app move fetches). What Next does
with a payload from the previous build is **not measured here**: the e2e builds
share one chunk graph ([testing](#testing)).

#### which build is this page — one stamp, two places

The pill's question — is the page on screen older than the worker that just took
over? — needs both to say which build they are, and nothing in a static export
did: `package.json`'s version does not move per deploy, and Next's build id is
not exposed to app code. So each `next build` **stamps itself once**, with the
moment it started (`next.config.js`, `BUILD_ID`), and the stamp goes to exactly
the two places that are compared:

- **every document**, as `<html data-build="…">` (`app/layout.tsx`) — the page's
  answer;
- **`/build.json`** (`app/build.json/route.ts`), a static file the worker
  precaches (`serwist.config.mjs`) — the worker's answer, read through it with a
  plain `fetch`.

On takeover the pill compares the two
(`apps/bracemark-web/src/lib/build-id.ts`). Three choices in there are
load-bearing, and none of them fails anything visibly if undone:

- **The worker's answer is a precached FILE, not a constant in the worker
  script.** The script is bundled by `serwist build`, a second process; a
  constant there could disagree with the pages it serves. A file in the precache
  cannot — it is one of them. And it has to be **in** the precache: fetched from
  the network instead, it names the latest deploy whatever the worker holds.
- **The page's answer is in the DOCUMENT, not the bundle**, and is read **once,
  at load**. The document decides which chunks a page runs, so it is the page's
  build. But the root layout is also in every route payload an in-app move
  fetches, from whichever worker is in control — so on an old page under a new
  worker the attribute can come to name the new build while the code is still
  old. Asked at takeover instead of at load, the page would call itself current
  exactly when it is not.
- **Anything unreadable counts as another build.** A pill shown once too often
  costs a reload; one withheld leaves a window on old code with nothing saying
  so.

No client chunk carries the stamp, and it is not shown anywhere: it answers
"are these two the same", not "which version is this". It is also how a person
checks an update by hand (`PWA-RELEASE-001`, `e2e/web/RELEASE.md`).

#### when the browser checks for a new build

**The browser re-fetches `/sw.js` by itself after every navigation in scope**,
past the worker and (for the script itself) past the HTTP cache, and installs
what it finds if the bytes differ. No app code takes part: `PWA-011` deploys a
build whose page ships without a single script, and the browser installs its
worker anyway. That is the property the update design rests on — a build can
always be replaced without its own cooperation.

Next's router changes routes with the History API, which is **not** a
navigation. A window that is opened once and never reloaded — an installed app
left running for weeks — therefore never checks again. So the app asks: on
returning to the foreground, at most once an hour, counted from the load
(`apps/bracemark-web/src/lib/service-worker-update-check.ts`, mounted by `Initializer`).
A window that is never hidden still waits for its next load.

#### ⚠ `/sw.js` is permanent — three ways to strand a device

Because the browser fetches the worker script itself, **a bad worker is fixed by
deploying a good one**, and nobody has to clear site data — as long as none of
these three things happens. None fails a lint, a typecheck or a unit test.

1. **`/sw.js` stops being a valid worker at that URL and scope.** A browser
   keeps its installed worker until a new one from the **same URL** replaces it;
   it never gives one up because the file went away. Renaming `swDest`
   (`serwist.config.mjs`) or `swUrl` (`inner-layout.tsx`), changing the scope,
   answering that path with a redirect (a browser refuses a redirected worker
   script), or deleting the file leaves every installed browser with the old
   worker and its old precache, indefinitely. **Never move or remove it. To
   retire the worker, ship a kill switch at this same URL** (below).
2. **The new worker cannot install.** The precache install is all-or-nothing:
   one manifest URL that does not answer 200 and the new worker never takes
   over. Online nothing looks wrong, because page loads come from the network
   (above); what stays behind is the build the device opens **offline**, deploy
   after deploy. The e2e origin is a node server, not CloudFront + S3, so a URL
   can resolve there and 404 in production — the clean-URL function and the
   bucket's keys decide ([hosting.md](./hosting.md), _clean URLs_).
3. **The new worker installs and still holds old content.** A precache entry's
   `revision` is what makes a new worker re-fetch a URL whose name did not
   change. A stable-named file shipped with `revision: null` keeps the copy the
   first worker fetched. Today only `/_next/static/` entries have no revision,
   and those are content-addressed.

**As built — `tools/scripts/check-service-worker.mjs`**, run by `deploy-static.sh`
([hosting.md](./hosting.md), _deploying the static sites_) and by hand as
`npm run check:service-worker`. Before upload it reads the manifest out of `out/sw.js`
and refuses a build where a manifest URL has no file in the export (by the
CloudFront function's mapping, not a local server's) or a stable-named entry has
no revision. After the invalidation completes it asks the real host: `/sw.js`
answers 200, as JavaScript, without a redirect, byte-identical to the artifact,
and every manifest URL answers 200. That covers 2 and 3, and the redirect and
removal halves of 1. Nothing covers a deliberate rename — that is this rule.

##### a failed install hangs, it does not fail

In the Serwist this repo ships (9.5.11), a precache fetch that fails does not
reject the install: `@serwist/utils`' `parallel` wraps an `async` function in
`new Promise(...)`, so the rejection is dropped and the install's promise never
settles. The new worker sits in `installing` and the old one keeps running.
Measured in Chrome 154, with a manifest entry answering 404:

- the new worker stayed `installing` for **300 seconds** — Chrome's own limit on
  an install — and only then became `redundant`;
- a fixed build deployed 20 seconds in was **not** picked up by a check made
  then: the check is merged into the stuck one and resolves at once, having
  installed nothing;
- with the window then left alone, the fixed build was still not installed ten
  minutes in. Nothing checks again by itself; the next navigation or launch does.

Closing the browser discards the stuck worker, and the next launch checks
afresh — which is how `PWA-010` reaches the fixed build.

So a build with a bad precache entry costs more than itself: in a window that
stays open it also holds back the build that fixes it. That is the argument for
catching it at deploy rather than in the field. If a Serwist upgrade makes the
install reject properly, this section shrinks to "the old worker stays" and
nothing else here changes.

##### the kill switch — not built

The one case no ordinary deploy fixes is a worker that has to **go away**: the
script is being retired, or a bug in the update path itself. The standard answer
is a few lines served at the same `/sw.js` — skip waiting, unregister, delete
Cache Storage, reload the open windows — which every installed browser picks up
on its next load. **It is not in the repo yet and has never been rehearsed.**
When it is written: it must delete **Cache Storage only, never IndexedDB** (the
library and its keys live there — [sessions.md](./sessions.md)'s no-wipe rule),
and its forced reload discards unsaved drafts, the one place that is acceptable.

### version skew — the conditions for safe mixed versions

Tabs running different builds is not something the worker introduces. Without
any worker, a tab opened before a deploy and one opened after it already run
different builds, and a phone and a laptop can too. Three contracts hold:

1. **Old chunks.** Online, [hosting.md](./hosting.md) keeps every `_next/` file
   forever. Offline, a missing chunk is caught and routed to a reload into the
   new build (_update policy_, above).
2. **Synced payloads.** Every entity schema in `packages/shared/src/sync/entities.ts`
   is a `z.looseObject`, so an old reader keeps fields it doesn't know and
   writes them back unchanged. The blob frame carries a version byte, and
   readers reject an unknown version loudly
   ([local-first-sync.md](./local-first-sync.md), _crypto boundary_). That's
   already the rule between devices, and tabs get it for free.
3. **⚠ The local database schema.** This is the one place two versions can't
   share. Every tab on the origin opens the same IndexedDB database
   (`bracemark-data`, Dexie, `DATA_DB_VERSION = 1`). When a new build ships
   `version(2)` and a new tab opens it, IndexedDB sends `versionchange` to
   every older connection, and IndexedDB **won't reopen at a lower version**, so
   every later read and write in the old tab fails. If the old tab held the
   connection instead, the new tab's upgrade would be blocked and it would hang.
   The session database (`bracemark-session`, raw IndexedDB, `DB_VERSION = 1`)
   fails the other way round: raw IndexedDB never closes a connection by itself,
   so a bump there leaves the **new** tab's `loadSession()` blocked behind the
   old tab, and auth never resolves.

   **As built** (`packages/web-react/src/data/update-required.ts`, `db.ts`,
   `session-store.ts`): both databases close on `versionchange` at once — no
   dialog first, which would hold the upgrade hostage — and raise a sticky
   update-required signal. Dexie's default handler closes too, but leaves
   auto-open on; ours closes with `disableAutoOpen`. Two more paths meet a newer
   schema without ever receiving `versionchange`: a raw open that fails with
   `VersionError`, and a Dexie open — Dexie 4 does NOT fail that one; on
   `VersionError` it retries at the installed version and would run this build's
   code over a schema it doesn't know — so an `on('ready')` check refuses any
   installed version above `DATA_DB_VERSION`. Every path raises the same signal.
   Either database raising this signal also closes the data store, even when
   only the session schema changed. Explicit reopens are refused while the
   signal is set, so editors and late writes cannot continue under obsolete
   session handling.
   React reads it through `useUpdateRequired()` (`web-react/src/hooks/`). The
   sync providers stop scheduling cycles on it, and the web app shows the
   **update-required banner** (`apps/bracemark-web/src/components/update-required-banner.tsx`).

   It is a banner, not a modal: an unsaved draft stays on screen and selectable
   to copy, and Save now fails against the closed database with the editor's
   own error, which the banner has already explained. That holds only because
   the banner sits **above the modal layer** (`z-60 pointer-events-auto`): at the
   dialogs' own `z-50` the order was whichever mounted last, so an editor opened
   after the banner buried it under the overlay, and in either order the modal's
   `pointer-events: none` on `body` left Reload dead. The component's header
   carries both halves and what they cost. The tab never reloads by
   itself; Reload is the explicit discard. If the new build's worker is still
   waiting when Reload is pressed, the reload first asks it to take over
   (`SKIP_WAITING`), so the old shell can't be served again and meet the
   upgraded database in a loop. A database-open error is never "signed out"
   ([sessions.md](./sessions.md)): nothing reads the signal as permission to
   clear anything.

   **⚠ The handler has to be in the build being replaced, not the one
   replacing it.** `versionchange` fires in the _old_ tab, so the old code is
   what must handle it. It is in every build from this one on, before the first
   `version(2)`. [local-first-sync.md](./local-first-sync.md), _schema changes_,
   carries the matching rule from the schema side. **Bump `DATA_DB_VERSION`
   with every new Dexie `version(n)`** — the newer-schema check compares against
   it. `VERSION-SKEW-WEB-001`/`002` upgrade each database from a second tab under
   an open editor.

### sign-out leaves the worker alone

**Sign-out doesn't unregister the worker, and keeps its app-only caches.**
Cached response bodies contain static app resources, not account data (the
cross-origin rule above), and unregistering would take offline support away
from the next sign-in. What a body-clean cache could still hold is an
account-bearing KEY: `defaultCache`'s runtime page caches key on the full URL,
and `/links?list=<id>&tag=<id>` names the account's lists and tags.

**Today no such key is written.** Serwist registers the precache route ahead of
`runtimeCaching`, the precache ignores every query
([navigations with a query string](#navigations-with-a-query-string--verified)), and every
route is precached — so a query URL, a full load or an in-app move, and its
`?_rsc=` payload are answered from the precache and never reach a runtime cache.
`PWA-005` asserts it before sign-out, after a full load of a query URL and an
in-app move to `?list=archive`.

**The purge is a safeguard for the day that stops holding** — a route left out
of the precache, or a narrower `ignoreURLParametersMatching`. The sign-out
teardown (`clearData` → `purgeAccountCacheKeys`,
`packages/web-react/src/data/service-worker-cache.ts`) deletes every runtime entry whose
URL carries a query, and never touches the precache, whose keys carry Serwist's
own revision query. `PWA-005` checks both after sign-out; if its pre-sign-out
check ever fails, the purge has started doing real work, and this section is
the place to say why.

If the worker ever caches data again, the sign-out teardown has to clear that
cache, and this section has to be rewritten.

### storage durability — verify before promising

Reachability is worthless if the browser throws the data away.

- **Persistence is requested.** After sign-in the app calls
  `navigator.storage.persist()` unless the origin is already persisted
  (`inner-layout.tsx`). Chrome grants it based on engagement or installation,
  Firefox asks the user, and a persisted origin is protected from automatic
  storage-pressure eviction. The answer may be no, and persistence never stops
  the user clearing site data.
- **⚠ TODO — Safari, measured by hand.** WebKit deletes all of a site's
  script-writable storage, IndexedDB and the worker registration included, after
  7 days of Safari use without an interaction with the site, unless it was added
  to the Home Screen. Whether a granted `persist()` exempts an origin from that
  is not established and has to be **measured on current Safari**, not assumed.
  Automation can't settle it: Playwright's `webkit` is its own WebKit build, not
  Safari.app, and doesn't carry Safari's tracking-prevention policy; Safari.app
  itself is scriptable through `safaridriver`, but the cap counts days of Safari
  use, which no driver fast-forwards. The procedure: in Safari (not a Home Screen
  app), sign in with a library, confirm `await navigator.storage.persisted()`
  in the console, then use Safari on other sites for 8+ days without opening the
  app, and open it offline; repeat once from a Home Screen install. Until then a
  Safari tab's library is only as durable as the user's last visit, and the
  claim's edge runs through that browser — a question for
  [brand-assets.md](./brand-assets.md), _the claim boundary_, once measured.

### the Expo app

- **Reachability:** built in. The code ships in the binary, and the local
  store is expo-sqlite plus expo-file-system. Maestro covers offline cold
  start, read, write and export on both OSes, plus a 500/404 api's cold start
  and export on Android ([e2e.md](./e2e.md)). With the session redesign
  ([sessions.md](./sessions.md)) nothing on the device expires the library on a
  clock.
- **Updates:** store builds only. `expo-updates` is **not installed** (it
  appears in `app.config.ts` only on the share extension's excluded-packages
  list), so there's no over-the-air policy to design and no update server
  whose disappearance matters. The iOS share extension ships in the same
  bundle as the app, so the two processes are always the same version.
- **⚠ The schema changes by migration, never by "delete the app".**
  `packages/expo-react/src/data/db.ts` holds the shipped version-1 DDL. Before
  the first release, the fix for a changed table was to delete the app. Now
  that deletes a library that may exist nowhere else.
  [local-first-sync.md](./local-first-sync.md), _schema changes_, owns the
  `PRAGMA user_version` migrations that replace it. There's no multi-tab
  equivalent of `versionchange` here: one app process opens the database at a
  time, and it runs any migration before first use.
- **An old app meeting a newer blob format** fails loudly, by design
  (_version skew_ above). An "update the app" message would read better than
  a sync error. It's a nicety, not part of the promise: a dead server writes
  no new formats.

### the browser extension

- **Reachability:** the code ships in the package, so the popup and options
  pages open offline.
- **Updates:** packaged updates avoid the web worker's precache handover. Its
  IndexedDB belongs to the browser extension's own origin, so it never shares
  a database with a web app tab. Popup, options and background contexts still
  share local state: session-generation coordination and the `versionchange`
  guard come with `@stxapps/web-react`.
- **Boundary: no export.** The popup is quick-save plus a recent list, and the
  options page is account and theme ([browser-extension.md](./browser-extension.md)).
  If the server disappeared, the extension's local copy couldn't be exported
  from the extension. That's accepted: the extension has no library view, so
  export requires a retained web or mobile copy. A link saved only in the
  browser extension and never synced may exist nowhere else; do not claim
  that another client necessarily has it. If the browser extension gains a
  library view, it gains an export in the same change.
- **The 401 rule:** the MV3 background worker never wipes. See
  [sessions.md](./sessions.md), _who acts on a 401_.

### testing

`e2e-pwa` ([e2e.md](./e2e.md), _the PWA target_) is the only run that meets the
worker:

- `PWA-001`–`003` — the installed app with the origin stopped and the network
  gone: a cold launch, an offline edit that reaches another profile, and an
  in-app route to Settings → Data and an export. `PWA-003` runs with the device
  clock two years ahead ([sessions.md](./sessions.md)'s specimen).
- `PWA-004` — a **normal tab**: the app registers the worker itself at sign-in,
  and the case never opens Settings → Data online (asserted: no runtime entry
  for it), so offline the section can only come from the precache.
- `PWA-005` — after a full online session no cache holds a cross-origin key and
  no runtime cache a query-keyed one, before sign-out or after; sign-out keeps
  the registration.
- `PWA-006` — a never-visited query URL loads cold and offline.
- `PWA-007` — build B (A with a changed worker script) takes over two open tabs:
  both show the pill, the untouched one keeps working, Reload lands on B.
- `PWA-008`–`011` — builds that **differ**: `pwa/fixtures/build.ts` derives each
  from the staged export with a changed page (a revisioned entry), a new asset
  (an unrevisioned one), its own build stamp, and a worker script naming them. Each reads which build
  the worker holds with the **origin stopped**, since with it up a page is the
  latest deploy's regardless (_what answers a navigation_).
  - `PWA-008` — the new worker replaces the changed page and adds the asset; the
    old copy is deleted, not outranked. Keep the old revision on the changed page
    and it fails at the reload.
  - `PWA-009` — a cold launch after a deploy, with nothing asking: the page is
    the new build's at once, the new worker installs by itself **and no pill
    shows**, and the next launch with the origin gone is the new build.
  - `PWA-010` — a build whose precache names a missing file never takes over;
    the old build still opens with the origin gone and still takes a write; the
    fixed build takes over on the next launch and clears what the failed install
    left.
  - `PWA-011` — a build whose page has no script at all is installed on the
    browser's own check; the fix after it is the app again on one reload.
- `VERSION-SKEW-WEB-001`/`002` (`e2e-web`) — a second tab opens each database
  one version up under an open, dirty editor: the upgrade isn't blocked, the old
  tab shows the update-required banner, and the draft is still on screen.
- `PWA-012` — an origin that accepts connections and never answers: the launch
  opens the installed build from the precache within seconds. Only a **stall**
  shows this; a stopped origin refuses at once, so every other offline case
  opens instantly with or without the timeout.
- `PWA-013` — an origin answering 500 opens the installed build; an unknown
  path still gets the origin's 404.
- `npm run test:check-service-worker` — the deploy check itself (`tools/scripts/`,
  node's runner): it refuses a manifest it can only read part of, a precached
  URL with no file, a stable name without a revision, and a host that redirects
  the worker, serves it as a page, serves another build's, or 404s an entry.
- Unit specs: `navigation-response.spec.ts` (the network's answer in time; the
  whole timeout for a stall and not a millisecond less; a failure without
  waiting it out; 5xx falls back and 404 stands; nothing precached waits for
  the network), `service-worker-update-check.spec.ts` (the foreground check's interval,
  counted from the load; offline skipped without spending it),
  `update-pill.spec.tsx` (first install vs another build vs the same build, the
  build read at load, an unreadable build, chunk failures,
  the draft confirm, flush before reload), `update-required-banner.spec.tsx`
  (no reload by itself, a waiting worker's handover before the reload, the
  fallback when it never reports), `chunk-error.spec.ts`,
  `service-worker-cache.spec.ts`, `use-unsaved-draft.spec.tsx`, and the session
  database's `versionchange` case in `session-store.spec.ts`.

**⚠ `offline: true` does not take the network away from the service worker.**
Playwright's offline emulation covers the page, not fetches the worker makes
itself, and the worker's cross-origin rule re-fetches every api request in the
worker — measured: an "offline" page's `GET /v1/auth/session` reached the local
api through its worker. Until `pwa/fixtures/pwa.ts` also aborted every request
leaving the app's origin (context routing does reach worker requests), "the api
is gone" was never actually true in `PWA-002`/`003`. Keep the route in any new
offline case.

**Not covered end to end:**

- **The previous release → this one.** Every update case replaces a build with
  one derived from it in the same run. The pair real users meet is the worker
  that shipped last time against the one about to ship. That pair could not
  exist before the first release, and it can now: keep the released `out/` (or
  rebuild its deploy tag against the local stack) and install from that
  (`PWA-UPGRADE-001`, `e2e/NEXT.md`).
- **A stalled response body.** The navigation timeout is on the response
  starting; headers followed by a stall are not exercised.
- **Two real builds.** The derived builds share build A's chunk graph, so an old
  tab asking the new worker for a chunk only the old build had — and a new page
  running over the old build's route payloads — are not exercised; chunk
  recovery is pinned at the unit level.
- **Any browser but Chrome.** Safari and Firefox update by the same rules on
  paper; `PWA-RELEASE-001` (`e2e/web/RELEASE.md`) checks an update by hand on
  both, on a real deploy.
- **The real host.** Whether each precache URL resolves on CloudFront + S3 is
  the deploy check's, not a case's.
- The Safari storage measurement above.

### build order

All five steps have landed, in the order the dependencies set:

1. **The cache rule** — cross-origin requests to the network only.
2. **The `versionchange` guard** on both databases, with the update-required
   banner.
3. **Immediate takeover** (`skipWaiting: true`), the reload pill and chunk-load
   recovery.
4. **Register after sign-in**, with the PNG `globIgnores`, the precached RSC
   payloads, and `ignoreURLParametersMatching`.
5. **`navigator.storage.persist()`** after sign-in — then the Safari
   measurement, still TODO.

The public claim covers data already available on a device whose app files,
keys and storage remain intact; signing in once is not an unconditional
durability guarantee, and Safari's retention is the open edge.
