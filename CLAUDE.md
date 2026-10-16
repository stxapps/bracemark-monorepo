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
words for one — write "the marketing site" on first mention. And **never write
"extension" bare**: the **browser extension** (`bracemark-extension`) and the iOS
**share extension** (a target inside `bracemark-expo`) are unrelated things that
share a name — qualify which one on first mention, in code comments and prose
alike. See `docs/architecture.md`, _apps_.

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
- **Long-running commands** (build, test, e2e, a dev server): run in the background and check its output; treat ~3 min with no new output as a hang — kill it and investigate rather than waiting out the tool timeout. A healthy run keeps printing (the e2e `list` reporter logs every test); a hung one — a stuck worker teardown, a Next dev server that accepts a request and never answers — goes silent. Probe a dev server with `curl --max-time 10`, never a bare `curl`.

# Docs

`docs/` is the design record — read the relevant file **before** changing code in
its area, and update it in the same change when the design moves. Each is
self-contained and cross-links its neighbours.

**⚠ marks a doc that carries at least one tripwire**: a rule whose violation is
**silent** — no lint error, no type error, no failing test, and often no symptom
short of a device, a deploy or a screen reader. Each such rule lives in its doc in
full, with the reasoning and the specimen that produced it. The marker is here so
that reading comes _before_ the edit; nothing downstream will tell you.

| working on                                                                     | read                            |
| ------------------------------------------------------------------------------ | ------------------------------- |
| workspace layout, package boundaries; an import _inside_ a package             | `architecture.md` ⚠             |
| **any dependency version / `package.json` / Expo SDK bump**                    | `architecture.md` ⚠             |
| **running `nx migrate`; when the Expo SDK ceiling lifts**                      | `dependency-upgrades.md` ⚠      |
| local store + encrypted file sync (the data path); what the server still holds | `local-first-sync.md` ⚠         |
| **a schema — Dexie, expo-sqlite, an R2 payload, D1, the DO**                   | `local-first-sync.md` ⚠         |
| the read edge — indexes, liveQuery, virtual scrolling, paging                  | `client-queries.md` ⚠           |
| links-page search (the URL⇄`LinkQuery` grammar, the UI); expo route params     | `search.md` ⚠                   |
| accounts — key derivation, username/password rules                             | `account.md` ⚠                  |
| **sessions — lifetime, expiry, revocation; anything that wipes a device**      | `sessions.md` ⚠                 |
| **the service worker — what it caches, when it registers, how it updates**     | `offline-mode.md` ⚠             |
| server backups — D1 export, R2 replication, **an R2 lifecycle rule**, restores | `server-backups.md` ⚠           |
| API endpoints (contract-first, typed once in `shared`); **a new GET**          | `api-contracts.md` ⚠            |
| link editors, list/tag trees, bulk edit                                        | `editors.md`                    |
| title/image/screenshot/page-copy capture, `bracemark-extractor`                | `link-extraction.md` ⚠          |
| import/export, sign-out wipe, delete all data, delete account                  | `data-lifecycle.md` ⚠           |
| **a limit** — tree depth, a name's length, tags per link; a new `.max()`       | `data-limits.md` ⚠              |
| subscriptions — Paddle, store IAP, the entitlement fold                        | `iap.md`                        |
| app lock + list locks                                                          | `locks.md`                      |
| **error messages, labels, roles, font scaling**                                | `accessibility.md` ⚠            |
| light/dark theme; a Tailwind class, a `data-*` variant, a `--color-*` token    | `theme.md` ⚠                    |
| safe-area insets, viewport sizing, popup positioning                           | `safe-area.md`                  |
| **the soft keyboard** — avoidance, dismissal, why a field is stuck             | `soft-keyboard.md` ⚠            |
| `bracemark-extension` auth flow                                                | `browser-extension.md`          |
| the iOS **share extension** — its process, its imports, its sheet              | `share-sheet.md` ⚠              |
| an expo dependency — router, uniwind, expo-image, fonts, IAP                   | `expo-dependencies.md`          |
| prebuild, `app.config.ts`, the npm scripts, R8, signing, any native change     | `expo-build.md` ⚠               |
| **tablet support, the OS minimums, the Play Console device catalog**           | `expo-build.md` ⚠               |
| **writing or reviewing a spec**; test layers, jest vs vitest                   | `testing.md` ⚠                  |
| driving an app to see it run — the browser, the AVD, Maestro, simctl/adb       | `app-drivers.md` ⚠              |
| whole-flow e2e — `e2e/`, playwright, maestro, the contract runs                | `e2e.md` ⚠                      |
| seeded dev accounts — a filled library, a paid plan, locally                   | `e2e.md` ⚠                      |
| env vars, per app and per mode; where a credential goes instead                | `env-files.md` ⚠                |
| **testing on a real phone/tablet** — what connects, secure contexts, HTTPS     | `device-testing.md` ⚠           |
| **deploying a Worker; applying a D1 migration**                                | `hosting.md` ⚠                  |
| which host each app answers, the CSP, `nx start` preview                       | `hosting.md`                    |
| **turning on any CloudFront/S3 request log** — /privacy says we keep no copy   | `hosting.md` ⚠                  |
| leaving an origin — cross-origin nav vs. the Next router                       | `hosting.md`                    |
| **the public repo, the AGPL licence, what we claim about it**                  | `brand-assets.md` ⚠             |
| **the mark** — the icon shape, its two components, the icon PNGs               | `brand-assets.md`               |
| **user-facing wording** — the voice, "bookmark" vs "link", the lines, a claim  | `brand-assets.md` ⚠             |
| the marketing site — its pages, its apex, why it's in this repo                | `architecture.md`, `hosting.md` |
| how the workspace was originally scaffolded (run-once history)                 | `setup.md`                      |

