import { waitForApi } from '../runner/lib';
import { assertOriginOwnedByRepo, assertPortFree } from '../runner/stack';
import { API_URL, WEB_URL } from '../web/fixtures/env';

// The api is the only server the PWA cases borrow; the web origin is theirs to
// start and stop, so its port has to be free rather than merely ours.
export default async function globalSetup(): Promise<void> {
  await assertOriginOwnedByRepo(API_URL, 'bracemark-api', { required: true });
  await waitForApi();
  await assertPortFree(WEB_URL, 'the PWA origin');
}
