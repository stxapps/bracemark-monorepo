// The origins and the browser binary every web e2e run needs, resolved once.
import { E2E_ORIGINS } from '../../runner/environment';
//
// These deliberately DUPLICATE the values in `apps/bracemark-web/.env.development`
// rather than importing or parsing them. E2e asserts on the running system from
// outside it; a spec that read the app's own config could not catch the app being
// pointed at the wrong origin, which is exactly the class of mistake the
// cross-origin sign-out spec exists to catch. The port map is contractual anyway
// (docs/env-files.md, "the local port map"): 3000 and 3001 are baked into five
// files, so hard-coding them here adds no new coupling.

// bracemark-web — the app under test.
export const WEB_URL = E2E_ORIGINS.web;

// bracemark-api — polled in global-setup, because `npm run dev` brings up Next on
// 3000 well before wrangler finishes booting local D1/R2, and an account created
// against a half-up api fails in a way that looks like a UI bug.
export const API_URL = E2E_ORIGINS.api;

// bracemark-extractor — the server-extraction origin, on 8788 (docs/env-files.md,
// _the local port map_), and brought up by `npm run dev` alongside the api and the
// web app. Two things need it: the marketing-screenshot capture (shot/), whose
// preflight asks THIS origin rather than curl because the two genuinely disagree —
// a zone behind Cloudflare answers a Worker where it 403s a shell — and the
// `internet` extraction cases (web/extraction.e2e.ts), which fetch example.com
// through it. Playwright's webServer does not start it; `npm run dev` does.
export const EXTRACTOR_URL = E2E_ORIGINS.extractor;

// bracemark-site — the marketing apex. Sign-out leaves the app for this origin via
// a cross-origin `location.replace`, so a spec that asserts on it needs the value
// but NOT a running server: asserting on the URL the browser navigated to is the
// point, and `npm run dev` deliberately excludes the site (docs/env-files.md).
export const SITE_URL = E2E_ORIGINS.site;

// The system Chrome. `@playwright/test` normally launches a browser it downloaded
// itself; no install here fetches one, so every launch has to be told where the
// installed one is. (A downloaded Chromium may nonetheless be present, and one
// two entrypoints here use it: `shot/extension.ts` and the `e2e-extension`
// target, since Chrome won't load an unpacked extension at all. They launch their
// own contexts and do not come through this constant — every WEB spec stays on
// system Chrome.) Chrome
// auto-updates, so expect the occasional protocol-assumption break on a new major
// — that is the standing cost of this choice, not a regression.
// See docs/e2e.md, "the browser this repo drives".
export const CHROME_PATH =
  process.env.E2E_CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
