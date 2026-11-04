import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { MEASURE_OUTPUT } from '../paths';
import { resolveDevice } from '../runner/device';
import { createRunId, provisionAccount, waitForApi } from '../runner/lib';
import { capture } from '../runner/process';
import { assertOriginOwnedByRepo } from '../runner/stack';
import { API_URL, WEB_URL } from '../web/fixtures/env';
import {
  assertInstalled,
  checkout,
  describeDevice,
  type DeviceOptions,
  flow,
  METRO_URL,
  reversePorts,
} from './native';

// What Android hands the autofill service on the three Account views that take the
// account's password. On change password: whether a field hinted `username`,
// holding the account's name, comes ahead of the proof field. That pair is how a
// password manager tells which saved login an update belongs to
// (apps/bracemark-expo/src/features/settings/account-username-field.tsx). On recovery
// code and delete account: that there is NO such field. With one, Google Password
// Manager offered to save a password that only proved who you were, on delete account
// for an account already gone (docs/password-manager.md, _a password that only
// proves who you are_).
//
//   npm run dev                                   # the api and the web app (accounts)
//   npm run expo:start                            # Metro, from this checkout
//   npm run measure:autofill:android
//   npm run measure:autofill:android -- --device emulator-5556
//
// WHY IT EXISTS: what a manager is given is outside the app's tree, so no spec or
// flow sees it, and losing the username is silent. Every flow passes, and the
// evidence is an entry with no name in one person's password manager. jest pins the
// field's props (account-username-field.spec.tsx). This shows that Android really
// passes them on: the `AssistStructure` the framework built for the fill request,
// which `dumpsys autofill` writes to logcat while the framework's log level is
// verbose. It reads the structure, not a manager's decision, so it needs no Google
// account on the emulator.
//
// ANDROID ONLY. iOS gives an app nothing like it. What iOS AutoFill made of the
// same views was measured by hand (docs/password-manager.md, _the iOS app_): the
// read-only field changes nothing there.
//
// NOT A TEST, and in no suite: logcat's dump is a debugging surface whose format
// is not a contract. A view whose dump no longer parses prints `?` rather than
// a failure of the product, and every raw dump is written beside the results.

interface View {
  name: string;
  // The prefix of the view's testIDs.
  view: 'change-password' | 'recovery-code' | 'delete-account';
  // The proof field: its testID, and its `aria-label`, which Android reports as
  // the node's content description.
  field: string;
  label: string;
  // Whether the account's name should be beside the proof field.
  named: boolean;
}

const VIEWS: View[] = [
  {
    name: 'change-password',
    view: 'change-password',
    field: 'change-password-current',
    label: 'Current password',
    named: true,
  },
  {
    name: 'recovery-code',
    view: 'recovery-code',
    field: 'recovery-code-current',
    label: 'Current password',
    named: false,
  },
  {
    name: 'delete-account',
    view: 'delete-account',
    field: 'delete-account-password',
    label: 'Confirm your password',
    named: false,
  },
];

// One editable node of the structure, in the order the service walks them.
export interface FieldNode {
  label: string;
  hints: string[];
  // The dump redacts values to a length, so a length is all there is to compare.
  valueLength: number | null;
}

