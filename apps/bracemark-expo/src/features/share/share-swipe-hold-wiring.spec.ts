// The native half of the share pickers' swipe hold, as far as jest can reach it
// (docs/share-sheet.md, _the pickers hold the system's swipe off_).
//
// The hold is one chain across four files in three languages — JS calls a
// module function, the Swift module posts a notification, an observer patched
// into expo-share-extension's controller by a config plugin sets
// `isModalInPresentation` — and every link is joined by a STRING: no compiler,
// linter or type relates a Swift literal to the one a .js plugin writes into
// another Swift file. Break any of them and nothing fails: the module posts
// into nothing, or is never registered and JS's optional lookup returns null,
// and the only symptom is a picker that can be swiped away on a device.
//
// What this cannot see is the half only a device shows — that UIKit honours the
// flag, and that the flick it holds off is the one a thumb makes. That is
// SHARE-IOS-003 (docs/e2e.md); this pins what that flow would otherwise have to
// rediscover as a timeout.
//
// The plugins are run for real, as the `finalized` mods prebuild runs, against
// the INSTALLED expo-share-extension's controller rather than a fixture: the
// anchor each one rewrites is upstream's text, so a fixture would agree with
// the plugin by construction and a dependency bump is exactly what has to fail
// here — before the next prebuild, not during it.

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const APP_ROOT = path.join(__dirname, '..', '..', '..');
const MODULE_ROOT = path.join(APP_ROOT, 'modules', 'bracemark-share');
const CONTROLLER = 'ShareExtensionViewController.swift';
const UPSTREAM_CONTROLLER = path.join(
  path.dirname(require.resolve('expo-share-extension/package.json')),
  'plugin',
  'swift',
  CONTROLLER,
);

// Swift with its `//` comment lines dropped. The sources here restate their
// contract in the header above the code, so an unstripped match can land on
// the prose and keep passing after the code has changed (docs/testing.md, _the
// doc-comment decoy_).
function swiftCode(source: string): string {
  return source
    .split('\n')
    .filter((line) => !line.trim().startsWith('//'))
    .join('\n');
}

const guardModule = () =>
  swiftCode(
    fs.readFileSync(path.join(MODULE_ROOT, 'ios', 'BracemarkShareSwipeGuardModule.swift'), 'utf8'),
  );

function only(source: string, pattern: RegExp, what: string): RegExpExecArray {
  const matches = [...source.matchAll(new RegExp(pattern, 'g'))];
  if (matches.length !== 1) throw new Error(`expected one ${what}, found ${matches.length}`);
  return matches[0];
}

type Plugin = (config: Record<string, unknown>) => {
  mods: { ios: { finalized: (config: Record<string, unknown>) => Promise<unknown> } };
};

const withSwipeHold = jest.requireActual<Plugin>(
  '../../../plugins/with-share-extension-swipe-hold',
);
const withRootView = jest.requireActual<Plugin>('../../../plugins/with-share-extension-root-view');

// Runs the plugins' `finalized` mods over a project root, the way the mod
// compiler does. The LAST plugin applied is the first mod to run.
async function prebuild(projectRoot: string, ...plugins: Plugin[]): Promise<void> {
  const config = plugins.reduce<Record<string, unknown>>((applied, plugin) => plugin(applied), {
    name: 'Bracemark',
    slug: 'bracemark',
  }) as ReturnType<Plugin>;
  await config.mods.ios.finalized({
    ...config,
    modRequest: { platformProjectRoot: projectRoot },
    modResults: {},
  });
}

const roots: string[] = [];

