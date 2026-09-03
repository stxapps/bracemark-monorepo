<!-- nx configuration start-->
<!-- Leave the start & end comments to automatically receive updates. -->

## General Guidelines for working with Nx

- For navigating/exploring the workspace, invoke the `nx-workspace` skill first - it has patterns for querying projects, targets, and dependencies
- When running tasks (for example build, lint, test, e2e, etc.), always prefer running the task through `nx` (i.e. `nx run`, `nx run-many`, `nx affected`) instead of using the underlying tooling directly
- Prefix nx commands with the workspace's package manager (e.g., `pnpm nx build`, `npm exec nx test`) - avoids using globally installed CLI
- You have access to the Nx MCP server and its tools, use them to help the user
- For Nx plugin best practices, check `node_modules/@nx/<plugin>/PLUGIN.md`. Not all plugins have this file - proceed without it if unavailable.
- NEVER guess CLI flags - always check nx_docs or `--help` first when unsure

## Scaffolding & Generators

- For scaffolding tasks (creating apps, libs, project structure, setup), ALWAYS invoke the `nx-generate` skill FIRST before exploring or calling MCP tools

## When to use nx_docs

- USE for: advanced config options, unfamiliar flags, migration guides, plugin configuration, edge cases
- DON'T USE for: basic generator syntax (`nx g @nx/react:app`), standard commands, things you already know
- The `nx-generate` skill handles generator discovery internally - don't call nx_docs just to look up generator syntax

<!-- nx configuration end-->

# Workspace

Packages `@stxapps/{shared,react,web-ui,web-crypto,web-react,expo-crypto,expo-react}`;
apps `bracemark-{web,site,extension,api,extractor,expo}`. Nx project names carry the
scope — `@stxapps/bracemark-web`, never the folder name `bracemark-web`.

`bracemark-web` (the app, `app.bracemark.com`) and `bracemark-site` (the public
marketing site, the apex `bracemark.com`) are **different properties**, not two
words for one — write "the marketing site" on first mention. See
`docs/architecture.md`, _apps_.

Layering, lowest first: `shared → crypto → react → ui → app`, crossed with a
platform axis (`agnostic` / `web` / `worker` / `expo`) where a platform may use
`agnostic` but never another platform. Hence the sibling pairs —
`web-crypto`/`expo-crypto`, `web-react`/`expo-react` — and **packages must never
import an app.** Both axes are declared as `nx.tags` in each `package.json` and
enforced by `@nx/enforce-module-boundaries`, so an illegal import fails
`npm run lint` rather than failing silently. Per-project tags, per-package
responsibilities, and the reasoning: `docs/architecture.md`.

# Package manager

- This monorepo uses **npm** (npm/npx), not pnpm or yarn. The lockfile is `package-lock.json`.
- Run Nx via `npx nx <target>` or `npm exec nx <target>` (the generic Nx guidance above shows a `pnpm` example — ignore that here).
- Use the root scripts where they exist: `npm run lint`, `npm run typecheck`, `npm run test`, `npm run build`, `npm run dev`, `npm run reset`.
- **Whole workspace vs. one project.** The root scripts above fan out to every project (`nx run-many`). To run a target on a single app/package after a change, scope it by the project's full Nx name: `npx nx <target> <project>`, e.g. `npx nx typecheck @stxapps/bracemark-web`, `npx nx test @stxapps/bracemark-api`, `npx nx build @stxapps/bracemark-web` (`npx nx show projects` lists them). To check only what a change affected across the graph, use `npx nx affected -t <target>`.
- **After making changes, autofix before checking.** Run the fixer first so `lint`/`typecheck` only report what needs real attention: whole-workspace `npm run fix` (ESLint `--fix` + prettier), or scoped `npx nx lint @stxapps/<project> --fix` for a single project. Then run `npm run lint` and `npm run typecheck` (or their scoped forms).

# Docs