// The LAST window of the dump: each fill request in the session adds a structure,
// and the one this view's focus asked for comes last.
export function parseLastStructure(logcat: string): FieldNode[] | null {
  const lines = logcat
    .split('\n')
    .filter((line) => line.includes('AssistStructure:'))
    .map((line) => line.slice(line.indexOf('AssistStructure:') + 'AssistStructure:'.length));
  let start = -1;
  lines.forEach((line, index) => {
    if (/^\s*Window #\d+/.test(line)) start = index;
  });
  if (start < 0) return null;
  const nodes: FieldNode[] = [];
  let label = '';
  for (const line of lines.slice(start)) {
    if (/^\s*View \[/.test(line)) label = '';
    const description = /Content description: (.*)$/.exec(line);
    if (description) label = description[1].trim();
    const info =
      /Autofill info: .*?hints=(null|\[[^\]]*\]), value=(null|\[type=\d+, value=(\d+)_chars\])/.exec(
        line,
      );
    if (info && info[1] !== 'null') {
      nodes.push({
        label,
        hints: info[1]
          .slice(1, -1)
          .split(',')
          .map((hint) => hint.trim())
          .filter(Boolean),
        valueLength: info[3] === undefined ? null : Number(info[3]),
      });
    }
  }
  return nodes;
}

// `missing` and `after` are a view that should name the account and doesn't, or
// does so after the password; `named` is one that should not and does.
export type Verdict = 'ok' | 'missing' | 'after' | 'named' | '?';

// The proof field must be in the structure (else the dump is not this view's:
// `?`). Where the view should name the account, a `username` node holding a value
// as long as the account's name must come before it; where it should not, there
// must be no `username` node at all.
export function judge(
  nodes: FieldNode[] | null,
  label: string,
  username: string,
  expectNamed: boolean,
): Verdict {
  if (!nodes) return '?';
  const proof = nodes.findIndex(
    (node) => node.label === label && node.hints.some((hint) => hint.startsWith('password')),
  );
  if (proof < 0) return '?';
  if (!expectNamed) {
    return nodes.some((node) => node.hints.includes('username')) ? 'named' : 'ok';
  }
  const named = nodes.findIndex(
    (node) => node.hints.includes('username') && node.valueLength === username.length,
  );
  if (named < 0) return 'missing';
  return named < proof ? 'ok' : 'after';
}

function adb(device: string, ...args: string[]) {
  return capture('adb', ['-s', device, ...args], { timeoutMs: 30_000 });
}

async function readStructure(device: string): Promise<string> {
  await adb(device, 'logcat', '-c');
  await adb(device, 'shell', 'dumpsys', 'autofill');
  // The dump is written by system_server as dumpsys runs; give logcat a beat.
  await new Promise((resolve) => setTimeout(resolve, 1000));
  return (await capture('adb', ['-s', device, 'logcat', '-d'], { timeoutMs: 30_000 })).stdout;
}

function parseOptions(args: string[]): { device?: string } {
  let device: string | undefined;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--device') device = args[++i];
    else throw new Error(`unknown option ${args[i]}`);
  }
  return { device };
}

async function main(): Promise<void> {
  const options = parseOptions(process.argv.slice(2));
  await waitForApi();
  await assertOriginOwnedByRepo(API_URL, 'bracemark-api', { required: true });
  await assertOriginOwnedByRepo(WEB_URL, 'bracemark-web', { required: true });
  // The development client loads its bundle from here; another checkout's Metro
  // would serve its own app and the reading would be of that.
  await assertOriginOwnedByRepo(METRO_URL, 'Metro', {
    required: true,
    start: 'Start it with `npm run expo:start`',
  });

  const deviceId = await resolveDevice('android', options.device);
  const device: DeviceOptions = { platform: 'android', deviceId };
  await assertInstalled(device);
  await reversePorts(deviceId);

  const runDir = join(MEASURE_OUTPUT, createRunId('measure-autofill-android'));
  await mkdir(runDir, { recursive: true });
  const { commit, dirty } = await checkout();
  console.log(
    `${await describeDevice(device)}, ${commit.slice(0, 8)}${dirty ? ' (dirty)' : ''} — dumps in ${runDir}\n`,
  );

  // The dump is written only at verbose; put the level back as it was.
  const before = (
    await adb(deviceId, 'shell', 'cmd', 'autofill', 'get', 'log_level')
  ).stdout.trim();
  await adb(deviceId, 'shell', 'cmd', 'autofill', 'set', 'log_level', 'verbose');

  const account = await provisionAccount('measure-autofill');
  const results: Verdict[] = [];
  try {
    for (const view of VIEWS) {
      await flow('account-view-focus.yaml', device, {
        USERNAME: account.username,
        PASSWORD: account.password,
        VIEW: view.view,
        FIELD: view.field,
      });
      const logcat = await readStructure(deviceId);
      await writeFile(join(runDir, `${view.name}.log`), logcat, 'utf8');
      const nodes = parseLastStructure(logcat);
      const verdict = judge(nodes, view.label, account.username, view.named);
      results.push(verdict);
      const mark = verdict === 'ok' ? '✓' : verdict === '?' ? '?' : '✗';
      console.log(`${mark} ${view.name} — ${verdict}`);
      for (const node of nodes ?? []) {
        console.log(
          `    ${node.label || '(no label)'}: [${node.hints.join(', ')}]` +
            (node.valueLength === null ? '' : `, ${node.valueLength} chars`),
        );
      }
    }
  } finally {
    if (before && before !== 'verbose') {
      await adb(deviceId, 'shell', 'cmd', 'autofill', 'set', 'log_level', before);
    }
  }

  const differ = results.filter((verdict) => verdict !== 'ok').length;
  console.log(
    differ === 0
      ? `\nall ${results.length} views as expected`
      : `\n${differ} of ${results.length} views differ — a \`?\` is a dump this no longer parses; read ${runDir}`,
  );
  process.exitCode = differ === 0 ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
