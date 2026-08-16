import { waitForApi } from './runner/lib';

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
}
