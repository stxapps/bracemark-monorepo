import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { expect } from '@playwright/test';

import { profileDir, SEED_CREDENTIALS } from '../paths';
import { requireLocalEnvironment } from '../runner/environment';
import { waitForApi } from '../runner/lib';
import { WEB_URL } from '../web/fixtures/env';
import { launchApp } from '../web/fixtures/launch';
import { SEED_USERS, seedPassword, type SeedUser, seedUser } from './catalog';
import { generateArchives } from './fixtures';
import { findUserId, grantPlan, readGrantedPlan } from './plan';
import { importArchive, waitForSync } from './steps';

// The account seed — four dev accounts, filled, on the local stack.
//
// It is `init`/`prepare` for a session of looking at the app by hand, and it does
// exactly what you would do yourself, in the order you would do it: create the
// account through the real create-account form, grant the plan, import a backup
// through Settings → Data, wait for it to reach the server, write down the
// password. Nothing here reaches behind the app.
//
// That last point is the design, not modesty. Links, lists and tags are E2E
// encrypted — the api stores AES-GCM blobs it cannot read — so there is no
// database to seed them into and no shortcut to take: the only writer that can
// produce them is a signed-in client holding the account's key. The plan is the
// one exception, and it is an exception because it is genuinely server state
// (see seed/plan.ts). Read docs/e2e.md, _seeding a dev account_, before changing
// the shape of this.
//
//   npm run seed:accounts              # all four
//   npm run seed:accounts -- free-full # just one
//   npm run seed:fixtures              # the archives only, no browser

const ACCOUNTS_PATH = join(SEED_CREDENTIALS, 'accounts.json');

interface SeededAccount {
  key: string;
  username: string;
  password: string;
  plan: string;
  links: number;
  lists: number;
  tags: number;
  seededAt: string;
  webUrl: string;
}

async function main(): Promise<void> {
  // Local only, and not for want of a way in: a plan CAN be granted on staging
  // (seed/plan.ts), but these accounts must not exist there. `seedPassword` is a
  // hash of the account's key, in a public repo — on a laptop that is a
  // convenience, on a publicly reachable host it is a paid account anyone can
  // sign in to. Staging journeys grant a plan to their own disposable account
  // instead (e2e/STAGING.md).
  requireLocalEnvironment('the account seed');

  const selected = process.argv.slice(2).filter((arg) => !arg.startsWith('-'));
  const users = selected.length > 0 ? selected.map(seedUser) : SEED_USERS;

  await waitForApi();

  // Regenerate every time. The archives are derived from seed/library.ts and cost
  // seconds, so a stale one on disk is a trap with no upside.
  console.log('generating archives…');
  const archives = new Map(
    (await generateArchives(users)).map((archive) => [archive.user.key, archive.path]),
  );

  for (const user of users) {
    console.log(`\n— ${user.key} (${user.username}, ${user.plan}) —`);
    const account = await seedOne(user, archives.get(user.key));
    await recordAccount(account);
  }

  console.log(`\nCredentials: ${ACCOUNTS_PATH}`);
  console.log(`Sign in at ${WEB_URL}/sign-in`);
}

