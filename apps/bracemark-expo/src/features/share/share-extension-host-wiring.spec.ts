// The iOS share extension's controller and the modules that drive it, as far as
// jest can reach them (docs/share-sheet.md, _the pickers hold the system's swipe
// off_, and _"Full-screen" is a SIZE_).
//
// JS calls a module function (`BracemarkShare.close`,
// `BracemarkShareSwipeGuard.setHeld`), the Swift module asks
// `ShareExtensionHost.current`, and the controller — which registered itself
// there — acts. The protocol between the last two is checked by the Swift
// compiler; what the compiler cannot see is everything joined by a string or
// by a line that merely has to be present: the controller registering itself
// at all, the modules being registered with autolinking, the principal class
// the Info.plist names, the root name the controller mounts. Break one and
// nothing fails — a call into a nil host, a module JS's lookup cannot find, an
// extension that never instantiates — until a device.
//
// What this cannot see is the half only a device shows: that UIKit honours
// `isModalInPresentation` against a thumb (SHARE-IOS-003, docs/e2e.md), and
// where the root view actually lands (`maestro hierarchy`).

import * as fs from 'node:fs';
import * as path from 'node:path';

const APP_ROOT = path.join(__dirname, '..', '..', '..');
const MODULE_ROOT = path.join(APP_ROOT, 'modules', 'bracemark-share');

// Swift with its `//` comment lines dropped. The sources here restate their
// contract in the header above the code, so an unstripped match can land on
// the prose and keep passing after the code has changed (docs/testing.md, _the
// doc-comment decoy_).
function swiftCode(file: string): string {
  return fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .filter((line) => !line.trim().startsWith('//'))
    .join('\n');
}

const controller = () =>
  swiftCode(path.join(MODULE_ROOT, 'ios-extension', 'ShareViewController.swift'));
const podSource = (name: string) => swiftCode(path.join(MODULE_ROOT, 'ios', name));

// The body of `func name(…) {…}`, up to the next declaration at the same depth.
function body(source: string, signature: RegExp): string {
  const start = source.search(signature);
  if (start === -1) throw new Error(`no ${signature} in the controller`);
  const rest = source.slice(start);
  const next = rest.slice(1).search(/\n {2}(?:override |private |@objc )*func /);
  return next === -1 ? rest : rest.slice(0, next + 1);
}

const { default: appConfig } = jest.requireActual<{
  default: { plugins: unknown[] } & Record<string, unknown>;
}>('../../../app.config');

