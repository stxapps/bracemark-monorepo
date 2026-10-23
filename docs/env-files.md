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

`.env.development` has a second reader: `nx build bracemark-web -c development`
takes it through the same `envFile` mechanism, which is a PRODUCTION-mode build
(the static export and its service worker) aimed at the local stack. Nothing
deploys it — `deploy-static.sh` rebuilds and then refuses a bundle that does
not name its tier's origins — and the one caller is the PWA e2e target
([e2e.md](./e2e.md), _the PWA target_), which copies `out/` away as soon as it
is built.

Current vars:

- `NEXT_PUBLIC_API_URL` → the matching bracemark-api URL.
- `NEXT_PUBLIC_EXTRACTOR_URL` → the matching bracemark-extractor URL.
- `NEXT_PUBLIC_APP_URL` → **this app's own** origin (the `app.` host), read by
  `src/app/layout.tsx`. `metadataBase` and `og:url` have to be absolute — the
  card images resolve against it and live in this app's own `src/app/`, as the
  `opengraph-image.png` / `twitter-image.png` file conventions, not on the apex —
  and an absolute origin is per-tier like every other one here. Same var
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

**Not in any env file: `BUILD_ID`.** It is not configuration — it is the build
naming itself. `next.config.js` stamps each `next build` with the moment it
started and passes that through Next's `env` option, so it is inlined where it is
read (`src/app/layout.tsx`, `src/app/build.json/route.ts`) and nowhere else; no
client chunk carries it. A value already in the environment wins, which is what
keeps the static-generation workers on the id the main process chose — and means
setting `BUILD_ID` by hand pins it, which nothing here does. What it is for:
[offline-mode.md](./offline-mode.md), _which build is this page_.

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
argument for why. Short version: every URL it feeds — `metadataBase`, `og:url`,
the sitemap, the JSON-LD — names a page's canonical address, which is
production's in every tier; and env-driving it would put `https://bracemark.com`
into the deploy script's forbidden-origin list for staging, where it collides
with the `https://bracemark.com/extractor` User-Agent that /extractor publishes
verbatim.

`npm run dev:site` (= `nx dev @stxapps/bracemark-site`) serves on **port 3001**,
so it can run beside bracemark-web's 3000.

It is deliberately **not** in `npm run dev`, which is the app stack — api + web +
extractor, three projects that are useless apart (no api means no auth or sync;
no extractor means no server previews in the web app). The site is only loosely coupled: it links
to the app by URL and calls the api for public data at most. Same reasoning as
`dev:ext`, which keeps the browser extension out of the default stack too.

The one dev-time consequence: bracemark-web's Support link points at
`localhost:3001`, so it fails unless `dev:site` is also running. That's a rare
click while working on the app, and paying for a fourth always-on Next dev server
to cover it isn't worth it.

#### the local port map

| dev server                              | port   | pinned in                                 | consumed by                            |
| --------------------------------------- | ------ | ----------------------------------------- | -------------------------------------- |
| bracemark-web (`npm run dev`)           | `3000` | `apps/bracemark-web/package.json`         | site's `NEXT_PUBLIC_APP_URL`, api CORS |
| bracemark-site (`npm run dev:site`)     | `3001` | `apps/bracemark-site/package.json`        | web + expo `*_SITE_URL`, api CORS      |
| bracemark-extension (`npm run dev:ext`) | `3002` | `apps/bracemark-extension/wxt.config.ts`  | nothing                                |
| bracemark-api (`npm run dev`)           | `8787` | `apps/bracemark-api/wrangler.jsonc`       | every frontend's `*_API_URL`           |
| bracemark-extractor (`npm run dev`)     | `8788` | `apps/bracemark-extractor/wrangler.jsonc` | web's `NEXT_PUBLIC_EXTRACTOR_URL`      |

**3000 and 3001 are contractual; 3002 is not.** The two Next ports are baked into
`.env.development` files and into bracemark-api's dev `CORS_ORIGINS`, so moving
either means editing five files. The browser extension's port is HMR transport
only — its pages load from `chrome-extension://` and its api calls are CORS-exempt
via `host_permissions`, so nothing references it. When a port clashes, **3002 is
the one that moves.** (It started at 3001, which collided with `dev:site` — the
one pairing that could not run side by side.)

