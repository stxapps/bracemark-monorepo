import { unique, unresolvableUrl } from '../web/fixtures/data';
import { parseNativeCli } from './cli';
import { provisionAccount } from './lib';
import { prepareNativeRun } from './native-run';
import { selectCasesForPlatform, validateCaseRegistry } from './registry';

// Standalone native journeys. Platform and device are deliberately mandatory:
// a result that does not say which runtime it exercised is not a baseline.
async function main(): Promise<void> {
  validateCaseRegistry();
  const options = parseNativeCli();
  const selected = selectCasesForPlatform('native', options.platform, options);
  const run = await prepareNativeRun('mobile', options, selected);

  try {
    for (const testCase of selected) {
      // Every flow gets a fresh account. This makes destructive and ordering-
      // sensitive cases independent, and keeps a failed flow from poisoning the
      // state observed by the next one.
      const withRecovery = testCase.id === 'NATIVE-ACCOUNT-002';
      const account = await provisionAccount(`${run.runId}-${testCase.id}`, { withRecovery });
      if (withRecovery && !account.recoveryCode) {
        throw new Error(`${testCase.id}: provisioning returned no recovery code`);
      }

      const env: Record<string, string> = {
        USERNAME: account.username,
        PASSWORD: account.password,
      };
      if (account.recoveryCode) env.RECOVERY_CODE = account.recoveryCode;

      if (testCase.id === 'NATIVE-LINK-001') {
        env.LINK_URL = unresolvableUrl(`${run.runId}-first-on-device`);
        env.LINK_URL_2 = unresolvableUrl(`${run.runId}-second-on-device`);
      }
      if (testCase.id === 'LINK-EDITOR-002') {
        env.LINK_URL = unresolvableUrl(`${run.runId}-editor`);
        env.LIST_NAME = unique('E2E list');
        env.MOVED_LIST_NAME = unique('E2E moved list');
        env.KEPT_TAG = unique('e2e-kept');
        env.DROPPED_TAG = unique('e2e-dropped');
        env.ADDED_TAG = unique('e2e-added');
        env.NOTE = unique('E2E note');
        env.TITLE = unique('E2E title');
        env.EDITED_NOTE = unique('E2E edited note');
      }
      if (testCase.id === 'LINK-CLOSE-001') {
        env.ANCHOR_URL = unresolvableUrl(`${run.runId}-close-anchor`);
        env.DISCARDED_URL = unresolvableUrl(`${run.runId}-close-discarded`);
        env.DRAFT_NOTE = unique('E2E draft note');
      }
      if (testCase.id === 'LINK-LIFECYCLE-002') {
        env.LINK_URL = unresolvableUrl(`${run.runId}-lifecycle`);
        env.ANCHOR_URL = unresolvableUrl(`${run.runId}-trash-anchor`);
      }
      if (testCase.id === 'NATIVE-DATA-001') {
        env.LINK_URL = unresolvableUrl(`${run.runId}-delete-all`);
        env.LIST_NAME = unique(`${run.runId} delete list`);
        env.TAG_NAME = unique(`${run.runId} delete tag`);
      }

      await run.runCase(testCase, env, [account.password, account.recoveryCode ?? '']);
    }
    await run.finish('passed');
  } catch (error) {
    await run.finish('failed');
    throw error;
  }
}

await main();
