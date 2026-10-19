## hosting — origins, hosts, and the local production preview

Which app answers which hostname, why the origins are split the way they are, and
how to run a production build on your own machine. This is the half of the deploy
story that the **source depends on**: env files bake these hosts into bundles,
`CORS_ORIGINS` lists them, and the extractor's separate origin is a security
property the code is written to preserve.

Companions: [env-files.md](./env-files.md) for the config side (how each app
receives its per-environment values), [architecture.md](./architecture.md) for
what each app is, and [account.md](./account.md) for the threat model the CSP
below serves.

> **Staging is deployed.** The staging E2E run on 2026-10-09 verified the app,
> marketing site, both Workers and encrypted R2 file transfers. **The CSP is
> enforced on both tiers** as of the same day: all four CloudFront policies send
> `Content-Security-Policy` and no report-only header. Staging's then passed
> the whole staging suite with no document violating it; production serves no
> build yet, so its policy is checked by header and by a browser refusal, not by
> a journey. Results and what is still open:
> [e2e/STAGING.md](../e2e/STAGING.md).

### the hosts

Two deploy tiers, `staging` and `production`, on **two different registrable
domains** rather than one domain split by subdomain:

| tier         | site (marketing) | web (the app)        | api                  | extractor                  |
| ------------ | ---------------- | -------------------- | -------------------- | -------------------------- |
| `staging`    | `dryrunbase.com` | `app.dryrunbase.com` | `api.dryrunbase.com` | `extractor.dryrunbase.com` |
| `production` | `bracemark.com`  | `app.bracemark.com`  | `api.bracemark.com`  | `extractor.bracemark.com`  |

