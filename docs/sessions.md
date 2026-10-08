## sessions

How long a signed-in device stays signed in, what ends a session, and, most
importantly, **what is allowed to wipe a device**. The session is the one piece
of server state a local-first client depends on, and whether its data survives
turns on how that dependency is handled. This doc covers the lifetime (sliding,
server-decided), explicit revocation versus expiry or an unknown token, and what
the client does about each. The promise all of it serves: **a library already on
a device outlives the server.**

Neighbours: [account.md](./account.md) (the credential and key model a session
is minted from), [data-lifecycle.md](./data-lifecycle.md) (the sign-out teardown
that a revocation runs, and _delete account_), [local-first-sync.md](./local-first-sync.md)
(what the device holds and what a paused sync owes on resume),
[api-contracts.md](./api-contracts.md) (the auth-aware fetch),
[share-sheet.md](./share-sheet.md) (the iOS **share extension's** session mirror),
[browser-extension.md](./browser-extension.md) (the **browser extension's** own
sign-in), [offline-mode.md](./offline-mode.md) (the other half of the
dead-server promise: whether the library can still be opened).

> **STATUS — built, not yet deployed.** The api answers the three session codes
> and slides the idle window (`middleware/auth.ts`, `services/session.ts`),
> revocation is a retained marker (`sessions` migration `0002_revoked_at.sql`),
> cleanup runs from a daily cron (`worker.ts` `scheduled`), and every client —
> bracemark-web, the browser extension, bracemark-expo and its iOS share
> extension — keeps its library on anything but its own sign-out or a
> `session_revoked` for the generation it holds. See [what this
> replaced](#what-this-replaced). The marketing site's pages that describe this
> design (/privacy _How long we keep it_, /delete-account _What is deleted_ and
> _What is kept_, the _Sign out_ help page, the FAQ's _Can I change my
> password?_) are now true of the code. **The database and bracemark-api are
> already deployed**, so the order at the next deploy matters: apply
> `0002_revoked_at.sql` to `SESSIONS_DB` before the Worker that reads
> `revoked_at` goes out ([hosting.md](./hosting.md), _deploying the workers_;
> `tools/scripts/deploy-worker.sh` applies migrations first), and the cron
> trigger ships with that deploy. Server schema changes stay append-only
> ([local-first-sync.md](./local-first-sync.md), _schema changes_).

### the promise, and the rule that carries it

The marketing site's landing page, in its _If we disappear_ band, says: "The
library does not need us to be reachable in order to open." That sentence is
only true if nothing on the device ever decides by itself that the user's data
has to go. Three things could:

1. **the client's clock**, which today wipes 30 days after sign-in whether or
   not the server is alive;
2. **a 401 from something that isn't us**, such as a proxy, a gateway error
   page, or whoever holds the domain after we are gone;
3. **a 401 from us that means "sign in again"** rather than "this device must
   forget".

This design removes all three. What is left:

**⚠ Session handling wipes an account's local store only for (a) an explicit
sign-out on that device, or (b) a 401 from bracemark-api carrying
`session_revoked` for the session generation still stored on that device.
Expiry and unknown tokens preserve data. A clock, another status, a codeless
401, `session_expired`, or `session_unknown` must never trigger a wipe.**

Explicit _delete all data_ and _delete account_ remain separate user actions
([data-lifecycle.md](./data-lifecycle.md)). Finishing an interrupted teardown
must also preserve this account/generation boundary; a storage read failure is
not proof that the device was signed out.

This rule is silent. Break it and no lint, type or test failure follows. The
cost only shows up when the server is unreachable for good and a user's only
copy erases itself on the next launch. The one specimen is the code this design
replaces: a `s.expiresAt > Date.now()` check at hydrate time that looked like
tidy housekeeping and was actually a timed delete of every user's library.

### lifetime — sliding, idle-based, decided by the server

| constant           | value    | meaning                                                                         |
| ------------------ | -------- | ------------------------------------------------------------------------------- |
| `SESSION_IDLE_MS`  | 90 days  | expiry window measured from the last successful renewal                         |
| `SESSION_SLIDE_MS` | 1 day    | minimum interval between successful renewals of one session                     |
| `SESSION_PURGE_MS` | 365 days | retention after expiry for unrevoked rows, or after revocation for revoked rows |

`SESSION_PURGE_MS` is a public promise, so its number lives in `@stxapps/shared`
as `SESSION_RETENTION` (`auth/sessions.ts`): `days` for the api's cleanup
(`SESSION_PURGE_MS` is `days` in ms), `label` for /privacy and /delete-account,
which say "a year" by reading it. A spec pins the two together.

An authenticated request may move the session's `expires_at` to
`now + SESSION_IDLE_MS`, at most once per `SESSION_SLIDE_MS`. The guard does
this in `requireAuth`, `middleware/auth.ts`, through `renewSession`
(`services/session.ts`) and `sessionsRepo.renew`. The shape:

- **Throttled atomically.** The read can skip an unnecessary renewal, but the
  `UPDATE` itself must require `revoked_at IS NULL`, `expires_at >= now`, and
  `expires_at < now + SESSION_IDLE_MS - SESSION_SLIDE_MS`, and equality with
  the expiry read when the request authenticated. The equality check prevents
  a delayed renewal from undoing a password change: the request timestamp
  predates that change, so a timestamp predicate alone still accepts its newly
  expired deadline. Concurrent requests
  can read the same old expiry; the SQL predicate makes only the first renewal
  change the row. Use a consistent server timestamp and never resurrect an
  expired or revoked session. This bounds successful renewals, not the number
  of attempted SQL statements under concurrency.
- **Primary reads today.** The repository uses direct D1 `prepare()` calls.
  [D1 read replication](https://developers.cloudflare.com/d1/best-practices/read-replication/)
  requires the Sessions API (`withSession()`); direct calls execute on the
  primary. Replica reads would be a separate design change that must address
  revocation freshness and read-after-sign-in consistency.
- **Off the critical path.** Fire the `UPDATE` through `c.executionCtx.waitUntil`
  and handle/report its failure. The already-authorized request can finish,
  but a failed renewal leaves the old deadline intact. A later request retries
  while the session remains valid; a failure near expiry can require sign-in.
  Where there is no execution context (`app.request()` in the specs) the
  renewal is awaited inline instead.
- **`last_seen_at` moves with it.** The column already exists and was waiting
  for this. It will serve a future sessions/devices list.

**Sliding alone needs no new columns.** `expires_at`, `last_seen_at` and
`idx_sessions_expires_at` already existed. The explicit revocation marker below
is the append-only migration `0002_revoked_at.sql` (plus
`idx_sessions_revoked_at`, cleanup's second clock), folded into
`db/schemas/sessions.sql`.

Regular successful authenticated traffic keeps a session alive. Opening the
app offline does not renew it, and a 90-day window is not a guarantee for every
three-calendar-month visit. Throttling can leave the deadline up to a day behind
the latest request even when writes succeed.

**Why idle expiry, and what it does not protect.** It bounds the lifetime of an
unused credential. An attacker using a stolen token also generates authenticated
traffic and can keep renewing it after the real device stops. Background sync
also counts as activity; this is API inactivity, not human inactivity.

This design chooses **no absolute session-age cap** for convenience. That accepts
the risk of an actively abused token remaining usable until explicit revocation;
an absolute cap or credential renewal would provide a different security tradeoff.
[OWASP's session guidance](https://cheatsheetseries.owasp.org/cheatsheets/Session_Management_Cheat_Sheet.html)
describes this limitation of idle timeouts. The 90-day idle window is a product
choice, not a claim that idle expiry alone stops token theft. Expiry costs a
sign-in, never local data.

### revocation, expiry and unknown tokens

The guard tells four failure cases apart and answers each with its own code. All
are 401s in the uniform error envelope (`{ "error": "<code>" }`,
`apps/bracemark-api/src/lib/errors.ts`):

| case                              | code              | client does                                                        |
| --------------------------------- | ----------------- | ------------------------------------------------------------------ |
| no `Authorization: Bearer` header | `unauthorized`    | nothing (it didn't send a token)                                   |
| token hash matches **no row**     | `session_unknown` | **keep everything**, enter the expired state                       |
| row found, `revoked_at` is set    | `session_revoked` | **wipe** only if the request's session generation is still current |
| unrevoked row, `expires_at < now` | `session_expired` | **keep everything**, enter the expired state                       |

The codes live in `@stxapps/shared` (`SESSION_ERROR`, `auth/sessions.ts`), so the
API and both client stacks import one constant rather than retyping a string.
The same module turns a response into a verdict (`sessionVerdictFromResponse`:
`session_revoked` → `revoked`; `session_expired` and `session_unknown` →
`expired`; anything else, including a codeless or foreign 401, → `null`).

**Why a marker, and not "no row means wipe"?** Deleting the row already revokes
API access: today's guard rejects both missing and expired rows with
`401 unauthorized`. What a deletion can't do is say _why_ the row is gone. A
missing row is the absence of a message, not a message, and rows go missing
when nobody chose it:

- **cleanup**: under "no row means wipe", an expired row could never be
  deleted, or a device idle past cleanup would get the clock wipe back with a
  longer fuse;
- **the database lost, or recreated empty**: [server-backups.md](./server-backups.md)
  keeps no copy of it;
- **a backward restore**, which drops every row newer than the restore point;
- **a bug**: a changed token hash, a bad migration, or a deploy bound to the
  wrong database makes every token unknown at once;
- **the public repo**: anyone who deploys the AGPL code with an empty database
  at our domain after we're gone answers "no row" to every token. That is the
  _If we disappear_ scenario exactly.

Under "no row means wipe", each of these erases every device that comes back,
pending ops included. With a marker, each costs a sign-in. The marker costs one
nullable column, one append-only migration, a two-case cleanup predicate, and
a year of retained rows that the public pages disclose. If remote wipe were
dropped entirely, deleting rows would be enough and no column would be needed;
this design keeps remote wipe, so it keeps the evidence. Being prelaunch
removes client compatibility work, not this distinction.

**Revocation needs a retained marker.** Nullable `revoked_at` on the sessions
table, returned by the repository; the guard checks revocation before expiry.
The three deletion paths are explicit revocation writes, including for
already-expired rows: `revokeSession` (sign-out), `revokeOtherSessions` (_sign
out other devices_), and `revokeAllSessions` (delete account). Each keeps the
original revocation timestamp on retries (`COALESCE(revoked_at, ?)`). The row
survives account teardown so an old token can still receive the verdict;
/delete-account and /privacy say so.

**Changing the password expires the other sessions; it doesn't revoke them.**
`changePasswordDoor` has its own write, `expireOtherSessions`: move `expires_at`
into the past (`MIN(expires_at, now - 1)`) on every other unrevoked session,
never forward, and never touch `revoked_at`. That cuts off whoever had the old
password as completely as revocation does. An expired row can't authenticate,
and the renewal predicate (`expires_at >= now`) won't revive it. What it
doesn't do is wipe. A password change is routine hygiene or a response to a
leak, and neither is a reason to destroy edits the user's own phone hasn't
synced yet. In the leak case, the one device that should forget, the
attacker's, would never cooperate with a wipe anyway. The other devices enter
the expired state and resume with the new password; the DEK is unchanged, so
resume is the ordinary path. _Sign out other devices_ stays a revocation: it
is the control whose purpose is to make a lost device forget.

**Cleanup never turns inactivity into a wipe.** Delete unrevoked rows only when
`expires_at < now - SESSION_PURGE_MS`, and revoked rows only when
`revoked_at < now - SESSION_PURGE_MS`. A device returning after either purge
gets `session_unknown`: preserve its library and pending ops and ask it to sign
in. Its latest edits may never have reached the server.

**What a remote wipe can't reach, and why that's accepted.** A revoked device
keeps its copy when:

- it doesn't reach the API within `SESSION_PURGE_MS` of the revocation;
- its row was purged before a later account-wide revocation (it can't
  authenticate either);
- the sessions table was lost or emptied (_the sessions database_, below);
- it is offline for good, or controlled by an attacker. No protocol erases a
  device that won't cooperate.

The trade is deliberate. A missed wipe leaves a copy the device already had; a
wrong wipe destroys what may be the only copy, and can't be undone. Extending
delivery means longer marker retention or a different revocation protocol, never
mapping absence to revocation.

- Cleanup is `sessionsRepo.purge` (the two retention cases above), run by
  `purgeSessions` from the `scheduled` handler in
  `apps/bracemark-api/src/worker.ts`, on a `triggers.crons` entry declared in
  each env of `wrangler.jsonc` (daily, `17 3 * * *`); see
  [hosting.md](./hosting.md) before deploying. `wrangler dev` never fires it; `curl
"http://127.0.0.1:8787/cdn-cgi/handler/scheduled"` does. The same cron is the
  natural home for the orphan-claim and tombstone-teardown sweepers
  ([data-lifecycle.md](./data-lifecycle.md), _deferred_).
- ⚠ **No missing row is evidence of revocation.** Cleanup, a restore, and an
  unrecognized token all take the same non-destructive `session_unknown` path.
  Retention changes affect how long revocation can be delivered, never whether
  an ordinary expired device keeps its data.

**Only our own code counts.** The client branches on
`sessionVerdictFromResponse` (`packages/shared/src/auth/sessions.ts`), which
returns null for any body that isn't our JSON envelope with one of the three
codes. So a proxy's HTML 401, a gateway's error page, or a parse failure is just
a failed request, handled like any other network error: the sync cycle fails and
retries later. A bare `res.status === 401` check — what `authFetch` did before
this design — is exactly what this rule forbids.

**Residual trust.** A server that sends our exact `session_revoked` envelope can
wipe a device that reaches it with the matching current session. This protocol
trusts the API origin's verdict; parsing our envelope is not independent proof
of who issued it. TLS, domain control and Cloudflare protect that origin. A wipe
can lose unsynced edits permanently, even if the account still exists. The code
check prevents an unrelated HTML 401 from triggering a wipe; it does not defeat
a malicious replacement server that deliberately copies the envelope.

### the sessions database — never restored backward

**⚠ Never restore `SESSIONS_DB` to an earlier point. If it is damaged, empty the
`sessions` table.** D1 Time Travel is always on and can't be turned off, so
`wrangler d1 time-travel restore` is always one command away, and here it is
the wrong one. Revocation and the password-change expiry are writes, so a
restore to before them undoes them. A phone signed out through _Sign out other
devices_ after it was lost authenticates again, and so does a session the old
password minted. Nothing flags it: the restored rows are well-formed, and the
guard accepts them.

Emptying the table is safe because of the rule this doc is built on. Every
device gets `session_unknown`, keeps its library and pending ops, and signs in
again. The cost is the pending remote wipes the table carried, which go with
it (_what a remote wipe can't reach_, above). Losing the database outright
costs the same. [server-backups.md](./server-backups.md) carries the rule from
the backup side. (Before this design the reverse was true — clients wiped on any
401 — so the safety of emptying the table holds only for clients that run this
code; there are no older builds in users' hands.)

### the expired state on the client

A session is `active`, `expired`, or absent (signed out). Both `session_expired`
and `session_unknown` enter `expired`, meaning reauthentication is required.
The client stores that state alongside the session record, so a relaunch
doesn't repeat a sync cycle it already knows will fail.

In **expired**:

- The library opens, reads, searches, **edits** and **exports** exactly as it
  does offline. Edits queue as pending ops, as they do offline.
- Sync pauses. The engine schedules no cycles.
- A persistent notice says sync is paused and offers **Sign in to resume**.
  The sign-in form is pre-filled with the stored username, and the username is
  locked. See [accessibility.md](./accessibility.md) before writing the notice.
- **One probe per launch or return to foreground, when online:** a single
  authenticated request with the old token — `GET /v1/auth/session`
  (`sessionProbeEndpoint`), whose only answers are the guard's. It keeps
  answering `session_expired` while its expired row is retained,
  `session_unknown` after purge, or `session_revoked` while an explicit
  revocation marker is retained. Only the last answer can wipe, subject to the
  generation check below. Without the probe, an expired device would never
  receive a retained revocation. A failed or codeless probe preserves the
  current state and all local data. The auth providers fire it on launch, on
  `visibilitychange`/`online` (web) and on `AppState` `active` (expo).

Where the notice and the resume live: bracemark-web's
`components/sync-paused-notice.tsx` under the links topbar and at the top of
Settings (resume in a dialog, over web-ui's `SignInForm lockedUsername`);
bracemark-expo's `components/sync-paused-notice.tsx` on the links screen and in
Settings → Data, with resume as the `/resume` modal route; the browser
extension popup's sync pill ("Sync paused — sign in to resume") and its detail
view, with a `Resume` view. The sync indicator's `BgSyncStatus` is `paused`
(`@stxapps/shared` `sync/status.ts`) — not `error`, not `idle`. A first sync the
pause interrupted keeps the initial-sync gate closed with the same two actions.
The words are `SESSION_COPY` (`packages/react/src/lib/session-copy.ts`).

**Resume** is a normal sign-in (password or recovery code) with the username
locked to the stored one. On success the client replaces the token (and the
re-derived key, which is the same DEK) in the record, sets it back to `active`,
**keeps the local store**, and runs a sync cycle that pushes whatever queued
while paused through the normal reconcile/push/pull order. Preserve the sync
cursor and local data; normal reconciliation may download records changed on
other devices, including a fallback listing if the cursor is too old.

- **Same username is enough, today.** Usernames are unique and never released
  after deletion ([data-lifecycle.md](./data-lifecycle.md), _deferred_:
  username release after a cooldown), so a username names one account for
  good. ⚠ **If username release ever ships, resume must compare the server's
  `userId` instead**. Otherwise a device holding one account's library could
  resume into a different account that reclaimed the handle. That change is a
  `userId` in the sign-in response and in the session record.
- **"Use a different account" is sign-out.** It runs the full teardown and
  warns first if pending ops exist. Their only copy is this device. The
  ordinary sign-out warns the same way on every client, and only then — a live
  session can still sync, so its copy says "cancel and sync first" where this
  one says "sign in to resume" ([data-lifecycle.md](./data-lifecycle.md), _the
  press, and the wait_).
- **Resume can fail for good.** If the account was deleted and this device's
  marker already purged, the probe answers `session_unknown`, and sign-in can
  never succeed: a deleted username answers exactly like one that never
  existed ([data-lifecycle.md](./data-lifecycle.md), _delete account_). The
  client can't tell that from a mistyped password and must not guess. A failed
  resume leaves the expired state as it was: the library stays readable and
  exportable, the notice stays, and _Use a different account_ is the way out.

### concurrent requests and shared local state

**⚠ A verdict belongs to the session that sent the request.** Capture a local
session generation together with its token for each request and probe. Resume
replaces the token and advances that generation atomically in the persisted
session record. Before an
expiry or revocation changes state, compare its generation with the persisted
current generation under the same lifecycle lock used for replacement and wipe.
A delayed response for the old token must not expire or erase the resumed session.
Never include raw tokens in cross-context notifications or logs.

As built: the generation is an opaque local string (`newSessionGeneration`,
compared for equality only, never sent anywhere); `authFetch` captures it with
the token and reports `{ verdict, generation }`; the auth provider decides under
`withSessionLock` against the persisted record (`session-store.ts` in both
stacks).

On web, each tab currently has its own in-memory session mirror. Persisting the
new state alone does not refresh another tab. The implementation must coordinate
all contexts sharing the session/data databases, including the browser extension's
popup, options page and background worker on their own origin:

- Publish a session-change notification and re-read the persisted record on
  notification and foreground. Notifications are wake-ups, not the source of truth.
- Serialize resume, sign-out and revocation teardown across those contexts.
  Re-read the generation after acquiring ownership; only one owner performs a
  teardown, and a new account cannot be adopted until it completes.
- Stop scheduling old-generation sync and fence in-flight completions and local
  writes before wiping or switching accounts. A sleeping tab or background worker
  that missed a notification must not write into the new account's store. Do not
  rely on aborting a fetch alone to cancel its already-running continuations.
- Resume in another tab must refresh the token and state without clearing local
  data. Sign-out must close the old account's UI and writers in every context.

As built on the web (`packages/web-react/src/data/session-store.ts`,
`contexts/auth-provider.tsx`): the lifecycle lock is a Web Lock
(`bracemark-session-lifecycle`, spanning every context of the origin, with an
in-context queue where Web Locks are missing); the notification is a
`BroadcastChannel` (`bracemark-session`) carrying the generation or `null` and,
for a teardown, its reason — never the token; every context re-reads the record
on a notification, on `visibilitychange` and on `pageshow`. A teardown deletes
the record, announces it, then wipes, so a context that learns of it only closes
its UI and never wipes a second time. A new account can't be adopted over
another one's library: `setSession` tears the old one down first, under the
same lock. A failed session read or failed cleanup aborts adoption, and a
retry with no session first finishes the old cleanup. The in-memory token
changes only after its durable write or delete succeeds. New-account seeding
also runs inside this lock, after cleanup. An explicit end names its target when
its action begins, and is decided under the lock like a server verdict: sign-out
names the generation whose token it sends, so a resume while its request is in
flight survives the late local step; delete-account names the account, so every
generation of it goes — but never an account adopted since. The target is an
argument to `endSession`, never read from the render that finishes the request:
a mutation's `onSuccess` runs the latest render's callbacks, not the ones that
were current when it started.

The lifecycle lock is not the only Web Lock on the origin. A sync cycle runs
under a second one, named per account (`bracemark-sync-cycle:<username>`,
[local-first-sync.md](./local-first-sync.md), _two tabs, one queue_), and the
two are kept apart on purpose: hydration takes the lifecycle lock on every
startup, so a cycle that held it across its round trips would hold the app blank
behind another tab's sync. A cycle never takes the lifecycle lock, and nothing
under the lifecycle lock waits for a cycle; a teardown stops a cycle through the
fence below, not by waiting for it.

In-flight completions are fenced **in the database**, not by
aborting fetches: every pulled write re-checks, inside its own transaction, that
the account's sync bookkeeping row still exists (`AccountFencedError`,
`data/sync-store.ts`). Local entity writes, imports, and commit restamps check
the same ownership. The row is claimed only under the lifecycle lock and only
for the persisted account: by `setSession` before it exposes the session, and —
for a session an older build adopted without one — by the sync provider just
before a first pull (`claimIfStillSignedIn`), which re-reads the record and
claims nothing if it has moved on. So a sync cycle cannot recreate ownership
after a teardown. **Hydration never touches the data store**: a wait there — a
long transaction in another tab, a newer build's upgrade — would hold the app
blank, and the lifecycle lock with it, for as long as it lasts
(`SKELETON-WEB-001` holds the `items` store from a second tab, and a startup
claim left the page empty behind it). The web
teardown clears ownership and data in one transaction, so a write either lands
first and is wiped, or sees no ownership and fails. Expo applies the same
transactional checks in its sqlite store, and an in-process queue as its lock.
Each sync-provider effect owns its cancellation flag, so a replacement effect
cannot let an old completion overwrite the paused state.

Expo applies the same generation rule to requests in the main process. Update
the shared-Keychain mirror with the state; retain the outbox's existing account
boundary. The exact
cross-context locking and notification mechanism is implementation work, but
these races are acceptance requirements, not optional follow-up hardening.

### who acts on a 401 — the lifecycle owner, only

Only the process running the `AuthProvider` writes session state or wipes: the
web app, the browser extension's popup and options pages, and the Expo app's
main process. Two other processes carry the token and must **never** act on it:

- the **browser extension's** MV3 background worker (`background.ts` calls
  `loadSession()` but has no provider), and
- the iOS **share extension** (`loadSharedSession()`, which reads the
  shared-Keychain mirror, [share-sheet.md](./share-sheet.md)).

On any 401 they stop (the share extension's outbox file is already the record
of truth, and the main app drains it). Both **read** the stored state: when it
is `expired` they don't call the API at all — the browser extension's
`utils/sync-runner.ts` mirrors `paused` and returns, and the share extension's
`uploadQueuedDraft` (`share-store.ts`) skips the upload. That replaced a
`session.expiresAt <= Date.now()` check there, which was a clock check and fell
under the rule above. A verdict their requests provoke reaches no listener: they
run no `AuthProvider`.

### the contract

- **`expiresAt` is off the wire.** It is gone from `createAccountResponseSchema`
  and `signInResponseSchema` (`packages/shared/src/auth/endpoints.ts`, which now
  answer `{ token }`), and from `SessionRecord` in both session stores
  (`packages/web-react/src/data/session-store.ts`,
  `packages/expo-react/src/data/session-store.ts`, including the latter's
  `PersistedSession` and `parse`). A client with no expiry to read cannot wipe
  on one, and that structural guarantee is worth more than a comment
  saying not to. The server keeps `expires_at` for itself.
- **The three session codes are in `@stxapps/shared`** (`SESSION_ERROR`), and
  `requireAuth` emits them. `unauthorized` keeps its meaning, "no bearer token".
- **`GET /v1/auth/session`** (`sessionProbeEndpoint`) is the probe's address:
  `requireAuth` and `{ ok: true }`, nothing else.
- **State and generation are persisted** in both client session records; the
  iOS share extension's mirror carries the state. Local lifecycle notifications
  carry the generation; they are not new server authentication credentials.
- **A persisted record from before the change** has a stale `expiresAt` and no
  state field. Both stores read it as `active` with an empty generation (the
  `expiresAt` is dropped unread, and never written back), and the auth provider
  assigns and persists a generation under the lifecycle lock — never treating it
  as corrupt. Expo's `parse()` no longer requires `expiresAt`.

### the dead-server path

With the rule above, "the server is gone" is just offline that never ends. This
doc owns only the promise that nothing **wipes**. Whether each platform can
still **open** the library with the origin gone (the per-platform table,
bracemark-web's service worker, the browser extension's missing export, the
Safari question) is [offline-mode.md](./offline-mode.md), _the promise_. The
landing page's claim needs both docs' rules to hold.

### what this replaced

The implementation replaced the local-clock/blanket-401 paths and changed the
server's revocation and cleanup contracts. Kept here as the list of specimens,
because each looked harmless:

- `packages/web-react/src/contexts/auth-provider.tsx` — the hydrate branch
  `s.expiresAt > Date.now()` and its `clearData()` for a stored-but-expired
  session. The **no-session** residue cleanup stays, deciding on a read made
  under the lifecycle lock; a failed read throws past it, so it never clears.
- `packages/web-react/src/data/session-store.ts` — `getToken()`'s expiry check.
- `packages/web-react/src/lib/auth-api-client.ts` — the branch that treated "no
  token but a record" as an expiry, and `res.status === 401` without a code.
- `packages/expo-react/src/contexts/auth-provider.tsx`,
  `packages/expo-react/src/data/session-store.ts`,
  `packages/expo-react/src/lib/auth-api-client.ts` — the same three, mirrored.
- `packages/expo-react/src/data/share-store.ts` — the share extension's clock check.
- `EndReason`'s `'expired'`, now `'revoked'`: `AuthGuard`
  (`apps/bracemark-web/src/components/auth-guard.tsx`,
  `apps/bracemark-expo/src/components/auth-guard.tsx`) sends a revoked device
  to sign-in, which says this device was signed out (`SESSION_COPY.revoked`). An
  expired device never leaves the app.
- `SESSION_TTL_MS` in `services/session.ts`, now `SESSION_IDLE_MS`.
- The session repository's revocation deletes, now marker writes, and
  `deleteExpired`, now `purge` with its two retention clocks.
- `changePasswordDoor` (`services/account.ts`) calling `revokeOtherSessions`;
  it expires the other sessions instead.
- The change-password confirmation in both `account-section.tsx` files, which
  said the other devices "have been signed out"; it now says they keep their
  copy and ask for the new password (`SESSION_COPY.passwordChanged`), as the
  marketing site's _Sign out_ help page and FAQ already did.

The docs this touched: [account.md](./account.md) (the replay-window note and
the door-rotation STATUS note), [data-lifecycle.md](./data-lifecycle.md) (the
sign-out teardown's triggers, _delete account_, _deferred_),
[api-contracts.md](./api-contracts.md) (the `authFetch` row),
[share-sheet.md](./share-sheet.md), [browser-extension.md](./browser-extension.md),
[e2e.md](./e2e.md). [server-backups.md](./server-backups.md) already carried the
restore rule.

### testing

The layers ([testing.md](./testing.md)), and where each part of the rule is pinned:

- **api (vitest):** `middleware/auth.spec.ts` — the guard's four failure codes;
  revocation before expiry; renewal sliding a due session, writing nothing
  inside the slide window, changing the row once under five concurrent
  attempts, never reviving a revoked or expired row, and a failed renewal
  letting the request through with the old deadline; the original revocation
  time kept on retry; an already-expired session revoked; account-wide and
  except-caller revocation; the password-change expiry (never revoked, never
  moved forward, the caller untouched); cleanup on both retention clocks, and a
  purged token — revoked or not — answering `session_unknown`.
  `routes/auth.spec.ts` drives the same through the routes (sign-out, sign out
  other devices, delete account, change password, the probe, `{ token }` with no
  expiry on the wire). `worker.spec.ts` runs the cron entry.
- **shared (jest):** `auth/sessions.spec.ts` — the rule as a table:
  `session_revoked` → wipe-eligible; `session_expired` and `session_unknown` →
  keep; a codeless 401, an HTML 401, another code, our code on another status →
  nothing. `sync/status.spec.ts` — `paused` outranks every cycle outcome and is
  neither `error` nor `idle`.
- **clients (jest):** per stack, `lib/auth-api-client.spec.ts` (web) — the same
  table through a real `api.call`, a network error, the generation captured at
  send and not at arrival, no clock; `contexts/auth-provider.spec.tsx` (both
  stacks) — `session_revoked` for the current generation wipes and says why,
  expiry keeps everything and persists `expired`, a replaced generation's
  verdicts do nothing, a record two years old on the device clock hydrates
  signed in, a pre-redesign record gets a generation, a failed read doesn't
  wipe, bursts collapse, the probe fires on launch and foreground, resume keeps
  the store, a different account is torn down before it's adopted, and (web)
  another context's teardown or resume is adopted without a second wipe;
  `data/session-store.spec.ts` (both); `contexts/sync-provider.spec.tsx` (web) —
  paused runs no cycle; the account fence in `sync/engine.spec.ts` and
  `data/sync-store.spec.ts` (web) and `data/sync-store.spec.ts` (expo) — a
  teardown mid-cycle or mid-first-sync leaves nothing written;
  `data/share-store.spec.ts` (expo) — while the session is `expired`, a share
  saves and sends nothing: no upload from the iOS **share extension**, no sync
  cycle from the Android share activity, each with an `active` control.
- **e2e ([e2e.md](./e2e.md)):** `SESSION-INVALID-WEB-001` (revoked → wiped,
  sign-in says why) and `SESSION-INVALID-NATIVE-001` (revoked, on device);
  `SESSION-EXPIRED-WEB-001` — expired by a password change on another profile,
  the library kept in two tabs, an edit queued while paused, the state surviving
  a reload, resume in the OTHER tab with the new password picked up by the
  first, and the queued edit reaching a fresh reader; `SESSION-UNKNOWN-WEB-001`
  — the stored token replaced by one the server never issued (what a purge looks
  like from the device), an unsynced edit kept and pushed after resume;
  `WEB-ACCOUNT-003` — a session two years old on the device clock is signed in
  with its library; and `PWA-003` now runs its dead-origin export with the
  device clock two years ahead — the specimen for the rule.
- `SESSION-EXPIRED-NATIVE-001` — the same expiry on a device (the runner
  changes the password from a web profile, the flow pauses, saves a link,
  resumes through the `/resume` modal, and the runner reads the link from the
  web). Passes on the iOS simulator and the Android emulator.
- `SESSION-UNKNOWN-NATIVE-001` — the unknown token on a device. The device's
  Keychain/Keystore is out of the runner's reach, so where the web case forges
  the stored token this one deletes the account's session rows from local D1
  (`e2e/seed/sessions.ts`) — the purge's own write. It reuses the expired
  case's paused and resume parts, resuming with the same password. Passes on
  the iOS simulator and the Android emulator.
- `SESSION-RACE-WEB-001` — a delayed sign-out and revoked response arrive
  after resume in another tab; the replacement session and its unsynced edit
  survive, including reload.
- `WEB-ACCOUNT-004` — two accounts in turn on one profile: the second starts
  empty and writable, the first returns to only its own library. The sequential
  account switch; its RACES are the line below.
- **Not covered end to end:** the sleeping-tab /
  in-flight-sync / account-switch races, which are pinned at the unit level by
  the account fence and the generation checks rather than driven in a browser.
  Nor is **idle expiry** as such: the client can't tell it from a
  password-change expiry (both are `session_expired`, and the client reads no
  clock), and the server half — an unrevoked row past `expires_at` — is pinned
  in `middleware/auth.spec.ts`. An e2e case for it would re-run
  `SESSION-EXPIRED-*` under another name.
- **By hand, on a real device:** revoke with _Sign out other devices_ and
  expire with _Change password_ from bracemark-web, as the e2e runner does. For
  what those can't reach (one session revoked alone, idle expiry with the
  password unchanged, an unknown token), `tools/scripts/dev-session.sh`
  `expire` / `revoke` / `forget` writes the local dev sessions database the way
  the api would; `list` finds the device's session id. Local only.
