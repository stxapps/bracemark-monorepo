import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { expect, type Page } from '@playwright/test';

import { MEASURE_OUTPUT, profileDir } from '../paths';
import { createRunId, waitForApi } from '../runner/lib';
import { capture } from '../runner/process';
import { assertOriginOwnedByRepo } from '../runner/stack';
import { newCredentials } from '../web/fixtures/account';
import { unique } from '../web/fixtures/data';
import { API_URL, CHROME_PATH, WEB_URL } from '../web/fixtures/env';
import { launchApp, type LaunchedApp } from '../web/fixtures/launch';
import { openSidebarItem } from '../web/fixtures/links';
import { grantPlusAndLoad } from '../web/fixtures/plan';
import { createInSettings, lockListInSettings } from '../web/fixtures/taxonomy';

// What Chrome's password manager makes of each form that takes the account's
// password — which field it reads as the current password, which as the new one,
// and whether it offers to save — and that it offers nothing for a LOCK password,
// which is a secret but not this site's login. Read off
// chrome://password-manager-internals, which logs exactly that while a tab has
// it open.
//
//   npm run dev                                   # the api and the web app
//   npm run measure:password-manager
//   npm run measure:password-manager -- --flow change-generated,create-account
//   npm run measure:password-manager -- --headed
//
// WHY IT EXISTS: the save prompt is browser chrome, outside the page, so no spec
// can see it, and every way of getting it wrong is silent — the field a manager
// saves from is invisible, or missing, and every flow passes regardless. The
// specimen: change password's generated passphrase lived only in an <output>, so
// the form's one password field was the CURRENT one and Chrome offered to save
// the old password (docs/accessibility.md, _what a field tells the browser_).
// WEB-ACCOUNT-006 pins the input that fixed it; this is what showed Chrome reads
// that input, and what to re-run when a form that takes a password changes shape.
// The second specimen is the other direction: the lock surfaces were `off`, which
// Chrome ignores on a password field, so setting a lock or unlocking one had it
// offer to replace the saved sign-in password with the lock's. They now say
// `one-time-code`, and the lock flows expect no submission at all.
//
// NOT A TEST, and in no suite. The internals page is a debugging surface whose
// text is not a contract, read from the system Chrome, which auto-updates — a
// suite gated on its wording would go red on a Chrome release with nothing wrong
// in the app. So a flow whose log no longer parses prints `?`, not a failure of
// the product, and the raw log is written beside the results to read by eye.
//
// ITS LIMITS. The log names FIELDS, never values, so "the prompt carries the new
// password" is inferred from which field Chrome took as the new one. And every
// flow runs in a fresh profile with no saved login, so Chrome's offer is always
// to SAVE — what it does against a login it already holds (update, or nothing
// for an unchanged one) is outside this, and so is the prompt Chrome stops
// showing on its own after it has been dismissed for a site a few times. A real
// profile is the check for those.

interface Submission {
  // The fields Chrome's last parse before the submission chose, by id — `''` for
  // a role it filled with nothing.
  current: string;
  next: string;
  username: string;
  // What Chrome took as the sign the form was sent, e.g. XHR_SUCCEEDED.
  indicator: string;
  // "ASK the user", "DROP the password", …
  decision: string;
}

interface Flow {
  name: string;
  what: string;
  // The account the flow starts from. `signedOut` is create-account, which IS
  // the flow.
  launch: { withRecovery?: boolean; signedOut?: boolean };
  run: (app: LaunchedApp) => Promise<void>;
  // One per submission Chrome should detect, in order — a flow that prompts
  // twice is as wrong as one that prompts with the wrong field. Empty for a lock
  // flow: Chrome should see nothing to save.
  expected: Omit<Submission, 'username' | 'indicator'>[];
}

const ASK = 'ASK the user';

