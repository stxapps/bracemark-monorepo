## sessions

How long a signed-in device stays signed in, what ends a session, and, most
importantly, **what is allowed to wipe a device**. The session is the one piece
of server state a local-first client depends on, and whether its data survives
turns on how that dependency is handled. This doc covers the lifetime (sliding,
server-decided), the two ways a session dies (revoked vs. expired) and what the
client does about each, and the promise all of it serves: **a library already on
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
> not. See [what this replaces](#what-this-replaces). The design below was chosen
> before production, so it takes the clean version of every contract change
> rather than a compatible one. Nothing is deployed that it has to stay
> compatible with.

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

**⚠ A device wipes its local store only for (a) an explicit sign-out on that
device, or (b) a 401 from bracemark-api whose body carries the code
`session_revoked`. Nothing else wipes: not a clock, not another status, not a
401 without our code, not `session_expired`.**

This rule is silent. Break it and no lint, type or test failure follows. The
cost only shows up when the server is unreachable for good and a user's only
copy erases itself on the next launch. The one specimen is the code this design
replaces: a `s.expiresAt > Date.now()` check at hydrate time that looked like
tidy housekeeping and was actually a timed delete of every user's library.

### lifetime — sliding, idle-based, decided by the server

| constant           | value    | meaning                                                              |
| ------------------ | -------- | -------------------------------------------------------------------- |
| `SESSION_IDLE_MS`  | 90 days  | a session with no authenticated request for this long is **expired** |
| `SESSION_SLIDE_MS` | 1 day    | the most often the guard writes a new `expires_at` for one session   |
| `SESSION_PURGE_MS` | 365 days | how long an expired row is kept before the cleanup job deletes it    |

Each authenticated request moves the session's `expires_at` to
`now + SESSION_IDLE_MS`, but at most once per `SESSION_SLIDE_MS`. The guard does
this in `requireAuth`, `middleware/auth.ts`, which already carries a note asking
for exactly this shape:

- **Throttled.** Write only when `expires_at < now + SESSION_IDLE_MS - SESSION_SLIDE_MS`,
  meaning the row was last moved more than a day ago. That caps it at one D1
  write per session per day. D1 writes go to the primary; the guard's read is
  served by a replica.
- **Off the critical path.** Fire the `UPDATE` through `c.executionCtx.waitUntil`
  so it never delays the response. A lost write costs at most a day of sliding.
- **`last_seen_at` moves with it.** The column already exists and was waiting
  for this. It will serve a future sessions/devices list.

**No schema migration.** `expires_at`, `last_seen_at` and
`idx_sessions_expires_at` are all in `0001_init.sql` already.

So anyone who opens the app at least once every three months never signs in
again. That's how most consumer apps behave, and there is **no absolute cap**
on total session age: revocation (below) is the control for a lost device, and
a cap would add sign-ins with no security gain over it.

**Why idle expiry at all, then.** It limits how long a **stolen token** stays
usable after the real device stops using it. The client cannot detect that
theft, so a server-side idle limit is the only defence. It is set at 90 days
because, with the split below, an idle expiry costs the user a sign-in and
nothing else. It never costs them data.

### two deaths — revoked and expired

The guard tells three cases apart and answers each with its own code. All three
are 401s in the uniform error envelope (`{ "error": "<code>" }`,
`apps/bracemark-api/src/lib/errors.ts`):

| case                              | code              | client does                                  |
| --------------------------------- | ----------------- | -------------------------------------------- |
| no `Authorization: Bearer` header | `unauthorized`    | nothing (it didn't send a token)             |
| token hash matches **no row**     | `session_revoked` | **wipe**: the sign-out teardown              |
| row found, `expires_at < now`     | `session_expired` | **keep everything**, enter the expired state |

The codes live in `@stxapps/shared` next to the auth endpoints, so the API and
both client stacks import one constant rather than retyping a string.

**Revocation deletes the row, so "unknown" means "revoked".** Everything that
revokes today already deletes: `revokeSession` (sign-out),
`deleteByUserIdExcept` (sign out other devices, change password),
`deleteByUserId` (delete account). None of them needs changing. There is no
`revoked_at` column and no tombstone, because the absence of the row is the
signal.

**The cleanup job keeps expired rows for a year.** Because an unknown token reads
as revoked, a cleanup job that deleted a row as soon as it expired would turn
every idle device into a wiped one. So the job deletes only rows where
`expires_at < now - SESSION_PURGE_MS`: sessions that have been expired for a
year, meaning the device has been silent for fifteen months. A device that
comes back after that is wiped. That is the one case where idle time leads to
a wipe. It is deliberate, and the data is still on the server for the user's
next sign-in.

- The job is `sessionsRepo.deleteExpired`, with its cutoff moved back by
  `SESSION_PURGE_MS`. It exists and nothing calls it. Wiring it up means a
  `scheduled` handler in `apps/bracemark-api/src/worker.ts` and a
  `triggers.crons` entry in `wrangler.jsonc` (daily is plenty); see
  [hosting.md](./hosting.md) before deploying either. The same cron is the
  natural home for the orphan-claim and tombstone-teardown sweepers
  ([data-lifecycle.md](./data-lifecycle.md), _deferred_).
- ⚠ **`SESSION_PURGE_MS` must stay much longer than `SESSION_IDLE_MS`.**
  Shrinking it toward the idle window quietly turns expiry back into a wipe,
  the exact behaviour this design removes, and no test would notice.

**Only our own code counts.** The client branches on `apiErrorCode(e)`
(`packages/shared/src/api/client.ts`), which returns null for any body that
isn't our JSON envelope. So a proxy's HTML 401, a gateway's error page, or a
parse failure is just a failed request, handled like any other network error:
the sync cycle fails and retries later. A bare `res.status === 401`
check, as `authFetch` has today, is exactly what this rule forbids.

**Residual trust.** A server that sends our exact `session_revoked` envelope can
wipe the devices that reach it. That is the purpose of revocation (a remote
wipe for a lost device) and there is no way to have that feature without this
exposure. The mitigations are the ones that already protect the origin (TLS,
the domain, Cloudflare), plus the fact that a wipe loses only the device copy,
not the account. What this design _does_ remove is the accidental wipe:
a 401 from a misconfigured proxy or a lapsed domain's parking page.

### the expired state on the client

A session is `active`, `expired`, or absent (signed out). The client stores
which one alongside the session record, so a relaunch doesn't repeat a request
it already knows will fail.

In **expired**:

- The library opens, reads, searches, **edits** and **exports** exactly as it
  does offline. Edits queue as pending ops, as they do offline.
- Sync pauses. The engine schedules no cycles.
- A persistent notice says sync is paused and offers **Sign in to resume**.
  The sign-in form is pre-filled with the stored username, and the username is
  locked. See [accessibility.md](./accessibility.md) before writing the notice.
- **One probe per launch or return to foreground, when online:** a single
  authenticated request with the old token. It keeps answering
  `session_expired` until its row is deleted, and a deleted row means someone
  revoked it: another device ran _sign out other devices_ or _change password_,
  or the account was deleted. The probe then gets `session_revoked` and the
  device wipes. **Without the probe, an idle-expired lost device could never
  be remotely wiped**, so the probe is load-bearing for the revocation promise
  even though it looks like wasted traffic.

**Resume** is a normal sign-in (password or recovery code) with the username
locked to the stored one. On success the client replaces the token (and the
re-derived key, which is the same DEK) in the record, sets it back to `active`,
**keeps the local store**, and runs a sync cycle that pushes whatever queued
while paused. Nothing is re-downloaded that is already on the device.

- **Same username is enough, today.** Usernames are unique and never released
  after deletion ([data-lifecycle.md](./data-lifecycle.md), _deferred_:
  username release after a cooldown), so a username names one account for
  good. ⚠ **If username release ever ships, resume must compare the server's
  `userId` instead**. Otherwise a device holding one account's library could
  resume into a different account that reclaimed the handle. That change is a
  `userId` in the sign-in response and in the session record.
- **"Use a different account" is sign-out.** It runs the full teardown and
  warns first if pending ops exist. Their only copy is this device.

### who acts on a 401 — the lifecycle owner, only

Only the process running the `AuthProvider` writes session state or wipes: the
web app, the browser extension's popup and options pages, and the Expo app's
main process. Two other processes carry the token and must **never** act on it:

- the **browser extension's** MV3 background worker (`background.ts` calls
  `loadSession()` but has no provider), and
- the iOS **share extension** (`loadSharedSession()`, which reads the
  shared-Keychain mirror, [share-sheet.md](./share-sheet.md)).

Both only report back. On any 401 they stop (the share extension's outbox file
is already the record of truth, and the main app drains it). Both **read** the
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
- **The two codes are added to `@stxapps/shared`,** and `requireAuth` emits them.
  `unauthorized` keeps its current meaning, "no bearer token".
- **A persisted record from before the change** has a stale `expiresAt` and no
  state field. On Expo, `parse()` currently rejects a record missing
  `expiresAt`; when it stops requiring the field, it should treat a record
  without a state as `active`, not as corrupt. There are no production records,
  so this only matters for dev devices, but a corrupt-read path that signs a
  developer out is noise worth avoiding.

### the dead-server path

With the rule above, "the server is gone" is just offline that never ends. This
doc owns only the promise that nothing **wipes**. Whether each platform can
still **open** the library with the origin gone (the per-platform table,
bracemark-web's service worker, the browser extension's missing export, the
Safari question) is [offline-mode.md](./offline-mode.md), _the promise_. The
landing page's claim needs both docs' rules to hold.

### what this replaces

Every place below either wipes on the client's clock or treats any 401 as
invalidating. Each one goes:

- `packages/web-react/src/contexts/auth-provider.tsx` — the hydrate branch
  `s.expiresAt > Date.now()` and its `clearData()` for a stored-but-expired
  session. (The **no-session** half of that branch stays: it clears plaintext
  left behind by an interrupted teardown, and that is a different thing.)
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

Docs that change in the same commit: [account.md](./account.md), _the two
identifiers_ ("the same 30-day TTL" in the replay-window note);
[data-lifecycle.md](./data-lifecycle.md), _the sign-out teardown_ (the
teardown's triggers are now the two in the rule above) and _deferred_ (the
cleanup job lands); [api-contracts.md](./api-contracts.md) (the `authFetch` row);
this doc's STATUS.

### testing

The layers ([testing.md](./testing.md)):

- **api (vitest):** the guard's three codes; the slide happens only past the
  throttle and never blocks the response; `deleteExpired` spares a row that
  expired yesterday and deletes one that expired over a year ago; each
  revocation path makes the old token answer `session_revoked`.
- **clients (jest / vitest):** the rule as a table, per stack. `session_revoked`
  wipes; `session_expired`, a codeless 401, an HTML 401, a 500 and a network
  error do not. A record with a year-old clock time still hydrates as signed in.
- **e2e ([e2e.md](./e2e.md)):** both stacks already have a "server-revoked
  session's wipe" case. They gain an **expired → keep, resume, push the queued
  edit** case, and the PWA target's dead-origin export (`PWA-003`) gains a
  session whose sign-in is far in the past on the device clock. That combination
  is the specimen for the rule.