# Tripwires

Two rules that no doc lookup will save you from, because their trigger is not an
area of the code — it is a keystroke anywhere in the tree. Both are irreversible.

- **`internal/` must never appear in a file this repo tracks.** A private folder
  sits at the workspace root — gitignored here, backed by its own private repo.
  Nothing from it may cross into anything this repo tracks: no path, no filename,
  no quoted line, no number, no date — in docs, source comments, or commit
  messages. `tools/git-hooks/pre-commit` and `npm run check:private` only stop the
  _directory_ from being committed; a sentence copied out of it passes every
  check, and once pushed to a public repo it is unrecoverable (forks, caches,
  mirrors). **Reading it is fine and is now expected** — searches are unrestricted
  and `rg -u` reaches it — which makes this the load-bearing rule rather than a
  backstop: the folder's contents are in front of you, and the only thing between
  them and a public commit is not writing them down. The folder carries its own
  instructions; nothing about its contents belongs in this file.
- **No credential goes in the worktree, and `.gitignore` is not the reason it's
  safe.** Nothing guards the tree — no `permissions.deny`, no `PreToolUse` hook —
  because there is nothing there to guard, and that holds only as long as the next
  credential goes outside: `~/.gradle/gradle.properties` for the Play upload key,
  the login keychain plus `tools/scripts/deploy-worker.sh` for the Cloudflare API
  token and the R2 key pair, `wrangler secret` for anything a Worker needs, and
  the keychain plus `tools/scripts/run-api-dev.sh` for what the local api needs (the
  App Store key there is the production key — so no `.dev.vars`). A
  gitignored file inside the checkout is **not** a substitute: it is invisible to
  `git` and to a default `rg`, which is exactly what makes it feel safe, and fully
  visible to a backup, an editor index, a recursive grep and an AI agent. The four
  `BRACEMARK_UPLOAD_*` values sat in `apps/bracemark-expo/.env.local` and were
  copied into the generated `android/gradle.properties` on every prebuild for
  months on that reasoning, and nothing catches such a regression — no lint rule,
  no type error, no test, and the pre-commit hook is happy because the file is
  correctly ignored. What stays in the tree is identifiers only —
  `APPLE_TEAM_ID`, account ids, distribution ids — and "is this an identifier or a
  credential?" is the whole question. → `env-files.md`, _what's committed vs
  ignored_; `expo-build.md`, _android release signing_.