async function seedOne(user: SeedUser, archivePath: string | undefined): Promise<SeededAccount> {
  // Re-running the seed must be safe, and it is safe in two different ways: the
  // account is signed into rather than re-created, and a Bracemark backup merges
  // SKIP-EXISTING BY PATH (docs/data-lifecycle.md), so re-importing the same
  // archive touches nothing already there. A re-seed therefore repairs a run that
  // died halfway instead of duplicating it.
  const existingId = await findUserId(user.username);
  console.log(existingId ? 'account exists — signing in' : 'creating account (Argon2id, ~seconds)');

  // An existing account signs in with the password accounts.json holds for it,
  // not the derived one. The derived password is only what the account was
  // CREATED with. Change it by hand in Settings → Account and write the new one
  // down, and a re-seed typing the derived one is refused. A fresh account always gets the derived
  // password, so a record left over from a reset api state cannot leak in.
  const recorded = existingId
    ? (await readAccounts()).find((a) => a.key === user.key && a.username === user.username)
    : undefined;
  const credentials = {
    username: user.username,
    password: recorded?.password ?? seedPassword(user.key),
  };

  const app = await launchApp(profileDir(`seed-${user.key}`), {
    ...(existingId ? { existing: credentials } : { create: credentials }),
  });

  try {
    const { page } = app;

    if (user.plan !== 'free') {
      // AFTER the account exists (the user id is minted by create-account) and
      // BEFORE the import: a Bracemark backup over the plan's link cap is refused
      // whole, so a 1,000-link library imported on the free tier fails outright
      // rather than truncating.
      const userId = existingId ?? (await findUserId(user.username));
      if (!userId) throw new Error(`no user id for ${user.username} after create-account`);
      await grantPlan(userId, user.plan);
      const granted = await readGrantedPlan(userId);
      if (granted !== user.plan) {
        throw new Error(`plan grant did not land: purchases row reads ${granted ?? 'nothing'}`);
      }
      // The client caches the folded status in localStorage and re-queries on
      // mount, so a reload is what turns the row into entitlements.
      console.log(`granted ${user.plan} — reloading for the entitlement`);
      await page.reload();

      // Confirm the grant reached the CLIENT, not just the database. "Never
      // expires." is the Subscription section's line for a paid plan with a null
      // expiry — which is exactly and only a manual/lifetime grant — so seeing it
      // proves the whole path: row → `foldSubscriptionStatus` → `GET
      // /v1/iap/status` → entitlements. Worth its two seconds on the empty
      // accounts especially: the full ones prove it a second time by importing a
      // library the free cap would refuse, and an unverified plan there would
      // simply be a free account wearing the wrong name.
      await page.goto('/settings/subscription');
      await expect(page.getByText('Never expires.')).toBeVisible();
    }

    if (archivePath) {
      await importArchive(page, archivePath);
      await waitForSync(page);
    }

    return {
      key: user.key,
      username: user.username,
      password: credentials.password,
      plan: user.plan,
      links: user.links,
      lists: user.lists,
      tags: user.tags,
      seededAt: new Date().toISOString(),
      webUrl: WEB_URL,
    };
  } finally {
    // Takes the browser profile with it — the session in there belongs to an
    // account whose password is now written down, and a live session on disk is
    // the thing paths.ts exists to keep out of `git status`.
    await app.close();
  }
}

// One file, rewritten after each account, so a run that dies on the fourth still
// leaves working credentials for the first three.
async function recordAccount(account: SeededAccount): Promise<void> {
  await mkdir(SEED_CREDENTIALS, { recursive: true });
  const accounts = await readAccounts();
  const next = [...accounts.filter((a) => a.key !== account.key), account].sort((a, b) =>
    a.key < b.key ? -1 : 1,
  );
  await writeFile(ACCOUNTS_PATH, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
}

async function readAccounts(): Promise<SeededAccount[]> {
  try {
    return JSON.parse(await readFile(ACCOUNTS_PATH, 'utf8')) as SeededAccount[];
  } catch {
    // No file yet, or one left unreadable by an interrupted write — either way
    // nothing in it can be trusted: sign-in falls back to the derived password,
    // and the account about to be recorded is the current truth.
    return [];
  }
}

// Guarded on being the entry module, exactly as seed/fixtures.ts is. Nothing
// imports this file today — the steps the shot run shares with it live in
// `seed/steps.ts` precisely so that nothing has to — and the guard stays as the
// backstop for the day something does: an unguarded top-level `await main()` runs
// on IMPORT, and this one re-seeds four accounts, idempotently and silently, for
// ten minutes. `seed/steps.ts` carries the specimen.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
