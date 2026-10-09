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

The security cases are:

- `STAGING-HOSTING-001`: app/marketing HTML, security headers, and agreement
  between the document's build ID and the deployed `build.json`.
- `STAGING-CSP-001`: an unapproved external script is blocked by the browser.
- `STAGING-CSP-002`: an unapproved connection is blocked by the browser.
- `STAGING-CORS-001`: both Workers answer browser health requests; their
  preflights allow the app and omit permission for an unrelated origin.

The CSP cases require a real `Content-Security-Policy` response header and an
`enforce` violation event for the probe. Report-only policies, DNS errors, and
ordinary successful user flows cannot satisfy them. Sentinel responses are
intercepted only to make an accidentally allowed request succeed; no probe goes
to a third-party host. The policy here allows inline Next bootstrap scripts, so
these checks do not assert that every inline script is blocked. Review-only CSP
rollout is expected to make the enforcement cases red until CloudFront enforces
it. Running a subset never counts as the full staging security gate.

## Mobile Release builds

Maestro drives installed Release apps without app-side test instrumentation.
Android uses a release APK with R8 and resource shrinking. iOS uses a
Release-configured, ad hoc signed **simulator `.app`**, not a TestFlight/App Store IPA. Official
Maestro physical-iOS support remains outside this workflow; real-device store,
biometric, and share checks remain in [mobile/RELEASE.md](./mobile/RELEASE.md).

Build one platform at a time:

```sh
npm run e2e:build:staging -- --platform android
npm run e2e:build:staging -- --platform ios
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
Use the printed absolute receipt path below: Nx runs the native runner from
`e2e/`, so a relative path is resolved there.

Then run, using the matching receipt:

```sh
npm run e2e:mobile:staging -- --platform android --device <serial> --release-receipt <release.json> --suite smoke
npm run e2e:contract:staging -- --platform android --device <serial> --release-receipt <release.json>
npm run e2e:mobile:staging -- --platform ios --device <udid> --release-receipt <release.json> --suite smoke
npm run e2e:contract:staging -- --platform ios --device <udid> --release-receipt <release.json>
```

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

The first staging suite uses Free accounts. Plus grants/downgrades and paid server
extraction depend on local D1 fixtures and are excluded. Native on-device
extraction is admitted; it does not call the server extractor. Worker health and
CORS checks cover the deployed extractor's transport, not its paid extraction
journey. Purchases/restores retain their sandbox release checklists.

Local fault-injection cases remain local: process pause/throttle, reverse-route
cuts, fake error servers, direct session-row removal, and the browser interception
schedules. Android sandbox-inspection cases also need a debuggable app (`run-as`)
and cannot inspect a normal release APK. The local PWA target still owns its
controlled two-build update/offline tests; CDN updates and real installation remain
[web/RELEASE.md](./web/RELEASE.md). Browser extension and visual-baseline targets
remain local.

After preflight passes, each test run writes `.artifacts/runs/<run-id>/run.json`,
reports and failure artifacts. Security tests attach deployment headers/build identity. Release
receipts are evidence of build configuration and artifact identity; passing flows
are the runtime evidence. Neither proves store distribution, every native
architecture, or all provider configurations. Disposable accounts are isolated
but are not automatically deleted after a run. No cloud-administrator credentials
are needed by the runners; build signing credentials stay outside the checkout.

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
the probe passes an enforcing refusal and rejects report-only/allowed policies.
It changes no deployed headers and does not count as staging qualification.

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
