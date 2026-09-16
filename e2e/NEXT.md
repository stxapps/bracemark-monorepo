# E2E next

Temporary implementation roadmap for whole-flow coverage across Bracemark's four
clients: the web app, the browser extension, Android, and iOS.

This file owns the ordered backlog and completion state. It does not replace the
permanent records:

- [`docs/testing.md`](../docs/testing.md) decides which test layer owns a claim.
- [`docs/e2e.md`](../docs/e2e.md) records the lasting E2E architecture and its
  tripwires.
- [`docs/app-drivers.md`](../docs/app-drivers.md) records the browser/device
  drivers and their limits.
- [`e2e/README.md`](./README.md) contains current run instructions.

When this roadmap is complete, move any lasting decisions into the appropriate
document above and delete this file. Do not preserve a stale completed backlog.

## Outcome

The goal is not to repeat every unit assertion through four user interfaces. The
goal is that every important boundary has one accurate proof at the lowest layer
that can observe it:

| Layer                      | What it must prove                                                                                                                     |
| -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| Unit/component/native unit | Validation, parsing, policy matrices, state machines, error handling, accessibility contracts, native constants                        |
| Functional E2E             | Real IndexedDB/SQLite/SecureStore, persistence, navigation, gestures, system surfaces, and mounted-screen reactivity                   |
| Cross-client E2E           | Encryption compatibility, sync, conflicts, and a write made by one client becoming readable on another                                 |
| Visual checkpoint          | Paint, clipping, scroll position, keyboard geometry, responsive layout, light/dark appearance                                          |
| Release qualification      | Real biometrics, payment providers, installed PWA behavior, and store/browser surfaces that local automation cannot represent honestly |

Coverage is complete when each supported user journey and each platform-specific
boundary has an owner in that table. A large number of duplicated E2E cases is
not itself completeness.

## Current baseline

Present in the tree today; this table is an inventory, not a claim that every row
has just passed on every platform.

| Surface           | Current coverage                                                                                                                                        |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Web               | Six Playwright cases: session reload, sign-out teardown, one-link persistence, two mounted writes, list creation round trip, mounted delete-all repaint |
| Native            | Four Maestro flows: password sign-in/cold start, recovery sign-in, two mounted link inserts, mounted delete-all repaint                                 |
| Contract          | Frozen device vectors plus web to mobile and mobile to web encrypted round trips                                                                        |
| Browser extension | Published-screenshot driver only; no functional E2E target                                                                                              |
| PWA               | Unit/component coverage around registration and navigation; no production-build offline E2E target                                                      |
| Automation        | No CI workflow currently runs these targets                                                                                                             |

Before adding broad new coverage, capture a fresh result for every existing case:

- [ ] `BASE-001` Run the complete web suite.
- [ ] `BASE-002` Run all four native flows on iOS.
- [ ] `BASE-003` Run all four native flows on Android.
- [ ] `BASE-004` Run vectors, web to mobile, and mobile to web on iOS.
- [ ] `BASE-005` Run vectors, web to mobile, and mobile to web on Android.
- [ ] `BASE-006` Update the state table in `docs/e2e.md` with the measured
      results, versions, and any still-pending leg.

## Rules for every new case

1. Name the exclusive risk the case catches. If a component test can observe the
   same failure, write or keep the component test instead.
2. Drive public UI, operating-system surfaces, and network boundaries. Do not
   import app or UI source into `e2e`; `@stxapps/shared` remains addressing only,
   never the expectation oracle.
3. Use roles, accessible labels, and stable `testID`s for controls. Body copy is
   an assertion only when the wording itself is the contract, never a navigation
   selector.
4. Assert user data by its deterministic fixture value. Do not assert global
   counts on an account shared by multiple cases.
5. Persistence claims require a real reload or cold start. Reactivity claims must
   pass without one.
6. Sync claims require a second client or profile to read the result. Seeing a
   local write on the writer is not a sync assertion.
