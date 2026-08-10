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

> **Status: nothing is deployed yet.** Both domains are registered and every host
> named here is a real name rather than a placeholder, but no bucket,
> distribution or Worker has been provisioned. Treat this page as the contract
> the code is already written against.

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
what makes "`api.bracemark.com` only ever sees ciphertext" provable from the
code rather than asserted in prose. It has no storage bindings at all — no D1, no
R2, no Durable Objects. See [link-extraction.md](./link-extraction.md), _server
extraction_.

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

The name had to be **obviously not the product**, and `dryrunbase.com` is: "dry
run" is what a staging tier does, and nothing in it reads as Bracemark. It
carries none of the brand's SEO or trademark weight, which is precisely what a
staging host should be worth.

### security headers — where the CSP has to live

bracemark-web is `output: 'export'`, so **there is no Next server and
`next.config`'s `headers()` never runs**. The CSP that [account.md](./account.md)
names as the XSS mitigation for the bearer token and encryption key in IndexedDB
can therefore only be set by the CDN in front of the bucket. Note the trap in the
provider names: only bracemark-api and bracemark-extractor run on **Cloudflare**,
and they serve JSON rather than HTML, so the app's CSP is a **CloudFront**
artifact even though the backend is on Cloudflare.

One policy per tier, not one shared policy, because `connect-src` must name that
tier's own api and extractor origins. Keep them otherwise identical, and roll out
as `Content-Security-Policy-Report-Only` before enforcing. The constraints to
bake in:

- `script-src` needs `'wasm-unsafe-eval'` — hash-wasm's Argon2.
- A static export cannot mint per-request nonces, so Next's inline bootstrap
  scripts need either a build-time hash union (regenerated every deploy) or
  `'unsafe-inline'`, with `connect-src` as the load-bearing exfiltration block.
- `worker-src 'self'` covers the Argon2 worker and the serwist service worker.
- `connect-src` is pinned to `'self'` plus that tier's api and extractor origins.
  This is what makes `'unsafe-inline'` on `script-src` survivable, so every host
  added here widens the one control that is holding — add deliberately.
- `frame-ancestors` is ignored in a `<meta>` tag and only works from a real
  header, which is another reason this cannot live in the app.
- **Paddle.js** ([iap.md](./iap.md)) loads from Paddle's CDN and opens checkout as
  an overlay `<iframe>`. Every host involved (`cdn.paddle.com`, `buy.paddle.com`,
  `checkout-service.paddle.com`, and their `sandbox-*` peers) is one label under
  `paddle.com`, so a single `https://*.paddle.com` per directive covers sandbox
  and live alike — the Paddle allowances are **identical across tiers**, and only
  the api/extractor `connect-src` hosts differ. Add it to `script-src`,
  `frame-src`, `connect-src`, `img-src` and `style-src`. The `connect-src` entry
  is the one that widens the exfiltration block above; that is the price of
  overlay checkout. Re-check this against Paddle's own CSP guidance at
  integration time.

**The marketing site gets its own, much smaller policy — do not reuse the app's.**
The apex holds no credentials, runs no crypto and has no service worker, so it
needs none of `wasm-unsafe-eval`, `worker-src`, or the Paddle allowances;
checkout happens in the app. A tight `default-src 'self'` plus its tier's api
origin in `connect-src` is the whole policy. Copying bracemark-web's would
silently widen the apex to every host the app needs, for nothing.

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

| resource          | staging                                                                                              | production                                                                                                    |
| ----------------- | ---------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| S3 bucket (web)   | `bracemark-web-staging`                                                                              | `bracemark-web-production`                                                                                    |
| S3 bucket (site)  | `bracemark-site-staging`                                                                             | `bracemark-site-production`                                                                                   |
| Worker name / env | `bracemark-api-staging` / `staging`                                                                  | `bracemark-api-production` / `production`                                                                     |
| Extractor Worker  | `bracemark-extractor-staging` / `staging`                                                            | `bracemark-extractor-production` / `production`                                                               |
| D1 databases      | `bracemark-directory-db-staging`, `bracemark-accounts-db-1-staging`, `bracemark-sessions-db-staging` | `bracemark-directory-db-production`, `bracemark-accounts-db-1-production`, `bracemark-sessions-db-production` |
| R2 bucket         | `bracemark-user-files-staging`                                                                       | `bracemark-user-files-production`                                                                             |

**The domains are the deliberate exception**: staging's hosts are
`*.dryrunbase.com`, carrying neither the brand nor the tier suffix, for the
reason given [above](#why-staging-is-a-separate-registrable-domain). The `*-dev`
peers (`bracemark-directory-db-dev`, `bracemark-user-files-dev`, and the rest)
are the local `wrangler dev` bindings and are never deployed.

### cors & frontend↔backend wiring

Each frontend tier points at the matching api tier, and each api tier allows only
its own frontend origins back (`CORS_ORIGINS`, never `*`) — both the `app.` host
and the apex, per _the hosts_ above. The full table lives in
[env-files.md](./env-files.md#wiring-the-frontends-to-the-backend); keep the two
in sync.

Deploy artifacts are **built once per tier**, never promoted: `NEXT_PUBLIC_API_URL`
and `NEXT_PUBLIC_APP_URL` are baked at build time, so staging and production are
genuinely different bundles from the same commit. A staging build of the site
linking to production's app is exactly the cross-tier leak the split exists to
prevent.
