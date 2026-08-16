import { profileDir } from '../paths';
import { unresolvableUrl } from '../web/fixtures/data';
import { launchApp } from '../web/fixtures/launch';
import { addLink, displayUrl } from '../web/fixtures/links';
import { syncAndWait } from '../web/fixtures/sync';
import { maestro, waitForApi, writeManifest } from './lib';

// THE contract run, web → mobile. Create an account and write links in a real
// browser, then sign into the same account on a real device and read them back.
//
// Why this exists, when web-crypto and expo-crypto each already have a
// contract-vectors spec: those prove both implementations agree with a frozen
// table of vectors. They cannot prove the round trip — real Argon2id in a browser,
// through the real api, into a real R2 blob, back out through react-native-
// quick-crypto on a device. ARGON2_PARAMS and the encrypted-blob framing are
// explicitly frozen cross-platform contracts (packages/shared/src/crypto/params.ts),
// and drift in either is silent until a user with two devices finds it.
//
// Prerequisites: `npm run dev`, and a bracemark-expo dev build already installed on
// a booted simulator/emulator. This does not build the app — see e2e/README.md.
//
// On Android, run `adb reverse tcp:8787 tcp:8787` first: both .env.development
// files point at `http://localhost:8787` and EXPO_PUBLIC_* is inlined by Metro at
// bundle time, so the emulator has to be taught that localhost means the host,
// rather than the env being forked per platform (docs/env-files.md).
async function main(): Promise<void> {
  await waitForApi();

  const first = unresolvableUrl('written-on-web-one');
  const second = unresolvableUrl('written-on-web-two');
  const links = [first, second];

  const app = await launchApp(profileDir('contract-web-to-mobile'));
  try {
    const { page } = app;
    await page.goto('/links');
    for (const url of links) await addLink(page, url);
    // The phone reads R2, not this browser's Dexie. Without this the flow below
    // signs in to an account whose blob hasn't been uploaded yet and fails on a
    // race rather than on a contract break.
    await syncAndWait(page);
  } finally {
    await app.close();
  }

  const manifest = await writeManifest('contract-web-to-mobile', {
    direction: 'web → mobile',
    username: app.credentials.username,
    password: app.credentials.password,
    links,
  });
  console.log(`wrote ${manifest}`);

  await maestro('mobile/contract/verify-links.yaml', {
    env: {
      USERNAME: app.credentials.username,
      PASSWORD: app.credentials.password,
      LINK_1: displayUrl(first),
      LINK_2: displayUrl(second),
    },
  });

  console.log('contract web → mobile: OK');
}

await main();