// A scratch `ios/` holding one share extension target with `controller` in it —
// by default the installed library's own file, as `addPbxGroup.js` copies it.
function iosRoot(controller = fs.readFileSync(UPSTREAM_CONTROLLER, 'utf8')): {
  root: string;
  read: () => string;
} {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bracemark-share-ios-'));
  roots.push(root);
  const target = path.join(root, 'BracemarkShareExtension');
  fs.mkdirSync(target);
  fs.writeFileSync(path.join(target, CONTROLLER), controller);
  return { root, read: () => fs.readFileSync(path.join(target, CONTROLLER), 'utf8') };
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

// The observer as the plugin writes it: the notification it listens for and the
// userInfo key it reads the flag from.
const OBSERVER =
  /NotificationCenter\.default\.addObserver\(forName: NSNotification\.Name\("([^"]+)"\)[^\n]*\n\s*self\?\.isModalInPresentation = \(notification\.userInfo\?\["([^"]+)"\] as\? Bool\)/;

test('the observer the plugin patches in hears what the Swift module posts', async () => {
  const module = guardModule();
  const posted = only(module, /Notification\.Name\("([^"]+)"\)/, 'posted notification name')[1];
  const key = only(module, /userInfo: \["([^"]+)": held\]/, 'userInfo key')[1];

  const ios = iosRoot();
  await prebuild(ios.root, withSwipeHold);
  const [, observed, read] = only(swiftCode(ios.read()), OBSERVER, 'swipe-hold observer');

  // A name that differs posts into nothing. A KEY that differs is worse than
  // silent: `?? false` reads every post as "let go", so the hold is never taken.
  expect(observed).toBe(posted);
  expect(read).toBe(key);
});

test('the observer lands inside the method the controller runs at load, beside `close`', async () => {
  const ios = iosRoot();
  await prebuild(ios.root, withSwipeHold);
  const patched = ios.read();

  // Order is the claim: appended after the method's closing brace the Swift
  // would not compile, but written into any OTHER method it compiles and is
  // never registered.
  const method = patched.indexOf('private func setupNotificationCenterObserver() {');
  const ours = patched.search(OBSERVER);
  const close = patched.indexOf('NSNotification.Name("close")');
  expect(method).toBeGreaterThan(-1);
  expect(ours).toBeGreaterThan(method);
  expect(close).toBeGreaterThan(ours);
  // …and `viewDidLoad` still calls it. Upstream moving that call would leave
  // the patch intact and dead.
  const [, viewDidLoad] = only(
    patched,
    /override func viewDidLoad\(\) \{([\s\S]*?)\n {2}override func /,
    'viewDidLoad body',
  );
  expect(viewDidLoad).toContain('setupNotificationCenterObserver()');
});

// `expo prebuild` without `--clean` runs the mods over the file they already
// patched, and both of this controller's plugins are `finalized` mods whose
// relative order is whatever `plugins` in app.config.ts happens to say.
test('re-running prebuild, in either plugin order, patches the controller once', async () => {
  const forward = iosRoot();
  await prebuild(forward.root, withRootView, withSwipeHold);
  const once = forward.read();
  await prebuild(forward.root, withRootView, withSwipeHold);
  expect(forward.read()).toBe(once);

  const reversed = iosRoot();
  await prebuild(reversed.root, withSwipeHold, withRootView);
  expect(reversed.read()).toBe(once);

  expect(once.match(new RegExp(OBSERVER, 'g'))).toHaveLength(1);
  // The neighbour's rewrite survived ours (docs/share-sheet.md, _the host view
  // is full-screen_) — the two edit the same file.
  expect(once).toContain('frame = view.bounds');
  expect(once).not.toContain('frame = screenBounds');
});

// The throw is the only thing that turns an upstream reword into a failed
// prebuild instead of a picker that can be swiped away.
test('a controller without the method fails the prebuild rather than skipping the patch', async () => {
  const reworded = fs
    .readFileSync(UPSTREAM_CONTROLLER, 'utf8')
    .replace(/setupNotificationCenterObserver/g, 'registerObservers');
  const ios = iosRoot(reworded);

  await expect(prebuild(ios.root, withSwipeHold)).rejects.toThrow(
    /setupNotificationCenterObserver/,
  );
  expect(ios.read()).toBe(reworded);
});

// Dropping expo-share-extension from `plugins` is a legitimate config.
test('a project with no share extension target prebuilds untouched', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bracemark-share-ios-'));
  roots.push(root);
  fs.mkdirSync(path.join(root, 'Bracemark'));

  await expect(prebuild(root, withSwipeHold)).resolves.toBeUndefined();
  expect(fs.readdirSync(path.join(root, 'Bracemark'))).toEqual([]);
});

// Autolinking registers the classes this file names and nothing else, and the
// plugin runs only if the app config lists it. Neither omission is an error
// anywhere: the Swift still compiles into the pod, the plugin file still lints.
test('the module is registered for iOS and the plugin is in the app config', () => {
  const module = guardModule();
  const className = only(module, /class (\w+): Module/, 'module class')[1];
  const registered = JSON.parse(
    fs.readFileSync(path.join(MODULE_ROOT, 'expo-module.config.json'), 'utf8'),
  ) as { apple: { modules: string[] } };
  expect(registered.apple.modules).toContain(className);

  const { default: appConfig } = jest.requireActual<{ default: { plugins: unknown[] } }>(
    '../../../app.config',
  );
  expect(appConfig.plugins).toContain('./plugins/with-share-extension-swipe-hold');
});