const FLOWS: Flow[] = [
  {
    name: 'change-generated',
    what: 'Change password, current password, generated passphrase',
    launch: {},
    run: async ({ page, credentials }) => {
      await openChangePassword(page);
      await page.locator('#cp-current').fill(credentials.password);
      await submitGenerated(page);
    },
    expected: [{ current: 'cp-current', next: 'cp-generated-password', decision: ASK }],
  },
  {
    name: 'change-own',
    what: 'Change password, current password, typed new password',
    launch: {},
    run: async ({ page, credentials }) => {
      await openChangePassword(page);
      await page.locator('#cp-current').fill(credentials.password);
      await page.getByRole('button', { name: 'Choose my own' }).click();
      await page.locator('#cp-new-password').fill(newCredentials().password);
      await submitChange(page);
    },
    expected: [{ current: 'cp-current', next: 'cp-new-password', decision: ASK }],
  },
  {
    name: 'change-recovery',
    what: 'Change password, recovery code, generated passphrase',
    launch: { withRecovery: true },
    run: async ({ page, recoveryCode }) => {
      if (!recoveryCode) throw new Error('the account was created without a recovery code');
      await openChangePassword(page);
      await page.getByRole('button', { name: /use my recovery code/i }).click();
      await page.locator('#cp-recovery').fill(recoveryCode);
      await submitGenerated(page);
    },
    expected: [{ current: '', next: 'cp-generated-password', decision: ASK }],
  },
  {
    // The recovery code is a second door, not the password: what Chrome should
    // offer is the CURRENT password, which this form proves — never the code,
    // which would then fill sign-in's password field.
    name: 'recovery-view',
    what: 'Settings → Recovery code, generate',
    launch: {},
    run: async ({ page, credentials }) => {
      await page.goto('/settings/account');
      await page.getByRole('button', { name: /^Recovery code/ }).click();
      await page.locator('#rc-current').fill(credentials.password);
      await page.getByRole('button', { name: /^Generate/ }).click();
      await expect(page.getByLabel('Your recovery code')).toBeVisible({ timeout: 60_000 });
    },
    expected: [{ current: 'rc-current', next: '', decision: ASK }],
  },
  {
    // ONE submission, at the end. With the generated passphrase exposed on the
    // setup step, Chrome took Continue for a submission — the username check's
    // fetch counts as one — and offered to save before the account existed.
    name: 'create-account',
    what: 'Create account, generated passphrase, no recovery code',
    launch: { signedOut: true },
    run: async ({ page, credentials }) => {
      await page.goto('/create-account');
      await page.locator('#username').fill(credentials.username);
      await expect(page.getByText('Username is available')).toBeVisible();
      const passphrase = (await page.getByLabel('Your password').innerText()).trim();
      await page.locator('#signup-passphrase-saved').check();
      await page.getByRole('button', { name: /continue/i }).click();
      await page.locator('#confirm').fill(passphrase);
      await page.getByRole('button', { name: /continue/i }).click();
      await page.getByRole('button', { name: /without a recovery code/i }).click();
      await expect(page).toHaveURL(/\/links/, { timeout: 60_000 });
    },
    expected: [{ current: '', next: 'confirm', decision: ASK }],
  },
  {
    // NO submission, from either surface. The specimen came from a real profile
    // with the account's login saved: setting the lock and leaving Settings
    // opened Chrome's offer to update that login with the lock password, and the
    // unlock field was offered the sign-in password. Here, under `off`, the set
    // and the unlock each logged an ASK. Covers both surfaces (the dialog and
    // the pane) for both kinds of lock.
    name: 'lock-app',
    what: 'Set app lock, close settings, unlock the app',
    launch: {},
    run: async ({ page, credentials }) => {
      const password = unique('app-lock');
      await grantPlusAndLoad(page, credentials.username);
      await page.goto('/settings/misc');
      await page.getByRole('button', { name: 'Set app lock…' }).click();
      const dialog = page.getByRole('dialog', { name: 'Set app lock' });
      await dialog.getByLabel('Password', { exact: true }).fill(password);
      await dialog.getByRole('button', { name: 'Set lock', exact: true }).click();
      await expect(dialog).toHaveCount(0);
      await leaveSettings(page);
      await page.reload();
      await page.getByLabel('Password', { exact: true }).fill(password);
      await page.getByRole('button', { name: 'Unlock', exact: true }).click();
      await expect(page.getByRole('heading', { name: 'Bracemark is locked' })).toHaveCount(0);
    },
    expected: [],
  },
  {
    name: 'lock-list',
    what: 'Lock a list, close settings, unlock it in place',
    launch: {},
    run: async ({ page, credentials }) => {
      const password = unique('list-lock');
      const list = unique('Locked list');
      await grantPlusAndLoad(page, credentials.username);
      await createInSettings(page, 'list', list);
      await lockListInSettings(page, list, password);
      await leaveSettings(page);
      await openSidebarItem(page, `${list} Locked`);
      await page.getByLabel('Password', { exact: true }).fill(password);
      await page.getByRole('button', { name: 'Unlock', exact: true }).click();
      await expect(page.getByLabel('Password', { exact: true })).toHaveCount(0);
    },
    expected: [],
  },
];

// Leaving Settings through its close link — a same-document navigation, which
// is where the prompt opened — then giving Chrome's decision a beat to land
// before the next load discards the page it would land on.
async function leaveSettings(page: Page): Promise<void> {
  await page.getByRole('link', { name: 'Close settings' }).click();
  await expect(page).toHaveURL(/\/links/);
  await page.waitForTimeout(2_500);
}

async function openChangePassword(page: Page): Promise<void> {
  await page.goto('/settings/account');
  await page.getByRole('button', { name: /^Change password/ }).click();
}

async function submitGenerated(page: Page): Promise<void> {
  await expect(page.getByLabel('Your new password')).not.toBeEmpty();
  await page.getByLabel('I’ve saved my new password somewhere safe.').check();
  await submitChange(page);
}

async function submitChange(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Change password', exact: true }).click();
  await expect(page.getByText(/^Your password has been changed\./)).toBeVisible({
    timeout: 60_000,
  });
}