`docs/` is the design record — read the relevant file **before** changing code in
its area, and update it in the same change when the design moves. Each is
self-contained and cross-links its neighbours.

| working on                                                         | read                            |
| ------------------------------------------------------------------ | ------------------------------- |
| workspace layout, package boundaries, module resolution            | `architecture.md`               |
| **any dependency version / `package.json` / Expo SDK bump**        | `architecture.md` ⚠             |
| **running `nx migrate`; when the Expo SDK ceiling lifts**          | `upgrades.md` ⚠                 |
| local store + encrypted file sync (the data path)                  | `local-first-sync.md`           |
| the read edge — indexes, liveQuery, virtual scrolling, paging      | `client-queries.md`             |
| links-page search (the URL⇄`LinkQuery` grammar, the UI)            | `search.md`                     |
| accounts — key derivation, username/password rules                 | `account.md`                    |
| API endpoints (contract-first, typed once in `shared`)             | `api-contracts.md`              |
| link editors, list/tag trees, bulk edit                            | `editors.md`                    |
| title/image/screenshot/page-copy capture, `bracemark-extractor`    | `link-extraction.md`            |
| import/export, sign-out wipe, delete all data, delete account      | `data-lifecycle.md`             |
| subscriptions — Paddle, store IAP, the entitlement fold            | `iap.md`                        |
| app lock + list locks                                              | `locks.md`                      |
| **error messages, labels, roles, font scaling**                    | `accessibility.md` ⚠            |
| light/dark theme                                                   | `theme.md`                      |
| safe-area insets, viewport sizing, popup positioning               | `safe-area.md`                  |
| **the soft keyboard** — avoidance, dismissal, why a field is stuck | `soft-keyboard.md` ⚠            |
| `bracemark-extension` auth flow                                    | `browser-extension.md`          |
| `bracemark-expo` share sheet (iOS + Android)                       | `share-sheet.md`                |
| an expo dependency — router, uniwind, expo-image, fonts, IAP       | `expo-native-deps.md`           |
| prebuild, `app.config.ts`, the npm scripts, R8, signing            | `expo-build.md`                 |
| test layers, jest vs vitest, driving an app to see a change        | `testing.md`                    |
| whole-flow e2e — `e2e/`, playwright, maestro, the contract runs    | `e2e.md`                        |
| seeded dev accounts — a filled library, a paid plan, locally       | `e2e.md`                        |
| env vars, per app and per mode                                     | `env-files.md`                  |
| which host each app answers, the CSP, `nx start` preview           | `hosting.md`                    |
| leaving an origin — cross-origin nav vs. the Next router           | `hosting.md`                    |
| **the public repo, the AGPL licence, what we claim about it**      | `brand-assets.md` ⚠             |
| **the mark** — the icon shape, its two components, the icon PNGs   | `brand-assets.md`               |
| **user-facing wording** — the voice, "bookmark" vs "link", lines   | `brand-assets.md`               |
| the marketing site — its pages, its apex, why it's in this repo    | `architecture.md`, `hosting.md` |
| how the workspace was originally scaffolded (run-once history)     | `setup.md`                      |

# Tripwires

Rules whose violation is **silent** — no lint error, no type error, no failing
test. Check the linked doc before acting on any of these.

- **`internal/` must never appear in a file this repo tracks.** A private folder
  sits at the workspace root — gitignored here, backed by its own private repo.
  Nothing from it may cross into anything this repo tracks: no path, no filename,
  no quoted line, no number, no date — in docs, source comments, or commit
  messages. `tools/git-hooks/pre-commit` and `npm run check:private` only stop the
  _directory_ from being committed; a sentence copied out of it passes every
  check, and once pushed to a public repo it is unrecoverable (forks, caches,
  mirrors). Default search won't surface the folder either — ripgrep respects
  `.gitignore` — so the failure mode is writing the reference by hand. The folder
  carries its own instructions; nothing about its contents belongs in this file.
