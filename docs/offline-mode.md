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
[hosting.md](./hosting.md) (the CSP the worker registers under, and the
never-expire-`_next/` rule that old tabs rely on), [e2e.md](./e2e.md), _the PWA
target_ (`PWA-001`–`003`, the only run that meets the worker),
[data-lifecycle.md](./data-lifecycle.md) (the sign-out teardown),
[brand-assets.md](./brand-assets.md) (the claim this doc makes true or false).

> **STATUS — partly built.** The worker exists (`apps/bracemark-web/src/sw.ts`,
> built by `serwist build` after `next build`). It registers only when the app
> runs standalone or an existing registration is found. `PWA-001`–`003` cover
> opening, editing and exporting with the origin gone and a fresh, unexpired
> session. They do not prove survival past today's session expiry. Everything
> below that changes the worker (the cache rule, registering after sign-in,
> the update policy, the `versionchange`
> guard) is designed, not built. See [build order](#build-order).

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
local library, keys and required app files remain on the device.** Today it also
depends on the session not having expired or been rejected. The future column
requires **both** this design and the session redesign to be implemented.

| platform                          | today                                                                   | after this design                                             |
| --------------------------------- | ----------------------------------------------------------------------- | ------------------------------------------------------------- |
| Expo app (iOS, Android)           | opens with an unexpired session; code ships in the binary               | opens with retained local data and keys                       |
| browser extension                 | opens, but has no export                                                | same (a stated boundary, see below)                           |
| bracemark-web, installed PWA      | opens with a fresh session and installed worker (`PWA-001`–`003`)       | opens after worker installation, subject to storage retention |
| bracemark-web, a tab already open | loaded views remain available; uncached routes/assets may fail          | offline routes require the installed worker and cached assets |
| bracemark-web, fresh tab          | fails without an existing worker; an existing registration can serve it | opens after worker installation, subject to storage retention |
| bracemark-web, never signed in    | fails                                                                   | fails, and holds no library to lose                           |

A browser that never signed in has no local library. Signing in alone does not
prove offline readiness: the local library must have been created or synced and
the worker installation must have completed. Browser eviction, user-cleared data
and incomplete local downloads remain boundaries; content never downloaded cannot
be recovered from a dead server. See _storage durability_ below.

### ⚠ the worker caches the app, never data

**The worker may cache same-origin app code and pages. It must never cache a
cross-origin response.** The data path already has a durable, per-account,
wiped-on-sign-out home: IndexedDB. A second copy in Cache Storage has none of
those three properties.

This is not the current behaviour, and nothing flags it. `sw.ts` passes
`@serwist/next`'s `defaultCache` as `runtimeCaching`, and that list ends with a
catch-all for **remaining cross-origin GETs**: `NetworkFirst`, cache `cross-origin`,
32 entries, one hour (`node_modules/@serwist/next/dist/index.worker.mjs`, the
`!sameOrigin` matcher). Earlier image, font and other asset matchers also accept
cross-origin URLs, so the cache used depends on which rule matches first.
Together these rules can cache:

- the api's authenticated reads: `GET /v1/ops/list`, `GET /v1/files/list`,
  `GET /v1/iap/status`;
- the door blobs: `GET /v1/auth/password-door`, `GET /v1/auth/recovery-door`;
- bracemark-extractor's image proxy, `GET /v1/image?url=…`, whose URL **names a
  third-party image from a page the user saved**;
- presigned R2 downloads.

Cache Storage keys on the URL, not on the `Authorization` header, so:

- **Sign-out leaves residue.** The teardown wipes IndexedDB and the React Query
  cache ([data-lifecycle.md](./data-lifecycle.md), _the sign-out teardown_) but
  never Cache Storage. The previous account's `iap/status` and a list of image
  URLs from its saved pages can remain on the device after sign-out. The next
  account to sign in within the cache's freshness window can be served the previous account's
  `iap/status` when the network is slow or down.
  Cache freshness limits are not timed deletion guarantees: expiration cleanup
  runs when the worker uses the cache, and earlier asset rules have different
  retention settings.
- **Offline stops looking offline.** `NetworkFirst` with a 10-second timeout
  answers from the cache when the network fails or is slow, so a request that
  should fail can return an old answer. The sync engine and the entitlement fold
  are built to handle a failed request. They aren't built to handle a stale
  success.

The fix is a cross-origin `NetworkOnly` GET route placed **before every
runtime caching rule**. Other methods must remain network-only too. An
alternative is to constrain every caching matcher to approved same-origin app
resources. **Removing only the final cross-origin entry is insufficient**:
the earlier asset matchers would still cache third-party responses.

**Prelaunch: reset development profiles, without a legacy-cache migration.**
There are no real users or production installs to migrate. Before verifying
the new worker, manually unregister the old worker and clear its Cache Storage
and expiration metadata in development/test profiles, or use a fresh profile.
This is a development reset, not activation-time product code or a requirement
to support upgrades from the current unsafe cache rules. A routing change alone
does not remove old entries from a reused test profile.

Ship the cross-origin network-only rule in the first public build. Existing
registrations can also control ordinary tabs, and registering after every
sign-in widens that population, so **the rule lands first**. Once real users
exist, any later change that leaves account data in old caches must include a
cleanup path; the prelaunch reset policy no longer applies to their devices.

With the rule in place from the first public build, cached response bodies
contain the static export's pages, RSC payloads and chunks. Sign-out can retain those app
resources, subject to the cache-key boundary
[below](#sign-out-leaves-the-worker-alone).

### when the worker registers — after sign-in, in any display mode

**Register once the auth provider reaches `authenticated`**: after sign-in,
after create-account, or on a load that finds a stored session. The display
mode stops mattering. Today `Initializer` in `apps/bracemark-web/src/app/inner-layout.tsx`
registers only when `(display-mode: standalone)` matches or a registration
already exists.

Standalone-only registration was chosen for three reasons. Each still holds
for an anonymous visitor. None of them holds for a signed-in user:

- **"A visitor who never returns shouldn't download the whole precache."**
  They still won't. A visitor who never signs in never registers. A user who
  signs in has a library on the device worth keeping reachable, and already
  downloads most of the precache just by using the app. The precache is 76
  entries, **about 3.5 MB gzipped** (measured on a local production build,
  September 2026). 1.9 MB of that is PNGs the app never shows offline: the
  manifest screenshots `ss-*.png`, the `opengraph-image`/`twitter-image`.
  Excluding them through `globIgnores` in `serwist.config.mjs` leaves about
  1.7 MB, almost all of it JS chunks. Later deploys only fetch entries whose
  revision changed or whose cache entry is missing; unchanged hashed chunks
  can be reused while their entries remain cached.
- **"The worker's update rules shouldn't strand a tab on an old build."** True
  of `skipWaiting: false`, which is today's config. The update policy below
  addresses it, subject to the update verification gate below.
- **"Lean on Next.js before adding machinery."** Next has no way to load a page
  offline from a cold start. Something has to answer the navigation, and
  Serwist is already a dependency. Nothing new gets added.

**Keep worker lifecycle listeners with registration.** Retain the existing
`waiting` listener and add the activation/controller-change handling needed by
the update pill. Distinguish first installation from a replacement worker so
first-time control does not announce a spurious update.

**The offline guarantee starts when the install finishes, not when the user
signs in.** Sign-in needs the network, so the first session is always online,
and the precache downloads in the background during it. A user who signs in
and closes the tab within seconds may not have a full precache yet. That is
not yet offline-ready. A later online visit can retry installation; installation
failures and storage quota limits must remain visible in readiness checks.

#### navigations with a query string — verify

The precache matches `/links`, not `/links?list=…`. Serwist strips only
`utm_*` and `fbclid` before matching (`precacheOptions.ignoreURLParametersMatching`,
default `[/^utm_/, /^fbclid$/]`), and the runtime page cache keys on the full
URL. So a cold offline load of a restored tab or bookmark at
`/links?list=<id>`, a URL never visited with that exact query while online,
probably misses both caches. Every route in the static export is one HTML file
whatever its query, so the likely fix is `ignoreURLParametersMatching: [/.*/]`
for the precache. **Verify first:** `PWA-001` loads bare `/links`, so no case
has tried this.

### update policy — immediate takeover requires verification

The proposed policy is **`skipWaiting: true`** (currently `false` in `sw.ts`),
with `clientsClaim: true` (already set). **Do not enable it until the two-build
offline tests below pass and draft protection exists.** New worker code can
take over old pages while those pages still request old assets. This is a real
compatibility boundary, documented in
[Chrome's worker lifecycle guidance](https://developer.chrome.com/docs/workbox/service-worker-lifecycle).

After the replacement has installed and activated,
open tabs keep their loaded code and a reload can load the new build. A reload
that only starts the update check may still load the old build. The pill must
track completed activation, not promise a new version merely because a deploy
exists.

The alternatives have different costs:

- **Wait until every tab closes** (`skipWaiting: false`, today). A waiting
  worker activates only once no page is using the old one, and **a reload
  doesn't count**: the reloading page is still a client of the old worker
  while its navigation is in flight. So the refresh button does nothing for
  an update, and people with the PWA installed rarely close every window.
  They could run an old build indefinitely. This remains the current safe
  default until the immediate-takeover verification gate passes. A waiting
  worker can also be activated explicitly through a coordinated update flow;
  changing `skipWaiting` globally is not the only possible update mechanism.
- **Force every tab to reload on update.** That reloads the user mid-task and
  can lose text in an open editor. It reduces version skew only if coordinated
  successfully, and still needs the draft and pending-save protection below.

**Committed edits survive a reload; drafts and unfinished writes need protection.**
The `items`/`pendingOps` transaction must finish before a save is considered
durable. The existing dirty-editor guard ([editors.md](./editors.md)) blocks
accidental dialog dismissal, such as Escape and backdrop clicks. It does not
intercept document reloads. A new app-level update coordinator must account for
dirty editors and pending local saves; a `beforeunload` warning alone is not
durable draft recovery.

**The "updated, reload" pill.** A tab that was open when the new worker took
over shows a quiet pill offering a reload. Its action waits for pending local
saves to commit and lets the user finish editing or explicitly discard the
draft before reloading. A routine update never reloads the tab on its own.
Schema changes require the separate connection-closing and draft-recovery flow
below, because the old tab can no longer save to the upgraded database.

### version skew — the conditions for safe mixed versions

Tabs running different builds is not something the worker introduces. Without
any worker, a tab opened before a deploy and one opened after it already run
different builds, and a phone and a laptop can too. That does not prove safety
under worker takeover. Three separate contracts have to hold:

1. **Old chunks.** An old tab can lazily load a chunk its build names. Online,
   [hosting.md](./hosting.md) keeps every `_next/` file forever, so it loads.
   Offline, activation can remove old precache entries while a tab still needs
   them. **Do not assume Next turns every chunk failure into a safe reload.**
   Its installed navigation-failure handler is conditional, and
   `experimental.appNavFailHandling` defaults to false; even a fallback reload
   needs draft protection. Before immediate takeover ships, verify old tabs
   opening unvisited routes offline after the new worker activates. If this
   fails, retain the old assets needed by live clients or implement explicit,
   draft-safe recovery to the new build. Specify when retained assets can be
   removed and test repeated updates; one previous cache alone does not protect
   a tab that survives several deploys. Until that policy is implemented and
   verified, keep the waiting-worker behavior.
2. **Synced payloads.** Every entity schema in `packages/shared/src/sync/entities.ts`
   is a `z.looseObject`, so an old reader keeps fields it doesn't know and
   writes them back unchanged. The blob frame carries a version byte, and
   readers reject an unknown version loudly
   ([local-first-sync.md](./local-first-sync.md), _crypto boundary_). That's
   already the rule between devices, and tabs get it for free.
3. **⚠ The local database schema.** This is the one place two versions can't
   share. Every tab on the origin opens the same IndexedDB database
   (`bracemark-data`, Dexie, today at `version(1)`). When a new build ships
   `version(2)` and a new tab opens it, IndexedDB sends `versionchange` to
   every older connection. Dexie closes the old tab's connection. IndexedDB
   **won't reopen at a lower version**, so every read and write in that tab
   fails from then on. If the old tab held on to the connection instead, the
   new tab's upgrade would be blocked and it would hang.

   The session database (`bracemark-session`, raw IndexedDB in
   `packages/web-react/src/data/session-store.ts`, `DB_VERSION = 1`) fails the
   other way round. Raw IndexedDB never closes a connection by itself, so a
   bump there leaves the **new** tab's `loadSession()` blocked behind the old
   tab, and auth never resolves.

   **Every tab handles `versionchange` on both databases by stopping database
   work and closing the affected connection promptly.** Stop sync scheduling,
   gate new reads/writes, and account for transactions already running. Do not
   hold the connection open while waiting for a person to answer a dialog;
   that blocks the new tab's upgrade. Do not offer Save against a closed or
   incompatible database.

   Show an update-required state, retaining any unsaved draft in memory with
   a way to copy it and an explicit discard-and-reload action. Automatic
   reload is allowed only when there is no draft or the draft has been durably
   preserved for recovery. If automatic draft recovery is implemented, it
   needs a versioned, account-bound store independent of the database being
   upgraded, a restore path in the new build, and sign-out cleanup. A failure
   to preserve a draft must leave the recovery UI open rather than reload.
   Do not use the unavailable old database as the only draft backup.

   An old page whose first database open happens after the upgrade can get
   `VersionError` without receiving `versionchange`; route it to the same
   update-required UI. Once safe to reload, ensure the target build can open
   the new schema. In particular, a waiting old worker must not serve the old
   shell again and create a reload loop. Verify the new app shell is available
   offline before automatically reloading an offline tab. Database-open errors
   must never be interpreted as a missing session that permits a data wipe.

   **⚠ The handler has to be in the build being replaced, not the one
   replacing it.** `versionchange` fires in the _old_ tab, so the old code is
   what must handle it. It has to ship in the **first build users run**, well
   before the first `version(2)`, or the first schema bump hits every open tab
   with no handler. This is why it's in [build order](#build-order) ahead of
   anything that needs it. [local-first-sync.md](./local-first-sync.md),
   _schema changes_, carries the matching rule from the schema side.

### sign-out leaves the worker alone

**Don't unregister on sign-out, and retain app-only response caches.** This
policy relies on the cross-origin routing fix shipping in the first public build.
Cached response bodies then contain static app resources rather than account
data. Unregistering would take offline support away from the next sign-in and
require registration again without an account-cleanup benefit.
Account teardown still clears the stores listed in
[data-lifecycle.md](./data-lifecycle.md), _the sign-out teardown_, plus any new
draft-recovery store. Runtime cache keys can include list/tag/search query
parameters even when their response bodies are static. Normalize those keys
only where response equivalence is proven, or remove account-bearing entries
on sign-out; app-only response bodies do not justify retaining private URLs.

This depends on the cache rule above. If the worker ever caches
data again, the sign-out teardown has to clear that cache, and this section
has to be rewritten.

### storage durability — verify before promising

Reachability is worthless if the browser throws the data away. Two things to
settle before the claim covers every browser:

- **Ask for persistence.** Call `navigator.storage.persist()` after sign-in.
  Chrome grants it based on engagement or installation, Firefox asks the user,
  and a persisted origin is protected from automatic storage-pressure eviction.
  Check the result; the request can be denied, and persistence does not prevent
  the user from clearing site data.
- **Safari.** WebKit deletes all of a site's script-writable storage,
  IndexedDB and the worker registration included, after 7 days of Safari use
  without an interaction with the site, unless it was added to the Home Screen.
  Whether a granted `persist()` exempts an origin from that has to be
  **measured on current Safari**, not assumed. Until it is, a Safari tab's
  library is only as durable as the user's last visit, and the claim's edge
  runs through that browser. It's a question for
  [brand-assets.md](./brand-assets.md), _the claim boundary_, once measured.

### the Expo app

- **Reachability:** built in. The code ships in the binary, and the local
  store is expo-sqlite plus expo-file-system. Maestro covers offline cold
  start, read, write and export on both OSes, plus a 500/404 api's cold start
  and export on Android ([e2e.md](./e2e.md)). These fresh-session cases do not
  remove today's local-expiry wipe; the session redesign is still required.
- **Updates:** store builds only. `expo-updates` is **not installed** (it
  appears in `app.config.ts` only on the share extension's excluded-packages
  list), so there's no over-the-air policy to design and no update server
  whose disappearance matters. The iOS share extension ships in the same
  bundle as the app, so the two processes are always the same version.
- **⚠ The schema can't keep the "delete the app" policy past launch.**
  `packages/expo-react/src/data/db.ts` runs idempotent DDL under a greenfield
  no-migrations policy, and its fix for a changed table is to delete the app.
  After launch, deleting the app deletes a library that may exist nowhere
  else. [local-first-sync.md](./local-first-sync.md), _schema changes_, owns
  the switch to `PRAGMA user_version` migrations. There's no multi-tab
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
  share local state: keep session-generation coordination and database-upgrade
  handling, and verify their lifecycle during an installed-package update.
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
worker. It gains:

- **A normal tab, cold, never warmed.** Registration happens after sign-in in
  a normal tab, not standalone, and the case **never visits Settings while
  online**. `PWA-003` today includes an online launch under the worker. Make
  absence of warmed Settings/Data runtime entries an explicit assertion so
  the new case proves those routes are available from the precache.
- **No cross-origin entries.** After a full online session (sync, images,
  entitlement), inspect requests in **every** app-owned cache, not only the
  cache named `cross-origin`. Include cross-origin image/font URLs matching
  the earlier asset rules and presigned downloads. Start from a fresh or
  manually reset test profile; no legacy-cache upgrade case is required before
  launch. Check sign-out removes account-bearing URL keys. The two-build update
  cases below use builds with the safe cache rule already in place.
- **Update on reload.** Serve build A, then build B, wait for B's installation
  and activation, then reload into B. A second tab that stayed open
  shows the pill and still works. Also reload while B is still installing:
  the UI must not incorrectly claim the tab is already on B.
- **Old tab, new worker, no network.** After B takes over A, go offline and
  open previously unvisited routes, including Settings → Data → Export.
  Repeat across multiple updates and with an unsaved editor. Verify old-asset
  retention or explicit recovery, with no automatic draft loss or reload loop.
- **`versionchange`.** A build with `version(2)` opened beside a tab on
  `version(1)`, for both databases: the old connection closes without waiting
  for user input, and the new tab is not blocked. Test a committed queued op,
  an in-flight save, and an unsaved editor separately. The draft remains
  recoverable or is discarded only by explicit choice. Cover an old tab's
  first open receiving `VersionError`, offline recovery, and a waiting worker
  still serving A. The handler must already be in build A.
- **A query-string cold load**, for the verify item above.
- **Session prerequisites.** Run cold launch/export after local clock advance
  past the old TTL and after server expiry or token purge, with an unsynced
  edit present. Those cases depend on [sessions.md](./sessions.md)'s redesign;
  the current fresh-session PWA cases cannot stand in for them.

### build order

The order is set by what the next step depends on. The verification gates are
part of each step, not work to defer until after enabling the behavior:

1. **The cache rule.** Cross-origin requests go to the network only, starting
   with the first public build. Reset old development/test profiles manually;
   no legacy-cache migration ships. This comes first because every later step
   widens who has the worker.
2. **The `versionchange` guard**, on `bracemark-data` (Dexie) and
   `bracemark-session` (raw IndexedDB), both in `@stxapps/web-react`. The
   browser extension inherits the same protection. Include the update-required
   UI, pending-save handling, draft recovery/discard flow, and a compatible
   reload target. It must ship before launch and before any schema bump.
3. **The reload pill and two-build verification.** Enable `skipWaiting: true`
   only after old-tab offline navigation and draft protection pass. Otherwise
   retain the waiting worker until an asset-retention or recovery policy passes.
4. **Register after sign-in**, with the PNG `globIgnores` and, if the verify
   item confirms it, `ignoreURLParametersMatching`.
5. **`navigator.storage.persist()`** after sign-in, then the Safari measurement.

Step 4 establishes normal-tab worker registration, not the whole dead-server
promise. Before updating the platform table or public claim, also land the
[session redesign](./sessions.md), pass the cold-launch/export and update cases,
and establish the supported browsers' storage-retention boundaries. The claim
covers data already available on a device whose app files, keys and storage
remain intact; signing in once is not an unconditional durability guarantee.
