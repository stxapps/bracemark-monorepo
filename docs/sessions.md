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

> **STATUS — designed, not built.** What runs today is a fixed 30-day session
> (`SESSION_TTL_MS` in `apps/bracemark-api/src/services/session.ts`), and every
> client wipes itself **on its own clock** once `expiresAt` passes, online or
> not. See [what this replaces](#what-this-replaces). There are no real users
> and no production launch yet, so the client contract can change directly.
> **The database and bracemark-api are already deployed**, however: server
> schema changes require new append-only migrations even before launch. See
> [local-first-sync.md](./local-first-sync.md), _schema changes_.

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

An authenticated request may move the session's `expires_at` to
`now + SESSION_IDLE_MS`, at most once per `SESSION_SLIDE_MS`. The guard does
this in `requireAuth`, `middleware/auth.ts`, which already carries a note asking
for exactly this shape:

- **Throttled atomically.** The read can skip an unnecessary renewal, but the
  `UPDATE` itself must require `revoked_at IS NULL`, `expires_at >= now`, and
  `expires_at < now + SESSION_IDLE_MS - SESSION_SLIDE_MS`. Concurrent requests
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
- **`last_seen_at` moves with it.** The column already exists and was waiting
  for this. It will serve a future sessions/devices list.

**Sliding alone needs no new columns.** `expires_at`, `last_seen_at` and
`idx_sessions_expires_at` already exist. The explicit revocation marker below
does need an append-only server migration and a matching canonical schema update.

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

The codes live in `@stxapps/shared` next to the auth endpoints, so the API and
both client stacks import one constant rather than retyping a string.

**Why a marker instead of deleting the row?** Deletion is already sufficient
to revoke API access: today's guard rejects both missing and expired rows with
`401 unauthorized`. It does not establish why a row is missing. Explicit
revocation, expired-session cleanup and missing records after database recovery
would all look identical to a client deciding whether to erase local data.

This design keeps both remote wipe on explicit revocation and cleanup of old
sessions, so it needs retained revocation evidence. A nullable `revoked_at` on
the existing row is the chosen representation. If remote wipe were dropped,
deleting the row and requiring reauthentication while preserving local data
would be simpler and would need no new column. Treating every missing row as
a wipe instruction would instead require retaining expired rows indefinitely
and accepting accidental wipes after session-record loss; that does not meet
this design's preservation rule. Being prelaunch removes client compatibility
work, not this distinction between future cleanup and explicit revocation.

**Revocation needs a retained marker.** Add nullable `revoked_at` to the sessions
table and return it from the repository. Check revocation before expiry. The
current deletion paths — `revokeSession` (sign-out), `deleteByUserIdExcept`
(sign out other devices, change password), and `deleteByUserId` (delete account)
— must become explicit revocation writes, including for already-expired rows.
Keep the original revocation timestamp on retries. The token hash and marker
must survive account teardown so an old token can still receive the verdict.

**Cleanup never turns inactivity into a wipe.** Delete unrevoked rows only when
`expires_at < now - SESSION_PURGE_MS`, and revoked rows only when
`revoked_at < now - SESSION_PURGE_MS`. A device returning after either purge
gets `session_unknown`: preserve its library and pending ops and ask it to sign
in. Its latest edits may never have reached the server.

This bounds remote-wipe delivery: the device must contact the API while its
revocation marker exists. A token purged before a later account-wide revocation
cannot receive that verdict either. It already cannot authenticate, but its
device copy survives. Remote wipe is best-effort for a cooperating client, not
a guarantee of erasure on an offline or attacker-controlled device. Extending
that delivery window requires longer marker retention or a different revocation
protocol; mapping absence to revocation is not an acceptable substitute.

- The starting point is `sessionsRepo.deleteExpired`, which exists but is not
  called. Replace its predicate with the two retention cases above. Wiring it
  up means a `scheduled` handler in `apps/bracemark-api/src/worker.ts` and a
  `triggers.crons` entry in `wrangler.jsonc` (daily is plenty); see
  [hosting.md](./hosting.md) before deploying either. The same cron is the
  natural home for the orphan-claim and tombstone-teardown sweepers
  ([data-lifecycle.md](./data-lifecycle.md), _deferred_).
- ⚠ **No missing row is evidence of revocation.** Cleanup, a restore, and an
  unrecognized token all take the same non-destructive `session_unknown` path.
  Retention changes affect how long revocation can be delivered, never whether
  an ordinary expired device keeps its data.

**Only our own code counts.** The client branches on `apiErrorCode(e)`
(`packages/shared/src/api/client.ts`), which returns null for any body that
isn't our JSON envelope. So a proxy's HTML 401, a gateway's error page, or a
parse failure is just a failed request, handled like any other network error:
the sync cycle fails and retries later. A bare `res.status === 401`
check, as `authFetch` has today, is exactly what this rule forbids.

**Residual trust.** A server that sends our exact `session_revoked` envelope can
wipe a device that reaches it with the matching current session. This protocol
trusts the API origin's verdict; parsing our envelope is not independent proof
of who issued it. TLS, domain control and Cloudflare protect that origin. A wipe
can lose unsynced edits permanently, even if the account still exists. The code
check prevents an unrelated HTML 401 from triggering a wipe; it does not defeat
a malicious replacement server that deliberately copies the envelope.

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
  authenticated request with the old token. It keeps answering
  `session_expired` while its expired row is retained, `session_unknown` after
  purge, or `session_revoked` while an explicit revocation marker is retained.
  Only the last answer can wipe, subject to the generation check below. Without
  the probe, an expired device would never receive a retained revocation. A
  failed or codeless probe preserves the current state and all local data.

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
  warns first if pending ops exist. Their only copy is this device.

### concurrent requests and shared local state

**⚠ A verdict belongs to the session that sent the request.** Capture a local
session generation together with its token for each request and probe. Resume replaces the token and
advances that generation atomically in the persisted session record. Before an
expiry or revocation changes state, compare its generation with the persisted
current generation under the same lifecycle lock used for replacement and wipe.
A delayed response for the old token must not expire or erase the resumed session.
Never include raw tokens in cross-context notifications or logs.

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

Expo applies the same generation rule to requests in the main process and to
reports from the iOS share extension. Update the shared-Keychain mirror with the
state/generation; retain the outbox's existing account boundary. The exact
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

Both only report back with the request's generation. On any 401 they stop (the
share extension's outbox file is already the record of truth, and the main app
drains it). Both **read** the
stored state: when it is `expired` they don't call the API at all. That replaces
the `session.expiresAt <= Date.now()` check at `share-store.ts:412`, which is a
clock check and falls under the rule above.