- **Dependency versions on the Expo side.** Root `package.json` pins the
  version; `bracemark-expo` declares `*`; packages declare a peer `*` (a real floor
  only where it means something). Never declare `expo-modules-core` anywhere;
  never write `*` in the **root** manifest (it resolves to `latest` — SDK 57, not
  54); pin `react` exactly, no caret, and follow any bump with `npm dedupe`. A
  second opinion on one of these versions nests a duplicate copy, and the symptom
  is an opaque native crash, not a version error. → `architecture.md`,
  _dependency versions_. Related: `nx lint --fix` will re-add an
  imported-but-undeclared dep to a `package.json`, so read its diff.
- **`nx migrate` runs migrations whose `requires` gate does NOT hold, and
  proposes an SDK bump you didn't ask for.** `npx nx migrate latest` rewrites root
  `package.json` to `@nx/expo`'s default SDK lane (56, on Nx 23) — expo,
  react-native, react, `typescript`, and a dozen more, plus deliberate `~`/`^`
  ranges flattened to exact pins on unrelated packages — so restore the manifest
  (`git checkout package.json`) and re-apply only the `@nx/*` + `nx` lines. Then
  the silent half: `@nx/js`'s two `23-1-0-*-for-ts6` migrations declare a
  `requires` of `{ typescript: ">=6.0.0" }` and **ran anyway** on a TypeScript
  5.9 workspace, writing TS 6 semantics (`ignoreDeprecations: "6.0"`,
  `esModuleInterop: false`, `types: ["*"]`) into ~26 tsconfigs. The run prints its
  successes and exits 0, and the values look deliberate in a diff — read the
  tsconfig diff after every `--run-migrations`. → `upgrades.md`
- **`apps/bracemark-expo/ios/` and `android/` are generated and gitignored.** Every
  native change belongs in `app.config.ts` or a config plugin. A hand-edit in
  Xcode leaves a _clean_ working tree and is destroyed by the next
  `expo prebuild --clean`. → `expo-build.md`
- **A new `--color-*` token in `apps/bracemark-expo/global.css` must also be
  named in `tools/prettier/expo-tailwind.css`.** The expo tokens live under
  `@variant light`/`@variant dark`, where `prettier-plugin-tailwindcss` cannot
  see them, so that formatter-only stylesheet re-declares the names in a real
  `@theme` block. Miss one and its utilities become "unknown" classes, which
  prettier hoists to the front of every class list they appear in — the symptom
  is `npm run fix` churning files you never touched, with no lint or type error.
  → `theme.md`, _the token shim the formatter needs_.
- **An expo Tailwind class Uniwind can't map fails silently.** No lint error, no
  type error — the style is simply absent, and the only place you'd see that is a
  device, a multi-minute native build away. Check a new or unusual class in
  seconds by running uniwind's `ProcessorBuilder` in node, and don't infer safety
  from an existing usage without checking how it's paired (a broken `aspectRatio`
  next to an explicit `size-4` is invisible). Related: `rem` is baked at BUILD
  time to `value * 16`, so an expo `max-w-*` cap does NOT move with the OS font
  scale the way its web counterpart does. → `theme.md`, _extending_.
- **A bare `data-x:` variant on a React-set `data-*` attribute matches when it is
  false.** Tailwind compiles `data-selected:` to the presence selector
  `[data-selected]`, but React stringifies false-valued `data-*` — cmdk's
  `data-selected={!!selected}` emits `data-selected="false"` on every unselected
  row, which `[data-selected]` matches. The symptom is a state style stuck on
  permanently (every `CommandItem` wearing the highlight, so no row looks picked
  and hover appears dead). Spell it `data-[selected=true]:` whenever the attribute
  comes from **our** JSX or a library that passes a boolean; the bare form is only
  safe on Radix, which omits the attribute when off. The `@custom-variant` bridges
  at the top of `packages/web-ui/src/styles.css` cover the `data-state`/
  `data-orientation` shorthands and nothing else. → `theme.md`.