**The bind address is not uniform, and only one of the two defaults is
reachable from another device.** Next binds `0.0.0.0`, so `localhost:3000` is
also `<mac-lan-ip>:3000` with no flag. `wrangler dev` defaults to
`--ip localhost` and binds loopback only, so the same phone that loads the web
app gets a connection refused on `:8787` — a bind address presenting as a network
fault. Both Worker configs therefore set `"ip": "0.0.0.0"` beside the pinned
`port` in their top-level `dev` block; it is a dev-only field and never reaches a
deployed env. The cost is real and bounded: while `npm run dev` is up, the local
api and its local D1/R2 state answer anything on the current network, so it is
worth knowing which network that is.

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

Production's file is the only one that names a sitemap. bracemark-site emits
`Sitemap: https://bracemark.com/sitemap.xml` under its `Allow: /`; staging still
builds `sitemap.xml` — a static export cannot drop a route per tier — but its
robots.txt does not advertise it, since a file that disallows everything and
points at URLs to crawl is two contradictory instructions. `robots.spec.ts`
holds both branches. [hosting.md](./hosting.md#sitemapxml-and-json-ld) has the
sitemap itself.

Production behaviour is otherwise unchanged by this: both apps still allow
everything.
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
| `.env.staging`     | `nx build:staging @stxapps/bracemark-extension` (and `build:staging:firefox`) |

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
(`build:staging`, `build:staging:firefox`) — no Nx `envFile` needed.

**⚠ A production build refuses any api but `https://api.bracemark.com`.**
`wxt.config.ts` checks the value in `manifest` whenever `mode` is `production` —
`nx build`, `build:firefox`, `zip`, `zip:firefox`, i.e. the store builds. Nothing
else would: bracemark-web has `deploy-static.sh`'s tier check between the build
and the bucket, but between `nx zip` and a store upload nothing reads the bundle.
And the committed `.env.production` is not the last word: WXT loads `.env.local`,
`.env.production.local`, `.env.<browser>` and their `.local` variants too (all
gitignored by `.env*.local` or absent today), and an exported `WXT_PUBLIC_API_URL`
outranks every file. By the time `manifest` runs WXT has put those files into
`process.env`, which Vite's `loadEnv` lets win, so the guard sees the value the
bundle bakes — the same one the host grant is derived from. The escape hatch is
the same as bracemark-expo's: `BRACEMARK_NONPROD_RELEASE=1` in the shell, never
in a file (enforced). A staging build is `--mode staging` and never trips it.

### bracemark-expo — Expo / Metro

Expo builds through Metro, which loads `.env` / `.env.<mode>` via `@expo/env`.
Public vars need the **`EXPO_PUBLIC_`** prefix and are read via
`process.env.EXPO_PUBLIC_*` — Metro **inlines** them into the JS bundle at build
time, exactly like bracemark-web's `NEXT_PUBLIC_` and bracemark-extension's
`WXT_PUBLIC_`, so nothing secret belongs here. The mode is `NODE_ENV`: `expo
start` is `development`, `expo export` / a release build is `production`. Expo has
**no `--mode` flag** — it only ever auto-selects `development` or `production` by
`NODE_ENV`:

| command                             | mode          | env file           |
| ----------------------------------- | ------------- | ------------------ |
| `npm run expo:start` (`expo start`) | `development` | `.env.development` |
| release build / `expo export`       | `production`  | `.env.production`  |

**The domain is a second axis, and Expo only knows the first.** The variant
(dev / release) decides the mode, but which stack the build talks to —
localhost, staging, production — is independent of it: a dev build against
staging and a release build against staging are both real needs. `staging` is
the wrinkle it is for bracemark-web — a _production-mode_ build, so no file is
picked for it by mode — and unlike bracemark-web there's no Nx `envFile` seam to
lean on, because the Expo build isn't an `nx build`. **We don't use EAS** — there
is no `eas.json` and none is needed; builds are local (`npx expo prebuild` +
Xcode / Gradle).

**So the domain is chosen per command, by an npm script — or, as the sticky
alternative, in ONE gitignored file, `.env.local`. The committed files are only
the per-variant defaults.** The scripts are in `apps/bracemark-expo/package.json`
([expo-build.md](./expo-build.md), _the npm scripts_):

| domain \ variant     | development (Metro)   | release, on a device                             | store                                         |
| -------------------- | --------------------- | ------------------------------------------------ | --------------------------------------------- |
| localhost            | `start` (the default) | not supported (Android refuses cleartext)        | —                                             |
| this Mac, on the LAN | `start:lan`           | not supported (same)                             | —                                             |
| dryrunbase.com       | `start:staging`       | `android:release:staging`, `ios:release:staging` | —                                             |
| bracemark.com        | `start:production`    | `android:release`, `ios:release` (the default)   | `android:bundle`; `ios:bundle` → `ios:upload` |

Each one sets `EXPO_PUBLIC_API_URL` and `EXPO_PUBLIC_SITE_URL` in that one
command's environment, which outranks every env file — so the choice lasts
exactly as long as the command, and there is nothing to comment back out.
`start:lan` is the physical-iPhone one: it computes the Mac's Bonjour name at
run time (`scutil --get LocalHostName`), so it follows a rename
(`Macs-MacBook-Pro-2.local`) on its own — see the physical-iPhone paragraph
below.

**Why the shell is safe now, when it used to be the wrong spelling.** An inline
var never reaches an Xcode build started from its UI — a GUI app does not inherit
your shell's environment — so the _Bundle React Native code and images_ phase
once baked `.env.production` into an Archive meant for staging, silently. Two
things make that a non-issue:

- **A dev build takes its origins from Metro**, and Metro from the shell that
  started it. The Debug binary carries no origin; a Debug run from Xcode's UI
  loads whatever the running `start:*` serves. Switching is a Metro restart — no
  native rebuild and no `--clear`: a dev bundle's env preamble is written from
  Metro's own environment rather than its transform cache (verified — a plain
  restart after a staging session served `localhost` again). Only a _reload_ of
  a still-running Metro replays its old value.
  ⚠ **The preamble being right is not the bundle being right.** App code reads
  `process.env.EXPO_PUBLIC_*` through `expo/virtual/env`, which
  `@expo/metro-config` generates in dev as `{ ...process.env, ...dotEnvFiles }`
  — the files spread _over_ the shell — so every `start:*` script and
  `ios:lan` served the right preamble and `.env.development`'s `localhost` to
  the app, and only an uncommented `.env.local` pair (later in that spread)
  worked. `metro.config.js` drops `env`/`local`/`development` from
  `watcher.additionalExts`, so Metro can't see those files and the module is
  plain `process.env` again. Removing that drop breaks the scripts with no
  error: check the URL in the served bundle, not just the preamble. It also
  stops hot-applying a `.env` edit, which the restart above covers anyway.