### the contract

- **`expiresAt` leaves the wire.** It comes out of `createAccountResponseSchema`
  and `signInResponseSchema` (`packages/shared/src/auth/endpoints.ts`), and out
  of `SessionRecord` in both session stores (`packages/web-react/src/data/session-store.ts`,
  `packages/expo-react/src/data/session-store.ts`, including the latter's
  `PersistedSession` and `parse`). A client with no expiry to read cannot wipe
  on one, and that structural guarantee is worth more than a comment
  saying not to. The server keeps `expires_at` for itself.
- **The three session codes are added to `@stxapps/shared`,** and `requireAuth`
  emits them. `unauthorized` keeps its current meaning, "no bearer token".
- **State and generation are persisted** in both client session records and
  the iOS share extension's mirror. Local lifecycle notifications carry the
  generation; they are not new server authentication credentials.
- **A persisted record from before the change** has a stale `expiresAt` and no
  state field. On Expo, `parse()` currently rejects a record missing
  `expiresAt`; when it stops requiring the field, it should treat a record
  without a state as `active`, assigning its generation under lifecycle
  coordination, not treating it as corrupt. There are no production client
  records, so this only matters for dev devices, but a corrupt-read path that signs a
  developer out is noise worth avoiding.

### the dead-server path

With the rule above, "the server is gone" is just offline that never ends. This
doc owns only the promise that nothing **wipes**. Whether each platform can
still **open** the library with the origin gone (the per-platform table,
bracemark-web's service worker, the browser extension's missing export, the
Safari question) is [offline-mode.md](./offline-mode.md), _the promise_. The
landing page's claim needs both docs' rules to hold.