- **A text field with no way to close the keyboard.** RN's two defaults fail in
  opposite directions and neither says so. `submitBehavior` resolves to
  `'newline'` for a **`multiline`** field, so return never blurs it — and three
  fields set `submitBehavior="submit"` deliberately (tags-field, both share
  pickers) so return adds an entry instead. Those depend entirely on tap-outside
  and scroll-to-dismiss, which is the other default: `keyboardShouldPersistTaps`
  defaults to `'never'`, which dismisses the keyboard but **withholds the tap
  from the child**, so the first press on the row you just filtered for does
  nothing. Put `keyboardShouldPersistTaps="handled"` and
  `keyboardDismissMode="on-drag"` on EVERY scroller that can be on screen under
  a keyboard, and give a surface with no scroller its own tap target. Nothing
  lints any of this, jest doesn't render it, and the Maestro flows use the
  native `hideKeyboard`, which bypasses the app's affordances entirely — so the
  suite stays green through a field the user cannot escape. → `soft-keyboard.md`
- **An error message that MOUNTS must carry `role="alert"`.** Nothing catches its
  absence — no lint rule, no type error, no test — and you cannot see the symptom
  without driving the app through a screen reader: the button finishes and
  re-enables, a line of red text appears, and nothing is announced. It was missed
  at 13 of `bracemark-expo`'s 17 error sites before the carriers below existed,
  and at a comparable share on web. Web spells it
  `<FieldError>` inside the Field kit, `<SettingsNotice tone="error">` in
  settings, and a bare `<p role="alert">` elsewhere; expo has exactly one carrier,
  `components/error-text.tsx`. The inverse is equally a bug: text that was already
  on screen, or that re-words as the user types (the password-strength verdict),
  must NOT announce. → `accessibility.md`
- **Awaiting an async helper inside a `liveQuery` querier silently kills
  reactivity.** Dexie's tracking zone survives exactly one await resumption, so a
  stacked one — awaiting a helper that itself awaited — leaves every later Dexie
  call registering no index ranges. Writes then stop re-firing the query and the
  list sits stale until a reload, with no error at the point of use. Nothing
  catches it, and it does **not** reproduce under fake-indexeddb, so no
  jest/vitest run can. In any code reachable from a querier, spell helper awaits
  `await Promise.resolve(helper())`; direct `db.*` awaits and `Promise.all` of
  them are already safe. Expo's port is table-coarse and carries no such rule.
  → `client-queries.md`, _the zone-echo constraint_.
- **Nothing under the auth gate may navigate on its own during a sign-out.**
  `endSession` wipes the local store, so for one frame every user list and tag
  disappears while the app still believes it is signed in — and any effect that
  treats data _disappearing_ as a deletion misfires on it. On web that meant the
  links page reading its own `?list=` as deleted and firing `router.replace` into
  `AuthGuard`'s exit navigation: two navigators in one frame, a crashed render,
  and the user stranded signed-out on the page they were leaving. The teardown now
  flips to `'ending'` BEFORE the wipe so the subtree unmounts first, and every gate
  treats `'ending'` exactly like `'loading'` — keep that ordering, and keep new
  auto-navigating effects UNDER the gate. `e2e/web/account.e2e.ts` covers only the
  visible half — it signs out from a **user** list (a system list can't look
  deleted, and the bare-`/links` version of it passes even against the crashing
  code), which pins the `location.replace` exit. The `'ending'` ordering itself has
  NO test and can't have one: with `location.replace` in place the stray dispatch
  is absorbed, so deleting the phase breaks nothing observable — until the next
  auto-navigating effect lands. → `data-lifecycle.md`, _the sign-out teardown_.