- **A release bundle refuses anything but production** (the guard, below), so
  the Archive that never sees a shell is exactly the production build it should
  be, and a staging release build is CLI-only by construction.

Every path still ends in the same loader — the dev server, and
`expo export:embed`, which both Xcode (`react-native-xcode.sh`) and the Gradle
plugin run for a release build, with `setNodeEnv('production')` then
`@expo/env.load(projectRoot)`. Both pass `--reset-cache`, so Metro re-reads the
env; but **Gradle may not run that step at all** — see the stale-bundle note
under the bundle check below.

**`.env.local` keeps its three commented pairs** — physical iPhone (the Mac's
LAN name), staging, production — for when a sticky choice is what you want: a
long session on one stack, or `npm run ios`/`android`, which start their own
Metro from the files. All-commented means the default. `.env.local` is the one
file `@expo/env` loads in every mode and ranks above both `.env.<mode>` files, so
an uncommented pair wins in the dev and the release variant alike — which is
also its hazard, and why a release bundle then fails the production guard unless
the shell asks otherwise. Restart Metro after editing it.

**Not the committed files.** Switching by editing `.env.development` /
`.env.production` puts the switch in git: every staging session becomes a diff
to keep out of a commit, and it travels between clones.

This replaced a committed `.env.staging` (a paste source for the inline spelling
above) and a gitignored `.env.development.local` (the physical-iPhone override).
**Don't bring the latter back:** `.env.development.local` outranks `.env.local`
in dev mode, so a leftover pair in it silently beats the switch.

