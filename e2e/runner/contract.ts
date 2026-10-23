import { parseNativeCli } from './cli';
import { E2E_ENVIRONMENT } from './environment';
import { runMobileToWeb } from './mobile-to-web';
import { prepareNativeRun } from './native-run';
import { selectCasesForPlatform, validateCaseRegistry } from './registry';
import { runVectors } from './vectors';
import { runWebToMobile } from './web-to-mobile';

async function main(): Promise<void> {
  validateCaseRegistry();
  const options = parseNativeCli();
  // A round trip through the crypto never sees the window, so the contract runs
  // on the phone alone — and, with an iPad up beside it, takes the phone.
  if (options.width !== 'narrow') {
    throw new Error('the contract runs on a phone only (docs/e2e.md, _narrow and wide_)');
  }
  const selected = selectCasesForPlatform('contract', options.platform, {
    ...options,
    environment: E2E_ENVIRONMENT,
  });
  const run = await prepareNativeRun('contract', options, selected);

  try {
    for (const testCase of selected) {
      if (testCase.id === 'CONTRACT-VECTORS-001') await runVectors(run, testCase);
      else if (testCase.id === 'CONTRACT-WEB-MOBILE-001') await runWebToMobile(run, testCase);
      else if (testCase.id === 'CONTRACT-MOBILE-WEB-001') await runMobileToWeb(run, testCase);
      else throw new Error(`no contract runner owns ${testCase.id}`);
    }
    await run.finish('passed');
  } catch (error) {
    await run.finish('failed');
    throw error;
  }
}

await main();
