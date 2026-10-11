import { IS_STAGING } from './runner/environment';
import { waitForApi } from './runner/lib';
import { assertStackOwnedByRepo } from './runner/stack';
import { API_URL, EXTRACTOR_URL, WEB_URL } from './web/fixtures/env';

// `webServer` in playwright.config.ts waits for bracemark-web on :3000, but
// `npm run dev` is a three-project `nx run-many` and Next is reliably first up.
// wrangler needs several more seconds to boot local D1/R2, and an account created
// in that window fails at the auth call — which surfaces as a red error line in
// the UI and reads exactly like a broken form.
//
// This is the only reason global setup exists. Per-worker state belongs in
// web/fixtures/app.ts, where it is scoped and torn down.
export default async function globalSetup(): Promise<void> {
  await waitForApi();
  if (IS_STAGING) return;
  await assertStackOwnedByRepo([
    { origin: WEB_URL, label: 'bracemark-web', required: true },
    { origin: API_URL, label: 'bracemark-api', required: true },
    // Not required: the browser-extension config shares this setup and starts
    // no extractor. One that IS listening still has to be this checkout's.
    { origin: EXTRACTOR_URL, label: 'bracemark-extractor' },
  ]);
}
