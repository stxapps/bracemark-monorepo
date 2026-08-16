import { randomBytes } from 'node:crypto';

import { expect, type Page } from '@playwright/test';

export interface Credentials {
  username: string;
  password: string;
}

// A throwaway account per worker. Local api state lives in
// `apps/bracemark-api/.wrangler/`, and creating a fresh account per run is
// cheaper and far less brittle than resetting that directory — it also means two
// runs (or two workers) never contend for the same rows.
//
// The username charset is `usernameSchema`'s: 3–32 of [a-zA-Z0-9_], and no
// RESERVED_USERNAMES entry ("e2e" is not one, and the random tail makes a
// collision with a real handle unrealistic).
export function newCredentials(): Credentials {
  return {
    username: `e2e_${randomBytes(6).toString('hex')}`,
    // 44 base64url chars of CSPRNG. This has to clear BOTH gates in
    // `newPasswordSchema` and the strength meter behind it: 20 characters
    // minimum, and zxcvbn `guessesLog10 >= 18` (PASSWORD_MIN_GUESSES_LOG10).
    // zxcvbn models an unmatched password as 10^length, so length alone carries
    // this well past the floor — do NOT shorten it to something "readable".
    password: randomBytes(33).toString('base64url'),
  };
}

// Drive the real create-account flow. This is the ONLY way an e2e run gets an
// account: there is no seeding shortcut, and there should not be one. Every
// alternative (calling the api directly, planting a session) would have to
// re-implement the client's key derivation, which is precisely the thing most
// worth exercising for real.
//
// The cost is real — Argon2id at 64 MiB / t=3 takes seconds in-browser — which is
// why the fixture in app.ts pays it once per worker rather than once per test.
// Do not "optimise" it by weakening ARGON2_PARAMS: those are a frozen
// cross-platform contract (packages/shared/src/crypto/params.ts), and a run that
// derived with different numbers would stop testing derivation at all.
//
// The step sequence mirrors `.claude/skills/verify/SKILL.md`. If the flow is
// reshaped, that skill and this helper move together.
export async function createAccount(page: Page, credentials: Credentials): Promise<void> {
  await page.goto('/create-account');

  await page.locator('#username').fill(credentials.username);

  // The default path hands the user a generated passphrase and gates Continue
  // behind a saved-it checkbox. We take the escape hatch instead: a generated
  // password would have to be scraped off the screen and kept for the mobile
  // half of the contract run, and scraping a secret out of the DOM is a worse
  // dependency than typing a known one in.
  await page.getByRole('button', { name: /choose my own/i }).click();

  await page.locator('#signup-new-password').fill(credentials.password);
  await page.getByRole('button', { name: /continue/i }).click();

  await page.locator('#confirm').fill(credentials.password);
  await page.getByRole('button', { name: /continue/i }).click();

  // The recovery step's primary action stays disabled until its saved-it checkbox
  // is ticked, so the secondary is the one an unattended run takes. An account
  // with no recovery code is a legitimate product state, not a test-only shortcut.
  await page.getByRole('button', { name: /without a recovery code/i }).click();

  // Argon2id runs here. The generous timeout is the derivation, not the network.
  await expect(page).toHaveURL(/\/links/, { timeout: 60_000 });
}

// Sign in an already-created account. Used by the contract runner's reverse leg,
// where the account was made on the phone.
export async function signIn(page: Page, credentials: Credentials): Promise<void> {
  await page.goto('/sign-in');
  await page.getByLabel(/username/i).fill(credentials.username);
  await page.getByLabel(/password/i).fill(credentials.password);
  await page.getByRole('button', { name: /sign in/i }).click();
  await expect(page).toHaveURL(/\/links/, { timeout: 60_000 });
}