7. Viewport claims require pixels or bounds. Accessibility visibility alone does
   not prove paint, scroll offset, clipping, or keyboard clearance.
8. No fixed sleeps when the product exposes a settled state. Wait for the UI,
   network, sync phase, or file that represents completion.
9. Every destructive case owns a disposable account. Seeded development accounts
   are for humans and published captures, not specs.
10. A retry is diagnostic evidence, not a green result. A case that passes only
    after retry is flaky and must fail the quality gate.
11. Do not add test-only shortcuts around account creation, encryption, local
    writes, sync, or the extractor's SSRF boundary.
12. Keep secrets and credentials out of source, logs, screenshots, reports, and
    uploaded artifacts. CI accounts use an ephemeral local stack.

## Run tiers

Every case carries exactly one primary tier and may carry extra traits.

| Tier      | Purpose                                                                                                         | Expected cadence                              |
| --------- | --------------------------------------------------------------------------------------------------------------- | --------------------------------------------- |
| `smoke`   | A client launches, authenticates, performs its core write, and reads it after the relevant persistence boundary | Pull requests affecting that client           |
| `full`    | Complete deterministic product journeys and platform behavior                                                   | Main/nightly; selected affected pull requests |
| `release` | Real hardware, store, provider, or browser chrome that cannot be represented locally                            | Release candidate                             |

Additional traits: `online`, `destructive`, `scale`, `visual`, `ios`, `android`,
`pwa`, and `extension`.

## Phase 1 — make the harness deterministic

### Native runner

- [ ] `HARNESS-NATIVE-001` Add required platform and device selection to the
      mobile runner. Pass Maestro the selected device explicitly; fail if the
      resolved device does not match.
- [ ] `HARNESS-NATIVE-002` Accept `smoke`/`full` and include/exclude traits, then
      select Maestro flows through tags rather than directory ordering.
- [ ] `HARNESS-NATIVE-003` Give every invocation a unique artifact directory
      containing JUnit, detailed HTML where useful, screenshots, recordings,
      command metadata, and debug logs.
- [ ] `HARNESS-NATIVE-004` Record platform, device id/model, OS version, Maestro
      version, app build identity, Metro URL, and stack origins in a run manifest.
      Never record passwords, recovery codes, tokens, or signed proofs in an
      uploaded manifest.
- [ ] `HARNESS-NATIVE-005` Validate Android boot completion and the required port
      reversals before provisioning an account.
- [ ] `HARNESS-NATIVE-006` Validate the Expo dev-client deep link and serving
      checkout before the first flow.
- [ ] `HARNESS-NATIVE-007` Run ordering-sensitive or destructive flows with their
      own provisioned account. Do not depend on the state left by a previous flow.

### Browser runner

- [ ] `HARNESS-WEB-001` Automate the existing port-owner/cwd preflight before
      reusing servers on ports 3000 and 8787. In CI, always own the processes the
      job drives.
- [ ] `HARNESS-WEB-002` Mark a pass-after-retry as a failed/flaky run while
      retaining the retry trace.
- [ ] `HARNESS-WEB-003` Keep the persistent-profile fixture required by the
      non-extractable `CryptoKey`, but provide an isolated-app helper for every
      destructive, sign-out, ordering, or multi-profile case.
- [ ] `HARNESS-WEB-004` Add case/trait filtering without introducing a Jest
      config or a target named `test`.

### Shared fixtures and case registry

- [ ] `HARNESS-FIXTURE-001` Add a small machine-readable case registry containing
      id, title, surface, tier, traits, fixture, flow/spec path, and artifact
      expectations. It organizes execution; it must not import product source or
      provide expectation values.
- [ ] `HARNESS-FIXTURE-002` Give every run a collision-free id and every created
      entity a readable, namespaced value.
- [ ] `HARNESS-FIXTURE-003` Continue generating scale archives from
      `e2e/seed/library.ts`, but import them into fresh disposable accounts. Never
      bind a spec to `seed_free_full`, `seed_plus_full`, or the published-capture
      account.