test('the controller registers itself as the host as it loads, and lets go on cleanup', () => {
  const source = controller();
  expect(source).toMatch(/class ShareViewController: UIViewController, ShareExtensionHosting \{/);
  expect(body(source, /override func viewDidLoad\(\)/)).toContain(
    'ShareExtensionHost.current = self',
  );
  // Only its own registration: a second controller must not be unhooked by the
  // first one's teardown.
  expect(body(source, /private func cleanupAfterClose\(\)/)).toMatch(
    /if ShareExtensionHost\.current === self \{\s*ShareExtensionHost\.current = nil/,
  );
});

// Cleanup must remove the root it was GIVEN. Upstream searched the subviews for
// `is RCTRootView`, and under the new architecture the factory returns an
// RCTSurfaceHostingProxyRootView, which is not one — the check compiled, never
// matched, and the root stayed in the hierarchy with its surface running until
// the process went. Nothing reports it.
test('cleanup removes the root view it holds, then lets the factory go', () => {
  const source = controller();
  const cleanup = body(source, /private func cleanupAfterClose\(\)/);

  expect(source).not.toMatch(/\bis RCTRootView\b/);
  expect(body(source, /private func loadReactNativeContent\(\)/)).toContain(
    'self.rootView = rootView',
  );
  const removed = cleanup.indexOf('rootView?.removeFromSuperview()');
  expect(removed).toBeGreaterThan(-1);
  // The surface stops on a host that is still there.
  expect(cleanup.indexOf('reactNativeFactory = nil')).toBeGreaterThan(removed);
  // …and it must not reach for `view`: deinit runs this too, and loading a
  // view from a deallocating controller re-enters viewDidLoad.
  expect(cleanup).not.toMatch(/\bview\./);
});

// The runtime boots WHILE the item providers load, not after them: for a share
// from Safari the property list arrives only once the page has run
// preprocessing.js (Readability and all), and Hermes starting behind that is
// the two waits added together. Moved back, the sheet just opens later.
test('React Native starts from viewDidLoad, before the share is read', () => {
  const source = controller();
  const didLoad = body(source, /override func viewDidLoad\(\)/);
  const start = didLoad.indexOf('startReactNative()');
  expect(start).toBeGreaterThan(-1);
  expect(didLoad.indexOf('loadReactNativeContent()')).toBeGreaterThan(start);

  const boot = body(source, /private func startReactNative\(\)/);
  expect(boot).toContain('RCTReactNativeFactory(delegate: delegate)');
  expect(boot).toContain('rootViewFactory.initializeReactHost(launchOptions: nil)');

  // The completion mounts on the factory that is already there, and on nothing
  // if the sheet was dismissed while the providers were loading.
  const mount = body(source, /private func loadReactNativeContent\(\)/);
  expect(mount).not.toContain('RCTReactNativeFactory(');
  expect(mount).toMatch(
    /guard let self = self, !self\.isCleanedUp, let factory = self\.reactNativeFactory/,
  );
});

test('the swipe hold reaches isModalInPresentation, and close() completes the request', () => {
  const source = controller();
  expect(body(source, /func setSwipeHeld\(_ held: Bool\)/)).toContain(
    'isModalInPresentation = held',
  );
  expect(body(source, /func close\(\)/)).toContain('extensionContext?.completeRequest(');

  expect(podSource('BracemarkShareSwipeGuardModule.swift')).toContain(
    'ShareExtensionHost.current?.setSwipeHeld(held)',
  );
  expect(podSource('BracemarkShareModule.swift')).toContain('ShareExtensionHost.current?.close()');
});

// The pod is linked into both targets, but autolinking registers only the
// classes this file names — an unlisted module compiles and is never found.
test('every module the share sheet calls is registered for iOS, under the name JS asks for', () => {
  const registered = (
    JSON.parse(fs.readFileSync(path.join(MODULE_ROOT, 'expo-module.config.json'), 'utf8')) as {
      apple: { modules: string[] };
    }
  ).apple.modules;

  for (const [file, name] of [
    ['BracemarkShareModule.swift', 'BracemarkShare'],
    ['BracemarkShareSwipeGuardModule.swift', 'BracemarkShareSwipeGuard'],
  ] as const) {
    const source = podSource(file);
    expect(registered).toContain(/class (\w+): Module/.exec(source)?.[1]);
    expect(source).toContain(`Name("${name}")`);
  }
  // share-host.ts's one call, on both platforms; Android's module has the same name.
  expect(fs.readFileSync(path.join(__dirname, 'share-host.ts'), 'utf8')).toContain(
    "requireNativeModule('BracemarkShare').close()",
  );
});

// The root must FILL ITS SUPERVIEW. A screen-sized rect is the right size in
// the wrong place — 72pt below the screen on an iPhone, Save button included.
test('the root view fills its superview, clear, rather than the screen', () => {
  const configure = body(controller(), /private func configureRootView\(/);
  expect(configure).toContain('rootView.frame = view.bounds');
  expect(configure).toContain('rootView.backgroundColor = .clear');
  expect(configure).toContain('[.flexibleWidth, .flexibleHeight]');
  expect(configure).not.toContain('UIScreen.main.bounds');
});

test('the Info.plist names this controller, and the controller mounts what index.share.js registers', () => {
  // As the plugin writes it.
  const files = fs.readFileSync(
    path.join(APP_ROOT, 'plugins', 'with-share-extension', 'files.js'),
    'utf8',
  );
  const principal = /NSExtensionPrincipalClass: '\$\(PRODUCT_MODULE_NAME\)\.(\w+)'/.exec(
    files,
  )?.[1];
  expect(controller()).toContain(`class ${principal}: UIViewController`);

  const mounted = /withModuleName: "(\w+)"/.exec(controller())?.[1];
  const entry = fs.readFileSync(path.join(APP_ROOT, 'index.share.js'), 'utf8');
  expect(entry).toContain(`AppRegistry.registerComponent('${mounted}'`);
});

// The plugin hard-codes where the controller lives (it references the file in
// place); a move that misses it prebuilds a target with a dangling source.
test('the plugin is in the app config, and the controller is where it looks', () => {
  expect(appConfig.plugins).toContainEqual(['./plugins/with-share-extension', expect.any(Object)]);
  const index = fs.readFileSync(
    path.join(APP_ROOT, 'plugins', 'with-share-extension', 'index.js'),
    'utf8',
  );
  const where = /controller: '([^']+)'/.exec(index)?.[1];
  expect(where).toBeDefined();
  expect(fs.existsSync(path.join(APP_ROOT, where ?? ''))).toBe(true);
});