Files in `apps/bracemark-expo/` (the two committed ones never change to switch):

| file               | used by                                                    | loaded by   |
| ------------------ | ---------------------------------------------------------- | ----------- |
| `.env.development` | dev default — `npm run ios`/`android`, `expo:start`        | Expo (auto) |
| `.env.production`  | release default — Xcode Archive, `./gradlew *Release`      | Expo (auto) |
| `.env.local`       | every mode — `APPLE_TEAM_ID` + the domain switch (ignored) | Expo (auto) |

`@expo/env` resolves files in a fixed priority order — `.env.<mode>.local`,
`.env.local`, `.env.<mode>`, `.env` — and the **first** file to define a key
wins; only a var already exported in the shell beats them all.

⚠ **A release bundle is production or a failed build.** `.env.local` applies to
release too — and it meant a pair left uncommented went into the App Store /
Play upload with nothing to flag it: no lint, no type error, no test, and the
app works. So **`metro.config.js` refuses any production-mode bundle whose
`EXPO_PUBLIC_API_URL` / `EXPO_PUBLIC_SITE_URL` are not exactly
`https://api.bracemark.com` / `https://bracemark.com`.** That is every release
path — `android:release`, `android:bundle`, `ios:release`, a bare `./gradlew
bundleRelease` / `assembleRelease`, Xcode Run in Release, Xcode Archive — and
`expo start --no-dev`. The check sits in the Metro config because every one of
those paths reaches it with the env already final: `expo export:embed` (what
Xcode and Gradle run) and `expo run`'s eager bundle both call
`setNodeEnv('production')` and `@expo/env.load()` before loading it. It also
covers the iOS **share extension**'s bundle, and as plain JS rather than a
config plugin it survives `prebuild --clean` with nothing to regenerate. The
failure lands in the build log naming both values and the fix.

The one way past it is **`BRACEMARK_NONPROD_RELEASE=1` in the shell**, for a
release build that is meant to talk to staging. The two `:release:staging`
scripts set it, as do `npm run e2e:build:<platform>:staging`
([e2e.md](./e2e.md)) and `npm run measure:data:<ios|android>`, whose
`expo start --no-dev` is production mode aimed at localhost. **Shell-only, and
enforced** — the guard also fails if the name appears in any `.env*` file in
the app. A shell var lasts one command, so it cannot be left on the way a file
line can; and since a build started from Xcode's UI does not inherit the shell,
**an Archive is production or a failed build**, with no exception to remember.
The cost is that a staging _Release_ build does not come from Xcode's UI — use
`ios:release:staging`.

⚠ **Still check the bundle before uploading a store build** — the guard reads
the env, this reads the file that ships. The store scripts do it themselves:
`npm run android:bundle` on the `.aab` it just built, `ios:bundle` on its
archive, and `ios:upload` once more on that archive before it sends it. For an
archive made in Xcode instead, run `npm run ios:check-archive` before
Distribute — it checks the newest archive holding `Bracemark.app`. All of them run
`tools/scripts/check-native-bundle.mjs`, which reads every JS bundle in the
artifact — on iOS that includes the share extension's own `main.jsbundle` under
`PlugIns/` — and fails unless each names `https://api.bracemark.com` and no
staging origin or origin on the local ports (:8787, :3001), on any host. The two
can disagree, and both ways have been seen:

- **A stale bundle.** A release bundle inlines `EXPO_PUBLIC_*` at transform
  time, into Metro's cache, whose key does not include the env: a staging
  `export:embed` run without `--reset-cache` after a production one came out
  byte-identical to it, while the guard approved the staging env. Xcode and
  Gradle pass `--reset-cache` — but `export:embed` drops it whenever `CI` is set.
  And **Gradle calls the JS task up to date after a staging build** — the env
  is no input of it — so a plain `./gradlew bundleRelease` right after
  `android:release:staging` packages the STAGING bundle, with no bundle step
  run for the guard to stop. `android:bundle` reruns that task (`--rerun`, as
  `e2e/runner/release-build.ts` does) and the `expo run:android` release
  scripts delete its output first; a bare `./gradlew` does neither.
