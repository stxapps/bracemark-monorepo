## env files

How each app gets its configuration per environment. There are **three
environments everywhere**, with the same names across every app and (eventually)
every piece of infrastructure:

| name          | what it is                          |
| ------------- | ----------------------------------- |
| `development` | local dev on your machine           |
| `staging`     | the testing deploy (pre-production) |
| `production`  | the live deploy                     |

`development` is the odd one out conceptually: it's the local mode the bundlers
already call "development", not a deploy target. The two deploy tiers are
`staging` and `production` — use exactly those two words everywhere (env files,
Nx configurations, wrangler envs, bucket / D1 names, domains, CI) so nothing
drifts.

For the hosts these values point at — which origin each app answers, and why the
two tiers sit on two registrable domains — see [hosting.md](./hosting.md), a
separate doc because that's topology, not config.

### the one constraint that explains everything: bake-time vs run-time

- **bracemark-web** (Next.js static export) and **bracemark-extension** (packaged
  extension) **inline their public vars at _build_ time** — the value is frozen
  into the shipped artifact. So each environment is a _separate build_, and
  **nothing here can be secret**: every var ends up in code the client
  downloads. These apps use `.env` files.
- **bracemark-api** reads its config **at _run_ time** from the host (Node
  `process.env` today, Cloudflare Workers bindings later). This is where secrets
  live, and they are **never committed and never bundled**. This app uses
  host-provided vars/secrets, not committed `.env` files.

So: frontends → build-time `.env` files; backend → runtime host config. The rest
of this doc is just the per-app spelling of that.

### bracemark-web — Next.js, static export

Next.js auto-loads `.env.<mode>` from the app dir based on `NODE_ENV`. Public
vars need the **`NEXT_PUBLIC_`** prefix and are baked into the static bundle.

`staging` is the wrinkle: it is a _production-mode_ build (`NODE_ENV=production`,
same as `production`), so Next can't pick it by mode. Nx supplies it via the
**`envFile`** option on the build target's `staging` configuration. `envFile` is
an **Nx `run-commands` option, not a Next feature** — Nx loads the file into
`process.env` before `next build` runs, and that overrides Next's
auto-loaded `.env.production`.

Files in `apps/bracemark-web/` (committed except `*.local`):

| file               | used by                             | loaded by    |
| ------------------ | ----------------------------------- | ------------ |
| `.env.development` | `nx dev bracemark-web`              | Next (auto)  |
| `.env.test`        | `nx test bracemark-web`             | `next/jest`  |
| `.env.production`  | `nx build bracemark-web`            | Next (auto)  |
| `.env.staging`     | `nx build bracemark-web -c staging` | Nx `envFile` |

Current vars:

- `NEXT_PUBLIC_API_URL` → the matching bracemark-api URL.
- `NEXT_PUBLIC_EXTRACTOR_URL` → the matching bracemark-extractor URL.
- `NEXT_PUBLIC_APP_URL` → **this app's own** origin (the `app.` host), read by
  `src/app/layout.tsx`. `metadataBase` and `og:url` have to be absolute — the
  card images resolve against it and live in this app's `public/`, not on the
  apex — and an absolute origin is per-tier like every other one here. Same var
  name bracemark-site uses for this same host, below. It was hard-coded to
  `https://app.bracemark.com` until the deploy script's tier check caught a
  staging bundle advertising production's URLs.
- `NEXT_PUBLIC_SITE_URL` → the matching **bracemark-site** origin (the apex), read
  by `src/lib/site.ts`. The app links out to pages that live on the marketing
  site — support, terms, privacy — and those are a different origin, so a
  relative `/support` would resolve against `app.*` and 404.
- `NEXT_PUBLIC_PADDLE_*` → the checkout SDK's env + client token (see
  [iap.md](./iap.md)).
