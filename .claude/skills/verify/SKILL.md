---
name: verify
description: How to build, launch, and drive this repo's apps to verify a change end-to-end (bracemark-web GUI via headless Chromium).
---

# Verifying changes in this repo

## Launch

- `npm run dev` (background) starts bracemark-web on :3000, bracemark-api (wrangler,
  local D1/R2 emulation) on :8787, and bracemark-extractor. Wait for
  `curl -s -o /dev/null -w '%{http_code}' http://localhost:3000/` → 200 (~15s).
- Local state lives under `apps/bracemark-api/.wrangler/`; creating a throwaway
  account per run is cheap and avoids depending on existing state.

## Drive bracemark-web (GUI surface)

- No Playwright in the workspace, and **don't count on the `~/Library/Caches/ms-playwright/`
  browser cache** — it has been empty (no download ever runs; nothing in the repo
  installs it). Drive the system Chrome instead, which is present:

  ```js
  // in a scratch dir, after `npm i playwright-core`
  import { chromium } from 'playwright-core';
  const browser = await chromium.launch({
    executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  });
  ```

  Headless is the default, and `deviceScaleFactor: 2` on the context makes
  screenshots legible at this repo's type sizes. `/Applications/Chromium.app/Contents/MacOS/Chromium`
  works the same way if Chrome is gone. Only fall back to the ms-playwright cache
  if it's actually populated.

- Flows that worked headless: create account at `/create-account`
  (Username/Password labels, button /create/i — Argon2 makes this take a few
  seconds; wait for URL /links/), add links via the topbar `Add` popover
  (label `URL`, button `Save`), manage lists at `/settings/lists` (create field
  label `New list name`, Enter commits; rows are inputs — match
  `input[aria-label="List name"][value="<name>"]`, per-row kebab label
  `List actions`), sidebar rows are buttons named by list name.
- `playwright-core` has no Testing Library helpers (`getByDisplayValue` doesn't
  exist) — use attribute selectors for the uncontrolled inputs.
- Layouts render a link's title, falling back to the URL with a leading
  `https://` stripped (host + path, via `displayUrl`) when there's no title;
  the host also shows on a secondary line/column. So untitled links ARE
  distinguishable by path — asserting on distinct paths (or distinct hosts)
  both work.

## Gotchas

- Nx TUI is disabled on purpose (breaks wrangler dev under run-many) — keep
  `--output-style=stream` output; don't re-enable.
- Sign-out now leaves the app for the marketing site's landing page
  (`NEXT_PUBLIC_SITE_URL`, so `localhost:3001` in dev) — a cross-origin
  `location.replace`, not a route change, so don't wait for a bracemark-web URL
  after it and expect the site dev server to be up. Sign-in is `/sign-in`. After
  sign-in, give the initial sync ~2s before asserting on content.
- Creating an account headless: fill `#username`, press "Choose my own" (the
  generated-password step gates Continue behind a saved-it checkbox), fill
  `#password`, Continue, fill `#confirm`, Continue, then "Create account without
  a recovery code" on the recovery step (the primary there is disabled until the
  saved-it checkbox is ticked). Argon2 makes the submit take a few seconds.
