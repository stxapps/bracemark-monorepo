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
    // 24 base64url chars of CSPRNG. This has to clear BOTH gates in
    // `newPasswordSchema` and the strength meter behind it: 20 characters
    // minimum, and zxcvbn `guessesLog10 >= 18` (PASSWORD_MIN_GUESSES_LOG10).
    // zxcvbn models an unmatched password as 10^length, and a random string's
    // chance fragments of dictionary words pull that down by up to ~2.5. Measured
    // 2026-10-27 against the app's own scorer setup (common + en dictionaries,
    // adjacency graphs, the username as a user input), 20,000 samples per length:
    // at 20 chars 3 fell below 18 (worst 17.48); at 24 none did (worst 21.48).
    // So 24 — not shorter, and NOT something "readable", which zxcvbn would match.
    // Not longer either: Maestro types a character at a time (~0.16s each on
    // Android) and every native sign-in types this, so the 44 it used to be cost
    // ~3 minutes of a full Android run (docs/e2e.md, _driving the native apps_).
    password: randomBytes(18).toString('base64url'),
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
  await submitCreateAccount(page, credentials);

  // The welcome, skipped through: no recovery code (a legitimate product state, not a
  // test-only shortcut) and no check. WELCOME-* cases drive it for real.
  await page.getByRole('button', { name: 'Skip for now' }).click();
  await page.getByRole('button', { name: 'Skip', exact: true }).click();
  await page.getByRole('button', { name: 'Start using Bracemark' }).click();
  await expect(page).toHaveURL(/\/links/);
  await expect(page.getByRole('heading', { name: 'You’re all set' })).toHaveCount(0);
}

// The same, taking the welcome's recovery-code step, and returning the code it was
// handed. Only `mobile/flows/recovery-sign-in.yaml` needs this: the recovery door is
// the one credential a run CANNOT choose in advance — it is CSPRNG-minted by the
// client and never user-supplied by design ("we GENERATE it and never let users type
// their own", `packages/shared/src/crypto/recovery-code.ts`), so the show-once panel
// is the only place it exists in a form anything can capture. It is read off the
// `<output>` by its `aria-label`, so a restyle of the panel cannot silently start
// returning the wrong string.
//
// Returned in DISPLAY form, hyphens and all ("A1B2C-D3E4F-…"), which is what the user
// would have saved and what a flow should type back — `normalizeRecoveryCode` strips
// the grouping before it is ever key material.
export async function createAccountWithRecovery(
  page: Page,
  credentials: Credentials,
): Promise<string> {
  await submitCreateAccount(page, credentials);

  await page.getByRole('button', { name: 'Create recovery code' }).click();
  const shown = page.getByLabel('Your recovery code');
  // A door: an Argon2id open of the password door, then a write.
  await expect(shown).toBeVisible({ timeout: 60_000 });
  const code = (await shown.innerText()).trim();
  if (!code) throw new Error('the welcome showed an empty recovery code');
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await page.getByRole('button', { name: 'Skip', exact: true }).click();
  await page.getByRole('button', { name: 'Start using Bracemark' }).click();
  await expect(page).toHaveURL(/\/links/);
  return code;
}

// The one step of create-account, which creates the account and signs in. Leaves the
// page on the welcome's first step. The field starts on a generated passphrase, and
// editing it is choosing your own: we replace it, because a generated password would
// have to be scraped off the screen and kept for the mobile half of the contract run,
// and scraping a secret out of the DOM is a worse dependency than typing a known one.
export async function submitCreateAccount(page: Page, credentials: Credentials): Promise<void> {
  await page.goto('/create-account');
  await page.locator('#username').fill(credentials.username);
  await page.locator('#signup-new-password').fill(credentials.password);
  await page.getByRole('button', { name: 'Create account', exact: true }).click();
  // Argon2id runs here. The generous timeout is the derivation, not the network.
  await expect(page.getByRole('heading', { name: 'Your account is ready' })).toBeVisible({
    timeout: 60_000,
  });
}

// Sign in an already-created account. Used by the contract runner's reverse leg,
// where the account was made on the phone, and by the seed re-running against an
// account it made earlier. A wrong password throws at once, with the form's
// message.
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

  // Wait for EITHER outcome. A refusal leaves the page on /sign-in, so a bare
  // URL wait sat out its whole minute before failing as "expected /links", which
  // reads as a hang and says nothing about the cause. The cause is the form's
  // own root error (sign-in-form.tsx), so it fails the moment that renders.
  // The specimen: a seed account whose password had been changed by hand, with
  // the seed still typing the derived one (seed/accounts.ts).
  const refused = page
    .getByRole('alert')
    .filter({ hasText: /^(Incorrect username or password|Could not sign in)/ });
  await expect
    .poll(async () => ((await refused.isVisible()) ? 'refused' : page.url()), { timeout: 60_000 })
    .toMatch(/\/links|^refused$/);
  if (await refused.isVisible()) {
    throw new Error(`sign-in as ${credentials.username} refused: ${await refused.innerText()}`);
  }
}