- **The guard bypassed** by `BRACEMARK_NONPROD_RELEASE=1` in the shell that
  built it, or broken by an Expo upgrade that loads the env later.

By hand, the bundle is Hermes bytecode but its string table holds the URLs
verbatim:

```sh
# Android
unzip -p app-release.aab base/assets/index.android.bundle | grep -aoE 'https://api\.[a-z]+\.com' | sort -u
# iOS — inside the archive's app bundle
grep -aoE 'https://api\.[a-z]+\.com' <archive>.xcarchive/Products/Applications/Bracemark.app/main.jsbundle | sort -u
```

Either should print `https://api.bracemark.com` and nothing else. **Keep the
`-a`:** without it grep treats the bytecode as binary and `-o` prints NOTHING —
which reads as "no staging URL in here" when the file was never searched. Empty
output is a failed check, not a pass (the script fails on a bundle-less artifact
for the same reason). The build log says the same thing earlier: `export:embed`
prints the env files it loaded and the vars it exported.

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
- `EXPO_PUBLIC_MEASURE_STALLS` → `1` turns on expo-react's JS-thread stall
  probe (`lib/stall-probe.ts`, started in `src/app/_layout.tsx`) and its
  `measure-stall-reading` readout in the Data view. **It is in no env file, on
  purpose.** Only `npm run measure:data:<ios|android>` sets it, in the
  environment of the Metro it starts, so a shipped build compiles the check to
  nothing ([e2e.md](./e2e.md), _the native leg_).
- `EXPO_PUBLIC_SYNC_TRACE` → `1` installs the sync engine's timing recorder
  (expo-react `sync/trace.ts`, started in `src/app/_layout.tsx`), which prints each
  cycle's phase table to the log as `[sync-trace]`. Same arrangement as the stall
  probe: it is in no env file, and you set it in Metro's environment for a
  measuring run ([local-first-sync.md](./local-first-sync.md), _measuring a
  sync_).

