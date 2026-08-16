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

  // `withRecovery` because one flow in the directory signs in through the
  // recovery door. It costs one extra checkbox on the way through the ceremony,
  // and the resulting account behaves identically for every other flow — a
  // recovery door is additive, not a different kind of account (docs/account.md,
  // _the doors_).
  const account = await provisionAccount('mobile', { withRecovery: true });
  if (!account.recoveryCode) throw new Error('provisioning returned no recovery code');

  const manifest = await writeManifest('mobile-run', {
    username: account.username,
    password: account.password,
    recoveryCode: account.recoveryCode,
  });
  console.log(`wrote ${manifest}`);

  await maestro('mobile/flows', {
    env: {
      USERNAME: account.username,
      PASSWORD: account.password,
      RECOVERY_CODE: account.recoveryCode,
    },
  });
}

await main();