### what this replaces

The implementation replaces the local-clock/blanket-401 paths and changes the
server's revocation and cleanup contracts:

- `packages/web-react/src/contexts/auth-provider.tsx` — the hydrate branch
  `s.expiresAt > Date.now()` and its `clearData()` for a stored-but-expired
  session. The **no-session** residue cleanup stays, but must recheck the
  persisted absence under lifecycle coordination before clearing anything.
  A failed read or a concurrent sign-in must not take that branch.
- `packages/web-react/src/data/session-store.ts` — `getToken()`'s expiry check.
- `packages/web-react/src/lib/auth-api-client.ts` — the branch that treats "no
  token but a record" as an expiry, and `res.status === 401` without a code.
- `packages/expo-react/src/contexts/auth-provider.tsx`,
  `packages/expo-react/src/data/session-store.ts`,
  `packages/expo-react/src/lib/auth-api-client.ts` — the same three, mirrored.
- `packages/expo-react/src/data/share-store.ts` — the share extension's clock check.
- `EndReason`'s `'expired'`, which now means "revoked": `AuthGuard`
  (`apps/bracemark-web/src/components/auth-guard.tsx`,
  `apps/bracemark-expo/src/components/auth-guard.tsx`) sends a revoked device
  to sign-in with a line saying this device was signed out. An expired device
  never leaves the app.
- `SESSION_TTL_MS` in `services/session.ts` becomes `SESSION_IDLE_MS`.
- The session repository's revocation deletes become marker writes, and the
  cleanup predicate distinguishes expired rows from revoked rows. Add the
  server migration before deploying the new guard.

Docs that change when this design is implemented: [account.md](./account.md), _the two
identifiers_ ("the same 30-day TTL" in the replay-window note);
[data-lifecycle.md](./data-lifecycle.md), _the sign-out teardown_ (the
teardown's triggers and account-deletion retention of revocation markers) and
_deferred_ (the cleanup job lands); [api-contracts.md](./api-contracts.md) (the `authFetch` row);
this doc's STATUS.

### testing

The layers ([testing.md](./testing.md)):

- **api (vitest):** the guard's four failure codes; revocation takes precedence
  over expiry; concurrent renewal attempts change the row once; a renewal
  racing revocation cannot revive it; a failed renewal leaves the old deadline.
  Cleanup respects both retention clocks and turns purged tokens into
  `session_unknown`. Each revocation path, including account deletion and an
  already-expired session, retains the marker and answers `session_revoked`.
- **clients (jest / vitest):** the rule as a table, per stack. `session_revoked`
  for the current generation wipes; `session_expired`, `session_unknown`, a
  codeless 401, an HTML 401, a 500 and a network error do not. A record with a
  year-old clock time still hydrates as signed in.
  Delayed expiry/revocation responses and background reports for a replaced
  generation do nothing. Probes preserve pending ops unless the current session
  is explicitly revoked.
- **e2e ([e2e.md](./e2e.md)):** both stacks already have a "server-revoked
  session's wipe" case. They gain an **expired → keep, resume, push the queued
  edit** case, and the PWA target's dead-origin export (`PWA-003`) gains a
  session whose sign-in is far in the past on the device clock. That combination
  is the specimen for the rule. Add a purged-token resume with an unsynced edit,
  two-tab expiry/resume, and sign-out/account-switch races with a sleeping tab
  and in-flight sync. Assert both preservation of queued edits on resume and
  absence of old-account writes after teardown.
