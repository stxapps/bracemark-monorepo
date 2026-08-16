// The origins and the browser binary every web e2e run needs, resolved once.
//
// These deliberately DUPLICATE the values in `apps/bracemark-web/.env.development`
// rather than importing or parsing them. E2e asserts on the running system from
// outside it; a spec that read the app's own config could not catch the app being
// pointed at the wrong origin, which is exactly the class of mistake the
// cross-origin sign-out spec exists to catch. The port map is contractual anyway
// (docs/env-files.md, "the local port map"): 3000 and 3001 are baked into five
// files, so hard-coding them here adds no new coupling.

// bracemark-web — the app under test.
export const WEB_URL = process.env.E2E_WEB_URL ?? 'http://localhost:3000';

// bracemark-api — polled in global-setup, because `npm run dev` brings up Next on
// 3000 well before wrangler finishes booting local D1/R2, and an account created
// against a half-up api fails in a way that looks like a UI bug.
export const API_URL = process.env.E2E_API_URL ?? 'http://localhost:8787';

// bracemark-site — the marketing apex. Sign-out leaves the app for this origin via
// a cross-origin `location.replace`, so a spec that asserts on it needs the value
// but NOT a running server: asserting on the URL the browser navigated to is the
// point, and `npm run dev` deliberately excludes the site (docs/env-files.md).
export const SITE_URL = process.env.E2E_SITE_URL ?? 'http://localhost:3001';

// The system Chrome. `@playwright/test` normally launches a browser it downloaded
// itself; this repo never runs `npx playwright install`, so there is no such
// browser and every launch has to be told where the installed one is. Chrome
// auto-updates, so expect the occasional protocol-assumption break on a new major
// — that is the standing cost of this choice, not a regression.
// See docs/e2e.md, "the browser this repo drives".
export const CHROME_PATH =
  process.env.E2E_CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
