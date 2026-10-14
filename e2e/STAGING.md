# Deployed staging and mobile Release tests

The staging targets use the real AWS-hosted app and marketing site, Cloudflare
Workers, D1, and R2. They do not start local servers. The design record is
[docs/e2e.md](../docs/e2e.md#deployed-staging-and-mobile-release-builds).

## Web

```sh
npm run e2e:web:staging
npm run e2e:web:staging -- --suite smoke
npm run e2e:web:staging -- --include-trait security
npm run e2e:web:staging -- --case DATA-IMPORT-WEB-001
# Discover the admitted cases without running them:
npm run e2e:web:staging -- --list
# Watch a case in a visible, paced browser window:
npm run e2e:web:headed:staging -- --case DATA-IMPORT-WEB-001
```

These are aliases for `npx nx e2e-web:staging @stxapps/e2e`. The app is
`https://app.dryrunbase.com`; the marketing site is `https://dryrunbase.com`.
API and extractor are `https://api.dryrunbase.com` and
`https://extractor.dryrunbase.com`. Deploy the release candidate through the
existing staging deploy scripts first. The client URLs are embedded during its
build; changing the runner's URLs cannot change them.

Playwright drives system Chrome with TLS validation and CSP enforcement enabled.
The ordinary flows create fresh disposable Free accounts through the real UI.
`DATA-IMPORT-WEB-001` imports a real image, uploads encrypted content to R2, and
reads it through a separate signed-in browser profile. It exercises R2's actual
presigned URLs, browser CORS, decryption, and blob images alongside entity sync.
Sign-out/account-switch flows visit the real marketing site in this mode.

### The cases that grant a plan

`EXTRACT-WEB-001` and `EXTRACT-WEB-ALL-001` need Plus: server extraction is a
paid lever, gated in the client on the entitlement the api folds. (The third is
the browser extension's `IAP-ENTITLEMENT-001`, below, under the same rules.)
They create a disposable account like every other journey, and then the runner
writes that account a `manual` purchase row in staging's remote D1 — the row a
comp is in production, and the one the local suite writes with `--local`
(`seed/plan.ts`). The deployed api folds it; nothing test-only is deployed to
make it work. These are the journeys that send a server extraction through the
deployed CSP and the deployed extractor Worker, using the extractor origin baked
into the shipped bundle.

That row is the **only write a runner makes outside the app**, and the only thing
on this page that needs a credential:

```sh
security add-generic-password -a bracemark -s bracemark-cf-token-staging-e2e -w
```

Mint it as an **account-owned** token against the **staging** account, with D1
Edit and nothing else. It is deliberately not the deploy token
(`bracemark-cf-token-staging`), and the runner never falls back to that one: a
process that drives a browser for minutes should not also hold the right to
replace a Worker. An exported `CLOUDFLARE_API_TOKEN` wins over the keychain, as it
does for the deploy scripts; with neither, the run stops — it does not fall
through to a `wrangler login` session.

- **It is proved before anything is created.** When a selected case declares
  `"stagingGrants": ["plan"]`, the web or browser-extension runner resolves the
  token and sends staging's directory an `UPDATE … WHERE 0` — no row changes,
  but the token, the account, the database and the `purchases` table all have to
  answer. A missing or refused token fails there, before Playwright provisions
  an account. A run that selects no such case never reads the keychain, and
  `--list` never does.
- **Only a declared case may grant.** The registry's `stagingGrants` is the list
  of cases that write to staging D1, and the write itself refuses a run that
  declared none (`seed/d1.ts`), and the registry allows the declaration on web
  and browser-extension cases only — the two runners that carry the preflight.
  So the native runner, the account seed and an undeclared case are all still
  refused.
- **It cannot spell production.** The statement is addressed to the
  `database_id` committed under `env.staging` in the api's `wrangler.jsonc`, in
  the account `apps/bracemark-api/.env.staging.local` names. The other tier's
  token gets a refusal; nothing gets a production write.
- **Only the plan.** Session-row removal and every other direct D1 fixture stay
  local. So does `npm run seed:accounts`: its passwords are a hash of a public
  constant, which is fine on a laptop and is not a thing to create on a public
  host. There is no standing paid account on staging.

Each grant is three `wrangler d1 execute --remote` calls, a few seconds apiece.
The disposable account keeps its purchase row, as it keeps everything else.

The security cases are:

- `STAGING-HOSTING-001`: app/marketing HTML and their 404 pages, security
  headers, the whole enforcing CSP compared with `staging/policy.ts`, and
  agreement between the document's build ID and the deployed `build.json`.
- `STAGING-CSP-001`: an unapproved external script is blocked by the browser.
- `STAGING-CSP-002`: an unapproved connection is blocked by the browser.
- `STAGING-CSP-003`: the marketing site, under its own policy, blocks both.
- `STAGING-CSP-004`: the signed-in app's service worker activates and Chrome
  loads its manifest, with no violation (`worker-src`, `manifest-src`).
- `STAGING-CSP-005`: marketing-site pages load and the bookmark converter
  converts a file in its `blob:`-started worker, with no violation.
- `STAGING-CORS-001`: both Workers answer browser health requests; their
  preflights allow the app and omit permission for an unrelated origin.

The CSP cases require a real `Content-Security-Policy` response header and an
`enforce` violation event for the probe. Report-only policies, DNS errors, and
ordinary successful user flows cannot satisfy them. Sentinel responses are
intercepted only to make an accidentally allowed request succeed; no probe goes
to a third-party host. The policy here allows inline Next bootstrap scripts, so
these checks do not assert that every inline script is blocked. CloudFront
enforces the policy on both tiers; a policy moved back to report-only turns the
refusals and the hosting case red. Running a subset never counts as the full
staging security gate.

Every signed-in journey is a CSP check as well: the app fixture fails a test
whose browser reported a violation in an app or marketing-site document, in any
profile the test opened, whether or not an assertion noticed. The failure lists
each violation's document, blocked URI and directive. `IAP-WEB-001` is admitted
for this reason — it opens the real Paddle sandbox overlay under the deployed
policy and closes it without paying, leaving one unpaid `ready` transaction per
run. When the CDN's policy changes on purpose, change `staging/policy.ts` with it.

## Browser extension

```sh
npm run e2e:extension:staging
npm run e2e:extension:staging -- --suite smoke
npm run e2e:extension:staging -- --case EXT-SYNC-002
```

These are aliases for `npx nx e2e-extension:staging @stxapps/e2e`. The runner
builds `npx nx build:staging @stxapps/bracemark-extension` — the Chrome MV3
bundle built for this tier from `.env.staging` — and refuses it before any
account exists unless the manifest grants exactly `https://api.dryrunbase.com/*`
and the scripts name the staging api and app and neither the local nor the
production ones (`runner/extension-bundle.ts`). A gitignored `.env.staging.local`
beside it would otherwise point the bundle at another tier silently. The local
target applies the same check to the development build. Then it stages the copy
the local target does (`tabs` added; the extraction case also gets the run's web
origin) in Playwright's bundled Chromium, headed and serial, against the deployed
app, api and R2. The bundle is built from this checkout, so it is the browser
extension a store build would be at this commit, talking to whatever is deployed.

What this run adds over the local one is what the deployed tier can break and
the development build cannot show:

- the staging bundle's baked origins — the api the popup signs in and syncs
  against, and the web-app origin its "Upgrade to Plus" hand-off opens
  (`IAP-ENTITLEMENT-001` asserts the URL);
- sign-in, sign-out and the session against the deployed api
  (`EXT-AUTH-001`, `EXT-SIGN-OUT-001`);
- encrypted sync in both directions through the deployed Workers and R2,
  including an update to an existing link (`EXT-SAVE-001`, `EXT-SYNC-001`,
  `EXT-SYNC-002`, `EXT-RESTORE-001`);
- **R2 from a `chrome-extension://` origin.** The browser extension's presigned
  blob PUT/GET is an ordinary CORS request that works only because each tier's
  bucket CORS policy allows origin `*` (`wxt.config.ts`, `host_permissions`).
  Narrowed to `app.*`, bracemark-web keeps working and every web journey stays
  green; `EXT-EXTRACT-001` uploads a captured image from the popup and reads it
  back in a separate web profile, so it goes red;
- the link-cap wall and its lifting by a Plus grant (`IAP-ENTITLEMENT-001`),
  which writes the plan row exactly as the web cases above do — same token, same
  preflight, declared in `cases.json`.

The web client every case pairs with runs under the deployed CSP, and a
violation in any of its profiles fails the case, as on the web target. Three
automated cases stay local: `EXT-SAVED-001` (its deployed leg is
`EXT-SYNC-001`'s pull; the rest is popup logic), `EXT-BOUNDARY-001` (a
`chrome://` page; nothing deployed is involved) and `EXT-SERVICE-WORKER-001`
(stopping the MV3 worker through CDP is process fault injection). The real
toolbar `activeTab` grant and Firefox remain
[extension/RELEASE.md](./extension/RELEASE.md).

## Mobile Release builds

Maestro drives installed Release apps without app-side test instrumentation.
Android uses a release APK with R8 and resource shrinking. iOS uses a
Release-configured, ad hoc signed **simulator `.app`**, not a TestFlight/App Store IPA. Official
Maestro physical-iOS support remains outside this workflow; real-device store,
biometric, and share checks remain in [mobile/RELEASE.md](./mobile/RELEASE.md).

Build one platform at a time:

```sh
npm run e2e:build:android:staging
npm run e2e:build:ios:staging
```

The build target regenerates that platform's generated native directory through
Nx prebuild, then runs `assembleRelease` or Xcode's Release simulator build. It
pins `EXPO_PUBLIC_API_URL` and `EXPO_PUBLIC_SITE_URL` in the child environment,
which outranks every dotenv file; it leaves `.env.local` alone. Android reruns
the JS embedding task so an earlier bundle cannot survive a changed environment,
while native dependency compilation can retain its normal cache. Existing
signing prerequisites still apply ([expo-build.md](../docs/expo-build.md)); no
credentials are added to the worktree.

Each build prints the artifact, installation command, and `release.json` receipt
under `.artifacts/releases/<build-run>/`. The receipt records build time, source
commit/dirty status, platform, Release configuration, staging URLs and SHA-256.
Android also retains and hashes `mapping.txt`, checks that R8 produced it, and
checks the generated minification/resource-shrinking flags. Both platforms check
the embedded JS/bytecode names staging and has no production/local API URL.

Boot the selected device and install the printed artifact explicitly:

```sh
adb -s <serial> install -r <artifact.apk>
xcrun simctl install <udid> <artifact.app>
```

If Android refuses `install -r` with `INSTALL_FAILED_UPDATE_INCOMPATIBLE`, the
existing app uses a different signing key (for example, a development build).
Uninstall that test-device app before installing Release; this clears its data.

Then run:

```sh
npm run e2e:android:staging -- --suite smoke
npm run e2e:contract:android:staging
npm run e2e:ios:staging -- --suite smoke
npm run e2e:contract:ios:staging
```

With nothing more, a run uses the newest receipt of that platform under
`.artifacts/releases/` and the one booted simulator (or attached Android
device), and prints both. Name either to override:

```sh
npm run e2e:android:staging -- --device <serial> --release-receipt <release.json>
```

Pass the receipt as the absolute path the build printed: Nx runs the native
runner from `e2e/`, so a relative path is resolved there. The defaults cannot
admit the wrong build — the preflight below hashes the installed app against
the chosen receipt either way — and with two devices up the run refuses to
choose.

No Metro or `adb reverse` is needed. Cold launch uses `launchApp` with cleared
state, rather than an Expo development-client link. Native preflight hashes the
installed app and compares it to the receipt before creating accounts. Android
also refuses a debuggable app. Its ADB preflight queries have a 15-second limit,
and copying the installed APK has a 90-second limit, so a stalled transport fails
instead of holding the runner indefinitely. iOS hashes the whole bundle, including
its share extension and frameworks, and verifies nested code signatures. Simulator
signing must remain enabled: an unsigned app can launch but its Keychain operations
fail with `-34018`, preventing sign-in. Reinstall a matching artifact if preflight refuses an
old build. Run manifests distinguish the build's source revision from the
runner's revision; rebuilding after source changes is the operator's job.

Finish native builds before driving the device, and run one device platform at
a time. If ADB lists the emulator but bounded shell probes stop answering, check
the transport and emulator before changing the app. `adb -s <serial> reconnect`
resets that transport; restarting the ADB server also affects any other attached
devices. A System UI ANR dialog can hide the app from Maestro. Keep those failed
attempts and rerun after the device responds normally; recovery is not a pass.

Use `--suite full` (the default) for all admitted journeys, or select `--case`
IDs as in local runs. The contract target runs both web-to-mobile and
mobile-to-web encryption round trips. Frozen vectors remain local: their screen
is deliberately absent in Release. Keep running that local contract leg too.

## Coverage and artifacts

`cases.json` is the admission list. Omitted `environments` means local-only;
`["local", "staging"]` opts a reviewed case into both modes. Selecting a local-only
case explicitly in staging fails before provisioning, rather than silently
skipping it. The staging manifests also list excluded cases. Production is not a
runner mode, and staging refuses origin overrides to production or localhost.

Staging journeys use Free accounts, with two exceptions: the two server-extraction
cases, and the browser extension's `IAP-ENTITLEMENT-001`, grant their own
disposable account Plus through staging's remote D1 (_the cases that grant a
plan_, above). The extraction cases are what sends an extraction through
the CSP; the pinned header and the CORS case's fetch from the page hold
the extractor's place in `connect-src` as well, and are all that holds it in a
run that selects neither. The other Plus journeys — locks, nested lists, the
search editor, the downgrade — are not admitted: the same grant would carry
them, and each is its own review. `EXTRACT-OFFLINE-001` stays local, since it
aborts the extractor at the browser and tests nothing a deployed tier changes.
Native on-device extraction is admitted; it does not call the server extractor.
Purchases/restores retain their sandbox release checklists.

Local fault-injection cases remain local: process pause/throttle, reverse-route
cuts, fake error servers, direct session-row removal, and the browser interception
schedules. Android sandbox-inspection cases also need a debuggable app (`run-as`)
and cannot inspect a normal release APK. The local PWA target still owns its
controlled two-build update/offline tests; CDN updates and real installation remain
[web/RELEASE.md](./web/RELEASE.md). Visual baselines remain local; the browser
extension's local-only cases are listed under _Browser extension_, above.

After preflight passes, each test run writes `.artifacts/runs/<run-id>/run.json`,
reports and failure artifacts. Security tests attach deployment headers/build identity. Release
receipts are evidence of build configuration and artifact identity; passing flows
are the runtime evidence. Neither proves store distribution, every native
architecture, or all provider configurations. Disposable accounts are isolated
but are not automatically deleted after a run. No cloud-administrator credentials
are needed by the runners — the plan grant's token is scoped to D1 on the staging
account and lives in the keychain — and build signing credentials stay outside
the checkout.

Validate runner changes with:

```sh
npx nx check:runner @stxapps/e2e
npx nx check:browser @stxapps/e2e
npx nx check:registry @stxapps/e2e
npx nx lint @stxapps/e2e
npx nx typecheck @stxapps/e2e
```

`check:runner` uses Node's test runner, including bounded subprocess termination,
origin/selection refusal and artifact/mapping tamper checks. It adds no Jest
config and remains outside `npm run test`.

`check:browser` uses system Chrome with synthetic CSP documents to verify that
the probe passes an enforcing refusal and rejects report-only/allowed policies,
and that the violation guard records an app document under either header while
ignoring an allowed request and a third party's document. It also checks the
header comparison against widened, narrowed and duplicated policies. It changes
no deployed headers and does not count as staging qualification.

`check:headers` is the one check here that may be pointed at production:

```sh
npx nx check:headers @stxapps/e2e                 # staging
npx nx check:headers @stxapps/e2e -- production
```

It reads the security headers of the tier's app and marketing-site hosts — a
page and a missing path on each — compares them with `staging/policy.ts`, and
has system Chrome attempt one unapproved connection and one unapproved script
per host, which the policy must refuse. It creates no account and sends nothing
off the machine, which is why it is not bound by the runner's refusal of
production. It needs no build behind the CDN: CloudFront attaches the policy to
its own 403, so an origin with empty buckets is checked on that. It does not
show that a build works under the policy; only the journeys do.

## Measured staging verification — 2026-10-09

Runner/native source baseline: `02d6f8a`, with the runner fixes described below.
The deployed web build identity is recorded separately by the hosting case.
Runs below use fresh disposable accounts and no automatic retries. Artifacts
remain local under `.artifacts/`; run IDs identify
the manifests and reports without publishing credentials.

| Surface                                                | Result                                                    | Evidence                                                         |
| ------------------------------------------------------ | --------------------------------------------------------- | ---------------------------------------------------------------- |
| Deployed web, all 26 admitted cases                    | 24 passed; `STAGING-CSP-001` and `STAGING-CSP-002` failed | `staging-web-2026-10-09T03-01-25-037Z-44101-968860`              |
| Android Release smoke                                  | 2 passed                                                  | `staging-mobile-android-2026-10-09T03-30-47-377Z-15356-e55933`   |
| Android Release data/extraction slice                  | 4 passed                                                  | `staging-mobile-android-2026-10-09T03-39-41-788Z-29142-b984ac`   |
| Android Release encrypted cross-client contracts       | 2 passed                                                  | `staging-contract-android-2026-10-09T03-35-42-192Z-22838-fb7d4b` |
| iOS simulator Release smoke                            | 2 passed                                                  | `staging-mobile-ios-2026-10-09T04-12-12-393Z-90419-9db1a2`       |
| iOS simulator Release data/extraction slice            | 4 passed                                                  | `staging-mobile-ios-2026-10-09T04-19-20-735Z-3463-47a4d2`        |
| iOS simulator Release encrypted cross-client contracts | 2 passed                                                  | `staging-contract-ios-2026-10-09T04-15-48-370Z-97396-e0bde1`     |

Web hosting/build identity, both Workers' CORS, and all 22 admitted product
journeys passed, including encrypted R2 image import and a separate browser
reader. The app still sends only `Content-Security-Policy-Report-Only`; the
enforcement gate correctly remains failed. This session changed no CloudFront
policy or deployed service.

The native slice includes session persistence after cold start, two mounted
link writes, mounted delete-all, the operating-system document-picker import,
on-device extraction on save, Generate all, and both encryption/sync directions.
It is selected runtime verification, not the entire admitted native suite or
physical-device/store qualification. Android ran on `bracemark-pixel8`, Android
16, with Maestro 2.8.0. Web used Chrome 154.0.8037.98 and Playwright 1.62.1.

Android's receipt is
`.artifacts/releases/staging-android-2026-10-09T03-01-00-716Z-40132-59b0d7/release.json`:
the APK SHA-256 is
`81a67a126b386e36363fb1e9b38e5e1f08f1c0219dc69f11739b52598a0eecfa`, with
the R8 mapping hashed separately in the receipt. It records a clean `02d6f8a`
build. The embedded staging URLs, R8 output, installed APK hash and refusal of a
debuggable installation were checked before the passing flows.

iOS's corrected signed receipt is
`.artifacts/releases/staging-ios-2026-10-09T04-02-00-569Z-73118-29530f/release.json`:
the whole-bundle SHA-256 is
`2098092105133266911ee55b3e538c7deabe94ce4434af13aa0f35d60a9bc875`. It records
`02d6f8a` with a dirty checkout containing these runner/documentation changes;
application source was unchanged. The app and share extension embedded staging
API URLs, their generated simulator application identifiers/App Group
entitlements, the nested signatures, and installed bundle identity were checked.
The runtime device is an iPhone 17 Pro simulator on iOS 26.5, with Maestro 2.8.0.

Earlier Android attempts remain failed: an unresponsive ADB/emulator transport
and a System UI ANR covered the app. They are retained in the runs ending
`80864-6cc142` and `7681-f06486`; neither is qualification evidence. Recovery
preceded the separate passing invocations above. The first iOS attempt, run
`staging-mobile-ios-2026-10-09T03-50-34-622Z-44953-0de7d6`, exposed the unsigned
simulator build's missing Keychain entitlements (`-34018`). Its failed run and
original receipt remain preserved; the builder now enables simulator signing
and checks signatures before issuing a receipt or admitting an installed app.
The corrected runner refused that same unsigned installation during preflight,
before account provisioning. The failed case's `keychain-diagnosis.log` retains
the credential-free simulator error evidence.

Runner checks passed 6/6, synthetic browser CSP detectors passed 2/2, registry
validation passed for 156 cases, and scoped lint/typecheck passed. Disabling the
subprocess timeout made its regression test fail; restoring it passed. The
signature checks rejected the original unsigned app and accepted the corrected
signed build/installation. These harness checks supplement the runtime results
above; they do not turn the failed deployed CSP checks green.

## Measured CSP enforcement — 2026-10-09

Later the same day the CSP moved from the report-only header to the enforcing
one on all four CloudFront policies, staging first. Runner baseline: `7940897`
plus the uncommitted changes of this pass — the violation guard, the pinned
header, `STAGING-CSP-003`/`-004`/`-005`, `IAP-WEB-001` admitted, and
`check:headers`. The deployed web build is the one the hosting case recorded.
The staging marketing site was redeployed from the same baseline between the two
full runs below, for the reason they give. No automatic retry counted as a pass.

| Surface                                           | Result                                                        | Evidence                                            |
| ------------------------------------------------- | ------------------------------------------------------------- | --------------------------------------------------- |
| Deployed web, 29 admitted cases, old site build   | 27 passed; `ACCOUNT-DELETE-001` and `WEB-ACCOUNT-004` failed  | `staging-web-2026-10-09T06-39-50-163Z-24015-93e5c4` |
| Deployed web, all 30 admitted cases, current site | 30 passed                                                     | `staging-web-2026-10-09T06-57-35-115Z-38045-7a9f17` |
| `check:headers`, staging                          | 4 responses and 4 refusals as designed                        | console output; no run directory                    |
| `check:headers`, production                       | 4 responses and 4 refusals as designed, all on CloudFront 403 | console output; no run directory                    |

In the final run the two enforcement cases that were red under report-only
passed, as did the marketing site's own refusals, the service worker and
manifest case, and the whole-header comparison on both origins' pages and 404s.
`IAP-WEB-001` opened and closed the real Paddle sandbox overlay under the
enforced policy, `DATA-IMPORT-WEB-001` moved encrypted images through R2 to a
second profile, and the bookmark converter ran a conversion in its
`blob:`-started worker. **No app or marketing-site document reported a
violation in any journey.**

The first run's two failures were the violation guard, and one finding: the
staging **marketing site** was serving a build far older than the app's, whose
zod chunk probed for eval on every page. Enforced, the browser refused the probe
and reported `script-src` / `eval` against `dryrunbase.com`; the page worked,
which is why nothing but the guard noticed. The two cases are the ones that end
on the marketing site, and every assertion of their own passed. It was not a
policy gap and `'unsafe-eval'` was not the fix: current source takes `z` from
`@stxapps/shared`, which is jitless. Before deploying, the current site export
was driven locally under the deployed site header — all 42 pages, the 404 and
the converter — with no violation; after `npm run deploy:site:staging` the same
two cases passed and `STAGING-CSP-005` now holds the site's pages and converter
on the CDN itself. That older build also predated the converter, so the site
policy's `worker-src blob:` had never been exercised on staging before this.

Production serves no build, so no journey can run there and none was claimed.
Its two policies were read back and differ from staging's only in the api,
extractor and R2 hosts (app) and the api host (site); its hosts send the designed
headers on CloudFront's 403; and Chrome refused the unapproved connection and
script on both. The first production deploy still needs a pass of its own.

Still not covered by any journey: a server extraction under the policy (it needs
a paid plan), and a violation raised inside a worker's own scope.

The first of those now has its journeys — `EXTRACT-WEB-001` and
`EXTRACT-WEB-ALL-001`, on a plan granted through staging's D1 (_the two cases
that grant a plan_, above) — but **they have not run against staging yet**, so
nothing here is a result for them. What has been checked is the edge of the
grant: with no token the run stops in preflight with the keychain command, and
with a token Cloudflare refuses it stops there too, naming the staging database;
neither creates a run directory or an account. Their first run needs the token
minted, and is the first time the deployed extractor fetches a page for a client
under this policy.

Runner checks passed 6/6, browser and header-comparison checks 6/6, registry
validation passed for 161 cases, and scoped lint/typecheck passed. Two local
smoke cases passed with the guard in place, under no CSP.
