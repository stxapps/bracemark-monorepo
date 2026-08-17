# @stxapps/e2e

Whole-flow tests: a real build, a real browser or device, a whole flow.

**The design record is [`docs/e2e.md`](../docs/e2e.md)** — what belongs at this
layer, why the standard Playwright auth fixture cannot work in this app, and the
constraints that shape everything here. This file is the operational half; read
that one before changing anything.

## running

Everything needs the dev stack first:

```sh
npm run dev        # api :8787, web :3000, extractor :8788
```

`playwright test` boots and waits for it itself; the `runner/` scripts check and
tell you to start it.

```sh
npx nx e2e-web @stxapps/e2e         # the web suite, headless, 2 workers
npx nx e2e-web:headed @stxapps/e2e  # the same, watchable
npx nx e2e-web:report @stxapps/e2e  # open the last HTML report
npx nx e2e-mobile @stxapps/e2e      # provision an account, run mobile/flows
npx nx e2e-contract @stxapps/e2e    # web → mobile, then mobile → web
```

The three run-it targets also have root scripts: `npm run e2e:web`, `e2e:mobile`,
`e2e:contract`. There is no bare `npm run e2e` — see `docs/e2e.md`, _running_.

A single spec, from this directory: `npx playwright test web/links.e2e.ts`.

The mobile and contract targets also need a **bracemark-expo dev build installed
on a booted simulator or emulator**. Nothing here builds the app —
`npx nx ios @stxapps/bracemark-expo` (or `android`) does, and it is a
prerequisite, not an e2e step.

**Run one platform at a time.** `runner/lib.ts` passes Maestro no `--device`, so
with both an iOS simulator and an Android emulator booted it picks one
non-deterministically or hangs on an interactive picker. Boot one, run its legs,
shut it down, boot the other. Web e2e is platform-independent — run it once.

```sh
npm run expo:ios          # or: npm run expo:android
npm run expo:android:reverse   # Android only, once per emulator boot
npm run e2e:mobile && npm run e2e:contract
```

Both build commands hold the foreground running Metro, so the rest wants a second
terminal.

## layout

| path               | what                                                            |
| ------------------ | --------------------------------------------------------------- |
| `paths.ts`         | where a run writes — the only source of `.artifacts` paths      |
| `web/`             | Playwright specs (`*.e2e.ts`) and their fixtures                |
| `mobile/flows/`    | Maestro flows that run standalone                               |
| `mobile/contract/` | Maestro legs of a contract run — parameterised, never run alone |
| `runner/`          | orchestrators: mobile, web→mobile, mobile→web                   |
| `.artifacts/`      | gitignored — traces, reports, run manifests, browser profiles   |

## four things that will surprise you

1. **Never add a jest config here.** `@nx/jest/plugin` infers a `test` target from
   its presence, and this project would silently join `npm run test`.
2. **Tests in a worker share one account.** Namespace with `unique()`
   (`web/fixtures/data.ts`), never assert on a global count, never sign out (see
   `account.e2e.ts`).
3. **Assert on what the user typed, not what was extracted.** The extractor's SSRF
   guard makes a local fixture server unreachable by design, so specs use
   unresolvable `.invalid` URLs — `unresolvableUrl()`, same module.
4. **The `testID`s the flows bind to are an interface.** They live in
   bracemark-expo, and renaming one fails a flow as a bare timeout on a missing
   element — never as anything that names the rename. The list is in
   `docs/e2e.md`, _the testID contract_. What still blocks a native run is an
   installed dev build, not a selector.
