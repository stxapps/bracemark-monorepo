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
> runs standalone, and `PWA-001`–`003` prove the installed PWA opens, edits and
> exports with the origin gone. Everything below that changes the worker (the
> cache rule, registering after sign-in, the update policy, the `versionchange`
> guard) is designed, not built. See [build order](#build-order).

### the promise

The marketing site's landing page, in its _If we disappear_ band, says: "The
library does not need us to be reachable in order to open." Two things have to
hold for that sentence to be true:

1. **Nothing wipes the library.** That is [sessions.md](./sessions.md)'s rule:
   no clock, and no 401 that isn't our own `session_revoked`.
2. **Something can still open it.** That is this doc.

Cold launch with the origin gone, per platform:

| platform                          | today                           | after this design                        |
| --------------------------------- | ------------------------------- | ---------------------------------------- |
| Expo app (iOS, Android)           | works: code ships in the binary | same                                     |
| browser extension                 | opens, but has no export        | same (a stated boundary, see below)      |
| bracemark-web, installed PWA      | works (`PWA-001`–`003`)         | same                                     |
| bracemark-web, a tab already open | works: the page is in memory    | same                                     |
| bracemark-web, fresh tab          | **fails**: no worker in a tab   | works, in any browser the user signed in |
| bracemark-web, never signed in    | fails                           | fails, and holds no library to lose      |

The last row is the honest edge of the claim, and it is empty by construction:
a browser that never signed in has no copy of anyone's library.

### ⚠ the worker caches the app, never data

**The worker may cache same-origin app code and pages. It must never cache a
cross-origin response.** The data path already has a durable, per-account,
wiped-on-sign-out home: IndexedDB. A second copy in Cache Storage has none of
those three properties.

This is not the current behaviour, and nothing flags it. `sw.ts` passes
`@serwist/next`'s `defaultCache` as `runtimeCaching`, and that list ends with a
catch-all for **every cross-origin GET**: `NetworkFirst`, cache `cross-origin`,
32 entries, one hour (`node_modules/@serwist/next/dist/index.worker.mjs`, the
`!sameOrigin` matcher). For Bracemark that catches:

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
  URLs from its saved pages stay on the device for up to an hour. The next
  account to sign in inside that hour can be served the previous account's
  `iap/status` when the network is slow or down.
- **Offline stops looking offline.** `NetworkFirst` with a 10-second timeout
  answers from the cache when the network fails or is slow, so a request that
  should fail can return an old answer. The sync engine and the entitlement fold
  are built to handle a failed request. They aren't built to handle a stale
  success.

The fix is a route placed **before** `defaultCache` that sends every
cross-origin request to `NetworkOnly`, or a `defaultCache` filtered to drop its
cross-origin entry. Either way, the rule is the thing to keep, not the
mechanism. Today only the installed PWA carries this cache. Registering in
every signed-in tab (below) would put it in all of them, so **this lands
first**.

With the rule in place, what the worker holds is the same for every user: the
static export's pages, RSC payloads and chunks. That is why sign-out does not
need to touch it ([below](#sign-out-leaves-the-worker-alone)).

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
  revision changed, and hashed chunks that didn't change are never fetched
  again.
- **"The worker's update rules shouldn't strand a tab on an old build."** True
  of `skipWaiting: false`, which is today's config. The update policy below
  removes it.
- **"Lean on Next.js before adding machinery."** Next has no way to load a page
  offline from a cold start. Something has to answer the navigation, and
  Serwist is already a dependency. Nothing new gets added.

**Keep the `waiting`/`controllerchange` listeners in the same place.** The
update pill (below) hangs off them.

**The offline guarantee starts when the install finishes, not when the user
signs in.** Sign-in needs the network, so the first session is always online,
and the precache downloads in the background during it. A user who signs in
and closes the tab within seconds may not have a full precache yet. That is
acceptable: their next online visit completes it.

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

### update policy — the new worker takes over at once, tabs update on reload

**`skipWaiting: true`** (currently `false` in `sw.ts`), with `clientsClaim: true`
(already set). A new worker takes over as soon as it has installed. Open tabs
keep running the code they already loaded, and any reload or new tab gets the
new version.

The two alternatives, and why neither:

- **Wait until every tab closes** (`skipWaiting: false`, today). A waiting
  worker activates only once no page is using the old one, and **a reload
  doesn't count**: the reloading page is still a client of the old worker
  while its navigation is in flight. So the refresh button does nothing for
  an update, and people with the PWA installed rarely close every window.
  They could run an old build indefinitely.
- **Force every tab to reload on update.** That reloads the user mid-task and
  loses any text in an open editor. It isn't safer, either: open tabs can
  already run different versions today (next section).

**A reload doesn't lose queued edits.** Every local write goes to IndexedDB
(`items` plus the `pendingOps` queue) before any sync is attempted, so a reload
at any moment loses only text typed into an editor that hasn't been saved. The
dirty-editor close guard ([editors.md](./editors.md)) already covers that.

**The "updated, reload" pill.** A tab that was open when the new worker took
over (it sees `controllerchange`) shows a quiet pill offering a reload. The
dirty-editor guard applies to it like any other navigation away. The tab never
reloads on its own for a routine update. The one exception is the schema
change below, where the old tab can no longer read the database.

### version skew — why tabs on different versions are safe

Tabs running different builds is not something the worker introduces. Without
any worker, a tab opened before a deploy and one opened after it already run
different builds, and a phone and a laptop always do. Three things keep it
safe, and only the third is new work:

1. **Old chunks.** An old tab can lazily load a chunk its build names. Online,
   [hosting.md](./hosting.md) keeps every `_next/` file forever, so it loads.
   Offline, the new worker's precache no longer has it, the chunk load fails,
   and Next falls back to a full page load, which is the new version. That is
   a graceful update, not an error.
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

   **So every tab handles `versionchange` on both databases by closing the
   connection and reloading.** It shows a line first ("Bracemark was updated in another tab")
   and waits for the dirty-editor guard, but it can't wait long, because it
   can no longer save. Nothing in lint, types or tests notices this is
   missing. The symptom is one tab of an existing user silently failing to
   save after a deploy.

   **⚠ The handler has to be in the build being replaced, not the one
   replacing it.** `versionchange` fires in the _old_ tab, so the old code is
   what must handle it. It has to ship in the **first build users run**, well
   before the first `version(2)`, or the first schema bump hits every open tab
   with no handler. This is why it's in [build order](#build-order) ahead of
   anything that needs it. [local-first-sync.md](./local-first-sync.md),
   _schema changes_, carries the matching rule from the schema side.

### sign-out leaves the worker alone

**Don't unregister on sign-out, and don't clear its caches.** Once the worker
caches only the app, it holds nothing about the account. What it holds is
identical for every user of the origin. Unregistering would take offline
support away from the next sign-in and re-download the precache for nothing.
The IndexedDB wipe already covers everything sign-out owes the user
([data-lifecycle.md](./data-lifecycle.md), _the sign-out teardown_).

This depends on the cache rule above. If the worker ever caches data again,
the sign-out teardown has to clear that cache, and this section has to be
rewritten.

### storage durability — verify before promising

Reachability is worthless if the browser throws the data away. Two things to
settle before the claim covers every browser:

- **Ask for persistence.** Call `navigator.storage.persist()` after sign-in.
  Chrome grants it based on engagement or installation, Firefox asks the user,
  and a persisted origin is not evicted under storage pressure.
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
  and export on Android ([e2e.md](./e2e.md)).
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
- **Updates:** the browser restarts every part of the extension together on
  update, so no two versions ever run side by side. Its IndexedDB belongs to
  the extension's own origin, so it never shares a database with a web tab.
  Nothing from _version skew_ applies.
- **Boundary: no export.** The popup is quick-save plus a recent list, and the
  options page is account and theme ([browser-extension.md](./browser-extension.md)).
  If the server disappeared, the extension's local copy couldn't be exported
  from the extension. That's accepted: the extension has no library view, so
  it isn't anyone's only client. The library a user reads is on web or mobile,
  and that's where export lives. If the extension ever gains a library view,
  it gains an export in the same change.
- **The 401 rule:** the MV3 background worker never wipes. See
  [sessions.md](./sessions.md), _who acts on a 401_.

### testing

`e2e-pwa` ([e2e.md](./e2e.md), _the PWA target_) is the only run that meets the
worker. It gains:

- **A normal tab, cold, never warmed.** Registration happens after sign-in in
  a normal tab, not standalone, and the case **never visits Settings while
  online**. `PWA-003` today reaches Export after an online launch that fills
  `defaultCache`, so it can't tell "the precache supplies Settings → Data"
  apart from "the runtime cache remembered it". This case can.
- **No cross-origin entries.** After a full online session (sync, images,
  entitlement), `caches.keys()` has no `cross-origin` cache and no entry for
  the api's or the extractor's origin.
- **Update on reload.** Serve build A, then build B. One reload in one tab
  runs B. A second tab that stayed open shows the pill and still works.
- **`versionchange`.** A build with `version(2)` opened beside a tab on
  `version(1)`: the old tab reloads into the new build and loses no queued op.
  This is the specimen for the ⚠ rule, and it needs the handler in build A,
  which is the point.
- **A query-string cold load**, for the verify item above.

### build order

Each step is safe on its own. The order is set by what the next step depends
on:

1. **The cache rule.** Cross-origin requests go to the network only. This comes
   first because every later step widens who has the worker.
2. **The `versionchange` guard**, on `bracemark-data` (Dexie) and
   `bracemark-session` (raw IndexedDB), both in `@stxapps/web-react`. The
   browser extension inherits it harmlessly, since nothing there triggers it.
   It must ship before launch.
3. **`skipWaiting: true`** plus the reload pill.
4. **Register after sign-in**, with the PNG `globIgnores` and, if the verify
   item confirms it, `ignoreURLParametersMatching`.
5. **`navigator.storage.persist()`** after sign-in, then the Safari measurement.

Once step 4 ships, [sessions.md](./sessions.md) and this doc's platform table
show the fresh-tab row as working, and the landing page's claim holds without
a qualifier, apart from what the Safari measurement finds.
