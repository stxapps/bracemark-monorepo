import { parseNativeCli } from './cli';
import { runMobileToWeb } from './mobile-to-web';
import { prepareNativeRun } from './native-run';
import { selectCasesForPlatform, validateCaseRegistry } from './registry';
import { runVectors } from './vectors';
import { runWebToMobile } from './web-to-mobile';

async function main(): Promise<void> {
  validateCaseRegistry();
  const options = parseNativeCli();
  const selected = selectCasesForPlatform('contract', options.platform, options);
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
