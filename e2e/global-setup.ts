import { IS_STAGING } from './runner/environment';
import { requireLocalStack, waitForApi } from './runner/lib';

// No config starts the stack — `npm run dev` does (docs/e2e.md, _running it_).
// This proves all three legs are this checkout's and answering before a worker
// creates an account; staging has nothing local to prove and only waits.
//
// This is the only reason global setup exists. Per-worker state belongs in
// web/fixtures/app.ts, where it is scoped and torn down.
export default async function globalSetup(): Promise<void> {
  if (IS_STAGING) {
    await waitForApi();
    return;
  }
  await requireLocalStack(['web', 'api', 'extractor']);
}
