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
  await fillCredentialSteps(page, credentials);

  // The recovery step's primary action stays disabled until its saved-it checkbox
  // is ticked, so the secondary is the one an unattended run takes. An account
  // with no recovery code is a legitimate product state, not a test-only shortcut.
  await page.getByRole('button', { name: /without a recovery code/i }).click();

  // Argon2id runs here. The generous timeout is the derivation, not the network.
  await expect(page).toHaveURL(/\/links/, { timeout: 60_000 });
}

// The same ceremony, taking the recovery-code exit, and returning the code it was
// handed. Only `mobile/flows/recovery-sign-in.yaml` needs this: the recovery door
// is the one credential a run CANNOT choose in advance — it is CSPRNG-minted by
// the client and never user-supplied by design ("we GENERATE it and never let
// users type their own", `packages/shared/src/crypto/recovery-code.ts`), so the
// show-once panel is the only place it exists in a form anything can capture.
//
// That makes this the deliberate exception to the rule stated above, not a
// contradiction of it: the password is scraped-vs-chosen and we choose, the
// recovery code has no chosen form to prefer. It is read off the `<output>` by
// its `aria-label` rather than by a class or a nth-child, so a restyle of the
// wallet panel cannot silently start returning the wrong string.
//
// Returned in DISPLAY form, hyphens and all ("A1B2C-D3E4F-…"), which is what the
// user would have saved and what a flow should type back — `normalizeRecoveryCode`
// strips the grouping before it is ever key material, so the round trip through
// the hyphenated form is part of what this exercises.
export async function createAccountWithRecovery(
  page: Page,
  credentials: Credentials,
): Promise<string> {
  await fillCredentialSteps(page, credentials);

  const code = (await page.getByLabel('Your recovery code').innerText()).trim();
  if (!code) throw new Error('create-account showed an empty recovery code');

  // `#recovery-saved` is the attestation checkbox that ungates the primary
  // action. The anchored name keeps this off "Create account without a recovery
  // code", which is the same button family one line apart.
  await page.locator('#recovery-saved').check();
  await page.getByRole('button', { name: /^create account$/i }).click();

  await expect(page).toHaveURL(/\/links/, { timeout: 60_000 });
  return code;
}

// Steps 1 and 2 of the ceremony — username, password, confirm — which both exits
// share. Leaves the page on step 3, the recovery panel. Nothing has reached the
// server's accounts when it returns: the account is made by whichever exit is
// pressed next, which is what lets shot/ photograph step 3 and walk away.
export async function fillCredentialSteps(page: Page, credentials: Credentials): Promise<void> {
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
}

// Sign in an already-created account. Used by the contract runner's reverse leg,
// where the account was made on the phone, and by the seed re-running against an
// account it made earlier.
//
// Targeted by id, like the create-account steps above, and NOT by label: the
// password field ships a "Show password" toggle inside its wrapper
// (web-ui password-input.tsx), so `getByLabel(/password/i)` matches the input AND
// the toggle button and fails strict mode. The ids are the form's own
// (`sign-in-form.tsx`), and stable for the same reason `#signup-new-password` is.
export async function signIn(page: Page, credentials: Credentials): Promise<void> {
  await page.goto('/sign-in');
  await page.locator('#username').fill(credentials.username);
  await page.locator('#password').fill(credentials.password);
  await page.getByRole('button', { name: /sign in/i }).click();
  await expect(page).toHaveURL(/\/links/, { timeout: 60_000 });
}