- [ ] `HARNESS-FIXTURE-004` Define three fixture sizes: empty, small journey
      library, and scale library. Use the smallest one capable of exposing the
      failure.
- [ ] `HARNESS-FIXTURE-005` Reserve `.invalid` URLs for deterministic non-extracted
      links and define a separate explicitly-online fixture set for extraction.

### Failure evidence

- [ ] `HARNESS-ARTIFACT-001` Keep Playwright trace and screenshot on failure for
      functional cases; add video only to flows where motion or system chrome is
      the subject.
- [ ] `HARNESS-ARTIFACT-002` Add named native screenshots after meaningful stable
      checkpoints, not after every tap or character.
- [ ] `HARNESS-ARTIFACT-003` Capture the accessibility hierarchy with a native
      failure so selector ambiguity and covered nodes can be diagnosed.
- [ ] `HARNESS-ARTIFACT-004` Establish artifact retention and redaction rules
      before uploading anything from CI.

## Phase 2 — browser-extension functional target

Add a distinct `e2e-extension` Nx target. Extract reusable build/load/profile and
sign-in support from `shot/extension.ts`; do not make specs depend on the
published-screenshot account or its live URL catalog.

Playwright's bundled Chromium and a persistent context remain required. The
automated popup path may use a staged build with the narrow additional `tabs`
permission, as the screenshot leg does, but the suite must state that this does
not prove the real toolbar click's `activeTab` grant. That final boundary belongs
to release qualification.

- [ ] `EXT-AUTH-001` Sign in through the browser extension and remain signed in
      after closing and reopening its page/profile.
- [ ] `EXT-SAVE-001` Save an unsaved HTTP page with a chosen list, tags, and note;
      observe the saved state without reopening.
- [ ] `EXT-SAVED-001` Open a page the account already holds and render the
      already-saved state instead of the editor.
- [ ] `EXT-RESTORE-001` Open a page whose link is in Trash and restore the existing
      entity rather than creating a duplicate.
- [ ] `EXT-BOUNDARY-001` Open a non-HTTP browser page and show the unsupported-page
      state.
- [ ] `EXT-SYNC-001` Create a link in the web app, request sync from the browser
      extension, and observe it there.
- [ ] `EXT-SYNC-002` Save in the browser extension, sync, and observe the link in
      a separate web profile.
- [ ] `EXT-EXTRACT-001` On a controlled live page, save and verify the active-tab
      title/image extraction result reaches the web app.
- [ ] `EXT-SERVICE-WORKER-001` Exercise a sync request after the MV3 background
      worker has suspended and restarted.
- [ ] `EXT-RELEASE-001` Manually install the production Chrome build, invoke the
      real toolbar action, and prove the `activeTab` grant exposes the current
      page.
- [ ] `EXT-RELEASE-002` Build and lint Firefox, then manually smoke sign-in, save,
      reopen, and sync in the supported Firefox release.

## Phase 3 — core deterministic journeys

### Accounts and sessions

Keep the existing account cases and add only boundaries not already observable
below E2E.

- [ ] `WEB-ACCOUNT-001` Existing: session survives a browser reload.
- [ ] `WEB-ACCOUNT-002` Existing: sign-out from a user list leaves for the
      marketing site without a teardown race.
- [ ] `NATIVE-ACCOUNT-001` Existing: password sign-in survives a cold restart;
      run on iOS and Android.
- [ ] `NATIVE-ACCOUNT-002` Existing: a wrong recovery code fails and the real one
      signs in; run on iOS and Android.
- [ ] `ACCOUNT-DELETE-001` Delete an account from an isolated web account; prove
      the session ends and a later sign-in is refused.
- [ ] `ACCOUNT-DELETE-002` Repeat the user-visible delete-account boundary on iOS
      and Android, without re-testing the server's entire deletion matrix.