Within each domain the pattern is `<role>.<domain>`, and the site is the
exception that proves the rule — it has no `<role>.` label because it **is** the
zone apex. Why the two tiers don't share a domain is
[below](#why-staging-is-a-separate-registrable-domain).

**Stable custom domains are required, not a nicety.** The frontends bake their
API URL in at build time, so pointing a bundle at a `*.workers.dev` or
`*.cloudfront.net` name would mean rebuilding every app whenever an infra
subdomain changed.

**Each host names its app, and so does the env var that carries it** —
`NEXT_PUBLIC_EXTRACTOR_URL` → `extractor.*`, never `extract.*`. That agreement is
load-bearing rather than tidy: while the var was spelled
`NEXT_PUBLIC_EXTRACT_URL`, an `extract.` host got derived from the var name and
sat in `.env.production` as a host that appears in no table anywhere. Keep the
two spellings in step.

**Two web origins per tier, and both are real API clients.** `app.*` is the
application (bracemark-web); the **apex** is the marketing site
(bracemark-site), which also calls the api for public data — stats and the health
check. Both therefore appear in `CORS_ORIGINS`, and neither is a redirect-only
host. They are separate origins with different security headers, which is the
whole reason they are separate distributions rather than one site with a path
prefix.

**`app.*` is also the PWA scope.** bracemark-web ships a `display: standalone`
manifest with no explicit `scope`, so the scope derives from `start_url: "."` and
stops at that origin. The apex is outside it, which means any app → site
navigation is out-of-scope for an installed user and gets handed to the
platform's in-app browser rather than staying in the app window. That is correct
for the links it applies to — Settings → About and the legal pages are one-way
trips off the app — and it is exactly why sign-out is **not** one of them. See
[architecture.md](./architecture.md#apps), _apps_.

**The extractor is a separate Worker on its own origin**, never a route on the
api. It `fetch`es arbitrary user-supplied URLs, and keeping it off `api.*` is
what makes "`api.bracemark.com` never sees your library in plaintext" provable from the
code rather than asserted in prose. It has no storage bindings at all — no D1, no
R2, no Durable Objects. See [link-extraction.md](./link-extraction.md), _server
extraction_.

### crossing an origin — `window.location`, never the router

Two web origins means bracemark-web has navigations that leave it, and **which API
performs one is not a style choice**:

| destination                            | use                                                                                        |
| -------------------------------------- | ------------------------------------------------------------------------------------------ |
| **same origin** (`/links`, `/sign-in`) | `next/navigation` — `redirect()` in render, `router.push`/`replace` in handlers            |
| **another origin** (the apex, legal)   | `window.location.replace` / `.assign`, from an effect or handler — **never during render** |

Same-origin is where the router earns its keep: a client-side transition, no
document reboot, no re-reading the session out of IndexedDB, and `redirect()` in a
gate's render throws before commit so protected content never paints.

Cross-origin it earns nothing and costs something real. Hand `redirect()` or
`router.replace()` an external URL and both land in the same place —
`navigate-reducer` sets `mpaNavigation`, which `app-router.tsx` handles by calling
`location.replace` **and then throwing mid-render**, under a comment that reads
_"This is a side effect in render. Don't try this at home, kids."_ It stays thrown
only while nothing dispatches to the router; anything that does clears the flag, so
the next render runs past the throw with more hooks than the aborted one, React
fails with _"Rendered more hooks than during the previous render"_, and that error
takes the pending navigation down with it. The user ends up stranded on the page
they were trying to leave. There is nothing on the other side of the trade: no
prefetch, no client transition, no history entry to reuse — the browser is
leaving. All the router adds is a state machine a concurrent dispatch can disturb.

This is not theoretical and it is not silent: sign-out crashed exactly this way,
and `e2e/web/account.e2e.ts` still fails if the exit is put back through
`redirect()`. Sign-out is the one navigation this applies to today
(`components/auth-guard.tsx` — see [data-lifecycle.md](./data-lifecycle.md), _the
sign-out teardown_, for the other half of that defence); Settings → About and the
legal pages are ordinary `<a>` links, which is the third correct answer whenever
the user is the one choosing to leave. Note the PWA-scope caveat above: an
installed sign-out stays on this origin rather than leaving for the apex at all.

### why staging is a separate registrable domain

Staging lives on `dryrunbase.com` rather than anywhere under `bracemark.com`.
This is forced, not stylistic — a hard Cloudflare constraint meeting the two-tier
isolation:

- **Each tier is its own Cloudflare account**, and **a zone lives in exactly one
  account.** `bracemark.com` is in the production account.
- **A Workers custom domain requires its zone to be in the same account as the
  Worker**, so the staging api and extractor need a zone the _staging_ account
  owns.
- Therefore staging hosts cannot be children of `bracemark.com` — flat
  (`staging-app.bracemark.com`) or nested (`app.staging.bracemark.com`) alike,
  because both resolve out of the production account's zone.

> **This supersedes an earlier design.** Staging used to nest under
> `staging.bracemark.com`, delegated to the staging account as its own zone via
> `NS` records. **That does not work on a non-Enterprise plan:** Cloudflare only
> accepts an apex domain when adding a site, and treating a subdomain as an
> independent zone ("Subdomain support") is
> [an Enterprise-only feature](https://developers.cloudflare.com/dns/manage-dns-records/how-to/create-subdomain/).
> On every other plan a subdomain is just a DNS record inside the parent zone —
> which puts it in the production account, defeating the isolation.

Folding staging into the production account was the other way out, and it was
rejected: it would put staging and production D1/R2 under one set of credentials
and one blast radius, which is the single thing the two-account split exists to
prevent. A second domain costs ~$10–15/year and that isolation is worth more.

It also turns out **cleaner** than the design it replaces. Staging is now a plain
apex zone, so a one-label `*.dryrunbase.com` wildcard covers `app.`, `api.` and
`extractor.` — no two-label wildcard, no delegation records, and `bracemark.com`
never references staging at all. Production keeps the clean apex hosts that end
users actually see.

**The cost of a real domain: staging is as crawlable as production.** Nothing
about `dryrunbase.com` is private — it resolves publicly and serves the same
pages. Both static apps therefore generate `robots.txt` per tier from
`src/app/robots.ts` and emit `Disallow: /` on staging; they shipped an identical
allow-everything static file in both tiers until that existed, which duplicated
the whole marketing site on a second indexable domain. The switch is
`ALLOW_INDEXING`, required in every env file —
[env-files.md](./env-files.md#robotstxt-is-per-tier) has the reasoning, including
why staging gets no `noindex` meta tag to go with it.

The name had to be **obviously not the product**, and `dryrunbase.com` is: "dry
run" is what a staging tier does, and nothing in it reads as Bracemark. It
carries none of the brand's SEO or trademark weight, which is precisely what a
staging host should be worth.

### checking the deployed candidate

`npm run e2e:web:staging` tests the deployed app at `app.dryrunbase.com` and
marketing site at `dryrunbase.com`, with the real Workers and R2.
(`npm run e2e:extension:staging` drives this checkout's staging browser-extension build
against the same tier; it is the only run that reaches R2 from a
`chrome-extension://` origin — `e2e/STAGING.md`, _browser extension_.) It checks
HTML, security headers, app build identity, Worker CORS and deliberate browser
CSP refusals on both origins. `--include-trait security` runs the deployment
checks alone. Three things hold the policy, and each catches what the other two
cannot:

- **the refusals** — the browser must raise an `enforce` violation for an
  unapproved script and an unapproved connection. A report-only header fails
  them, which is the point: it blocks nothing.
- **the pinned header** — `e2e/staging/policy.ts` is the whole policy, source by
  source, and the hosting case compares it with what CloudFront sends. A refusal
  cannot see what a policy _allows_, so `'unsafe-eval'` added to quiet a console
  message, a wildcard R2 host or the other tier's api would all pass it.
- **the violation guard** — every signed-in journey fails if the browser reports
  a CSP violation along the way (`e2e/web/fixtures/csp.ts`), asserted or not.
  That is what catches a host the policy is _missing_.

The test runner changes no CDN policy and deploys nothing. Its one write outside
the app is a `manual` purchase row in staging's D1, for the two server-extraction
journeys that need a paid plan — made with a D1-only token of its own, never the
deploy token below. Operational details and coverage limits:
[e2e/STAGING.md](../e2e/STAGING.md).

**Production is not a runner target**, so none of that runs there. What can is
`npx nx check:headers @stxapps/e2e -- production`: the same header comparison
and the same browser refusals, which create nothing and need no build behind the
CDN. It says the policy is the designed one and is enforced. It cannot say a
build works under it — the first production deploy needs that looked at by hand.

### security headers — where the CSP has to live

bracemark-web is `output: 'export'`, so **there is no Next server and
`next.config`'s `headers()` never runs**. The CSP that [account.md](./account.md)
names as the XSS mitigation for the bearer token and encryption key in IndexedDB
can therefore only be set by the CDN in front of the bucket. Note the trap in the
provider names: only bracemark-api and bracemark-extractor run on **Cloudflare**,
and they serve JSON rather than HTML, so the app's CSP is a **CloudFront**
artifact even though the backend is on Cloudflare.

One policy per tier, not one shared policy, because `connect-src` must name that
tier's own api and extractor origins. Keep them otherwise identical.

**It is enforced, on both tiers and both apps.** It shipped as
`Content-Security-Policy-Report-Only` first and moved to the enforcing header
once staging served a build to run against. Three consequences of that:

- **A violation is now a broken feature, and still a silent one.** The policy
  carries no `report-uri`, so the only record is the console of the browser that
  hit it. What stands in for a report endpoint is the staging suite's violation
  guard (_checking the deployed candidate_, above) — which sees only what a
  journey walks through.
- **Change the CDN's policy and `e2e/staging/policy.ts` in the same pass**, and
  staging before production. The pinned header goes red on any difference in
  either direction, so the table is where a new host gets argued for.
- **Trial a tightening as Report-Only _beside_ the enforcing header**, never in
  place of it: the two are independent headers, and swapping one for the other
  turns the protection off for the length of the trial. The guard counts a
  report-only violation as a failure too, so the suite says what the candidate
  would break.

The constraints baked in:

- `script-src` needs `'wasm-unsafe-eval'` — hash-wasm's Argon2.
- **`'unsafe-eval'` is deliberately absent, and one thing in the source keeps it
  that way.** zod 4 JIT-compiles a parser for every object schema through
  `new Function`, and probes for eval support with a `new Function('')` whose
  _caught_ throw is still a reported violation — so a bare `import { z } from 'zod'`
  anywhere puts an `eval` violation in the console on every page load, with the app
  working perfectly either way. `packages/shared/src/zod.ts` sets zod's `jitless`
  and re-exports `z`; lint restricts the bare specifier. That costs nothing (no
  runtime we ship to can eval), but it has to be set before a schema is
  constructed, not before it is parsed. →
  [api-contracts.md](./api-contracts.md#z-comes-from-shared-and-it-is-jitless).
- A static export cannot mint per-request nonces, so Next's inline bootstrap
  scripts need either a build-time hash union (regenerated every deploy) or
  `'unsafe-inline'`, with `connect-src` as the load-bearing exfiltration block.
- `worker-src 'self' blob:` — **both halves are needed, and `'self'` alone
  silently breaks sign-in.** The serwist service worker registers from a
  same-origin script, so it needs `'self'`. The Argon2 worker does not: Turbopack
  never hands `new Worker(new URL('./argon2.worker.ts', import.meta.url))` the
  chunk's URL. Its runtime builds a small bootstrap `Blob` that `importScripts`
  the real chunks, and starts the worker from that `blob:` URL (search the
  emitted `_next/static/chunks/turbopack-*.js` for `createObjectURL`). `'self'`
  does not match `blob:`, so a policy with only `'self'` blocks the KDF, and every
  sign-in and account creation hangs, while the service worker registers fine.
  The chunks the bootstrap imports are same-origin and fall under `script-src`.
- `connect-src` is `'self'`, that tier's api and extractor origins, **and that
  tier's R2 endpoint** — `https://<cloudflare-account-id>.r2.cloudflarestorage.com`.
  R2 is the one that gets forgotten, because it is the one data path that need
  not touch the api: `packages/web-react/src/sync/r2.ts` PUTs and GETs the
  encrypted blobs over whatever URL `files/sign` answered, and that is a presign
  of R2 whenever the api serving the page's build predates the blob route, or a
  build that predates it is the one running
  ([local-first-sync.md](./local-first-sync.md), _the blob route_). A current
  build against a current api goes through the api's own origin instead, so a
  staging run of today's checkout no longer exercises R2 here at all — which is
  exactly why the entry has to stay until no such build or api is left, not until
  a test notices. Omit it while one is and the app still signs
  in, still lists links, and silently loses every image, screenshot and page copy —
  a console violation is the only symptom, and local runners do not execute
  under a CSP. The staging image-import/cross-profile case exercised this path
  with the deployed headers, and its violation guard fails on the violation
  itself rather than on the missing image — but against a tier serving the blob
  route it moves its images through the api, so it now guards the api origin's
  entry, not this one. Name the tier's **exact** account host rather than
  `https://*.r2.cloudflarestorage.com`; the wildcard authorises every Cloudflare
  account's R2 as a destination, and the id it hides is already visible to any
  signed-in user in devtools.
- `img-src` needs `blob:`. Favicons and link images are decrypted locally and
  rendered from `URL.createObjectURL` (`use-object-url.ts`, behind
  `use-favicon-url.ts` and `use-image-file-url.ts`), never fetched from the site
  they came from — which is also why neither `img-src` nor `connect-src` needs a
  bare `https:`. Extraction and favicon fetches go through the extractor origin,
  and that property is worth more than any directive here: keep it.
- Both of the above are what makes `'unsafe-inline'` on `script-src` survivable,
  so every host added to `connect-src` widens the one control that is holding —
  add deliberately.
- `frame-ancestors` is ignored in a `<meta>` tag and only works from a real
  header, which is another reason this cannot live in the app.
- **Paddle.js** ([iap.md](./iap.md)) loads from Paddle's CDN and opens checkout as
  an overlay `<iframe>`. Every host involved (`cdn.paddle.com`, `buy.paddle.com`,
  `checkout-service.paddle.com`, and their `sandbox-*` peers) is one label under
  `paddle.com`, so a single `https://*.paddle.com` per directive covers sandbox
  and live alike — the Paddle allowances are **identical across tiers**, and only
  the api, extractor and R2 `connect-src` hosts differ. Add it to `script-src`,
  `frame-src`, `connect-src`, `img-src` and `style-src`. The `connect-src` entry
  is the one that widens the exfiltration block above; that is the price of
  overlay checkout. Re-check this against Paddle's own CSP guidance at
  integration time.

**The other security headers are not the CSP and are not free of choices.** HSTS,
`nosniff` and a `strict-origin-when-cross-origin` referrer policy are the
uncontroversial three. Two are not:
`X-Frame-Options` should be **`DENY`**, agreeing with `frame-ancestors 'none'` —
nothing frames either app, and Paddle is the app framing _them_. And
**`X-XSS-Protection` should be omitted**, not set: the auditor it enabled is gone
from Chrome and Edge, was never in Firefox, and had bypasses that could leak
cross-origin data. It is in every "security headers" preset you will be offered,
including AWS's own managed one, which is the only reason it needs saying.

Two more sit outside every such preset and are worth setting by hand.
**`Cross-Origin-Opener-Policy: same-origin-allow-popups`** severs `window.opener`
for anything that opens the app cross-origin, which is worth more here than on an
ordinary site given what the app holds in memory — `same-origin-allow-popups`
rather than plain `same-origin` so a popup the app itself opens keeps working
(Settings → Subscription reaches Paddle's portal through `window.open`). And a
**`Permissions-Policy`** disabling the features neither app uses — camera,
microphone, geolocation, and the sensor family. **`payment` stays out of that
list, deliberately — naming it in either direction breaks checkout.** Its
default allowlist is `self`, which lets the page delegate it through an iframe's
`allow` attribute, and Paddle.js creates its checkout iframe (overlay and inline
alike) with `allow="payment"` — that delegation is what gives Apple Pay and
Google Pay in the checkout the Payment Request API. `payment=()` would take the
wallets away. Naming Paddle's origin instead would pin one host into a header
that must track whichever one Paddle.js loads — the checkout host differs
between sandbox and live, so the two tiers would need different values — and a
Permissions-Policy allowlist takes exact origins, so the `https://*.paddle.com`
wildcard that works throughout the CSP is invalid in it. COEP is not wanted — it
buys cross-origin isolation for `SharedArrayBuffer`, which the Argon2 worker does
not need.

**The marketing site gets its own, much smaller policy — do not reuse the app's.**
The apex holds no credentials, runs no crypto and has no service worker, so it
needs none of `wasm-unsafe-eval` or the Paddle allowances; checkout happens in
the app. A tight `default-src 'self'` plus its tier's api origin in `connect-src`
is almost the whole policy. Copying bracemark-web's would silently widen the apex
to every host the app needs, for nothing.

**The one addition is `worker-src blob:`.** The site does run a dedicated worker,
the bookmark converter's (`src/app/tools/bookmark-converter/`), and Turbopack
starts it from a `blob:` bootstrap exactly as it does the app's Argon2 worker
(above). Without a `worker-src`, the browser falls back through `script-src` to
`default-src 'self'`, which does not match `blob:`. The tool then fails on every
file with "Could not check this file", and the rest of the site looks fine.
`'self'` is not needed here: the site has no service worker.

**The demo clip needs nothing, and that is why it is a file.** The launch post
plays an mp4 from `public/video/` (`<DemoClip />`,
`apps/bracemark-site/src/components/mdx-components.tsx`). The policy has no
`media-src`, so the browser falls back to `default-src 'self'`, which a
same-origin file satisfies. A hosted player is the other way to put a video on a
page and it costs two things at once: a `frame-src` for someone else's origin in
both tiers' policies and in `e2e/staging/policy.ts`, and the sentence /privacy
and the FAQ both print — that Bracemark loads no third-party code outside one
screen of the app. Serving it from a second bucket or a media subdomain would
keep the sentence and still need a `media-src`; under `public/` it rides the
deploy that already exists, and CloudFront answers the `Range` requests Safari
will not play a video without.

### clean URLs — the CloudFront function

`tools/cloudfront/rewrite-url.js`, associated with the **viewer request** event on
both of a tier's distributions.

The buckets are private and reached through an Origin Access Control, so the origin
is the S3 **API**, not an S3 website endpoint: no index document, no directory
semantics, no clean URLs. `next build` writes the page for `/support` to the key
`support.html`, which means that without a function the only URL that works is
`/support.html`. Everything either app's URL space assumes is this one file:

| request                                   | what happens                                                                    |
| ----------------------------------------- | ------------------------------------------------------------------------------- |
| `www.<domain>/x`                          | 301 to the apex (only the site has a `www.` alias)                              |
| `/support/`, `/support///`                | 301, trailing slashes stripped                                                  |
| `/support.html`                           | 301 to `/support` — `/index.html` is exempt, see below                          |
| `/`                                       | rewritten to `/index.html`                                                      |
| `/favicon.ico`, `/_next/**`, `/links.txt` | passed through — a dot in the last segment means a real file                    |
| `/.well-known/security.txt`               | passed through by that same rule ([below](#well-knownsecuritytxt))              |
| `/.well-known/apple-developer-merchant…`  | passed through by exact path — no dot ([below](#apple-pay-domain-verification)) |
| `/settings/misc`                          | rewritten to the key `settings/misc.html`                                       |

The redirect rules are evaluated together and emit **one** 301, so
`https://www.bracemark.com/support/` is a single hop, and every redirect carries the
query string through verbatim and lands on an absolute `https://` URL. Both of those
matter: `/links?list=inbox&q=…` is bracemark-web's whole addressing scheme
([search.md](./search.md)), and a redirect built from the request path alone is an
open redirect — a request for `//evil.com/` would answer `Location: //evil.com`,
which a browser reads as scheme-relative and follows off-site.

**What the distribution has to be configured with, for the above to hold:**

- **No default root object.** The function serves `/` itself, so the setting is
  redundant — and when it is set, CloudFront may resolve `/` to `/index.html` before
  the function runs, which is what `/index.html`'s exemption from the `.html`
  redirect is guarding. Without the exemption the two together answer the apex
  homepage with a 301 to `/index` (the rule strips the extension, so it does not
  produce `/`), cached for an hour. Leave the field empty; the exemption is there
  because "distribution has no default root object" is something a compliance
  scanner will flag as missing, and someone will eventually fill it in.

  The exemption is why the root is the one page with two live URLs — `/index.html`
  and `/index` both answer 200 beside `/`, and no `<link rel="canonical">` settles
  it. Canonicalizing them (`/index.html` → `/`) is a one-line change and is
  deliberately not made: it converts that same misconfiguration from an ugly
  redirect into an **infinite** one on `/`, taking the homepage down, and the
  function cannot detect the case — a default-root-object rewrite arrives
  byte-identical to a viewer requesting `/index.html`. If the duplicates ever need
  to go, drop the two keys at the origin instead of redirecting them.

- **Custom error responses: 403 _and_ 404 → `/404.html`, with response code 404.** A
  path matching no key (`/nope` → `/nope.html`) 404s at S3, or 403s if the bucket
  policy grants only `s3:GetObject` and not `s3:ListBucket` — this is what turns
  either into each app's own 404 page (`not-found.tsx`). CloudFront fetches that page
  itself, so it does not come back through the function.
- The **CSP and the other security headers** belong to a response headers policy, not
  to this function — _[security headers](#security-headers--where-the-csp-has-to-live)_
  above.

A deploy touches none of it: `deploy-static.sh` uploads objects and invalidates.

**One function per tier — `rewrite-url-staging`, `rewrite-url-production` — each
shared by that tier's two distributions, and both published from this one file.**
Sharing within a tier is the point: web and site want identical rules, and one
publish updates both.

Splitting across tiers is a deliberate copy rather than a constraint, and it is the
only thing that makes a change testable. A function has exactly two stages,
`DEVELOPMENT` and `LIVE`, and publishing promotes the code to every associated
distribution at once — no per-distribution rollout, no canary. One function across
all four distributions would make every publish a production publish. So: edit the
file, push it to the staging function, test, publish, click through
`dryrunbase.com` and `app.dryrunbase.com`, then send the identical file to
production.

```bash
# once per tier
aws cloudfront create-function --name rewrite-url-staging \
  --function-config 'Comment=clean URLs for the static sites,Runtime=cloudfront-js-2.0' \
  --function-code fileb://tools/cloudfront/rewrite-url.js

# every change after that: update -> test -> publish (each --if-match takes the
# ETag the previous call returned)
aws cloudfront update-function  --name rewrite-url-staging --if-match <ETag> \
  --function-config 'Comment=clean URLs for the static sites,Runtime=cloudfront-js-2.0' \
  --function-code fileb://tools/cloudfront/rewrite-url.js
aws cloudfront test-function    --name rewrite-url-staging --if-match <ETag> \
  --stage DEVELOPMENT --event-object fileb://event.json
aws cloudfront publish-function --name rewrite-url-staging --if-match <ETag>
```

`test-function` runs the real runtime against an event object you write by hand (the
shape is in [AWS's event-structure reference](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/functions-event-structure.html))
and reports compute utilization alongside the result. It is the only faithful test
there is: `nx start` serves the export through `serve`, whose own `index.html`
resolution exercises none of these rules
([below](#previewing-a-production-build-locally--nx-start)).

`tools/cloudfront/rewrite-url.test.mjs` pins the table above — `npm run test:cloudfront`,
node's own runner, 200ms, deliberately outside `npm run test` (docs/testing.md, _the one
thing outside the two runners_). It cannot judge runtime compatibility or compute
utilization, so it comes before `test-function` rather than instead of it. What it is
really there for is the two rules whose deletion is otherwise silent: the `/index.html`
exemption and the absolute `Location`.

**The file must stay under 10 KB, comments included** — a CloudFront quota that
can't be raised. It sits at roughly 8.5 KB, so a long new comment is a real budget
question rather than a theoretical one; the test asserts the ceiling, so it fails in
node rather than at `create-function`.

### request logging on the static hosts

⚠ **Off, published, and declared nowhere in this repo.** The four distributions
and their four buckets are configured in AWS, not in a file here, so nothing —
no lint rule, no type error, no test in either runner — can notice logging being
switched on. Two things make that more than housekeeping:

- **bracemark-web's page URL can carry words a person typed.** A search is the
  URL ([search.md](./search.md), _the query is the URL_), and a page load goes to
  the origin first, so CloudFront receives those words in a request line — and
  again in the `Referer` of any same-origin request made from that page, which a
  standard log records as a field of its own. It
  **sees** them regardless; whether they are **written down** is this setting.
- **/privacy says we keep no copy** — "we keep no separate copy of our own" of
  the request data, and of those search words by name
  (`apps/bracemark-site/src/app/privacy/page.tsx`, _Technical and security
  data_). A CloudFront standard log delivered to a bucket of ours would be
  exactly that copy, under a retention period we would then be choosing.

Read back with the AWS CLI on 2026-10-13, both tiers:

| what                                                        | all four                          |
| ----------------------------------------------------------- | --------------------------------- |
| distribution `Logging.Enabled` (standard logging to S3)     | `false`, no bucket                |
| real-time log configs (account-wide list, and per behavior) | none                              |
| WAF web ACL (its own request log)                           | none attached                     |
| Lambda@Edge associations                                    | none                              |
| the viewer-request function, `LIVE` stage                   | byte-identical to the repo's file |
| bucket server access logging                                | not configured                    |

And three account-wide reads, which are not per distribution:

| what                                                          | the account |
| ------------------------------------------------------------- | ----------- |
| CloudWatch log deliveries — sources, deliveries, destinations | none        |
| a `/aws/cloudfront/function/…` log group                      | none exists |
| CloudTrail trails, every region                               | none        |

The function matters because a CloudFront Function's `console.log` is its own
log channel, to CloudWatch, and `rewrite-url.js` reads the query string to
rebuild a redirect's `Location`. It logs nothing, the deployed copy is the
tracked one, and the log group such a line would create has never been made.
Both bracemark-web distributions use the managed `CachingOptimized` cache policy
with no origin request policy, which forwards no query string to S3, so the
words stop at the edge either way.

**The deliveries row is the one a read of the distribution misses.** CloudFront
has two standard-logging mechanisms, and the newer one is set up as a CloudWatch
Logs _delivery_ rather than on the distribution, so `Logging.Enabled: false`
says nothing about it. It is also the one a console walkthrough is likeliest to
create. No trail means no CloudTrail data events on the buckets either — those
would have recorded object reads by key, not a viewer's query string.

To repeat the read after any change in the AWS console:

```sh
aws cloudfront get-distribution-config --id <id> \
  --query 'DistributionConfig.{log:Logging,waf:WebACLId,rt:DefaultCacheBehavior.RealtimeLogConfigArn}'
aws cloudfront list-realtime-log-configs
aws s3api get-bucket-logging --bucket <bucket>   # prints nothing when off
aws logs describe-delivery-sources --region us-east-1
aws logs describe-log-groups --region us-east-1 --query 'logGroups[].logGroupName'
aws cloudtrail list-trails
```

The last three need more than the deploy permissions: an identity holding only
CloudFront and S3 access is refused them, and a refusal is not an empty list.
`CloudWatchLogsReadOnlyAccess` and `AWSCloudTrail_ReadOnlyAccess` are enough.

**Turning any of it on is a /privacy change first.** If a fault ever needs
access logs, the page says so before the setting moves, and the search words in
the request line are the reason the order matters.

### `/.well-known/security.txt`

RFC 9116, served from the site only, and the first URL a security researcher
fetches — it 404'd for the whole of this site's public life while `SECURITY.md` in
the repository already carried every fact it needed.

It is a **route handler** (`apps/bracemark-site/src/app/.well-known/security.txt/route.ts`,
`export const dynamic = 'force-static'`, the same declaration `app/robots.ts`
needs under `output: 'export'`), not a file in `public/`, for exactly one field.
RFC 9116 makes `Expires` mandatory and recommends under a year, so a hand-written
file dated the day it was added becomes an **invalid** document on a schedule
nobody set — and an expired security.txt reads as an abandoned one, which is worse
than none. Deriving it from the build date renews it on every deploy and bounds
the failure at how long we go without shipping. Note this is the opposite call
from `TERMS_UPDATED` / `PRIVACY_UPDATED` in `lib/site.ts`, which are typed by hand
on purpose: those **date a claim** and must move only when a human decides the
document changed. This dates nothing — it is a freshness marker on a contact
address.

Three things it depends on, none of which announces itself:

- **The export writes the dotfolder and the deploy syncs it.** `next build` emits
  `out/.well-known/security.txt`, and `deploy-static.sh`'s `aws s3 sync` of
  `$OUT_DIR` carries hidden directories with no extra flag. Verified in the
  export, not assumed.
- **The CloudFront function passes it through on the dot in `security.txt`**, not
  on anything about `.well-known` — the leading dot on the folder is incidental
  and must stay that way. `rewrite-url.test.mjs` pins the case, because a rule
  that grew a dotfolder branch would take the file off the air with a 404 nobody
  on our side ever requests.
- **`Canonical` takes `SITE_URL`**, which is hard-coded to production for the
  reason `lib/site.ts` gives, so a staging build publishes production's canonical.
  Same cosmetic mismatch as `og:url` there, and it costs nothing: staging is
  `Disallow: /` and nobody fetches this from it. It is _not_ caught by
  `verify_tier`, whose forbidden list is built from `NEXT_PUBLIC_*_URL` origins
  only — the bare apex is not one of them, which is the same reason the
  `/extractor` User-Agent survives a staging deploy
  ([above](#deploying-the-static-sites--deploy-staticsh)).

**`Policy:` points at `/security`, not at `SECURITY.md` on GitHub.** It pointed
at the file first, because for a stretch the file was the only policy document
there was. An on-origin target is better for the same reason `Canonical` exists: a
researcher holding this file is holding a claim about `bracemark.com`, and
resolving it should not depend on a link to a third-party host still pointing
where it did. `/security` prints the windows itself and links the repository for
the scope.

**The disclosure windows are committed in FOUR places**, and the values are no
longer typed in any of them but one: `SECURITY.md`, the "Reporting a security
problem" block on /support, the reporting section on /security, and — indirectly —
the `Policy:` line here, which decides which of the other three a researcher's
tooling reads first. Moving one and missing another is not a cosmetic slip: it
publishes two different promises to the one audience that reads a missed window as
a stall and goes public, and it fails no lint rule, no type check and no build.

The windows themselves live in `SECURITY_ACK_WINDOW` / `SECURITY_TRIAGE_WINDOW`
(`apps/bracemark-site/src/lib/site.ts`), so the two pages cannot disagree with each
other. `SECURITY.md` is markdown and can import nothing, so its copy stays typed
and `app/security/reporting-terms.spec.tsx` holds it — and the rendered text of
both pages — against those constants, plus the no-bounty statement and the
credit-you sentence, which are phrased per surface and so are asserted as present
rather than verbatim. The two fields on this file that decide where a report lands,
`Contact` and `Policy`, are pinned by `route.spec.ts` beside it (`@jest-environment
node`: a route handler returns a `Response`, which jsdom does not define). Word
forms rather than numerals in the constants, because a constant should not quietly
restyle published copy — same instinct as `brand.spec.ts` pinning the third copy of
the licence claim ([brand-assets.md](./brand-assets.md#the-source--what-we-may-claim)).
So the windows are still a decision to make deliberately in four places; what
changed is that forgetting one of them now fails `npm run test` rather than
shipping.

### `/sitemap.xml` and JSON-LD

The marketing site only — `app.bracemark.com` is an app behind an auth gate and
publishes neither.

**The sitemap** is `apps/bracemark-site/src/app/sitemap.ts`, the same
`force-static` metadata route as `robots.ts`, and production's robots.txt names
it ([env-files.md](./env-files.md#robotstxt-is-per-tier) has why staging's does
not). Three things to know:

- **The page list is typed by hand, and `sitemap.spec.ts` is what keeps it
  whole.** The module runs inside Next's build output, where walking `src/app/`
  would look in the wrong place, so the spec walks the tree instead and fails on
  any `page.tsx` the list is missing. A page that should stay out goes in the
  spec's `UNLISTED` set, with its reason. A dynamic route (`[slug]`) fails the
  spec outright unless it is in the spec's `DYNAMIC_ROUTES`: its URLs have to be
  enumerated in `sitemap.ts` from whatever its `generateStaticParams` reads. The
  routes today are `/docs/[slug]` and `/blog/[slug]`, each backed by its own
  manifest ([architecture.md](./architecture.md), _the marketing site's `/docs`_
  and _the marketing site's `/blog`_).
- **Clean URLs only**, the form the CloudFront function answers 200 for
  ([above](#clean-urls--the-cloudfront-function)). `/about/` or `/about.html` is a
  301, which a search console reports as a sitemap error. The function passes
  `/sitemap.xml` through on its dot, pinned in `rewrite-url.test.mjs` beside
  `robots.txt`; `deploy-static.sh` uploads it in the must-revalidate pass.
- **No `changefreq` or `priority`, and no generated `lastmod`.** Google ignores
  the first two and trusts `lastmod` only where it has proven accurate. Blog
  articles alone carry it, from their author-set publication or substantive
  update time; ordinary pages never get a build timestamp.

`/feed.xml` is a static GET route compiled from the blog manifest at build time.
The CloudFront clean-URL function passes the dotted path through. The deploy
script uploads `.xml` with the must-revalidate documents, then overwrites the
feed object with `application/rss+xml; charset=utf-8`, because `aws s3 sync`
infers generic XML from the extension rather than preserving the route's header.

**The JSON-LD** is `apps/bracemark-site/src/lib/structured-data.ts`, rendered by
`components/json-ld.tsx`: an `Organization` + `WebSite` + `SoftwareApplication`
graph on the landing page, and an `FAQPage` on `/faq`.

- **It holds no copy of its own.** Every string is a constant a visible page
  already prints — `BRAND.descriptor` as the app's description, `COMPANY` for the
  publisher, the four listings plus `SOCIAL` and `SOURCE` as the app's `sameAs`,
  the base prices from `@stxapps/shared` as its offers (lifetime only while
  `LIFETIME_ON_SALE`), and the FAQ's own answers. Nobody reads structured data
  rendered, so a sentence that existed only there would be a public claim no
  review ever saw ([brand-assets.md](./brand-assets.md)). No `aggregateRating`
  for the same reason — which also means no app rich result, since Google
  requires one; the graph is for entity identity, not a snippet.
- **The Organization is the legal entity, not the brand**: the one /terms and
  /privacy name, with the company's own site as its `url`. Bracemark is the
  `SoftwareApplication` it publishes.
- **The FAQ answers are extracted from JSX without rendering it** —
  `react-dom/server` is refused in a server component. `plainText()` walks
  `children`, and calls a plain function component that has none (`MailLink`
  prints its `address` prop). A component whose text is not its children would
  lose words there silently, so `structured-data.spec.tsx` compares every
  answer against the DOM's `textContent`.
- **The CSP does not apply.** `application/ld+json` is a data block the browser
  never executes, so it needs no hash and no `'unsafe-inline'`
  ([above](#security-headers--where-the-csp-has-to-live)). `<` is escaped as
  `\u003c` so a string containing `</script>` cannot close the tag.

### Apple Pay domain verification

Paddle offers Apple Pay in its checkout only on a domain Apple has verified, and
Apple verifies by fetching
`/.well-known/apple-developer-merchantid-domain-association` from **every domain a
checkout opens on** ([Paddle's guide](https://developer.paddle.com/concepts/payment-methods/apple-pay)).
Checkout happens only in bracemark-web, so the file lives in
`apps/bracemark-web/public/.well-known/` and the marketing site has none. It is
not ours to write: download it from **Paddle > Checkout > Website approval > Apple
Pay verification** (the domain must already be approved under _Domain approval_),
deploy, then click **Verify** there. It is a public verification file, not a
credential, so it is committed.

Not to be confused with `apple-app-site-association`, which is for universal links
and shared web credentials — neither of which Bracemark uses.

Three things it depends on, none of which announces itself:

- **The CloudFront function passes it through by exact path.** It is the one real
  file in either export with no dot in its name, so rule 5 misses it and rule 6
  would rewrite it to a `.html` key that doesn't exist — a 404 that shows up only
  as a failed **Verify**. `rewrite-url.test.mjs` pins the pass-through, and that it
  is exact rather than a `.well-known/` prefix (the reason is in
  [`security.txt`](#well-knownsecuritytxt) above).
- **No redirect in front of it.** Paddle requires the domain not sit behind a
  redirect or proxy. The file is fetched on `app.<domain>`, which has no `www.`
  alias, and the canonical path triggers none of rules 1–3.
- **Each tier is a separate verification.** Staging (`app.dryrunbase.com`) uses
  the sandbox Paddle account ([iap.md](./iap.md#config-per-env)), so Apple Pay on
  staging means verifying there too. `public/` is shared by both tiers' builds, so
  if the sandbox and live dashboards hand out different files, one committed copy
  cannot serve both.

### previewing a production build locally — `nx start`

Both web apps are `output: 'export'`, and **`next start` refuses to run against a
static export** — it exits with `"next start" does not work with "output: export"
configuration. Use "npx serve@latest out" instead.` So the `start` and
`serve-static` targets `@nx/next` infers (`nx.json`, `startTargetName`) are dead
on arrival in their default form.

They cannot simply be deleted, because those targets are **inferred by the
plugin** — removing the `nx.targets` override in `package.json` just reverts them
to a bare, still-broken `next start`. Instead both apps override the command to
serve the exported directory, which is what Next itself points you at:

```bash
npx nx build @stxapps/bracemark-web && npx nx start @stxapps/bracemark-web   # :3000
npx nx build @stxapps/bracemark-site && npx nx start @stxapps/bracemark-site # :3001
```

`start` depends on `build`, so the build above is implicit, and each app declares
`serve` as a devDependency for it. The ports match the dev servers (see
[env-files.md](./env-files.md#bracemark-site--nextjs-static-export)) — run the
preview or the dev server, not both.

This is the closest local stand-in for the real path, but it is **not** a
faithful one: the clean-URL rewrites live in a CDN function and the security
headers live in a response headers policy, so neither is exercised here. `serve`
does its own `index.html` resolution, which is enough to catch broken relative
asset paths and little more.

### naming conventions

One suffix scheme — `staging` / `production` — across everything, so a glance
tells you the tier: `bracemark-<resource>-<tier>`. The Worker auto-suffixes its
`name` (`bracemark-api` → `bracemark-api-staging`), so the env name _is_ the
tier, with no separate `-prod` shorthand.

| resource            | staging                                                                                              | production                                                                                                    |
| ------------------- | ---------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| S3 bucket (web)     | `bracemark-web-staging`                                                                              | `bracemark-web-production`                                                                                    |
| S3 bucket (site)    | `bracemark-site-staging`                                                                             | `bracemark-site-production`                                                                                   |
| Worker name / env   | `bracemark-api-staging` / `staging`                                                                  | `bracemark-api-production` / `production`                                                                     |
| Extractor Worker    | `bracemark-extractor-staging` / `staging`                                                            | `bracemark-extractor-production` / `production`                                                               |
| CloudFront function | `rewrite-url-staging`                                                                                | `rewrite-url-production`                                                                                      |
| D1 databases        | `bracemark-directory-db-staging`, `bracemark-accounts-db-1-staging`, `bracemark-sessions-db-staging` | `bracemark-directory-db-production`, `bracemark-accounts-db-1-production`, `bracemark-sessions-db-production` |
| R2 bucket           | `bracemark-user-files-staging`                                                                       | `bracemark-user-files-production`                                                                             |

**The domains are the deliberate exception**: staging's hosts are
`*.dryrunbase.com`, carrying neither the brand nor the tier suffix, for the
reason given [above](#why-staging-is-a-separate-registrable-domain). The
CloudFront function is the smaller one: it is named for what it does rather than
for the product, because its code says nothing about Bracemark and a second static
site in the same account would use it unchanged. The `*-dev`
peers (`bracemark-directory-db-dev`, `bracemark-user-files-dev`, and the rest)
are the local `wrangler dev` bindings and are never deployed.

### deploying the static sites — `deploy-static.sh`

Both web apps are `output: 'export'`, so deploying one is "upload a directory to
S3 and invalidate the CDN". `tools/scripts/deploy-static.sh` does that, and the
root `package.json` wraps it:

```bash
npm run deploy:web:staging       npm run deploy:web:production
npm run deploy:site:staging      npm run deploy:site:production
```

It builds for the tier, checks the artifact, syncs, then invalidates — and for
bracemark-web, checks the service worker before the sync and again after the
invalidation (_the worker check_, below). The
distribution id comes from `CLOUDFRONT_DISTRIBUTION_ID_<APP>_<TIER>` (e.g.
`CLOUDFRONT_DISTRIBUTION_ID_WEB_PRODUCTION`), read from the shell first and then
from the gitignored root `.env.local` the script parses in its preflight
([env-files.md](./env-files.md#whats-committed-vs-ignored)) — the ids are not
committed. `--distribution-id` overrides it for one run; `--dry-run`,
`--skip-build` and
`--no-invalidate` are there for the obvious reasons, and a production run
prompts for the bucket name unless `--yes` is passed. It also records the commit
it shipped and refuses uncommitted work on production — `--allow-dirty`,
`--no-push`, and _[which commit is live](#which-commit-is-live--deploy-tags)_
below.

**It builds rather than uploading whatever is in `out/`, and then verifies the
tier.** This is the enforcement half of _built once per tier, never promoted_
[below](#cors--frontendbackend-wiring): a bundle carries its API and app origins
inlined, so pushing a staging `out/` to the production bucket yields a site that
looks entirely correct until someone tries to sign in — pointing at
`api.dryrunbase.com`, holding the Paddle sandbox token. The script reads every
`NEXT_PUBLIC_*_URL` out of both tiers' env files, reduces each to its **origin**
(scheme + host), and refuses to upload a bundle that mentions the other tier's.
An origin shared by both tiers cancels out of the comparison, so adding a
third-party one doesn't blunt it.

**Keyed on the origin, not the registrable domain** — even though the domain is
what actually separates the tiers
([above](#why-staging-is-a-separate-registrable-domain)). bracemark-site's own
_content_ names `bracemark.com` in prose that is deliberately tier-independent:
`support@`/`security@`/`abuse@bracemark.com`, the "bracemark.com and
app.bracemark.com" scope lines in /terms and /privacy, and the
`https://bracemark.com/extractor` User-Agent that /extractor publishes to the
operators of sites we fetch ([link-extraction.md](./link-extraction.md#server-extraction-a-separate-bracemark-extractor-anonymous)).
None of that moves per tier, so a domain-keyed check rejects **every**
`deploy:site:staging` and no rebuild can fix it. An origin misses all of it and
still catches what a mis-tiered bundle actually carries — the other tier's baked
`https://api.*` / `https://app.*` values.

**Satisfied by any one of this tier's origins, not all of them**, because
bracemark-site declares `NEXT_PUBLIC_API_URL` but never mentions the api at all;
an all-of check would reject every site deploy for the opposite reason.

Matching is by substring, so `https://dryrunbase.com` catches
`https://dryrunbase.com/support`. The trap that leaves is an env file naming a
bare apex that _prefixes_ a hard-coded content URL — give bracemark-site a
`NEXT_PUBLIC_SITE_URL=https://bracemark.com` and the /extractor User-Agent above
starts matching again. It fails loudly at deploy rather than shipping something
wrong, but it is the reason that one origin is still hard-coded in
`apps/bracemark-site/src/lib/site.ts`.

The check is not decoration: bracemark-web's `metadataBase` and `og:url` were
hard-coded to `https://app.bracemark.com`, so every staging build advertised
production's origin in its card metadata. That is now
`NEXT_PUBLIC_APP_URL` ([env-files.md](./env-files.md#bracemark-web--nextjs-static-export)).

**Three cache classes, keyed off the path rather than a list of filenames.**

| what                                         | `Cache-Control`               | `--delete` |
| -------------------------------------------- | ----------------------------- | ---------- |
| `_next/**` — content-hashed, build-ID-scoped | `max-age=31536000, immutable` | no         |
| images, icons and `.mp4` — stable names      | `max-age=604800`              | yes        |
| `.html`, `.txt`, `.xml`, `sw.js`, `*.json`   | `max-age=0, must-revalidate`  | yes        |

Uploaded in that order, so a client loading a page mid-deploy can always resolve
the chunks it was just handed. The middle class is an extension list in
`deploy-static.sh`, and an extension missing from it is not an error: the file
falls into the last class and is revalidated on every request, which is how a
video would have shipped had `.mp4` not been added beside the image types. The `.txt` files are Next 16's RSC payloads and
travel with the HTML, not with the assets — they must not outlive it. `_next/`
is the one pass without `--delete`: a client on the previous build is still
fetching chunks by hash, and deleting them mid-session breaks navigation. That
means old builds accumulate — a build is ~10 MB, so they are left to.

**Never expire `_next/` with an S3 lifecycle rule by age.** The pass is
`--size-only`, so a chunk whose hash survives a build is never re-uploaded and
keeps the `LastModified` of the deploy that **first** uploaded it — a vendor
chunk can be months old and still loaded by the live build. An "expire after
_N_ days" rule on the prefix therefore deletes files the current build needs,
N days after they first shipped, with no deploy anywhere near it: the app
starts failing chunk loads and CloudFront answers each with `/404.html`. If old
builds ever need pruning, prune by **reference** — delete the `_next/` keys that
none of the last few builds' `out/` contains — never by age. Old tabs rely on
this rule once the service worker can hand them a new build
([offline-mode.md](./offline-mode.md), _version skew_).

**The worker check — bracemark-web only.** A browser that has installed the
service worker keeps it until a new one finishes installing, and that install
is all-or-nothing: one precache URL that does not answer 200 and the new worker
never takes over, in any browser, with no error anywhere
([offline-mode.md](./offline-mode.md), _`/sw.js` is permanent_). Nothing local
can rule that out, because whether a URL resolves is decided here — by the
clean-URL function and the keys in the bucket. So `deploy-static.sh` runs
`tools/scripts/check-service-worker.mjs` twice:

- **Before the sync**, against `out/`: every URL in the worker's precache
  manifest names a file in the export, by the function's own mapping (`/links` →
  `links.html`, never `links/index.html`), and only `/_next/static/` entries lack
  a revision. A failure here publishes nothing.
- **After the invalidation completes**, against the tier's own host
  (`NEXT_PUBLIC_APP_URL` from its env file): `/sw.js` answers 200, as
  JavaScript, with no redirect, byte-identical to `out/sw.js`; and every
  manifest URL answers 200. A failure here exits non-zero with the bucket
  **already updated** — fix and redeploy; the message says what is at stake.

`--no-invalidate` and `--no-wait` skip the second half, since the CDN may still
be serving the previous build, and print the command to run it by hand:
`node tools/scripts/check-service-worker.mjs apps/bracemark-web/out --origin <host>`.
`npm run check:service-worker` is the first half alone. A change to
`tools/cloudfront/rewrite-url.js` is the other moment to run the second half —
it can turn a precached URL into a 404 without any deploy of the app.

**No `--acl public-read` anywhere.** Buckets created since April 2023 have ACLs
disabled by default (`BucketOwnerEnforced`), which makes that flag an
`AccessControlListNotSupported` error rather than a no-op — and the buckets are
private regardless, reached only through CloudFront via an Origin Access
Control. Public read is a distribution concern here, not an object one.

The CSP and the clean-URL rewrites are **not** the script's business — they live
in a response headers policy and in `tools/cloudfront/rewrite-url.js`, per _security
headers_ [above](#security-headers--where-the-csp-has-to-live) and _[clean
URLs](#clean-urls--the-cloudfront-function)_. A deploy never touches them.

### deploying the workers — `deploy-worker.sh`

The two Cloudflare Workers deploy the other way round from the static apps:
there is no artifact to upload and nothing to invalidate, because `wrangler`
bundles and ships in one step and a Worker deploy is live the moment it returns.
`tools/scripts/deploy-worker.sh` is the sibling of `deploy-static.sh` and takes
the same shape, and the root `package.json` wraps it:

```bash
npm run deploy:api:staging        npm run deploy:api:production
npm run deploy:extractor:staging  npm run deploy:extractor:production
```

It resolves the tier's credential, proves that credential points at the tier it
claims to, compiles, applies the D1 migrations remotely, deploys, and then
health-checks the custom domain. `--dry-run`, `--skip-migrate`, `--no-deploy`,
`--no-smoke`, `--allow-todo` and `--yes` are there for the obvious reasons, and a
production run prompts for the Worker name unless `--yes` is passed. Like the
static deploy it records the commit it shipped and refuses uncommitted work on
production — `--allow-dirty`, `--no-push`, and
_[which commit is live](#which-commit-is-live--deploy-tags)_ below.

**There is no per-tier artifact here, and that is the one way it differs from
the static deploy.** A Worker bundle bakes nothing: config is read at runtime
from `c.env` ([env-files.md](./env-files.md#bracemark-api--hono-on-cloudflare-workers)),
so the same bytes are correct for either tier and there is no equivalent of
`deploy-static.sh`'s `verify_tier`. What the script guards instead is the
_destination_.

**The credential is the whole guard, so the script will not run without the
right one.** Each tier is its own Cloudflare account
([above](#why-staging-is-a-separate-registrable-domain)), and neither
`wrangler.jsonc` names an account — so nothing in this repo pins where a deploy
lands. Three consequences the script is built around:

- **A per-tier API token, out of the login keychain, never from a file in the
  worktree.** The tier's account id lives in a gitignored `.env.<tier>.local`
  beside `wrangler.jsonc` and that is fine — it is an identifier, and leaking it
  grants nothing. A token is a credential and is the only thing scoping a deploy
  to one tier, so it is kept where the AWS half of this deploy keeps its own
  (outside the tree) and put into the environment for the length of one command.
- **No fallback when the keychain misses.** Bare `wrangler` would quietly use an
  OAuth session from `wrangler login`, which authenticates the **user** rather
  than an account — and one user owns both tiers, so that session reaches
  production. The script dies instead.
- **The account check mirrors `verify_tier`**: it reads this tier's expected id
  and the other tier's out of the two gitignored files, and refuses to deploy
  with a credential that can see the wrong one. It is a second opinion rather
  than the guard — a token minted against a single account cannot reach the other
  one at all, which is what actually makes this safe — so a token without the
  permission to answer gets a warning, not a failure.

**Migrations run before the deploy, and always `--remote`.** Every D1 migration
is additive by rule (`apps/bracemark-api/src/db/migrations/README.md`), so old
code runs fine against a new schema and new code may not run against an old one;
migrate-then-deploy is the only ordering safe in both directions.
`wrangler d1 migrations apply` **defaults to the local miniflare database** when
given neither `--local` nor `--remote`, and reports success — so the flag is not
a preference, it is the difference between migrating production and writing to a
file under `.wrangler/`. The script lists each binding's pending migrations
first, which doubles as the check that its `database_id` is real and reachable by
the token in hand. bracemark-extractor has no storage bindings at all and skips
this entire phase.

**bracemark-api carries a cron trigger** (`triggers.crons`, declared per env in
`wrangler.jsonc`, daily): the `scheduled` handler in `src/worker.ts` purges
finished session rows on their two retention clocks
([sessions.md](./sessions.md)). It ships with the deploy like any other config;
`wrangler dev` never fires it, and `curl
"http://127.0.0.1:8787/cdn-cgi/handler/scheduled"` runs it locally.

**Unfilled `TODO:` values are fatal on production and a warning on staging.**
`wrangler` prints every `vars` value in its dry-run summary, which is the only
place a placeholder that was never filled in is visible: a `TODO:` string is a
perfectly valid string, so it deploys, and the symptom is a runtime one — a
checkout selling a price id that does not exist. Staging is where those get
filled in one at a time as the accounts behind them come into existence, so a
hard stop there would block the deploys you need to make progress; on production
every one of them is a live billing path. `--allow-todo` overrides.

**The first deploy of a tier is also what provisions its custom domain.** With
that environment's `routes` entry uncommented, `wrangler deploy` writes the
hostname's DNS record and certificate into the zone — which is why the zone has
to be in the same account as the Worker, and why the health check at the end can
legitimately fail for a few minutes on a first run while the certificate issues.

**What a deploy does not touch: secrets.** They are set out of band, per Worker
per environment — `bracemark-api-staging` and `bracemark-api-production` are
different Workers, so each needs its own complete set, with no inheritance from
the top level (the same rule that applies to `vars` and every binding). Use
`wrangler secret bulk --env <tier>` rather than one interactive `secret put` per
value; two of the api's secrets are multiline PEMs. A deploy never deletes a
secret. It **does** replace `vars` from `wrangler.jsonc`, which is intended —
that file is their source of truth, so `--keep-vars` is deliberately absent.

⚠ **The converse is the one that bites: setting a secret does not apply
`vars`.** `wrangler secret put` and `secret bulk` each create a new Worker
version, and that version carries the `vars` of the one before it — it never
reads `wrangler.jsonc`. So a credential whose two halves sit on either side of
that line is half-configured until the next **deploy**, and nothing says so: the
secret command succeeds, the tree is correct, and the `TODO:` gate above reads
the config about to ship, not the one already running. Play's service account
is exactly that pair — `PLAY_SA_PRIVATE_KEY` is a secret, `PLAY_SA_EMAIL` a var
— and it ran that way: the address was committed and the Worker's secrets set
within minutes of each other, no deploy followed on either tier, and the
placeholder stayed live. The
first real Play notification then had its token exchange refused
(`playAccessToken: token endpoint 400`), the notify route answered 500 as
designed for a store-side failure ([iap.md](./iap.md)), and Pub/Sub redelivered
into it for days — about one request every fifteen seconds per tier, every one
logged, none of it visible from the client. Staging recovered on its next
deploy and the notifications still being redelivered were then accepted;
production's stopped arriving, never accepted, days before it got one.

Two readings tell a config-only version from a real deploy, and both are worth
a look after setting a secret: `wrangler versions list --env <tier> --json`
carries `annotations["workers/triggered_by"]` — `secret` or `version_upload` —
and `wrangler versions view <version-id> --env <tier>` prints the `vars` that
version actually runs with. **A var and a secret that belong together ship
together: set the secret, then deploy.**

**Per-Worker secrets, not Secrets Store.** `wrangler secret` sets an encrypted
variable on one Worker, arriving as `c.env.NAME`; Cloudflare's Secrets Store is a
separate account-level product bound through `secrets_store_secrets`, for a
secret shared across many Workers. Nothing here is shared — every secret belongs
to bracemark-api alone (the extractor has none: v1 is anonymous, with no session
and no key), and the tiers are already separated by account — so it would buy no
reuse while adding a `store_id` to this public config and a dependency on a
product still in open beta.

### which commit is live — deploy tags

The four deployed apps carry no version number
([architecture.md](./architecture.md#project-versions--000-unless-a-store-reads-it),
_project versions_), so "which commit is live, and what was live before it" is
answered by the deploy scripts instead, in `tools/scripts/deploy-commit.sh`,
which both source.

**Every successful production deploy tags the commit it shipped:**

```
<app>/<utc date>-<utc time>         web/20261013-091500
```

```bash
git tag -l 'web/*'                                # every production deploy of web
git diff <tag> HEAD -- apps packages              # what is not out yet
```

The name is short on purpose — it is read in a git client's ref column, where a
long one is cut off — so it says neither "deploy" nor "production". A tag under
`web/`, `site/`, `api/` or `extractor/` **is** a production deploy, by this
convention and nothing else: keep every other tag out of those four namespaces.
The time is UTC, to the second — a Worker deploys in under a minute, and two
deploys of one app must not want the same name.

The tag is created when the deploy becomes real — after the S3 syncs, after
`wrangler deploy` returns — not at the end of the script, because a failed
invalidation or health check leaves the new code live all the same. It is
lightweight, not annotated: an annotated tag needs an identity and may ask to be
signed.

**The script then pushes it to `origin`**, because a step left to memory is a
step that gets skipped, and a tag that never leaves one clone is a history the
other clone cannot see. Three things bound that push:

- **Only a tag whose commit `origin` already has.** Pushing a tag uploads the
  commit it points at, so a deploy made from unpushed commits would otherwise
  publish them — to a public repo, ahead of the push that was going to — as a
  side effect of deploying. "Already has" is read from this clone's
  remote-tracking branches, without a fetch. A tag held back this way is not
  lost: every production deploy pushes **all** deploy tags of the four apps that
  `origin` can now take, not only its own, so it goes out with the next one —
  or by hand, with the `git push origin <tag>` line the script prints.
- **Never fatal, never a prompt.** By then the deploy is live, so a failed push
  is a warning (and is retried by the next production deploy, the same way). It
  runs with `GIT_TERMINAL_PROMPT=0`: a missing credential fails rather than
  asking for one. The static deploy pushes last, after the invalidation, so a
  push that stalls is never standing between an updated bucket and its CDN.
- **`--no-push`** tags without pushing, for the run where that is wanted.

A pushed tag is **public and, in practice, permanent** — forks and mirrors keep
it. It is the same kind of statement as `/deploy.json` below: the operator's
record of what was shipped, not a claim about the bytes being served.

**Staging is not tagged.** Its tag history could never be trusted to be complete
— a dirty tree deploys there, untagged, and staging is exactly where uncommitted
work is tried — and what only a tag can answer (what was live before, what to
roll back to, what is not out yet) are production questions. What is on staging
_now_ is answered by the deployed thing itself, below, which covers every deploy,
dirty ones included, from any clone. The cost is the static apps' staging
history: `/deploy.json` is overwritten by each deploy, so what was there before
is not recorded anywhere (a Worker's is, in `wrangler versions list`).

**A deploy builds the working tree, not `HEAD`**, so the tag is only true when
those are the same thing. Uncommitted or untracked changes anywhere in the repo
are **fatal on production and a warning on staging** — the same split as the
`TODO:` check above, for the same reason. A dirty deploy that goes ahead (staging,
or production with `--allow-dirty`) is stamped `<sha>-dirty` and, on production
too, is **not tagged**. Ignored files are outside the check, which is its one
limit: the per-tier env files are ignored and are inputs too.

**Because a tag can still be local, and staging has none, the deployed thing can
also be asked directly:**

| app                       | where                              | read with                             |
| ------------------------- | ---------------------------------- | ------------------------------------- |
| bracemark-web, -site      | `/deploy.json` in the bucket       | `curl https://<host>/deploy.json`     |
| bracemark-api, -extractor | the Worker version's tag + message | `wrangler versions list --env <tier>` |

The Worker version's tag is the commit (`<sha>` or `<sha>-dirty`); its message is
the git tag's name, or `untagged: staging` / `untagged: dirty tree` when there is
no git tag to name.

`/deploy.json` is `{ commit, dirty, deployedAt, tag }` — `tag` only when the
deploy was tagged, so never on staging. It is written by the
script straight to the bucket at **deploy** time and is deliberately not a field
of the build — not of bracemark-web's `/build.json`, say. `nx build` is cached
and `--skip-build` exists, so a commit baked in at build time names the commit of
the _build_, which need not be the one being deployed; and declaring the commit a
build input to fix that would mint a new build id — hence a service worker
update and an update pill — for every deploy that changed nothing in the app
([offline-mode.md](./offline-mode.md), _which build is this page_). The
documents pass of the sync excludes `deploy.json` so that `--delete` does not
remove the previous copy a moment before it is replaced.

It is the **operator's record, not a claim**. A self-reported sha proves nothing
about the bytes served beside it, so it does not move the boundary in
[brand-assets.md](./brand-assets.md), _the source — what we may claim_: still
"see for yourself what we do", never "verify what you are running".

**Rolling back.**

- **A static app:** check out the previous `<app>/…` tag, `npm ci`, and run the
  same deploy command. It is a rebuild, so the result is a new build id and a new
  tag pointing at the old commit — which is the truth.
- **A Worker:** `wrangler rollback <version-id> --env <tier>` puts a previous
  version back in seconds, no rebuild; find the id by its commit in
  `wrangler versions list`. It does **not** undo a D1 migration — those are
  additive by rule, which is precisely what leaves the older code safe against
  the newer schema. A rollback done this way creates no tag: tag the commit by
  hand if the history should show it.

### cors & frontend↔backend wiring

Each frontend tier points at the matching api tier, and each api tier allows only
its own frontend origins back (`CORS_ORIGINS`, never `*`) — both the `app.` host
and the apex, per _the hosts_ above. The full table lives in
[env-files.md](./env-files.md#wiring-the-frontends-to-the-backend); keep the two
in sync.

Both Workers answer a preflight with a two-hour `Access-Control-Max-Age` (`maxAge`
in each `app.ts`), so a browser asks once per URL rather than before every call —
the default it replaces is five seconds. Two hours is Chromium's ceiling; a longer
value would only reach Firefox. The entry is per URL, query string included, which
is why it pays in full on the extractor (`POST /v1/extract` and
`POST /v1/fetch-image` are one URL each — and the second is a POST only because
this makes it affordable: a page of previews costs one preflight, not one per
image) and on the api's POSTs, and not on a GET whose cursor moves. It delays nothing that matters:
an origin added to `CORS_ORIGINS` works at once, and one removed loses the
response at once, because the allow-list is read on every response and not only
on the preflight.

**The blob route rides `CORS_ORIGINS`, and asks one preflight per two hours.**
`PUT /v1/files/blob` ([local-first-sync.md](./local-first-sync.md), _the blob
route_) carries its token in `Authorization` and is preflighted — but it is one
URL for every object, so the two-hour `maxAge` above covers a whole sync with one
preflight. That is the point of the shape: a presigned URL is unique per object,
so its preflight is never reused. A browser reads with `POST /v1/files/blob` and
the token as a `text/plain` body, a CORS-simple request that is never
preflighted at all; the same doc has the measurement that ruled out a GET. The browser extension reaches it under its `host_permissions` for the
api host, without CORS at all.

**R2 needs a CORS policy of its own, and `CORS_ORIGINS` is not it.** A presigned
blob PUT/GET — what `files/sign` answers a client that names no transport, or an
api that predates the blob route answers everyone — goes from the browser
straight to `<account-id>.r2.cloudflarestorage.com`, so the api's CORS
middleware never sees it — the **bucket** answers the preflight, and a new bucket
has no policy at all. Forget it and every PUT dies at preflight with _"No
'Access-Control-Allow-Origin' header is present"_, while sign-in, lists and link
edits all keep working. Local dev cannot surface it: under `wrangler dev`, blobs go
through the api's own proxy route (`r2/local.ts`), which `CORS_ORIGINS` already
covers. Like secrets, the policy is set out of band, once per tier's bucket, with
that tier's token — and it is **the same policy on both tiers**:

```json
{
  "rules": [
    {
      "allowed": { "origins": ["*"], "methods": ["GET", "PUT"] },
      "maxAgeSeconds": 7200
    }
  ]
}
```

```bash
npx wrangler r2 bucket cors set bracemark-user-files-<tier> --file <that json> --env <tier>
npx wrangler r2 bucket cors list bracemark-user-files-<tier> --env <tier>
```

- **`*`, because the browser extension is a caller too, and its origin cannot
  be listed.** Its `host_permissions` name only the api
  (`apps/bracemark-extension/wxt.config.ts`), so its R2 transfers are ordinary
  cross-origin requests and need this policy exactly as bracemark-web's do. An
  allow-list cannot hold its origin: Chrome's `chrome-extension://<id>` is
  fixed per store listing, but Firefox's `moz-extension://<uuid>` and Safari's
  `safari-web-extension://<uuid>` are **random per install**. The policy used to
  name `app.*` only, on the reasoning that the extension's permissions kept it
  out of R2. They don't, and the staging extension's first sync died at
  preflight. Neither local dev nor the staging web suite can catch that: the
  first goes through the api's proxy, and the second runs only as `app.*`.
- **`*` grants nothing a presigned URL doesn't already grant.** CORS protects
  credentials the browser attaches on its own (cookies, a network position),
  and this endpoint honours none: the signature in the URL is the whole
  credential, and anyone holding the URL can already replay it outside a browser.
  A `*` response also can't be read with credentials, by spec. What bounds the
  exposure is the presign: one object, one method, a short expiry (five minutes
  for a PUT, an hour for a GET — `services/sync.ts`), over AES-GCM ciphertext. This is **not** a precedent for
  `CORS_ORIGINS`, which guards an authenticated api and stays an allow-list.
  bracemark-web's own control over where it may send bytes is its CSP
  `connect-src` ([above](#security-headers--where-the-csp-has-to-live)), and that
  still names the exact account host.
- **Don't fix the extension with `host_permissions` instead.** A host
  permission would skip CORS for the extension, but the exact host puts the
  Cloudflare account id into a committed env file and the published manifest. The
  wildcard `*.r2.cloudflarestorage.com` reaches every account's R2, which is the
  shape the CSP rejects. Either way, users see an install warning naming an opaque
  storage host. With `*` on the bucket, the permission would add nothing.
- **No `headers`.** `putBlob` sends a raw byte body and no custom header to R2,
  so the preflight asks for none. The `authorization` it sends goes only with a
  blob-route URL — `files/sign` returns one only beside those — and never to a
  presign. If the client starts sending a header to R2, add it here in the same
  change.
- **No `exposeHeaders`.** The client reads only the status and the body.
- **`maxAgeSeconds` matches the Workers' two hours, and buys nothing here.** A
  preflight is remembered per URL, and every presigned PUT URL is its own and dies
  after five minutes — so each PUT is preflighted whatever the value, and any value
  of 300 or more behaves identically. The number matches the Workers' only so that
  nobody goes looking for a reason it differs. The GET sends no header and is never
  preflighted.

Deploy artifacts are **built once per tier**, never promoted: `NEXT_PUBLIC_API_URL`
and `NEXT_PUBLIC_APP_URL` are baked at build time, so staging and production are
genuinely different bundles from the same commit. A staging build of the site
linking to production's app is exactly the cross-tier leak the split exists to
prevent.