- `ALLOW_INDEXING` → `true` or `false`, read by `src/app/robots.ts`. The one var
  here with **no `NEXT_PUBLIC_` prefix**, because it is read at build time only
  and never in a client component — prefixing it would bake a string into every
  chunk for nothing. See [_robots.txt is per-tier_](#robotstxt-is-per-tier).

Adding a new var = add the line to all **four** files (the symmetry is
deliberate: there is no config hiding in `package.json`). `.env.test` is the
newest of them and the easiest to forget — a var missing there doesn't fail the
build, it fails the whole jest suite at import time.

### bracemark-site — Next.js, static export

Identical mechanics to bracemark-web above — same auto-loaded `.env.<mode>`, same
`NEXT_PUBLIC_` bake, same `staging` wrinkle solved the same way (Nx `envFile` on
the build target's `staging` configuration).

Files in `apps/bracemark-site/` (committed except `*.local`):

| file               | used by                              | loaded by    |
| ------------------ | ------------------------------------ | ------------ |
| `.env.development` | `nx dev bracemark-site`              | Next (auto)  |
| `.env.test`        | `nx test bracemark-site`             | `next/jest`  |
| `.env.production`  | `nx build bracemark-site`            | Next (auto)  |
| `.env.staging`     | `nx build bracemark-site -c staging` | Nx `envFile` |

Two vars:

- `NEXT_PUBLIC_API_URL` → the matching bracemark-api URL. The apex calls the api
  for **public data only** (stats, health check) — it has no session and no
  crypto.
- `NEXT_PUBLIC_APP_URL` → the matching **bracemark-web** origin. Every "Sign in"
  and "Get Started" link crosses from the apex to the app, and that target is
  per-tier: `app.bracemark.com`, `app.dryrunbase.com`, or
  `localhost:3000` in dev. Hard-coding it would make a staging build of the site
  send visitors into production's app. `src/lib/site.ts` **throws** if it is
  unset rather than falling back — see [_the test env_](#the-test-env) for what
  makes that affordable.
- `ALLOW_INDEXING` → `true` or `false`, read by `src/app/robots.ts`; same
  no-prefix rule as bracemark-web's, above. See
  [_robots.txt is per-tier_](#robotstxt-is-per-tier).

The site's own apex is **not** a var: `SITE_URL` is hard-coded to
`https://bracemark.com` in `src/lib/site.ts`, and the block comment there is the
argument for why. Short version: it feeds only `metadataBase` and `og:url`, and
env-driving it would put `https://bracemark.com` into the deploy script's
forbidden-origin list for staging, where it collides with the
`https://bracemark.com/extractor` User-Agent that /extractor publishes verbatim.

`npm run dev:site` (= `nx dev @stxapps/bracemark-site`) serves on **port 3001**,
so it can run beside bracemark-web's 3000.

It is deliberately **not** in `npm run dev`, which is the app stack — api + web +
extractor, three projects that are useless apart (no api means no auth or sync;
no extractor means no link previews). The site is only loosely coupled: it links
to the app by URL and calls the api for public data at most. Same reasoning as
`dev:ext`, which keeps the browser extension out of the default stack too.

The one dev-time consequence: bracemark-web's Support link points at
`localhost:3001`, so it fails unless `dev:site` is also running. That's a rare
click while working on the app, and paying for a fourth always-on Next dev server
to cover it isn't worth it.

#### the local port map

| dev server                              | port   | pinned in                                | consumed by                            |
| --------------------------------------- | ------ | ---------------------------------------- | -------------------------------------- |
| bracemark-web (`npm run dev`)           | `3000` | `apps/bracemark-web/package.json`        | site's `NEXT_PUBLIC_APP_URL`, api CORS |
| bracemark-site (`npm run dev:site`)     | `3001` | `apps/bracemark-site/package.json`       | web + expo `*_SITE_URL`, api CORS      |
| bracemark-extension (`npm run dev:ext`) | `3002` | `apps/bracemark-extension/wxt.config.ts` | nothing                                |
| bracemark-api (`npm run dev`)           | `8787` | wrangler default                         | every frontend's `*_API_URL`           |

**3000 and 3001 are contractual; 3002 is not.** The two Next ports are baked into
`.env.development` files and into bracemark-api's dev `CORS_ORIGINS`, so moving
either means editing five files. The browser extension's port is HMR transport
only — its pages load from `chrome-extension://` and its api calls are CORS-exempt
via `host_permissions`, so nothing references it. When a port clashes, **3002 is
the one that moves.** (It started at 3001, which collided with `dev:site` — the
one pairing that could not run side by side.)

The `nx start` / `serve-static` preview servers reuse 3000 and 3001, so run the
preview or the dev server for a given app, not both — see
[hosting.md](./hosting.md#previewing-a-production-build-locally--nx-start).

### the test env

Both Next apps carry a committed **`.env.test`**, loaded by `next/jest` because
jest runs as `NODE_ENV=test`. Next only auto-loads `.env.<mode>` for the _current_
mode, so under jest `.env.development`, `.env.staging` and `.env.production` are
all invisible and **every `NEXT_PUBLIC_*` is undefined**.

That matters because several modules read their config at **module scope and
throw** — `bracemark-web`'s `lib/api-client.ts`, `lib/site.ts` and
`app/layout.tsx`, and `bracemark-site`'s `lib/site.ts`. A throw at module scope
under jest is not a failed assertion; it takes the whole suite down at _import_
time, before a single test runs, and the stack points at whatever file happened
to import the module first rather than at the missing var.

The workaround before `.env.test` existed was to mock the importer. `bracemark-web`'s
`subscription-section.spec.tsx` mocked `@/components/legal-consent` for exactly
that reason — its own comment called it "a mechanical reason and not a design
one" — and that mock is now gone, so the real component renders in the spec.

Values are the development ones. Nothing under jest reaches the network (the api,
the extractor and Paddle are mocked at the fetch/hook boundary); the vars only
have to exist and parse.

The alternative — defending every read with `?? 'https://…'` — is worse, and is
the specific bug this repo already shipped once: a fallback to a production URL
is indistinguishable from a correctly configured build until someone follows the
link. Prefer the throw, and keep `.env.test` in step.

### robots.txt is per-tier

Both apps generate `robots.txt` from **`src/app/robots.ts`** (Next's Metadata
API) rather than serving a static file, keyed on `ALLOW_INDEXING`:

| tier          | `ALLOW_INDEXING` | emits          |
| ------------- | ---------------- | -------------- |
| `production`  | `true`           | `Allow: /`     |
| `staging`     | `false`          | `Disallow: /`  |
| `development` | `false`          | `Disallow: /`  |
| `test`        | `false`          | (not rendered) |

Staging is a real, publicly resolvable registrable domain — `dryrunbase.com`, not
a subdomain of `bracemark.com`
([hosting.md](./hosting.md#why-staging-is-a-separate-registrable-domain)) — so it
is exactly as crawlable as production. Both apps served the _same_
allow-everything static `robots.txt` in both tiers until this existed, which put
a byte-for-byte copy of the marketing site, and of the sign-in and create-account
pages, in the index on a second domain, competing with the real one.

Three things worth keeping straight:

- **`ALLOW_INDEXING` is required, not defaulted, in both directions.** Defaulting
  to allow re-creates the bug above the first time an env file is added without
  it; defaulting to deny would silently deindex production the first time one is
  edited without it. `robots.ts` throws on anything but `true`/`false`.
- **Staging is deliberately not also given a `noindex` meta tag.** The two don't
  stack the way they look like they should — a crawler honouring `Disallow: /`
  never fetches the page, so it never sees the meta. The residual gap is that an
  externally linked but uncrawlable URL can still surface as a bare result; that
  is what `noindex` _would_ close, and closing it means dropping the `Disallow`.
  Take that trade only if a staging URL actually leaks.
- **`export const dynamic = 'force-static'` is mandatory.** `robots.txt` compiles
  to a route handler, and `output: 'export'` refuses one that hasn't declared
  itself static. It fails the build loudly, so it can't regress quietly.

Production behaviour is unchanged by this: both apps still allow everything.
Whether `app.bracemark.com` — an application behind an auth gate, whose only
public pages are `/sign-in` and `/create-account` — should be indexed at all is a
separate product question this doc doesn't answer.

### bracemark-extension — wxt / Vite

wxt builds through Vite, which loads `.env` / `.env.<mode>`. Public vars need the
**`WXT_PUBLIC_`** prefix and are read via `import.meta.env.WXT_PUBLIC_*` — baked
into the bundle just like bracemark-web. The mode is chosen with `--mode`, and unlike
bracemark-web's `staging` (which needs the Nx `envFile` indirection because Next
can't pick a production-mode build by mode) wxt selects the file natively:

| command                    | mode          | env file           |
| -------------------------- | ------------- | ------------------ |
| `wxt` (dev)                | `development` | `.env.development` |
| `wxt build`                | `production`  | `.env.production`  |
| `wxt build --mode staging` | `staging`     | `.env.staging`     |

Files in `apps/bracemark-extension/` (all committed — every value is public):

| file               | used by                                                                       |
| ------------------ | ----------------------------------------------------------------------------- |
| `.env.development` | `nx dev @stxapps/bracemark-extension`                                         |
| `.env.production`  | `nx build @stxapps/bracemark-extension`                                       |
| `.env.staging`     | `nx build:staging @stxapps/bracemark-extension` (and `build:firefox:staging`) |

Current var: `WXT_PUBLIC_API_URL` → the matching bracemark-api URL.

**Two consumers, one source of truth.** Unlike bracemark-web (one consumer,
`lib/api.ts`), the extension reads the URL in two places that must never drift —
the manifest `host_permissions` grant has to match the origin the client fetches,
or the MV3 background worker's CORS-exempt requests break. Both derive from the
same `WXT_PUBLIC_API_URL`:

- `utils/api.ts` reads `import.meta.env.WXT_PUBLIC_API_URL` (bundled context).
- `wxt.config.ts` can't use `import.meta.env` in its `manifest` function (it runs
  at config time, before the bundle env exists), so it reads the same `.env.<mode>`
  via Vite's `loadEnv(mode, process.cwd(), 'WXT_PUBLIC_')` and derives the host
  match pattern as `new URL(apiUrl).origin + '/*'`.

Both throw if the var is unset, mirroring bracemark-web's missing-`NEXT_PUBLIC_API_URL`
guard. The `staging` build is a plain `--mode staging` npm script + Nx target
(`build:staging`, `build:firefox:staging`) — no Nx `envFile` needed.

### bracemark-expo — Expo / Metro

Expo builds through Metro, which loads `.env` / `.env.<mode>` via `@expo/env`.
Public vars need the **`EXPO_PUBLIC_`** prefix and are read via
`process.env.EXPO_PUBLIC_*` — Metro **inlines** them into the JS bundle at build
time, exactly like bracemark-web's `NEXT_PUBLIC_` and bracemark-extension's
`WXT_PUBLIC_`, so nothing secret belongs here. The mode is `NODE_ENV`: `expo
start` is `development`, `expo export` / a release build is `production`. Expo has
**no `--mode` flag** — it only ever auto-selects `development` or `production` by
`NODE_ENV`:

| command                                         | mode          | env file           |
| ----------------------------------------------- | ------------- | ------------------ |
| `nx dev @stxapps/bracemark-expo` (`expo start`) | `development` | `.env.development` |
| release build / `expo export`                   | `production`  | `.env.production`  |

`staging` is the same wrinkle it is for bracemark-web: a staging build is a
_production-mode_ build (`NODE_ENV=production`), so Expo won't pick `.env.staging`
by mode. And unlike bracemark-web there's no Nx `envFile` seam to lean on — the Expo
build isn't an `nx build` running a bundler in `process.env`. **We don't use EAS**
— there is no `eas.json` and none is needed; builds are local (`npx expo
prebuild` + Xcode / Gradle, or `expo export`). So a staging build is made by
supplying the var inline (`EXPO_PUBLIC_API_URL=… expo export`), which takes
precedence over `.env.production`; `.env.staging` is committed as the single
source of that URL to paste from. `.env.development` and `.env.production` are
the two that work by auto-selection today.

Files in `apps/bracemark-expo/` (committed except `.env.local`):

| file               | used by                                           | loaded by   |
| ------------------ | ------------------------------------------------- | ----------- |
| `.env.development` | `nx dev @stxapps/bracemark-expo`, `expo prebuild` | Expo (auto) |
| `.env.production`  | release build / `expo export`                     | Expo (auto) |
| `.env.staging`     | a staging build (var supplied inline)             | you         |
| `.env.local`       | every mode — `APPLE_TEAM_ID` only (gitignored)    | Expo (auto) |

Current public vars:

- `EXPO_PUBLIC_API_URL` → the matching bracemark-api URL. Read once in
  `src/lib/api-client.ts`, which throws if unset (mirroring bracemark-web's and
  the browser extension's missing-URL guards) and binds it into
  `@stxapps/expo-react`'s `createAuthApiClient`.
- `EXPO_PUBLIC_SITE_URL` → the matching **bracemark-site** origin (the apex),
  read by `features/links/more-options-menu.tsx` for the Support item, which
  opens in the system browser. It is deliberately **not** the bracemark-web
  origin: the pages a native app links out to (support, terms, privacy) live on
  the marketing site. (This var was `EXPO_PUBLIC_WEB_URL` and pointed at
  `app.*`, which was wrong — bracemark-web has no `/support` route.)

Adding a new var = add the line to all three files, same deliberate symmetry as
the other frontends.

**The only non-`EXPO_PUBLIC_` var is `APPLE_TEAM_ID`**, read at
config-evaluation time by `expo prebuild` rather than at runtime. It is an
**identifier, not a credential** — leaking it grants nothing — which is what
keeps it in a file inside the worktree.

The four `BRACEMARK_UPLOAD_*` vars that carry the Android Play upload key used to
sit beside it here and **no longer do**. They are Gradle properties now, in
`~/.gradle/gradle.properties`, outside the repo entirely; the config plugin names
them and never sees a value. Two real passwords in a gitignored file inside a
public repo's checkout is a different kind of thing from a team id, and the old
arrangement also copied them into the generated `android/gradle.properties` on
every prebuild. Same rule as the [Cloudflare API token](#whats-committed-vs-ignored)
below: a secret gets injected by the tool that needs it, from outside the tree.
See [expo-build.md](./expo-build.md) — _android release signing_. The three
bullets below are about `APPLE_TEAM_ID`.

`APPLE_TEAM_ID` is the reason this app's config is `app.config.ts` and not
`app.json` — `ios.appleTeamId` has to come from the environment, and JSON has no
interpolation. At prebuild,
`@expo/config-plugins`' `withDevelopmentTeam` writes it into `DEVELOPMENT_TEAM`
for **every** native target in the pbxproj — the app _and_ the share extension —
which is what keeps local device signing from needing a manual team pick in
Xcode after each regenerate of `ios/`. Three things follow:

- **It lives in `.env.local`**, not one of the committed files. `.env*.local` is
  gitignored, and the value is per-developer-account rather than per-tier.
- **It's mode-agnostic on purpose.** `expo prebuild` calls
  `setNodeEnv('development')` _before_ `@expo/env.load()`, so it reads
  `.env.development`, never `.env.production` — a var only in the latter would
  be invisible to the one command that needs it. `.env.local` is loaded in every
  mode.
- **No `EXPO_PUBLIC_` prefix.** That prefix means "inline into the JS bundle";
  this is a config-time value and never belongs in shipped JS.

Unset is safe: `withDevelopmentTeam` skips a falsy id and leaves the pbxproj
alone, so a fresh clone still prebuilds — you just pick the team in Xcode.

### bracemark-api — Hono on Cloudflare Workers

Server-side: config is read at **runtime**, never baked. bracemark-api runs **only**
on Workers (`src/worker.ts`, `export default app`) — there is no Node entry.

**Config read.** `src/app.ts` resolves `CORS_ORIGINS` per-request:
`c.env.CORS_ORIGINS` (the Workers binding) first, then the `[]`
default. On Workers `c.env` is the source; the `process.env` fallback only covers
non-Workers callers like `app.request()` in jest tests. `globalThis.process`
(not bare `process`) keeps it safe on Workers, which has no `process` global.

**Per-environment values live in `wrangler.jsonc`**, as three wrangler
environments matching the project's tiers — `development` / `staging` /
`production`. **No environment names a Cloudflare account.** `account_id` is
deliberately absent from both Worker configs — these files are public, and an
account id is inventory — so the deploy target comes from `CLOUDFLARE_ACCOUNT_ID`
in the deploy environment instead. The cost is that nothing in the config pins
the account any more, which puts the whole burden of "deploy to the right tier"
on the API token: mint every one against a _specific_ account, never all of
them.

**Where that id comes from locally: `apps/bracemark-api/.env.<tier>.local`** (and
the same pair in `apps/bracemark-extractor/`). Wrangler loads `.env`,
`.env.local`, `.env.<env>` and `.env.<env>.local` from the working directory on
**every** command, later files winning, so `--env production` reads
`.env.production.local` and a `--env staging` run cannot see it. That tier-scoping
is the whole point: `CLOUDFLARE_ACCOUNT_ID` carries no tier in its name, so a
single value in any shared place — the workspace root's `.env.local`, a shell
profile — applies to both tiers, and with `account_id` gone from the config
nothing downstream would object. An already-exported value still wins over the
file, so CI's env vars and a one-off `CLOUDFLARE_ACCOUNT_ID=… npx nx deploy …`
both override it. The paths resolve against the **working directory**, which the
`deploy` / `d1-migrate` targets set to the app dir — a hand-run
`npx wrangler -c apps/bracemark-api/wrangler.jsonc` from the workspace root finds
nothing.

Two spellings to avoid. The committed `.env.staging` / `.env.production`: wrangler
reads those too, and they are public, which is the problem `account_id` was
removed from `wrangler.jsonc` to solve. And the untiered `.env.local` in the app
dir: it loads for every env including `development`, and because neither Worker
has a `.dev.vars`, `wrangler dev` loads that file as local **secret bindings** —
so the account id would arrive inside the Worker as well.

- non-secret vars (e.g. `CORS_ORIGINS`) → `vars` under each `env.*`. The
  `development` env sets `CORS_ORIGINS=http://localhost:3000` so local dev needs
  no extra file.
- secrets → `wrangler secret put <NAME> --env staging|production` (never
  committed). `R2_ACCOUNT_ID` is set this way too, for the reason above rather
  than because it is a secret — it is the same account id `CLOUDFLARE_ACCOUNT_ID`
  carries at deploy time.
- D1 / R2 → per-env `d1_databases` / `r2_buckets` bindings. `development`'s are
  emulated locally by miniflare (state under `.wrangler/`), so its ids are
  placeholders.
- **`.dev.vars`** (gitignored) is **only for local secrets** you can't commit to
  `wrangler.jsonc` — not for `CORS_ORIGINS`, which lives in the `development`
  env's `vars`. Loaded by `wrangler dev`, it overrides committed `vars` locally.

Local dev is `wrangler dev --env development` (the `dev` target); it uses the
`development` env above with locally emulated D1/R2. There are no
`NEXT_PUBLIC_`-style committed files here because nothing is public.

### wiring the frontends to the backend

Each frontend environment points at the matching bracemark-api environment, and
bracemark-api allows the matching frontend origin back:

| environment   | frontend `*_API_URL` →       | bracemark-api `CORS_ORIGINS` allows                    |
| ------------- | ---------------------------- | ------------------------------------------------------ |
| `development` | `http://localhost:8787`      | `http://localhost:3000`, `http://localhost:3001`       |
| `staging`     | `https://api.dryrunbase.com` | `https://dryrunbase.com`, `https://app.dryrunbase.com` |
| `production`  | `https://api.bracemark.com`  | `https://bracemark.com`, `https://app.bracemark.com`   |

**Staging is on its own registrable domain, `dryrunbase.com`** — not a subdomain
of `bracemark.com`. Each tier is its own Cloudflare account, a Workers custom
domain requires its zone in the same account, and a subdomain can't be an
independent zone off Enterprise; so `api.staging.bracemark.com` and friends
could never have existed. The staging hosts are `dryrunbase.com` (site),
`app.dryrunbase.com` (web), `api.dryrunbase.com`, `extractor.dryrunbase.com`.
See [hosting.md](./hosting.md#why-staging-is-a-separate-registrable-domain).

CORS is never `*` — each API environment allows only its own frontend
origin(s). Each tier allows **two** web origins: the `app.*` host (bracemark-web)
and the apex (bracemark-site, which also calls the api for public data like
stats / health). Both are apps in this monorepo. In `development` those are
localhost:3000 and localhost:3001 — the two Next dev servers. See
[hosting.md](./hosting.md#the-hosts) for the host naming scheme.

The `CORS_ORIGINS` column is **web-only**: bracemark-expo hits the same
`*_API_URL` per tier, but a native RN `fetch` sends no `Origin` header and
isn't subject to browser CORS, so the app needs no entry in the allowlist — it
points at the matching bracemark-api URL and that's the whole story. (Only the
browser frontends — bracemark-web and bracemark-site — need an allowed origin.)

### what's committed vs ignored

- **committed:** `.env.development`, `.env.test`, `.env.staging`, `.env.production`
  for the frontends — every value in them is public.
- **gitignored:** `.env*.local` (frontend personal overrides — and bracemark-expo's
  `APPLE_TEAM_ID`, above), `.dev.vars` (bracemark-api Workers local), and all real
  secrets. These never enter git.
- **in no env file at all:** the per-tier **Cloudflare API token**. Wrangler
  would happily read `CLOUDFLARE_API_TOKEN` out of the same `.env.<tier>.local`
  that carries the account id, which is exactly what makes it tempting — but the
  two are different in kind. An account id is an identifier and leaking it grants
  nothing; a token is the only thing scoping a deploy to one tier, so a plaintext
  copy of it in the worktree is one backup or one over-broad file read away from
  being a production write. It lives in the login keychain, and
  `tools/scripts/deploy-worker.sh` puts it in the environment for the length of
  one command. Same rule for the R2 S3-API key pair and every other real secret:
  `wrangler secret`, never a file here. See
  [hosting.md](./hosting.md#deploying-the-workers--deploy-workersh).
- **in no env file at all, second case:** the **Android Play upload key** — the
  keystore and its two passwords. Same reasoning one platform over, and it
  reached the same answer late: the four `BRACEMARK_UPLOAD_*` values were env
  vars in `apps/bracemark-expo/.env.local` until they moved to
  `~/.gradle/gradle.properties`, which Gradle merges into every build on the
  machine without the values ever entering the worktree. The keystore file
  itself lives outside the workspace, at whatever absolute path that file names.
  See [expo-build.md](./expo-build.md) — _android release signing_.

**The workspace root has its own pair, and it belongs to no app.** Root `.env` is
committed and holds non-secret Nx task-running defaults; root `.env.local` is
gitignored and holds the per-machine values a deploy needs —
`CLOUDFRONT_DISTRIBUTION_ID_<APP>_<TIER>` (one per app per tier, e.g.
`CLOUDFRONT_DISTRIBUTION_ID_WEB_PRODUCTION`) and, if you use one, `AWS_PROFILE` /
`AWS_REGION`. Those names carry their tier, which is what makes one shared file
safe for them; `CLOUDFLARE_ACCOUNT_ID` does not, and belongs in the per-tier
Worker files [above](#bracemark-api--hono-on-cloudflare-workers) instead. Nx auto-loads both files for `nx run*`, but `npm run deploy:*`
reaches `tools/scripts/deploy-static.sh` through bash, which loads nothing — so
the script parses root `.env.local` itself during preflight, with anything
already exported winning, since CI passes these as real env vars. A distribution
id is not a credential, but it is infrastructure detail this repo doesn't
publish: keep the values out of every tracked file, `.env.staging` and
`.env.production` included. See
[hosting.md](./hosting.md#deploying-the-static-sites--deploy-staticsh).