### Link lifecycle and editors

- [ ] `WEB-LINK-001` Existing: a link added through quick-add survives reload.
- [ ] `WEB-LINK-002` Existing: two links added to an already-mounted view both
      remain visible.
- [ ] `NATIVE-LINK-001` Existing: two links added to an already-mounted FlashList
      both remain visible; run on iOS and Android.
- [ ] `LINK-EDITOR-001` Web: create with list/tags/note, edit title/note/list/tags,
      reload, and assert the edited values.
- [ ] `LINK-EDITOR-002` Native: the same persistence boundary through the native
      add and modal edit surfaces; run on iOS and Android.
- [ ] `LINK-CLOSE-001` Web and native: a dirty editor refuses an accidental close
      and permits an explicit discard. Keep field validation at component level.
- [ ] `LINK-LIFECYCLE-001` Web: pin, archive, unarchive, move to Trash, restore,
      then permanently delete one deterministic link.
- [ ] `LINK-LIFECYCLE-002` Native: exercise the same state boundaries through
      native menus and confirmation surfaces on iOS and Android.

### Lists, tags, filters, and search

- [ ] `WEB-TAXONOMY-001` Existing: a list created in Settings appears in the links
      sidebar.
- [ ] `TAXONOMY-EDITOR-001` Web: create and rename one list and tag; verify editor
      pickers immediately see them.
- [ ] `TAXONOMY-EDITOR-002` Native: repeat the cross-surface read on iOS and
      Android.
- [ ] `TAXONOMY-DND-001` Web: perform one sibling reorder and one list reparent
      with real pointer drag-and-drop; verify order/tree after reload.
- [ ] `TAXONOMY-DND-002` Native: perform the corresponding real touch gestures on
      iOS and Android; verify order/tree after cold restart.
- [ ] `FILTER-001` Web and native: choose a user list, a tag, Show All, Archive,
      and Trash and assert a deterministic member/non-member pair in each view.
- [ ] `FILTER-HIDDEN-LOCKED-001` Prove hidden/locked lists remain valid editor
      destinations while their contents remain absent from unauthorized reads.
- [ ] `SEARCH-001` Web and native: commit a text search, clear it, and verify the
      URL/route and visible result set agree.
- [ ] `SEARCH-002` Web and native: commit representative advanced list/tag/text
      clauses, leave the page, and restore the search through history/navigation.
- [ ] `SEARCH-SCROLL-001` After paging and scrolling one view, change query/sort
      and prove the new view starts at its top rather than inheriting the old
      offset.

### Bulk editing

- [ ] `BULK-001` Web: select links, extend a range, Select all, and prove selection
      survives virtualization while the view remains fixed.
- [ ] `BULK-002` Native: select multiple links, scroll them off/on screen, and
      prove selection survives FlashList recycling on iOS and Android.
- [ ] `BULK-ACTIONS-001` Web and native: batch move, retag, archive/remove, and
      pin/unpin representative mixed-state links; assert only eligible rows
      change.
- [ ] `BULK-TRASH-001` Web and native: restore and permanently delete from Trash
      through the bulk confirmation path.
- [ ] `BULK-COPY-001` Web and native: copy ordered URLs without leaving bulk mode.
      Clipboard formatting remains unit-tested; E2E proves platform permission and
      feedback.

### Locks

- [ ] `LOCK-APP-001` Web: configure an app lock, reload, prove no app content
      flashes, reject a wrong password, and unlock with the real password.
- [ ] `LOCK-APP-002` Native: configure, cold-start, reject/unlock, and manually
      relock on iOS and Android.
- [ ] `LOCK-LIST-001` Web and native: lock a parent list, prove descendant content
      is absent from browse/search/tag views and from the DOM/accessibility tree,
      then unlock through the covering lock.
- [ ] `LOCK-AUTORELOCK-001` Native: unlock, background beyond the grace period,
      foreground, and prove the lock re-engages; separately prove a brief
      background does not relock.
