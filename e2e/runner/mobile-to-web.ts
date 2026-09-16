import { expect } from '@playwright/test';

import { profileDir } from '../paths';
import { unresolvableUrl } from '../web/fixtures/data';
import { launchApp } from '../web/fixtures/launch';
import { displayUrl } from '../web/fixtures/links';
import { provisionAccount } from './lib';
import { type NativeRun } from './native-run';
import { type E2ECase } from './registry';

// THE contract run, mobile → web. The mirror of web-to-mobile.ts, and not
// redundant with it: the two directions exercise opposite halves of the crypto
// boundary. web→mobile proves expo-crypto can DECRYPT what web-crypto sealed;
// this proves web-crypto can decrypt what expo-crypto sealed. A packing bug on
// one side only shows up in one of the two.
//
// The account is still created in the browser — the phone signs into it. That is
// not a shortcut around native key derivation: signing in on the device runs the
// full Argon2id + HKDF path there, which is the thing under test. What it avoids
// is maintaining a second create-account flow for no extra coverage.
//
// Same prerequisites as web-to-mobile.ts; see e2e/README.md.
export async function runMobileToWeb(run: NativeRun, testCase: E2ECase): Promise<void> {
  const credentials = await provisionAccount('contract-mobile-to-web');
  const url = unresolvableUrl(`${run.runId}-written-on-device`);

  await run.runCase(
    testCase,
    {
      USERNAME: credentials.username,
      PASSWORD: credentials.password,
      LINK_URL: url,
    },
    [credentials.password],
  );

  const app = await launchApp(profileDir('contract-mobile-to-web-verify'), {
    existing: credentials,
  });
  try {
    const { page } = app;
    await page.goto('/links');
    // Sign-in pulls and decrypts the remote blob; the initial sync lands a beat
    // after the redirect, so this assertion is what waits for it.
    await expect(page.getByText(displayUrl(url))).toBeVisible({ timeout: 60_000 });
  } finally {
    await app.close();
  }

  console.log('contract mobile → web: OK');
}
