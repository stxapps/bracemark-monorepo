import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { expect, type Page } from '@playwright/test';

import { profileDir, SEED_CREDENTIALS } from '../paths';
import { waitForApi } from '../runner/lib';
import { WEB_URL } from '../web/fixtures/env';
import { launchApp } from '../web/fixtures/launch';
import { SEED_USERS, seedPassword, type SeedUser, seedUser } from './catalog';
import { generateArchives } from './generate';
import { findUserId, grantPlan, readGrantedPlan } from './plan';

// The seed — four dev accounts, filled, on the local stack.
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
//   npm run seed                       # all four
//   npm run seed -- free-full          # just one
//   npm run seed:fixtures              # the archives only, no browser

// A thousand links is ~2,000 metadata blobs plus preview images, all of which
// must land in local R2 before the account is worth handing over — the browser
// profile this runs in is deleted at the end, so anything still sitting in Dexie
// is lost. These are wall-clock budgets for that, not correctness knobs.
const IMPORT_TIMEOUT_MS = 15 * 60 * 1000;
const SYNC_TIMEOUT_MS = 30 * 60 * 1000;

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

  console.log(`\nCredentials: ${join(SEED_CREDENTIALS, 'accounts.json')}`);
  console.log(`Sign in at ${WEB_URL}/sign-in`);
}

async function seedOne(user: SeedUser, archivePath: string | undefined): Promise<SeededAccount> {
  const credentials = { username: user.username, password: seedPassword(user.key) };

  // Re-running the seed must be safe, and it is safe in two different ways: the
  // account is signed into rather than re-created, and a Bracemark backup merges
  // SKIP-EXISTING BY PATH (docs/data-lifecycle.md), so re-importing the same
  // archive touches nothing already there. A re-seed therefore repairs a run that
  // died halfway instead of duplicating it.
  const existingId = await findUserId(user.username);
  console.log(existingId ? 'account exists — signing in' : 'creating account (Argon2id, ~seconds)');

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

// Import through Settings → Data, the same three clicks a person makes. The file
// input is hidden behind a "Choose a file" button; `setInputFiles` drives it
// directly, which is the one place this is allowed to reach past the UI — a real
// OS file picker cannot be driven at all.
async function importArchive(page: Page, archivePath: string): Promise<void> {
  console.log(`importing ${archivePath}`);
  await page.goto('/settings/data');
  await page.getByRole('button', { name: /^Import data/ }).click();
  await page.locator('input[type=file]').setInputFiles(archivePath);

  const receipt = page.getByText(/^Imported \d+ link/);
  const failure = page.getByText(/^Import failed:/);
  await expect(receipt.or(failure)).toBeVisible({ timeout: IMPORT_TIMEOUT_MS });
  if (await failure.isVisible()) throw new Error(await failure.innerText());

  console.log((await receipt.innerText()).trim());
}

// Wait for the pending-ops queue to drain to the api.
//
// This is the step it would be easy to skip and fatal to: an import lands in
// Dexie first and pushes in the background, and this profile is deleted when the
// run ends. Close early and the account is real, the plan is granted, and the
// library exists nowhere — signing in on another browser shows an empty account
// with no error to explain it.
//
// The signal is the Data section's own sync row: "N changes waiting to sync"
// while the queue is non-empty, "Last synced …" once a cycle has settled. Reading
// the UI rather than polling the api keeps this honest — it is the same thing a
// person watches — and the Sync now button is the same nudge they would press.
//
// The settled reading has to hold for THREE consecutive polls, and that is the
// part not to simplify away. Both halves can lie for one frame just after the
// navigation below: "Last synced" can still be showing the timestamp of the
// refresh the import itself ran before writing anything, and the pending count is
// a liveQuery that reads 0 until its first result lands. Either alone would let
// this return while the queue is full, which is precisely the failure this
// function exists to prevent — and it would look like a clean run.
const SETTLED_POLLS = 3;

async function waitForSync(page: Page): Promise<void> {
  await page.goto('/settings/data');

  const pending = page.getByText(/\d+ changes? waiting to sync/);
  const synced = page.getByText(/^Last synced/);
  const syncNow = page.getByRole('button', { name: 'Sync now' });

  const deadline = Date.now() + SYNC_TIMEOUT_MS;
  let settled = 0;
  let lastReport = '';
  while (Date.now() < deadline) {
    if ((await synced.isVisible()) && !(await pending.isVisible())) {
      if (++settled >= SETTLED_POLLS) {
        console.log('synced');
        return;
      }
    } else {
      settled = 0;
      if (await pending.isVisible()) {
        const report = (await pending.innerText()).trim();
        if (report !== lastReport) {
          console.log(report);
          lastReport = report;
        }
      }
      // Only offered at rest, so this nudges a queue that has stopped moving and
      // is a no-op mid-cycle. `requestSync` coalesces, so repeating it is safe.
      if (await syncNow.isVisible()) await syncNow.click();
    }
    await page.waitForTimeout(2000);
  }
  throw new Error(
    `sync did not settle within ${SYNC_TIMEOUT_MS / 60_000} minutes — the library may be ` +
      `only partly on the server. Sign in as this user and let it finish, or re-run the seed.`,
  );
}

// One file, rewritten after each account, so a run that dies on the fourth still
// leaves working credentials for the first three.
async function recordAccount(account: SeededAccount): Promise<void> {
  await mkdir(SEED_CREDENTIALS, { recursive: true });
  const path = join(SEED_CREDENTIALS, 'accounts.json');

  let accounts: SeededAccount[] = [];
  try {
    accounts = JSON.parse(await readFile(path, 'utf8')) as SeededAccount[];
  } catch {
    // No file yet, or one left unreadable by an interrupted write — either way
    // the accounts we are about to write are the current truth.
  }

  const next = [...accounts.filter((a) => a.key !== account.key), account].sort((a, b) =>
    a.key < b.key ? -1 : 1,
  );
  await writeFile(path, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
}

await main();