**A physical iPhone is the one target `localhost` cannot serve, and
`npm run start:lan` (or the first `.env.local` pair) is where that is fixed.** Both default URLs are `localhost`
because one bundle has to serve the iOS simulator, which shares the host's
loopback, and the Android emulator (or an Android phone over USB / wireless
debugging), which is taught the same by `adb reverse`
(`npm run expo:android:reverse` — see [e2e.md](./e2e.md)). A real iPhone is a
separate host: there is no `adb reverse` for iOS, so it has to address the Mac by
LAN IP (`ipconfig getifaddr en0`) or by its Bonjour `<name>.local`, and the Worker
has to be listening on more than loopback — see
[_the local port map_](#the-local-port-map). `start:lan` builds that address
from `scutil --get LocalHostName` at run time, and the matching `.env.local` pair
writes it out by hand — neither is a line in a committed file, because the
address is per-machine and per-network, and baking it in breaks the simulator,
the emulator and the e2e runs. Fall back to the LAN IP if mDNS fails. The device also needs a dev build signed for its UDID
(`npm run expo:ios -- --device`); Expo Go cannot load this app. The full
device/app/environment matrix — including the secure-context rule that decides
what `bracemark-web` can do from a phone — is
[device-testing.md](./device-testing.md).

**If you use the file, comment it back out when you are done — any pair, not
just the iPhone one.** (The scripts need no undoing; that is their point.) The
switch has no per-target scope, so one left in place takes the simulator, the
emulator and `npm run e2e:ios:iphone` / `e2e:android:phone` off loopback too, and a Metro
restart is what decides when the fix takes effect. The failure that produces, and why it is
intermittent rather than reliable, is [device-testing.md](./device-testing.md),
_one bundle, one set of origins_.

Adding a new origin var = add the line to both committed files, a commented line
to each pair in `.env.local`, and the var to every `start:*` and
`*:release:staging` script — same deliberate symmetry as the other frontends.

**The `expo:*` root scripts call `npm run -w`, not `nx` — which also keeps this
the only loader.** The visible reason is the terminal UI
([expo-build.md](./expo-build.md), _the npm scripts_: under nx there is no QR
code and no key menu). The env-shaped reason is that **nx is itself a dotenv
loader**, and a different one from Expo. `loadDotEnvFilesForTask` reads, for a
task named `start` on this project, `apps/bracemark-expo/.env.start.local`,
`.env.start`, `.env.local`, `.env` — **and then the same variants at the
workspace root**. So `nx start @stxapps/bracemark-expo` folded the root `.env`
and `.env.local` into the Expo process, which `expo start` on its own never
reads: it resolves `.env*` against the project root only. Both loaders skip a
var already present, so nx's values would win.

Today that is benign — the root files hold `NX_NATIVE_COMMAND_RUNNER`,
`FORCE_COLOR` and the four `CLOUDFRONT_DISTRIBUTION_ID_*` ids, none of which
Expo or the bundle looks at, and no name collides. The hazard is the shape, not
the current contents: a var added to the root `.env` for some other project
would silently enter the Expo build through the nx path and not through the
direct one, so the two spellings of "start Metro" would bundle different values
with nothing to flag it. Going through `npm run -w` leaves `@expo/env` as the
only thing that reads a `.env` for this app, which is the model the rest of this
document assumes.

The visible tell, if you ever need it: `expo start` logs the files it loaded and
the vars it exported. Under nx the export line is missing `APPLE_TEAM_ID` —
because nx had already put it in `process.env` from
`apps/bracemark-expo/.env.local`, so Expo found it set and said nothing.

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
interpolation. At prebuild it is written into `DEVELOPMENT_TEAM`, which is what
keeps local device signing from needing a manual team pick in Xcode after each
regenerate of `ios/`. That takes **two** plugins, not one:
`@expo/config-plugins`' `withDevelopmentTeam` covers the app target, and the
local `plugins/with-share-extension-build-settings.js` covers the iOS **share
extension** target, which the first one runs too early to see — see
[expo-build.md](./expo-build.md), _ios share extension build settings_. Three
things follow:

- **It lives in `.env.local`**, not one of the committed files. `.env*.local` is
  gitignored, and the value is per-developer-account rather than per-tier.
- **It's mode-agnostic on purpose.** `expo prebuild` calls
  `setNodeEnv('development')` _before_ `@expo/env.load()`, so it reads
  `.env.development`, never `.env.production` — a var only in the latter would
  be invisible to the one command that needs it. `.env.local` is loaded in every
  mode.
- **No `EXPO_PUBLIC_` prefix.** That prefix means "inline into the JS bundle";
  this is a config-time value and never belongs in shipped JS.

Unset is safe: both plugins skip a falsy id and leave the pbxproj alone, so a
fresh clone still prebuilds — you just pick the team in Xcode, on each of the
two targets.

### bracemark-api — Hono on Cloudflare Workers

Server-side: config is read at **runtime**, never baked. bracemark-api runs **only**
on Workers (`src/worker.ts`, `export default app`) — there is no Node entry.

**Config read.** `src/app.ts` resolves `CORS_ORIGINS` per-request:
`c.env.CORS_ORIGINS` (the Workers binding) first, then the `[]`
default. On Workers `c.env` is the source; the `process.env` fallback only covers
non-Workers callers like `app.request()` in jest tests. `globalThis.process`
(not bare `process`) keeps it safe on Workers, which has no `process` global.

**`SERVER_TIMING`** is `"1"` in the `development` and `staging` vars and absent
from `production`'s. It adds the Server-Timing breakdown to every response
(`src/lib/server-timing.ts`; [local-first-sync.md](./local-first-sync.md),
_measuring a sync_). To measure production, set it there.

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
so the account id would arrive inside the Worker as well. (That still holds for
bracemark-extractor. bracemark-api declares `secrets.required`, so only the names
it lists get bound — _bracemark-api local secrets_, below.)

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
- local secrets → the **login keychain**, never `.dev.vars` — next section.

Local dev is `wrangler dev --env development`, reached through
`tools/scripts/run-api-dev.sh` (the `dev` target); it uses the `development` env above
with locally emulated D1/R2. There are no `NEXT_PUBLIC_`-style committed files
here because nothing is public.

#### ⚠ bracemark-api local secrets

**The api's local secrets live in the login keychain, and `npm run dev` hands them
to `wrangler dev` through the shell.** There is no `.dev.vars`, and
`tools/scripts/run-api-dev.sh` refuses to start while one exists.

The reason is the App Store key. There is one In-App Purchase key for all three
tiers — one `APPSTORE_KEY_ID` in `wrangler.jsonc`, and the key id names the key
Apple verifies against — and no In-App Purchase key is sandbox-only: the one
development signs with reads live transaction history on the production host.
The Play service account is the same shape (one Play Developer API host for test
and real purchases, [iap.md](./iap.md)). So a `.dev.vars` line for either is a
production credential sitting in the worktree, which is the CLAUDE.md tripwire.
The two sandbox Paddle secrets would be harmless in a file, but wrangler can't
mix sources (below), so they moved too.

| secret                  | keychain item (`-a bracemark`)                |
| ----------------------- | --------------------------------------------- |
| `PADDLE_WEBHOOK_SECRET` | `bracemark-paddle-webhook-secret-development` |
| `PADDLE_API_KEY`        | `bracemark-paddle-key-development`            |
| `APPSTORE_PRIVATE_KEY`  | `bracemark-appstore-key-development`          |
| `PLAY_SA_PRIVATE_KEY`   | `bracemark-play-sa-key-development`           |
| `PLAY_NOTIFY_TOKEN`     | `bracemark-play-notify-token-development`     |

```sh
# a trailing -w prompts for the value, keeping it out of shell history:
security add-generic-password -U -a bracemark -s bracemark-paddle-key-development -w
# PEMs flattened to ONE line — see below:
security add-generic-password -U -a bracemark -s bracemark-appstore-key-development \
  -w "$(tr -d '\n' < AuthKey_<KEY_ID>.p8)"
security add-generic-password -U -a bracemark -s bracemark-play-sa-key-development \
  -w "$(jq -r .private_key <service-account>.json | tr -d '\n')"
```

A value already exported in the shell wins over the keychain, and a missing one
is reported by name and left unbound — the routes that need it stay off, as they
did with an empty `.dev.vars` line. `bracemark-paddle-key-development` is the
item `npm run check:paddle` reads for `development`, and
`bracemark-appstore-key-development` the one `npm run replay:appstore` reads, so
each secret has one home.

Three rules here fail **silently**:

- **Any `.dev.vars` or `.dev.vars.development` switches the shell off.**
  Wrangler 4 treats that file as the only source of local secrets and never
  reads `process.env` while it exists. That is why the script refuses to start
  beside one rather than warning.
- **The shell is read because of `secrets.required`,** declared on the
  `development` env in `wrangler.jsonc`, and **only the names listed there are
  bound.** Keep that list and the script's `SECRETS` table identical. The
  other switch, `CLOUDFLARE_INCLUDE_PROCESS_ENV=true`, binds the **whole** shell
  environment into the Worker — never use it. And don't copy `secrets.required`
  into `staging`/`production`: there, `wrangler deploy` makes every listed name
  mandatory, including the ones whose store setup is still TODO.
- **A PEM stored with its newlines comes back hex-encoded** from
  `security -w`, and `pemToPkcs8` then fails on the first store call, long
  after startup looked fine. Store PEMs flattened, as above (`pemToPkcs8`
  strips the armour and all whitespace, so one line imports fine). The script
  refuses a `*_PRIVATE_KEY` item that has no `-----BEGIN`.

  A PEM stored with **escaped** newlines is the neighbouring case, and it is
  tolerated rather than refused: the two characters `\` `n` where each line
  break was, which is how a PEM sits inside a service-account JSON and inside a
  double-quoted `.dev.vars` line. Only a JSON or dotenv parser turns those back
  into newlines; the keychain and the shell hand them over as written. Such an
  item is text, so it has its `-----BEGIN` and passes the script's check — and
  the `n` is a base64 letter, so stripping whitespace left a body the Workers
  `atob` rejected on the backslash: `InvalidCharacterError` from `pemToPkcs8`,
  a 502 on `iap/verify`, **after** the store had taken the purchase.
  `pemToPkcs8` now drops the escape pair along with the whitespace (a backslash
  is never part of a PEM), and `replay-appstore.ts` does the same.

**Non-secret overrides moved to the shell as well.** Only the listed names are
bound, so a `CORS_ORIGINS` line in a `.dev.vars.development` or an
`.env.development.local` does nothing. Export it for the session instead —
`CORS_ORIGINS=… npm run dev` — and the script forwards it as `--var`, which
overrides the committed value ([device-testing.md](./device-testing.md)).

### E2E environment selection

The runner defaults to local loopback origins. `E2E_ENVIRONMENT=staging` (set by
the three `e2e:*:staging` root scripts) selects the exact app/API/extractor/site
roles on dryrunbase.com and refuses mixed-tier overrides. Production is not an
E2E mode. Existing `E2E_*_URL` overrides remain available for local loopback ports;
they cannot silently turn a local seed or fault-injection run into a deployed run.

A staging web run needs **one credential, and only when a selected case grants a
plan**: a Cloudflare token with D1 Edit on the staging account, resolved from an
exported `CLOUDFLARE_API_TOKEN` or the keychain item
`bracemark-cf-token-staging-e2e` (_what's committed vs ignored_, below). The
account it is used against comes from `apps/bracemark-api/.env.staging.local`,
which wrangler reads for `--env staging` as it does on a deploy. Every other
staging run reads no credential at all.

`e2e:build:<platform>:staging` pins `EXPO_PUBLIC_API_URL=https://api.dryrunbase.com` and
`EXPO_PUBLIC_SITE_URL=https://dryrunbase.com` in the native build's environment,
above Nx/Expo dotenv precedence. Release compilation uses `NODE_ENV=production`;
staging is a service tier, not a Node mode. It disables the measurement probe,
leaves `.env.local` alone, and checks the embedded bundle before writing a hashed
build receipt. No committed Expo `.env.staging` or credentials file is added.
This finite build task can use Nx because the values are pinned explicitly and
it needs none of Metro's interactive terminal UI. Details:
[e2e/STAGING.md](../e2e/STAGING.md).

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
  for the frontends (bracemark-expo: the first and last only) — every value in
  them is public.
- **gitignored:** `.env*.local` (frontend personal overrides — and bracemark-expo's
  `APPLE_TEAM_ID` and domain switch, above), `.dev.vars` (still ignored, but
  bracemark-api's local secrets are in the keychain now — _bracemark-api local
  secrets_, above), and all real secrets. These never enter git.
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
- **in no env file at all, third case:** the **Paddle API key**. The Worker gets
  it as a `wrangler secret`, so nothing needed a third home until
  `npm run check:paddle` ([iap.md](./iap.md), _exercising Paddle locally_) had to
  ask the live catalog a question from a laptop. It resolves `PADDLE_API_KEY`
  from the shell, then the login keychain (`bracemark-paddle-key-<tier>`), and
  nowhere else — a live Paddle key can issue refunds and read every customer, so
  it gets the Cloudflare token's treatment, not the account id's.
- **in no env file at all, the token's sibling:** the **staging e2e token**. A
  second Cloudflare token for the staging account, D1 Edit only, in its own
  keychain item (`bracemark-cf-token-staging-e2e`) — what lets a staging journey
  write its disposable account a plan ([e2e.md](./e2e.md), _deployed staging and
  mobile Release builds_). Separate so that the test runner never holds the
  deploy token's right to replace a Worker; `e2e/runner/staging-credential.ts`
  reads the shell, then that item, and has no fallback to the deploy one. There is
  no production counterpart, because production is not an E2E target.
- **in no env file at all, fourth case:** bracemark-api's **local** secrets,
  the store keys above all — _bracemark-api local secrets_, above. The sandbox
  Paddle pair sat in `.dev.vars`, and the store keys were headed there too,
  until it turned out the App Store key is the production one.

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
