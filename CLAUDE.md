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

| working on                                                       | read                            |
| ---------------------------------------------------------------- | ------------------------------- |
| workspace layout, package boundaries, module resolution          | `architecture.md`               |
| **any dependency version / `package.json` / Expo SDK bump**      | `architecture.md` ⚠             |
| local store + encrypted file sync (the data path)                | `local-first-sync.md`           |
| the read edge — indexes, liveQuery, virtual scrolling, paging    | `client-queries.md`             |
| links-page search (the URL⇄`LinkQuery` grammar, the UI)          | `search.md`                     |
| accounts — key derivation, username/password rules               | `account.md`                    |
| API endpoints (contract-first, typed once in `shared`)           | `api-contracts.md`              |
| link editors, list/tag trees, bulk edit                          | `editors.md`                    |
| title/image/screenshot/page-copy capture, `bracemark-extractor`  | `link-extraction.md`            |
| import/export, delete all data, delete account                   | `data-lifecycle.md`             |
| subscriptions — Paddle, store IAP, the entitlement fold          | `iap.md`                        |
| app lock + list locks                                            | `locks.md`                      |
| light/dark theme                                                 | `theme.md`                      |
| safe-area insets, viewport sizing, popup positioning             | `safe-area.md`                  |
| `bracemark-extension` auth flow                                  | `browser-extension.md`          |
| `bracemark-expo` share sheet (iOS + Android)                     | `share-sheet.md`                |
| an expo dependency — router, uniwind, expo-image, fonts, IAP     | `expo-native-deps.md`           |
| prebuild, `app.config.ts`, the npm scripts, R8, signing          | `expo-build.md`                 |
| env vars, per app and per mode                                   | `env-files.md`                  |
| which host each app answers, the CSP, `nx start` preview         | `hosting.md`                    |
| **the public repo, the AGPL licence, what we claim about it**    | `brand-assets.md` ⚠             |
| **the mark** — the icon shape, its two components, the icon PNGs | `brand-assets.md`               |
| the marketing site — its pages, its apex, why it's in this repo  | `architecture.md`, `hosting.md` |
| how the workspace was originally scaffolded (run-once history)   | `setup.md`                      |

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
- **Greenfield — no migrations.** There is no production data. Edit persisted
  schemas in place (Dexie `version(1)`, the expo-sqlite DDL); don't add a
  migration step.
- **Extensionless imports inside packages.** `from './lib/theme'`, never
  `'./lib/theme.js'` — packages are `bundler=none` and consumed as raw source, so
  the NodeNext spelling resolves literally and 404s in Turbopack/Metro.
  → `architecture.md`, _module resolution in packages_.
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
  `packages/shared/src/stores/listing-copy.ts` — which is what four public surfaces
  print. `package.json` said `MIT` against an AGPL `LICENSE` for the repo's whole
  first public stretch, and nothing caught it; a reader is entitled to rely on the
  permissive one. Only the third copy is pinned by a spec. Relatedly, no surface may
  claim a visitor can **verify** what they are running — public source proves what
  the code does, not which build was served. → `brand-assets.md`, _the source_.
- **Never write "extension" bare.** Two unrelated things carry the name: the
  **browser extension** (`bracemark-extension`) and the iOS **share extension** (a
  target inside `bracemark-expo`). Qualify which one on first mention, in code
  comments and prose alike. → `architecture.md`, _apps_.
