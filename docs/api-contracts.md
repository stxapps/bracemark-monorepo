## api contracts

How bracemark-api endpoints are typed and shared across the server and every client.
See [architecture.md](./architecture.md) for the package layering and
[local-first-sync.md](./local-first-sync.md) for how the background sync engine
and TanStack Query sit on top of this contract layer.

### the decision: contract-first, not Hono RPC

Every endpoint is described **once** in `@stxapps/shared` as a `defineEndpoint`
descriptor plus zod request/response schemas. The server reads that descriptor
to validate requests and type responses; every client reads the same descriptor
to build a typed call. Nobody imports `bracemark-api`.

**Why not Hono's `hc<AppType>` RPC client?** It infers types from the bracemark-api
app instance, forcing clients to `import type { AppType } from '@stxapps/bracemark-api'`.
That's an `app → app` edge **and** a `web → node` edge — both forbidden by the
Nx `type:` / `platform:` boundaries in `eslint.config.mjs` (see
[architecture.md](./architecture.md)). The hand-written contract keeps every
dependency arrow pointing **down** at `shared`.

### where the pieces live

All in `packages/shared/src`, exported through the package barrel
(`src/index.ts`) — consumers always import from `@stxapps/shared`, never from
internal paths:

- **`api/endpoint.ts`** — the `defineEndpoint` primitive + `ApiEndpoint` type.
- **`api/client.ts`** — the platform-agnostic typed client: `callEndpoint`
  (GET/DELETE → query string, else JSON body; takes an optional `{ signal }` for
  cancellation), `createApiClient` (binds a `baseUrl` once so call sites stay
  terminal: `api.call(endpoint, input)`), and `ApiError`.
- **`auth/credentials.ts`** — pure, reusable field validators (`usernameSchema`,
  `passwordSchema`, the sign-in / create-account form schemas).
- **`auth/endpoints.ts`** — the auth endpoint contracts (e.g.
  `checkUsernameEndpoint`), whose request schemas reuse the validators from
  `auth/credentials.ts` so a rule like username length is defined exactly once
  and enforced identically on client and server.
- **`zod.ts`** — the workspace's only value import of `zod`. Everything else
  takes `z` from here, for the reason below.

### `z` comes from `shared`, and it is `jitless`

`packages/shared/src/zod.ts` calls `z.config({ jitless: true })` and then
re-exports `z`. Every value import of zod in the workspace goes through it —
`from '../zod'` inside `shared`, `from '@stxapps/shared'` everywhere else — and
`eslint.config.mjs` restricts the bare `'zod'` specifier so it stays that way. A
type-only `import type { z } from 'zod'` is exempt and stays as it is: it erases.