- [ ] `LOCK-BIOMETRIC-RELEASE-001` On a real iPhone with enrolled biometry, verify
      opt-in, success, cancel-to-password fallback, disable, and re-enrollment or
      unavailable behavior.
- [ ] `LOCK-BIOMETRIC-RELEASE-002` Repeat the supported biometric path on a real
      Android device.

## Phase 4 — cross-client sync and viewport behavior

Do not attempt every pair in a four-client complete graph. Use hub-and-spoke
coverage: every client must write; at least one independent client must read; and
both native operating systems must run the frozen crypto and web/mobile round
trips.

- [ ] `CONTRACT-VECTORS-001` Existing: frozen vectors pass on iOS.
- [ ] `CONTRACT-VECTORS-002` Existing: frozen vectors pass on Android.
- [ ] `CONTRACT-WEB-MOBILE-001` Existing: web writes, iOS reads.
- [ ] `CONTRACT-WEB-MOBILE-002` Existing: web writes, Android reads.
- [ ] `CONTRACT-MOBILE-WEB-001` Existing: iOS writes, web reads.
- [ ] `CONTRACT-MOBILE-WEB-002` Existing: Android writes, web reads.
- [ ] `SYNC-EXT-WEB-001` Covered by `EXT-SYNC-001`/`002`: browser extension and
      web each write and the other reads.
- [ ] `SYNC-REFRESH-PILL-WEB-001` Keep one web profile scrolled and engaged, write
      from a second profile, sync, prove rows do not jump, press the refresh pill,
      and prove the new row becomes the top state.
- [ ] `SYNC-REFRESH-PILL-IOS-001` Repeat with an engaged iOS list and a web writer.
- [ ] `SYNC-REFRESH-PILL-ANDROID-001` Repeat with an engaged Android list and a web
      writer.
- [ ] `SYNC-LOCAL-TOP-001` At native offset zero, add a link and prove through
      bounds/pixels that the newest row is in the viewport rather than merely in
      the accessibility tree.
- [ ] `SYNC-CONFLICT-001` Make concurrent offline edits to one link on web and one
      native client, reconnect in a controlled order, and prove the documented
      conflict result on both. Keep the conflict matrix itself at unit level.
- [ ] `SYNC-BLOCKED-001` Exercise a real capacity-blocked push and prove the
      client reports a capacity state rather than a generic network failure.

## Phase 5 — data lifecycle

Archive structure, parsers, policy, quota decisions, and cross-platform archive
compatibility remain unit/native-contract responsibilities. E2E covers the file
surface, orchestration, progress/receipt, visible result, and later sync.

- [ ] `DATA-DELETE-ALL-WEB-001` Existing: wipe in one tab and prove an already-open
      links tab repaints without reload while system lists remain.
- [ ] `DATA-DELETE-ALL-NATIVE-001` Existing: wipe over an already-mounted native
      links route and prove it repaints without relaunch on iOS and Android.
- [ ] `DATA-IMPORT-WEB-001` Import a small real Bracemark archive through the web
      file surface, assert the receipt, visible list/tag/link/image, and sync to an
      independent client.
- [ ] `DATA-IMPORT-WEB-002` Import one representative interop file and exercise the
      user-visible quota choice/cancel path. Parser-format matrices stay in unit
      tests.
- [ ] `DATA-IMPORT-NATIVE-001` Import the small archive through the iOS document
      picker, assert the receipt and visible result, then cold-start.
- [ ] `DATA-IMPORT-NATIVE-002` Repeat the system-picker boundary on Android.
- [ ] `DATA-EXPORT-WEB-RELEASE-001` Through a real browser save dialog, create each
      offered export format and verify filename plus receipt. Archive contents are
      verified below E2E.
- [ ] `DATA-EXPORT-NATIVE-RELEASE-001` On iOS and Android, create representative
      exports, prove the OS share surface opens and the receipt matches the run.