- **`useLocalSearchParams` in an expo `_layout` reads the LAYOUT's route, not the
  screen's.** Both param hooks return a plausible bag, so the failure is silent —
  no lint error, no type error, no failing test, just a screen whose query never
  changes. `features/links/page-provider.tsx` has to live in the links layout (the
  drawer content and the screen need ONE context), which put it a level above the
  `index` route the `?list=`/`?tag=`/`?text=` params land on: a drawer pick is a
  `push` demoted to a navigate against the DRAWER, rewriting only that navigator's
  route and never the layout's, so every view parsed the empty bag — My List,
  forever. Use `useGlobalSearchParams` in a layout, and HOLD the last bag while
  another route is focused, gating on the focused **pathname** (`useIsFocused`'s
  event-fed state lags the params by exactly the render that would poison the
  hold) — otherwise a pushed Settings or modal editor swings the page onto ITS
  params and discards the view underneath. The local hook stays correct in a leaf
  screen and for a layout's own dynamic segment. → `search.md`, _on native_.
- **`wrangler d1 migrations apply` defaults to LOCAL, and says so only in
  prose.** With neither `--local` nor `--remote`, it applies to the miniflare
  SQLite file under `.wrangler/`, prints `Resource location: local` in the middle
  of otherwise-normal output, prints ✅ and exits 0. Drop the flag from a
  production run and the real database is untouched while the Worker serves
  against tables that do not exist — no error, no lint rule, no type error, and
  no test in either runner can reach a remote D1 to catch it. The three
  `d1-migrate` configurations in `apps/bracemark-api/package.json` carry the flag
  explicitly on every command, `--local` included, so an absent one reads as
  wrong rather than as unspecified; `tools/scripts/deploy-worker.sh` is the safe
  path for a real tier. Relatedly, that target is `d1-migrate` and not `migrate`
  because **`nx migrate` is a built-in Nx command** — `nx migrate <project>`
  parses the project as a package to upgrade the workspace to, rather than
  running the target. → `hosting.md`, _deploying the workers_;
  `apps/bracemark-api/src/db/migrations/README.md`.
- **The client stores are still greenfield; the DEPLOYED schemas are not.** On a
  device nothing has shipped, so Dexie `version(1)`
  (`packages/web-react/src/data/db.ts`), the expo-sqlite DDL
  (`packages/expo-react/src/data/db.ts`) and the R2 payload shapes the clients
  write (`packages/shared/src/sync/`) are still edited **in place** — change the
  shape, recreate the dev database (delete the app / clear its data), don't add a
  migration step. `bracemark-api` is deployed, so its two SERVER schemas have
  left that regime and nothing about them says so at the call site:
  `src/db/migrations/<role>/0001_init.sql` is recorded as applied in every live
  D1 and `wrangler` will never re-run it, and a DO past `schema_version` 1 never
  re-runs `MIGRATIONS[0]` in `src/do/user-data.ts`. Editing either in place is
  silent in the worst way — a fresh/local database gets the new shape, every
  deployed one keeps the old, and the apply still prints ✅. **Append**
  (`0002_*.sql`, folded into `db/schemas/<role>.sql` so a fresh DB matches a
  migrated one; or a new `MIGRATIONS` entry, never an edit to a shipped one);
  folding a change back into the init is only correct if you also drop and
  re-provision every deployed database, deliberately. →
  `apps/bracemark-api/src/db/migrations/README.md`,
  `apps/bracemark-api/src/do/README.md`.
- **Extensionless imports inside packages.** `from './lib/theme'`, never
  `'./lib/theme.js'` — packages are `bundler=none` and consumed as raw source, so
  the NodeNext spelling resolves literally and 404s in Turbopack/Metro.
  → `architecture.md`, _module resolution in packages_.
