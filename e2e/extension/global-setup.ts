import { IS_STAGING } from '../runner/environment';
import { requireLocalStack, waitForApi } from '../runner/lib';
import { assertOriginOwnedByRepo } from '../runner/stack';
import { EXTRACTOR_URL } from '../web/fixtures/env';

// The browser-extension cases use the web app and the api, not the extractor.
// One that IS listening still has to be this checkout's. Staging has nothing
// local to prove and only waits for the deployed api.
export default async function globalSetup(): Promise<void> {
  if (IS_STAGING) {
    await waitForApi();
    return;
  }
  await requireLocalStack(['web', 'api']);
  await assertOriginOwnedByRepo(EXTRACTOR_URL, 'bracemark-extractor');
}