- [ ] `DATA-EMPTY-001` Export an empty/fully-filtered library and prove a file is
      still produced with the empty-run receipt.

If a system picker cannot be driven reliably on a supported OS/runtime, keep the
case in the release checklist rather than replacing the picker with an app mock
and calling it E2E.

## Phase 6 — native share surfaces

- [ ] `SHARE-ANDROID-001` Launch a real `ACTION_SEND` HTTP URL with a multi-word
      title, choose a list/tags, save, close, and observe the link in the already-
      running main app without relaunch.
- [ ] `SHARE-ANDROID-002` Start from a killed main app, share and save, then launch
      the app and prove the pending write drains and syncs.
- [ ] `SHARE-IOS-001` From Safari's system share sheet, enter the iOS share
      extension, choose a list/tags, save, return to Safari, then foreground the
      main app and prove the outbox drains.
- [ ] `SHARE-IOS-002` Share while signed out and prove the extension shows the
      signed-out state without launching the main app.
- [ ] `SHARE-BOUNDARY-001` On both platforms, cover no-URL and quota states at the
      system boundary. Detailed state-machine permutations remain component tests.
- [ ] `SHARE-CREATE-001` Create a list and tag inside the share surface, save, and
      prove the main app receives identical top-level entities exactly once.
- [ ] `SHARE-CROSS-CLIENT-001` After a successful share, prove a web profile can
      read the uploaded link without requiring another native edit.

The iOS system-sheet entry gesture must be followed by an assertion on an element
only the share extension renders. A successful tap command is not evidence that
the process boundary was crossed.

## Phase 7 — extraction

Create a deliberately-online, stable public fixture origin with pages for a known
title/image, redirects, missing metadata, and a controlled failure. It must be
reachable by the real extractor without weakening SSRF rules and must contain no
user or production data.

- [ ] `EXTRACT-FIXTURE-001` Establish the public fixture and document ownership,
      cache headers, expected bytes, and availability monitoring.
- [ ] `EXTRACT-WEB-001` Opt in to server extraction, save the known page, and prove
      its title/image become visible asynchronously.
- [ ] `EXTRACT-WEB-ALL-001` Import a small pending library, run Generate all,
      observe progress settle, and verify representative success/failure rows.
- [ ] `EXTRACT-EXT-001` Covered by `EXT-EXTRACT-001`: active-tab extraction from
      the live DOM reaches another client.
- [ ] `EXTRACT-NATIVE-001` In saves mode, save the known page and prove Expo's
      device extractor writes the result without calling the server extractor;
      run on iOS and Android.
- [ ] `EXTRACT-NATIVE-ALL-001` In all mode, run Generate all on pending imported
      rows and prove completion on iOS and Android.
- [ ] `EXTRACT-OFFLINE-001` Make extraction unavailable, prove link saving remains
      successful and pending, restore connectivity, and prove retry can enrich it.

The deliberately-online cases carry the `online` trait and do not block an
offline/local smoke run.

## Phase 8 — scale, loading, and offline operation

### Scale and viewport states

- [ ] `SCALE-WEB-001` Import the generated 1,000-link archive into a disposable
      account, page beyond the first result set, and prove a known later row becomes
      reachable without duplicate pinned rows.
- [ ] `SCALE-IOS-001` Repeat the infinite-scroll boundary on iOS.
- [ ] `SCALE-ANDROID-001` Repeat the infinite-scroll boundary on Android.
- [ ] `SKELETON-WEB-001` Delay the real initial read/sync boundary and capture the
      painted list/card skeleton plus accessible loading announcement.
- [ ] `SKELETON-NATIVE-001` Capture the corresponding real native loading state on
      iOS and Android without replacing the data hook.
- [ ] `VIEWPORT-BULK-001` Enter/exit native bulk mode at a non-zero offset and
      prove the FlashList cells remain painted and the offset remains stable.