- **RN core APIs that read `UIApplication` are WRONG, not broken, inside the iOS
  share extension's process.** They return a plausible number instead of
  throwing. Two are live today and both were shipped blank: RN's font-scale
  multiplier is `RCTSharedApplication().preferredContentSizeCategory`, which is
  nil in an app extension, so the multiplier is **0** and EVERY `Text`/
  `TextInput` lays out at zero point — invisible, with the accessibility tree
  fully correct, so jest, the Maestro flows and the contract runs all pass while
  the sheet shows icons and no words. Only a screenshot shows it; the embedded
  Inter face is a red herring (`expo-share-extension` copies it into the target's
  `UIAppFonts` from the `expo-font` plugin's array, and a missing family falls
  back to the system face rather than rendering nothing). The fix is
  `allowFontScaling={false}`, set from `index.share.js` via `lib/font-scale.ts` —
  which costs Dynamic Type on that one surface and cannot be avoided. Second:
  RN converts every keyboard frame through `RCTKeyWindow()`, which returns nil
  here by contract, so JS sees `screenY: 0, height: 0` and NO
  `KeyboardAvoidingView` can work — with `screenY: 0` it lifts by the panel's
  whole height, collapsing it and parking it above the sheet, and
  `keyboardVerticalOffset` only makes that bigger. The share sheet's iOS branch
  therefore takes its lift from our own `BracemarkShareKeyboard` module
  (`modules/bracemark-share/ios/`) via `features/share/share-keyboard.ts`, and
  the extension's `height` is omitted from `app.config.ts` so the host view is
  full-screen — a 520pt one cannot hold a ~520pt picker above the keyboard
  however correctly it lifts. Anything new in this tree that reads the key
  window, the screen or the shared application is suspect the same way. →
  `share-sheet.md`, _what an app-extension process breaks in React Native
  itself_; `accessibility.md`; `soft-keyboard.md`.
- **The lazy requires on the iOS share path.** `data/share-store.ts` (the whole
  sqlite/write-edge/sync half, plus `share-upload`) and `expo-crypto`'s
  `lib/ids.ts` defer their imports behind `require()` at the call site **on
  purpose**: everything the extension's entry imports statically is executed on
  every cold share, in a process re-created each time. "Tidying" one back into a
  top-level `import` changes no behaviour, passes every check, and silently puts
  drizzle-orm or quick-crypto back into the sheet's boot. The barrel-import half
  of this rule IS linted; this half can't be. → `share-sheet.md`, _keep
  `index.share.js` lean_.
- **The licence is stated in three places.** Root `LICENSE` (AGPL-3.0), root
  `package.json`'s `license` field, and `SOURCE.license` in
  `packages/shared/src/brand/brand.ts` — which is what four public surfaces
  print. `package.json` said `MIT` against an AGPL `LICENSE` for the repo's whole
  first public stretch, and nothing caught it; a reader is entitled to rely on the
  permissive one. Only the third copy is pinned by a spec. Relatedly, no surface may
  claim a visitor can **verify** what they are running — public source proves what
  the code does, not which build was served. → `brand-assets.md`, _the source_.
- **"A key derived from your password" is false, and it refutes itself one
  clause later.** The root of an account is a **random DEK**; the password
  derives only a KEK that **unwraps** a copy of it, which is exactly how a
  recovery code opens the same library. So a key genuinely derived from the
  password could not have a second door — every surface saying "derived" sits
  beside a sentence promising the recovery code, and the wording still reads as
  the more technical of the two. Nothing catches it: `bracemark-site` imports no
  crypto package, so the sentence describing the model and the code implementing
  it are in different projects with no link, and there is no lint error, type
  error or failing test in either runner. It reached **eight** user-facing
  surfaces out of one compressed heading in `account.md` — the landing hero,
  /about twice, /privacy, /terms, /faq and both store listings — and survived an
  earlier pass that corrected it in the landing page's `GUARANTEES` and nowhere
  else. In user-facing copy the verb is **unlocks**: "a key your password
  unlocks". Two nearby spellings that ARE right and must not be "corrected":
  the wrapped blobs are "locked with a key derived from your password or
  recovery code" (that IS the KEK), and "your password is put through Argon2id
  to derive a key, and that key unlocks the one your library is encrypted with".
  `password-derived` also stays correct for the KEK itself and as a name for the
  account _model_ — say which you mean. → `account.md`, _the model_ (the callout
  under the heading).