**What it buys is bracemark-web's CSP.** zod 4 JIT-compiles a fast parser for
every object schema by building the function source as a string and handing it
to `new Function` (`zod/v4/core/doc.ts`), and before it does it probes for eval
support with a `new Function('')` in a try/catch (`util.ts`, `allowsEval`). A
_caught_ throw is still a reported CSP violation, so under a `script-src` with no
`'unsafe-eval'` ([hosting.md](./hosting.md#security-headers--where-the-csp-has-to-live))
the probe alone logs one on every page load, and under `Report-Only` it goes on
to compile for real and log a second. `jitless` skips both; zod's own source says
so at the probe.

**It costs nothing, because no runtime we ship to could use the fastpass
anyway** — the browser is under that CSP, Cloudflare Workers block eval outright
(zod even sniffs the Workers user-agent), and Hermes has no eval. All three were
already falling back to the interpreted path, via a probe that throws. This only
stops them announcing it.

**Set before any schema is BUILT, not before the first parse** — which is why it
is a re-export rather than a call at an app entry point. The probe and the
`jitless` read both happen in `$ZodObject`'s constructor, so they run when a
module body evaluates `z.object(…)`; for the contract schemas here, that is
import time. Configuring at an entry point would be a race against ESM evaluation
order, and losing it changes no behaviour and no types — it just puts the
violation back in the console of a browser nobody is watching, since the CSP
carries no `report-uri`. Taking `z` from the module that configures it is what
makes the ordering unlosable.

### url versioning

Every API path is versioned with a `/v1` prefix, built from the `API_V1`
constant in `api/endpoint.ts`:

```ts
path: `${API_V1}/auth/check-username`, // → /v1/auth/check-username
```

The version is **part of the wire contract**, so it lives in the contract path
(in `shared`) rather than in each client's `baseUrl`. That's not just stylistic:
the client does `new URL(endpoint.path, baseUrl)`, and a leading-slash path
**discards** any path segment on `baseUrl` — so `NEXT_PUBLIC_API_URL=…/v1` would
be silently dropped. Keeping `/v1` in the path also means the server inherits it
for free (`routes/auth.ts` mounts `checkUsernameEndpoint.path` verbatim), and the
single descriptor still fully describes the wire URL.

Why version at all: the extension and a future Expo app are long-lived clients
whose update cadence we don't control. URL versioning lets an old client stay
pinned to `/v1` while the web app moves to `/v2`. Bumping means adding an
`API_V2` constant and migrating paths endpoint-by-endpoint. Operational roots
(`/`, `/health`) stay **unversioned** — `app.ts` mixes both by mounting versioned
sub-apps alongside the bare root routes.

### no response is cacheable

Every response bracemark-api sends carries `Cache-Control: no-store` — one
middleware in `app.ts`, registered first so it also covers a CORS preflight, a
404, a 429 and anything the error handler builds. It is a rule about the whole
api rather than a header per route, because the failure it prevents has no
symptom on the server at all. **bracemark-extractor carries the same
middleware**, for a sharper version of the same reason: every response it sends
is about something the user saved, and its image proxy was for a while a GET
whose URL _was_ that address ([link-extraction.md](./link-extraction.md),
_server extraction_; a POST now, [below](#a-gets-query-string-reaches-the-request-log)).

A response that says nothing about caching is one a client's HTTP cache may keep,
and Android's did: React Native's OkHttp cache (`cache/http-cache/`) stored
every GET, request URL included. So a device kept
`/v1/auth/password-door?username=…` (a GET then; the username lookups are POSTs
now, [below](#a-gets-query-string-reaches-the-request-log)) — whose account it
had been, with the response that request got — together with its object keys,
**after the account
signed out of it**, in a directory the sign-out teardown never touches
([data-lifecycle.md](./data-lifecycle.md), _what an empty table does not mean_).
A browser's cache and iOS's URL cache are the same kind of place. Most
endpoints are POSTs, which caches do not store in practice; the GETs are the
ones that were found, and the rule covers both so that adding a GET never
reopens it.

`no-store`, not `no-cache`: the point is that nothing is written, not that it is
revalidated. A route that should one day be cached is exempted in that
middleware, on purpose — `app.spec.ts` pins the header on a plain route, a GET
carrying a query, a blob, a 404 and a 429.

⚠ **On iOS the header's effect cannot be seen in a dev build.** The dev client's
network inspector (`EX_DEV_CLIENT_NETWORK_INSPECTOR`, Expo's default) routes
every request through a `URLProtocol` that hands the response back to the URL
loading system as cacheable (`expo-modules-core`,
`ExpoRequestInterceptorProtocol`), so the simulator's
`Library/Caches/<bundle id>/Cache.db` holds **every** request the app made —
GET and POST, body included — whatever the response says. Measured with this
header in place: the stored response's own headers read `no-store`. So a dev
build says nothing either way about what a release build's URL cache keeps, and
no run here has measured one.

**A blob read is not this api's response, so the instruction rides in the URL
it signs.** In staging and production a blob is read straight from
`<account>.r2.cloudflarestorage.com`, which answers with an ETag, a
Last-Modified and no caching header at all — a response a cache may keep, under
a URL that names the user id and the object. So `files/sign` adds
`response-cache-control=no-store` to every presigned GET (`r2/presign.ts`), S3's
response-header override, and R2 answers with that header. It is part of the
signed query, so a client cannot drop it. ⚠ Under `wrangler dev` the same read
goes through this api's blob proxy and carries the middleware's header instead,
so **a local run — the native residue case included — cannot tell whether the
override is there**; only a deployed tier can.

Measured in Chrome 2026-10-08, a throwaway account driven through create, write,
sign out, sign in, sign out, then the profile directory read from disk:

| what the profile's disk cache held after the sign-out | before                                                                                 | after |
| ----------------------------------------------------- | -------------------------------------------------------------------------------------- | ----- |
| this api's GETs (local stack, header off / on)        | 12 entries — `password-door?username=…` and `username-available?username=…` among them | none  |
| presigned R2 reads (staging, before / after a deploy) | one per blob read, keyed by the whole presigned URL                                    | none  |

R2's own documentation does not list the override among what `GetObject`
supports; the staging run is what says it does.

⚠ **What this does not reach: anything a client fetches from a saved site** — a
page for its title, a preview image, a favicon. Those are the site's headers.

### a GET's query string reaches the request log

The cache rule above is about where a GET's URL ends up on the **client**. This
is the same URL on the **server** side, and it is not ours to switch off per
route: `callEndpoint` sends a GET's request as a query string
([above](#where-the-pieces-live)), and bracemark-api runs with Cloudflare's
invocation log on (`apps/bracemark-api/wrangler.jsonc`, `observability`), which
stores the request line whole.

Read back from the stored log of both deployed tiers on 2026-10-13, one entry
per request holds:

- **in it:** the full URL, query string included; the request headers, with
  `authorization` stored as `********` (no cookie is ever sent); the client IP
  (`cf-connecting-ip`) and what Cloudflare derives from it — city, postal code,
  coordinates, network; the response status; the Worker version and its CPU and
  wall time.
- **not in it:** the request body, and the response body.

So a body is invisible to that log and a query string is not, which makes
**GET-with-a-query the one shape whose arguments are written down off the
device** — and a request **header** the other, since those are stored as sent.

**Rule: nothing a person chose goes in a URL or a header.** A username, a search
word, an address, a name — it travels in a POST body, even when the call only
reads. What may ride in a query is an opaque id, a cursor or a limit: things the
server already stores, or that say nothing about anyone.

That is why three lookups that only read are POSTs — `check-username`,
`read-password-door`, `read-recovery-door`. They were GETs with `?username=…`
until that same read of the log found an account name in a stored entry beside
the IP it came from, on the three requests made before any session exists. No
client had shipped, so the GET routes were removed outright rather than kept
beside the new ones; `routes/auth.spec.ts` pins that a GET to any of the three
answers 404. The recovery door's write is `put-recovery-door`, so the read and
the write are two verbs on one noun rather than one of them owning the bare
path — and its last segment is the `action` its signed payload carries, as it
is for every endpoint that takes a proof (`auth/endpoints.spec.ts`).

⚠ **/privacy says this in so many words** — _Technical and security data_: the
api's log is on, and none of its addresses contains a username. Two things hold
that sentence up, and only one of them is a test:

- **The inventory spec.** `packages/shared/src/api/query-inventory.spec.ts`
  walks every contract the barrel exports and fails on a new GET or DELETE, or a
  new field on an existing one, until it is listed there — which is the moment
  to ask whether a person chose the value. It cannot see a route mounted by hand
  without a contract, or a header set in a fetch wrapper. Two specs hold those
  halves. `app.spec.ts` in each Worker lists every GET and DELETE the app
  answers — the contracts plus the operational roots, and on the extractor the
  roots alone — so a hand-mounted one fails there (a handler mounted with
  `.all()` is the shape it still misses: Hono lists it beside path-scoped
  middleware). And `WEB-ACCOUNT-005` (`e2e/web/account.e2e.ts`) records every
  request a real profile sends the api across the journeys that name an account
  — the recovery-door check, a second account's creation, signing back in — and
  fails on a username in an address or a header; `EXTRACT-WEB-001` does the same
  for a saved address and the extractor. Both are admitted to staging, which
  makes them the check on the order of deploy the page depends on: against a
  tier whose api or web build still carries the GET lookups or the GET proxy
  they fail, and /privacy is not true of that tier until they pass.
- **Not Cloudflare's redaction.** The Play push endpoint's
  `?token=<PLAY_NOTIFY_TOKEN>` was stored as `REDACTED` in every entry sampled
  and the bearer token as `********`, while an e2e account's username in the
  same position was stored as typed. That is a pattern match on what looks like
  a secret, on their release schedule — a reason the one secret-in-a-query
  endpoint is tolerable, never a reason to add a second.

**What that rule buys is "not written to a log", never "not seen".** Cloudflare
terminates TLS, so it reads a POST body in transit exactly as it reads a query
string; moving the username changed where it is recorded, not who handles it.
/privacy is written to the narrower of the two on purpose — it says where **we**
put the username and that no logged address contains it, and stops short of "a
body is not logged", which is Cloudflare's behaviour rather than ours. Two
things beside the rule that the same page now states:

- **The log also holds the lines we write.** `console.*` output is stored with
  the invocation, and some lines interpolate a user id or a provider's purchase
  id (`services/iap.ts`, `services/account.ts`) — most of them on a failure, not
  all: a Play purchase replacing an earlier one logs both on the path that
  worked, which is why the page says "most of them when something fails". Those
  are ids we or a provider mint, so the rule above is not broken by them; the
  page says they
  exist because "we do not join it to your account" would otherwise be read as
  covering them. A new log line that interpolates something a person chose is
  the same leak as a query param, by a door this section's spec cannot see.
- **The other URL is the web app's own**, which goes to CloudFront rather than
  to a Worker and can carry a search word
  ([search.md](./search.md), _the query is the URL_;
  [hosting.md](./hosting.md), _request logging on the static hosts_).

**The fourth was bracemark-extractor's image proxy**, the last GET that carried
something a person saved: `GET /v1/image?url=…`, on the argument that an `<img>`
can issue nothing else, and tolerated because that Worker runs with
`invocation_logs: false` ([link-extraction.md](./link-extraction.md), _never log
the URL_). Neither half held:

- **No `<img>` ever pointed at it.** Its one caller is
  `ExtractClient.fetchImage` (`extract/client.ts`), a `fetch` that reads the
  bytes once so the client can store them itself — rendering a preview through
  the proxy is the per-paint leak the design forbids anyway. Nothing needed the
  GET.
- **Two neighbours of that log do not obey the setting.** The zone's edge
  analytics count the same request, and on the zones' current plan they expose
  the path, the status, the client IP and the user agent but **refuse the query
  string** as a field. The zone's **security events** do not refuse it: a
  request the managed firewall blocks is recorded with its query string, so a
  saved address that tripped a rule would have been kept there beside the
  caller's IP. The week read on 2026-10-13 held fifteen such events across both
  tiers, all of them scans for paths nothing answers, none with a query string.

Both of those are properties of a plan and a product rather than decisions of
ours, which is the reason the rule above is about what the request carries and
not about which log is switched off. So the proxy is
`POST /v1/fetch-image { url }` now, the address in its body, and the GET is
gone outright like the three lookups (`routes/image.spec.ts` in
bracemark-extractor pins the 404; `query-inventory.spec.ts` pins that the
inventory has no exception left). The cost is a CORS preflight, which each
Worker's two-hour `maxAge` reduces to one per endpoint rather than one per
image ([hosting.md](./hosting.md), _cors & frontend↔backend wiring_). That
Worker's log stays off all the same: "a body is not in the log" is Cloudflare's
behaviour, and "the log is off" is ours.

### assembling the client (the injection seam)

The contract above says how to _call_ bracemark-api; this is how a running app gets a
_configured_ client into its hooks. It's a dependency-inversion seam — each layer
adds one concern and refuses to know the next one up, so the only thing that knows
the runtime URL is the app:

| layer       | piece                                                           | adds                                                                                                                                                                                | deliberately doesn't know    |
| ----------- | --------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------- |
| `shared`    | `createApiClient({ baseUrl, fetch? })`                          | the typed transport (contracts → `fetch`)                                                                                                                                           | auth, React, the environment |
| `react`     | `ApiClientProvider` / `useApiClient`                            | a React **seam** — a context hole the hooks read                                                                                                                                    | which client, which baseUrl  |
| `web-react` | `createAuthApiClient({ baseUrl })`                              | bearer-token `authFetch` (+ reporting our session codes — never a bare 401 — as a verdict tagged with the sending generation, `notifySessionVerdict`; [sessions.md](./sessions.md)) | the environment              |
| app         | `const baseUrl = <env>; api = createAuthApiClient({ baseUrl })` | the **one** concrete client + provides it                                                                                                                                           | — (it's the top)             |

Which 401s that loop may act on, and which may wipe a device, is
[sessions.md](./sessions.md).

Why the seam exists: the query/mutation hooks in `@stxapps/react` need _a_ client,
but importing one would drag an app's env var into a package — forbidden by the
`type:`/`platform:` boundaries. So the hooks read `useApiClient()` from context and
the app injects the concrete client via `<ApiClientProvider client={api}>`. Same
hooks run unchanged in bracemark-web, bracemark-extension, and future bracemark-expo.

Why `baseUrl` stays in the app: auth is shared across the web apps (so it lives in
`web-react`), but the URL is resolved from a **bundler-inlined** env var that
differs per app — `process.env.NEXT_PUBLIC_API_URL` (Next) vs
`import.meta.env.WXT_PUBLIC_API_URL` (wxt) — and the literal access must stay in
app code for the bundler to inline it. See [env-files.md](./env-files.md).

Two consumption paths, one client. A web app has only the React tree
(`<ApiClientProvider client={api}>` in `inner-layout.tsx` / popup `providers.tsx`).
The extension also runs a **background service worker** that isn't React, so it
can't use `useApiClient()` — instead `utils/sync-runner.ts` imports the same `api`
and hands it to the sync engine as `SyncDeps.api`. That's the reason
`createAuthApiClient` is a plain factory in `web-react` rather than a React hook:
it has to be callable from a non-React module too. Both paths share one in-memory
session mirror, so the bearer token stays consistent.

### transport retry

Layered on the contract client is an optional retry policy in `shared`
(`api/retry.ts`) — the client-side half of the servers' rate limits (`bracemark-api`
and `bracemark-extractor` both run per-IP/per-user buckets). Those buckets are
**shared** (other tabs, other devices, a NATed neighbor), so a client can never
compute its remaining budget up front; the policy is therefore **reactive**: on a
`429` (honoring the server's `Retry-After`), a `5xx`, or a network blip, back off
and retry; on a non-429 `4xx` or any non-transport throw, surface it unchanged.
That classification + backoff math is three pure helpers —
`isRetryableTransportError`, `retryAfterMsOf`, `jitteredDelayMs` — so **the policy
is defined once** and every app retries by identical rules.

The _mechanism_ on top of that policy is picked per call site, and the two in the
codebase differ on purpose:

- **`withRetry(api)` — an inline wrapper.** Wraps an `ApiClient` so every `.call()`
  retries transparently, blocking in the same async frame until it succeeds or
  exhausts its tries. The **sync engine** uses it (see
  [local-first-sync.md](./local-first-sync.md)): it runs off the React tree, so a
  blocking `Retry-After` wait is fine, and wrapping the client retries at the
  **call** level — a blip on page 9 of an op-log pull doesn't discard pages 1–8.
- **the raw helpers — a scheduled re-wake.** A caller inside a React effect loop
  can't block: it must stay cancellable, visibility-aware, and single-flighted. The
  **extraction drain** (`ExtractionProvider`, see
  [link-extraction.md](./link-extraction.md)) imports the three helpers directly
  and schedules its own backed-off _re-entry_ into the loop rather than wrapping the
  client — `withRetry`'s blocking wait can't be cancelled by `pause()` or gated on
  tab visibility.

Don't stack the two: a client wrapped in `withRetry` **and** driven by a re-waking
loop nests two backoffs against the same bucket. One retry layer per path.

### deadlines

`fetch` has no deadline of its own. A server that accepts the connection and
never answers, or a network that silently drops the packets (a captive portal, a
Wi-Fi→cellular switch that leaves a dead socket), leaves a call pending forever.
So **every** contract call has one, applied in `callEndpoint`. It is resolved in
this order: the call site's `CallOptions.timeoutMs`, then the endpoint's own
`timeoutMs`, then `DEFAULT_CALL_TIMEOUT_MS` (60 s). When the deadline passes, the
call rejects with `ApiTimeoutError` and the fetch is aborted.

- **A default, not per-call-site wiring.** An endpoint added later is bounded
  without anyone remembering to bound it. If the guess is too short, the result is
  a loud timeout error rather than a silent hang.
- **The deadline covers the whole call, response body included**, not just the
  wait for the response headers. Our JSON bodies are small, so the difference is
  negligible, and the whole-call deadline also catches a body that stalls after
  its headers.
- **A slow endpoint declares its own deadline in its contract**, next to the
  schemas, so every platform's call gets it. What decides this is server _work_
  before the first byte, not transfer size. A first-byte deadline wouldn't spare
  these endpoints either, because they send nothing until they finish.
  `data/delete-all` and `auth/delete-account` page the whole R2 prefix
  server-side (`DELETE_ALL_TIMEOUT_MS`, 5 min). `/v1/extract` can spend up to 6
  hops × 8 s on the page and then again on its inline image (`EXTRACT_TIMEOUT_MS`,
  2 min, sized from the extractor's `safe-fetch.ts` caps; `safe-fetch.spec.ts`
  holds the two together).
- **One endpoint declares a SHORTER deadline, for the opposite reason.**
  `auth/sign-out` is best-effort, and every client holds its local sign-out
  until the request settles — behind a dialog with no way out, because what is
  typed during that wait is erased with the rest
  ([data-lifecycle.md](./data-lifecycle.md), _the press, and the wait_). On the
  default that is a minute of "Signing out…" on exactly the connection where
  the request cannot succeed. `SIGN_OUT_TIMEOUT_MS` is 10 s; when it fires the
  cost is the one a failed request already had — the session row is not
  revoked, idles out and is purged.
- **The deadline rejects; the abort only tidies up.** The call settles through its
  own timer, not through the fetch honoring its signal, because the point is a
  promise that always settles. A consequence: the fetch receives the client's own
  signal, linked to the caller's, never the caller's signal object itself. The
  mechanism is shared's `withDeadline` (`async/with-deadline.ts`), which the R2
  transfers use too.
- **A timeout is not retried** (`isRetryableTransportError`). The attempt has
  already spent the whole deadline against a server that isn't answering, and
  retrying would multiply that by `withRetry`'s `tries`. The caller's next attempt
  is the retry. Each retried attempt of any _other_ failure gets a fresh deadline,
  since each is its own `callEndpoint`.

The sync engine is the caller that needed this most. Its single-flight cycle is
shared by every later sync, so one hung call used to take all of sync down
([local-first-sync.md](./local-first-sync.md), under the single-flight bullet).
On web a cycle also holds a lock every tab of the origin waits on, so the same
deadlines are what stop one tab's hung call from holding every tab's sync
(_two tabs, one queue_, in the same doc).

**Outside this client.** The R2 presigned transfers (`sync/r2.ts`) bypass it, so
they bound themselves with the same `withDeadline`. A body can be KB or MB, and
which kind of deadline it gets depends on whether the transfer can see its own
progress (`sync/blob-transfer.ts` in `shared`):

- **Idle, where it can.** A web GET reads its body as a stream and restarts the
  clock on every chunk: 60 s for R2 to answer, then 60 s of silence
  (`BLOB_IDLE_TIMEOUT_MS`). It fails only a body that stops arriving, never a slow
  one, however large.
- **Total, scaled by size, where it can't.** A browser's `fetch` reports no upload
  progress, and React Native's resolves only after the whole body. So a PUT, and
  the expo GET, get a 60 s allowance plus the body at an 8 KB/s floor
  (`blobTransferTimeoutMs`). The cost when that floor is wrong is a transfer that
  fails on every cycle, not once. It can bite only the web PUT of a `files/`
  blob, on a link below the floor for the whole body; expo's JS transfers carry
  entity blobs alone. The floor is per transfer and the web engine uploads 8 at
  once, so it covers a ~512 kbps uplink carrying 8 MB-sized blobs. It is set low
  on purpose: too high means a blob that never syncs, too low only means a
  truly stalled PUT holds the cycle longer (5 MB ≈ 12 min) before the next cycle
  retries it. A flat total would be worse at both ends — minutes of stall behind
  a few-KB entity blob, and still too short for the largest `files/` blob.
- **None of ours** for expo's native file transfers (`File.downloadFileAsync`, the
  legacy `uploadAsync`). URLSession's and OkHttp's timeouts are idle deadlines
  already.

The extractor's image proxy (`ExtractClient.fetchImage`) streams a binary body,
so it can't ride `callEndpoint` either. It applies the contract's deadline
itself: `FETCH_IMAGE_TIMEOUT_MS`, 2 min, declared on `fetchImageEndpoint` and
failing with the same `ApiTimeoutError`. That is a total covering the whole
call, the body included: the extractor's 6 × 8 s redirect walk with over a
minute to spare for an image capped at 10 MB and usually far smaller, pinned by
`safe-fetch.spec.ts`. The caller reads a timeout as transient (`loadImage` leaves
the facet for a retry; a favicon records `none` and ages out). The third-party
fetches (favicons, on-device extraction, the extractor's own upstream fetches)
carry their own timeouts.

### adding an endpoint

1. **Contract** — in `packages/shared/src/<area>/endpoints.ts`, define the
   request/response zod schemas and a `defineEndpoint({ method, path, request,
response })` descriptor — prefix `path` with `` `${API_V1}/…` `` (see _url
   versioning_ above). Reuse pure validators from `<area>/credentials.ts`
   (or a sibling) rather than re-declaring field rules. It's exported
   automatically via the barrel — add an `export *` line in `src/index.ts` if the
   file is new. **Pick the method by what the request carries, not by whether it
   writes:** a GET's input becomes a query string and a query string is logged,
   so anything a person chose makes it a POST
   ([above](#a-gets-query-string-reaches-the-request-log)); a GET that is added
   anyway has to be entered in `api/query-inventory.spec.ts`.

2. **Server** — in `apps/bracemark-api/src/routes/<area>.ts`, build a `Hono()`
   sub-app whose route uses the contract's own `endpoint.path`, validates with
   `zValidator('query' | 'json', endpoint.request)`, and types the payload as the
   contract's response type so the handler fails to compile if the shape drifts.
   Mount it in `app.ts` via `app.route('/', <area>Routes)`. (CORS lives in
   `app.ts` — `CORS_ORIGINS`, default `http://localhost:3000`, the web dev port —
   with a two-hour `maxAge`, so a browser reuses a preflight rather than sending
   one before every JSON or authenticated call.)

3. **Client** — call `api.call(endpoint, input)`. `api` is the per-app client
   from `createAuthApiClient` (`apps/bracemark-web/src/lib/api.ts` with
   `NEXT_PUBLIC_API_URL`, `apps/bracemark-extension/utils/api.ts` with
   `WXT_PUBLIC_API_URL`; both default the dev URL to `http://localhost:8787`) —
   see _assembling the client_ above. Components should go through the TanStack
   Query hooks in `@stxapps/react` (which wrap `callEndpoint` via
   `useApiClient()`); the background sync engine calls through `SyncDeps.api`. See
   [local-first-sync.md](./local-first-sync.md) for that dividing line.
