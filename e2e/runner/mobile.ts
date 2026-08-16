import { maestro, provisionAccount, waitForApi, writeManifest } from './lib';

// `npm run e2e-mobile` — the standalone native flows, which need an account
// before they can do anything.
//
// Maestro cannot create one: every flow here starts signed in, and a
// create-account flow would be a second copy of a form jest already covers. So
// this provisions a throwaway account through the browser (see provisionAccount)
// and hands the credentials to `maestro test` as `-e` parameters.
//
// Prerequisites: `npm run dev`, plus a bracemark-expo dev build on a booted
// simulator or emulator. On Android, `adb reverse tcp:8787 tcp:8787` first.
// See e2e/README.md.
async function main(): Promise<void> {
  await waitForApi();

  const credentials = await provisionAccount('mobile');
  const manifest = await writeManifest('mobile-run', {
    username: credentials.username,
    password: credentials.password,
  });
  console.log(`wrote ${manifest}`);

  await maestro('mobile/flows', {
    env: { USERNAME: credentials.username, PASSWORD: credentials.password },
  });
}

await main();