- [ ] `VIEWPORT-KEYBOARD-001` At representative native editor/search/share
      surfaces, capture the keyboard-present checkpoint and prove focused fields,
      controls, and dismissal gestures remain reachable.

### Offline and reconnect

- [ ] `OFFLINE-WEB-001` While the page remains open, go offline, read cached data,
      create/edit a link, reconnect, sync, and prove another profile receives the
      queued write.
- [ ] `OFFLINE-IOS-001` Repeat local read/write/reconnect on iOS.
- [ ] `OFFLINE-ANDROID-001` Repeat local read/write/reconnect on Android.
- [ ] `PWA-001` Add a separate production-build PWA target; install/register the
      real service worker, complete one online launch, then cold-launch the app
      shell and cached library with the origin unavailable.
- [ ] `PWA-002` Create an offline edit in the installed PWA, reconnect, and prove
      it syncs to an independent client.
- [ ] `PWA-RELEASE-001` Install and smoke the PWA through real supported browser
      chrome on the release device/browser matrix. Do not treat display-mode
      emulation alone as installation proof.

A network-fault proxy owned by `e2e` may be introduced if it can delay/drop real
API and extractor traffic without changing product source or weakening security
boundaries. Prefer that over app-only failure switches.

## Phase 9 — subscriptions and IAP

Per-PR automation uses real local account state and the existing `manual`
entitlement source. It proves application behavior without pretending to be a
store transaction. Provider purchases stay in a separate release lane.

- [ ] `IAP-WEB-001` Free account: open the web subscription surface, prove the
      available plan/price/checkout affordance, and exercise cancel/return without
      completing a real payment.
- [ ] `IAP-NATIVE-001` Free account: fetch/display store products and open/cancel
      the native purchase sheet on the supported test build, without asserting a
      purchase occurred.
- [ ] `IAP-ENTITLEMENT-001` Grant a local manual plan, refresh each client, and
      prove paid gates open consistently in web, browser extension, iOS, and
      Android.
- [ ] `IAP-DOWNGRADE-001` Remove/lapse the local entitlement and prove existing
      paid-state data remains readable while gated create affordances close.
- [ ] `IAP-RESTORE-001` Exercise Restore purchases in store sandbox and prove
      verify-before-finish grants the correct account.
- [ ] `IAP-PADDLE-RELEASE-001` Complete a Paddle sandbox checkout and verify
      checkout, webhook/reconciliation, displayed entitlement, cancellation, and
      trial wording.
- [ ] `IAP-APPLE-RELEASE-001` Complete and restore a StoreKit sandbox purchase on
      an App Store-compatible build; verify server lookup, entitlement, and
      unfinished-transaction replay after a controlled verify failure.
- [ ] `IAP-PLAY-RELEASE-001` Complete and restore a Play license-tester purchase
      from the required track-installed build; verify entitlement and
      acknowledgement behavior.

Never add a test endpoint that directly marks an account paid. The manual grant
is an existing production state; provider-specific truth must come from the
provider sandbox.

## Visual checkpoints

Functional assertions remain authoritative. Screenshots make paint-only defects
reviewable and prove the viewport claims semantic selectors cannot.

- [ ] `VISUAL-001` Define named checkpoints for signed-out, empty, populated list,
      populated cards, search, add, edit, bulk mode, settings sections, app lock,
      list lock, delete receipt, and native share states.
- [ ] `VISUAL-002` Capture light and dark appearances for every checkpoint whose
      color/contrast differs materially.
- [ ] `VISUAL-003` Capture wide and narrow web layouts, plus the canonical iOS and
      Android phone profiles. Add tablet/large-screen coverage only when the
      product supports it.
- [ ] `VISUAL-004` Add large-font checkpoints for the highest-risk native forms,
      dialogs, and share surfaces.
- [ ] `VISUAL-005` Freeze or mask timestamps, progress counters, status chrome,
      random ids, and other unstable regions before considering pixel gating.