- **"The server sees nothing" is false, and it reads like precision.**
  `bracemark-api` is ONE Worker serving auth, sync AND billing, over a username
  directory, an accounts shard, a sessions DB, a purchases table and R2
  (`apps/bracemark-api/wrangler.jsonc`) — so the same host that cannot read a
  link holds your **username, public key, sessions and subscription row in the
  clear**. Only the LIBRARY is ciphertext-only. Say "`api.bracemark.com` never
  sees your library in plaintext"; never "only ever sees ciphertext", "the server
  sees nothing", "ciphertext and nothing else", or a narrowing to "the sync
  server" — there is no separate sync server to name, and inventing one to carry
  a smaller claim is the same error one step quieter. Two further spellings, both
  found in shipped copy AFTER those were retired: an **enumeration that closes**
  ("that is the end of the list", "nothing else on file") names a true subset and
  then asserts completeness, omitting the public key and the sessions row — name
  the residual or point at /privacy, never close the list from a surface that is
  not the inventory; and a claim about what we **see** rather than what we
  **hold** ("never a link") is false the moment `bracemark-extractor` is on, since
  a server fetching a page has to be told which page. Relatedly, the extractor
  **stores nothing it read** but its rate limiter is keyed on `cf-connecting-ip`,
  so a bare "stores nothing" is falsifiable by anyone who thinks about how a cap
  on an anonymous service works — /privacy and /extractor name the IP; every other
  surface must too. Nothing catches any of it:
  the schema lives in a different app from every surface that describes it, so
  there is no lint error, type error or failing test, and the phrasing sounds
  MORE rigorous the more wrong it gets. It had been quoted as settled across four
  docs and four call sites, and had reached the site-wide meta description, the
  footer on every page, and the landing page's loudest claim (`GUARANTEES`, _Our
  blindness_) before anyone read it against the tables. A privacy claim a reader
  can falsify costs more than the residual it was hiding, which is why the public
  surfaces now name the residual themselves. Two things that ARE true and should
  keep their wording: **`R2` only ever sees ciphertext**
  (`packages/web-react/src/sync/r2.ts` — a blob store with nothing else in it),
  and **"blind sync broker"** as a nickname for `bracemark-api`, which is blind to
  your library and to nothing else. Relatedly, `bracemark-extractor` is a second
  server of ours and is handed a **plaintext URL** by construction, so no surface
  may claim encryption happens before anything leaves the device. →
  `local-first-sync.md`, _the shape of the problem_ (the callout under the
  decisive constraint), and _crypto boundary & what the server still learns_.
- **`/extractor` publishes the extractor's caps as prose, and nothing links the
  two.** `bracemark-extractor` names `https://bracemark.com/extractor` in the
  `User-Agent` of every outbound fetch, so that page is read by operators of the
  sites our users save from — and it prints the timeout, redirect cap, HTML
  ceiling, image ceiling and batch cap as sentences. `bracemark-site` does not
  depend on `bracemark-extractor`, so moving `FETCH_TIMEOUT_MS`, `MAX_REDIRECTS`,
  `MAX_HTML_BYTES`, `MAX_IMAGE_BYTES` or `MAX_EXTRACT_URLS` leaves a public
  commitment quietly false, with no lint error, type error or failing test. The
  page's blocking advice is pinned the same way to `verdictForStatus`
  (`packages/shared/src/extract/retry.ts`): it tells operators to answer `403`
  because that is what settles as `permanent`. And its robots.txt paragraph is a
  DISCLOSURE — the extractor does not read robots.txt — which must not drift into
  sounding like compliance unless the code changes first. →
  `link-extraction.md`, _server extraction_.
- **Never write "extension" bare.** Two unrelated things carry the name: the
  **browser extension** (`bracemark-extension`) and the iOS **share extension** (a
  target inside `bracemark-expo`). Qualify which one on first mention, in code
  comments and prose alike. → `architecture.md`, _apps_.