// The log, split at each submission Chrome detected. A submission's fields are
// the last "Form parsing output" ahead of it; its decision is the first one after.
function parseSubmissions(log: string): Submission[] {
  const marker = /Successful submission indicator event:\s*(\S+)/g;
  const submissions: Submission[] = [];
  let from = 0;
  for (let match = marker.exec(log); match; match = marker.exec(log)) {
    const before = log.slice(from, match.index);
    const parses = before.split('Form parsing output:');
    const parse = parses.length > 1 ? (parses.at(-1) ?? '') : '';
    const after = log.slice(match.index);
    submissions.push({
      current: field(parse, 'Password element'),
      next: field(parse, 'New password element'),
      username: field(parse, 'Username element'),
      indicator: match[1] ?? '?',
      decision: /Decision:\s*(.+?)\s*$/m.exec(after)?.[1] ?? '?',
    });
    from = match.index + match[0].length;
  }
  return submissions;
}

// A field by its id, or `#<renderer id>` for one Chrome chose that has no id or
// name — a lock field has neither, and printed as `—` it read as "no field".
function field(parse: string, role: string): string {
  if (!parse) return '?';
  const name = new RegExp(`^\\s*${role} :\\s*(.*?)\\s*,?\\s*$`, 'm').exec(parse)?.[1];
  if (name === undefined) return '?';
  if (name !== '') return name;
  const id = new RegExp(`^\\s*${role} renderer id :\\s*(\\d+)`, 'm').exec(parse)?.[1];
  return id && id !== '0' ? `#${id}` : '';
}

interface FlowResult {
  name: string;
  what: string;
  submissions: Submission[];
  ok: boolean;
}

async function measureFlow(flow: Flow, runDir: string, headed: boolean): Promise<FlowResult> {
  const app = await launchApp(profileDir(`password-manager-${flow.name}`), {
    ...flow.launch,
    headed,
  });
  try {
    // Opened AFTER the account ceremony for every flow but create-account, so the
    // log holds only the flow under measurement. It records only while open.
    const internals = await app.context.newPage();
    await internals.goto('chrome://password-manager-internals');
    await app.page.bringToFront();

    await flow.run(app);
    // The decision lands a beat after the page settles.
    await app.page.waitForTimeout(2_500);

    const log = await internals.locator('body').innerText();
    await writeFile(join(runDir, `${flow.name}.log`), log, 'utf8');
    const submissions = parseSubmissions(log);
    const ok =
      submissions.length === flow.expected.length &&
      flow.expected.every((want, i) => {
        const got = submissions[i];
        return (
          got?.current === want.current && got.next === want.next && got.decision === want.decision
        );
      });
    return { name: flow.name, what: flow.what, submissions, ok };
  } finally {
    await app.close();
  }
}

function parseOptions(args: string[]): { flows: Flow[]; headed: boolean } {
  let flows = FLOWS;
  let headed = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--headed') headed = true;
    else if (arg === '--flow') {
      const names = (args[++i] ?? '').split(',').filter(Boolean);
      const unknown = names.filter((name) => !FLOWS.some((flow) => flow.name === name));
      if (names.length === 0 || unknown.length > 0) {
        throw new Error(
          `--flow takes one or more of: ${FLOWS.map((flow) => flow.name).join(', ')}`,
        );
      }
      flows = FLOWS.filter((flow) => names.includes(flow.name));
    } else throw new Error(`unknown option ${arg}`);
  }
  return { flows, headed };
}

function show(value: string): string {
  return value === '' ? '—' : value;
}

async function main(): Promise<void> {
  const options = parseOptions(process.argv.slice(2));
  await waitForApi();
  await assertOriginOwnedByRepo(API_URL, 'bracemark-api', { required: true });
  await assertOriginOwnedByRepo(WEB_URL, 'bracemark-web', { required: true });

  const runDir = join(MEASURE_OUTPUT, createRunId('measure-password-manager'));
  await mkdir(runDir, { recursive: true });
  const chrome = await capture(CHROME_PATH, ['--version'], { allowFailure: true });
  console.log(`${chrome.stdout.trim() || 'Chrome'} — logs in ${runDir}\n`);

  // One at a time: each flow is an account creation (Argon2id) against the one
  // local rate-limit bucket (docs/e2e.md, _one IP, one bucket_), and a handful
  // in sequence is about a minute.
  const results: FlowResult[] = [];
  for (const flow of options.flows) {
    const result = await measureFlow(flow, runDir, options.headed);
    results.push(result);
    console.log(`${result.ok ? '✓' : '✗'} ${result.name} — ${result.what}`);
    if (result.submissions.length === 0) console.log('    no submission detected');
    for (const s of result.submissions) {
      console.log(
        `    current ${show(s.current)}, new ${show(s.next)}, username ${show(s.username)}` +
          ` → ${s.decision} (${s.indicator})`,
      );
    }
    if (!result.ok) {
      for (const want of flow.expected) {
        console.log(
          `    expected: current ${show(want.current)}, new ${show(want.next)} → ${want.decision}`,
        );
      }
    }
  }

  const mismatched = results.filter((result) => !result.ok).length;
  console.log(
    mismatched === 0
      ? `\nall ${results.length} flows as expected`
      : `\n${mismatched} of ${results.length} flows differ — a \`?\` is a log this no longer parses; read ${runDir}`,
  );
  process.exitCode = mismatched === 0 ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