- [ ] `VISUAL-006` Begin new screenshot comparisons as review-only. Promote a
      checkpoint to a blocking visual assertion only after repeated runs show it
      is deterministic and its failure has a clear owner.

Do not reuse the published-store screenshot fixture as a visual-test baseline.
It deliberately depends on live public pages and serves a different purpose.

## Desired Nx targets

Keep one `@stxapps/e2e` project and its cross-client ownership. Add explicit
targets rather than a bare `e2e` fan-out that cannot satisfy device/build
prerequisites honestly.

```text
e2e-web
e2e-extension
e2e-pwa
e2e-mobile --platform ios|android --suite smoke|full --device <id>
e2e-contract --platform ios|android --device <id>
e2e-visual --platform ios|android --device <id>
```

Keep all E2E targets uncached. A cached pass after application code changed is
worse than no result.

## CI rollout

Introduce automation in stages so infrastructure failures do not hide product
failures.

### Pull requests

- [ ] `CI-PR-001` Run lint, typecheck, unit/component suites, and native unit
      suites where their platform is available.
- [ ] `CI-PR-002` Run web smoke against a job-owned local stack.
- [ ] `CI-PR-003` Build and run browser-extension smoke in bundled Chromium.
- [ ] `CI-PR-004` For native-affecting changes, run Android smoke.
- [ ] `CI-PR-005` For native-affecting changes, run a small iOS smoke on a macOS
      runner.
- [ ] `CI-PR-006` Upload failure evidence after redaction; never upload run
      credentials.

### Main/nightly

- [ ] `CI-NIGHTLY-001` Run full web and browser-extension suites.
- [ ] `CI-NIGHTLY-002` Run full Android and iOS deterministic suites.
- [ ] `CI-NIGHTLY-003` Run vectors and both contract directions on both native
      platforms.
- [ ] `CI-NIGHTLY-004` Run scale, offline, PWA, and explicitly-online extraction
      cases.
- [ ] `CI-NIGHTLY-005` Publish one summary keyed by case id, platform, attempt,
      duration, and artifact link.

### Release candidate

- [ ] `CI-RELEASE-001` Complete the real-device biometric checks.
- [ ] `CI-RELEASE-002` Complete iOS and Android share-surface checks.
- [ ] `CI-RELEASE-003` Complete Chrome/Firefox browser-extension checks and real
      PWA installation checks.
- [ ] `CI-RELEASE-004` Complete Paddle, App Store, and Play sandbox/provider
      checks.
- [ ] `CI-RELEASE-005` Record device, OS, app build, browser, and provider
      environment beside each result.

## Definition of done for a case

A checkbox above closes only when all of these are true:

- The case states the exclusive real-runtime risk it covers.
- Setup is deterministic and independent of human-modified accounts.
- Controls use stable selectors; user data uses namespaced fixture values.
- Assertions prove the intended boundary: persistence, reactivity, sync,
  viewport, system integration, or provider truth.
- The case fails when its guarded behavior is deliberately broken or bypassed.
- It passes repeatedly without relying on retries or fixed sleeps.
- Failure output identifies the step and retains sufficient evidence.
- The case is assigned to the correct tier and CI/release cadence.
- Relevant permanent design or operational documentation is updated.

## First implementation slice

Do these in order:

1. Finish `BASE-001` through `BASE-006`.
2. Implement `HARNESS-NATIVE-001` through `007` and artifact output.
3. Add the job-owned web smoke workflow for the six existing web cases.
4. Add the browser-extension fixture and `EXT-AUTH-001`, `EXT-SAVE-001`, and
   `EXT-SYNC-002`.
5. Implement the three refresh-pill cases; they cover the highest-value gap
   between unit correctness and mounted viewport behavior.
6. Add search/filter/editor journeys.
7. Add native share, locks, scale/offline, extraction, and lifecycle cases.
8. Add provider and real-hardware release qualification last.
