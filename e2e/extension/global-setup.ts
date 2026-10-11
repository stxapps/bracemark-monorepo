import { requireLocalStack } from '../runner/lib';
import { assertOriginOwnedByRepo } from '../runner/stack';
import { EXTRACTOR_URL } from '../web/fixtures/env';

// The browser-extension cases use the web app and the api, not the extractor.
// One that IS listening still has to be this checkout's.
export default async function globalSetup(): Promise<void> {
  await requireLocalStack(['web', 'api']);
  await assertOriginOwnedByRepo(EXTRACTOR_URL, 'bracemark-extractor');
}
