// The iOS share extension's community-module exclusion, as far as jest can
// reach it (plugins/with-share-extension-native-links.js; docs/share-sheet.md,
// _the share extension has almost no memory to spare_).
//
// The plugin rewrites ONE line of a Podfile that another library writes, and
// every way it can go wrong is silent until a device: an anchor that stops
// matching (and the plugin quietly no-ops — it throws instead, which is the
// first thing pinned here), a rewrite that lands in the APP's target and drops
// Reanimated from the app, or an excluded library that later starts
// registering a Fabric component — which, unlinked, is a nil in codegen's
// shared component dictionary and kills the share extension at launch.
//
// As next door (share-swipe-hold-wiring.spec.ts), the Podfile's share
// extension block is upstream's own: expo-share-extension's `withPodfile` mod is
// run for real against a scratch `ios/`, so a dependency bump that moves the
// anchor fails here, before the next prebuild.

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

type ModConfig = Record<string, unknown> & {
  mods?: { ios?: Record<string, (config: Record<string, unknown>) => Promise<unknown>> };
};
type Plugin = (config: ModConfig) => ModConfig;

const withNativeLinks = jest.requireActual<Plugin>(
  '../../../plugins/with-share-extension-native-links',
);
const { withPodfile } = jest.requireActual<{
  withPodfile: (config: ModConfig, props: { excludedPackages: string[] }) => ModConfig;
}>('expo-share-extension/plugin/build/withPodfile');

const APP_ROOT = path.join(__dirname, '..', '..', '..');

// The app's half of a generated Podfile — the lines the plugin must leave alone
// (its own `use_native_modules!`) and the anchor upstream's mod needs
// (`react_native_post_install`).
const APP_PODFILE = `require File.join(File.dirname(\`node --print "require.resolve('expo/package.json')"\`), "scripts/autolinking")

target 'Bracemark' do
  use_expo_modules!

  config_command = ['npx', 'expo-modules-autolinking', 'react-native-config', '--json', '--platform', 'ios']
  config = use_native_modules!(config_command)

  use_react_native!(:path => config[:reactNativePath])

  post_install do |installer|
    react_native_post_install(installer, config[:reactNativePath])
  end
end
`;

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function scratchIos(podfile = APP_PODFILE): { root: string; read: () => string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bracemark-share-podfile-'));
  roots.push(root);
  fs.writeFileSync(path.join(root, 'Podfile'), podfile);
  return { root, read: () => fs.readFileSync(path.join(root, 'Podfile'), 'utf8') };
}

// Fresh per run: a mod plugin attaches its mod to the config object it is handed.
const base = (): ModConfig => ({ name: 'Bracemark', slug: 'bracemark' });

// Upstream's dangerous mod, then ours as `finalized` — the order prebuild runs
// them in.
async function prebuild(root: string, ...plugins: Plugin[]): Promise<void> {
  const config = plugins.reduce<ModConfig>((applied, plugin) => plugin(applied), base());
  const modRequest = { platformProjectRoot: root, projectRoot: APP_ROOT };
  await config.mods?.ios?.dangerous?.({ ...config, modRequest, modResults: {} });
  await config.mods?.ios?.finalized?.({ ...config, modRequest, modResults: {} });
}

const withUpstream: Plugin = (config) => withPodfile(config, { excludedPackages: [] });

// The extension's target block: from its `target` line to the end of the file
// (upstream appends it last).
const shareBlock = (podfile: string) =>
  podfile.slice(podfile.search(/^target '\w*ShareExtension'/m));
const appBlock = (podfile: string) =>
  podfile.slice(0, podfile.search(/^target '\w*ShareExtension'/m));

test('rewrites the share extension’s autolinking into list → filter → link', async () => {
  const ios = scratchIos();
  await prebuild(ios.root, withUpstream, withNativeLinks);
  const share = shareBlock(ios.read());

  expect(share).not.toContain('use_native_modules!(config_command)');
  // The order is the claim: list (which writes codegen's autolinking.json for
  // BOTH targets), then the filter, then link — filtering before the list would
  // hand the app an extension-shaped component provider.
  const list = share.indexOf('share_native_modules = list_native_modules!(config_command)');
  const reject = share.indexOf('share_native_modules[:ios_packages].reject!');
  const link = share.indexOf('config = link_native_modules!(share_native_modules)');
  expect(list).toBeGreaterThan(-1);
  expect(reject).toBeGreaterThan(list);
  expect(link).toBeGreaterThan(reject);
  // …and before `use_react_native!`, which reads `config[:reactNativePath]`.
  expect(share.indexOf('use_react_native!(')).toBeGreaterThan(link);
});

test('leaves the app target’s own autolinking alone', async () => {
  const ios = scratchIos();
  await prebuild(ios.root, withUpstream, withNativeLinks);
  const app = appBlock(ios.read());

  expect(app).toContain('  config = use_native_modules!(config_command)');
  expect(app).not.toContain('share_native_modules');
});

test('is idempotent across a second prebuild over the same Podfile', async () => {
  const ios = scratchIos();
  await prebuild(ios.root, withUpstream, withNativeLinks);
  const once = ios.read();
  await prebuild(ios.root, withNativeLinks);

  expect(ios.read()).toBe(once);
});

test('does nothing when there is no share extension target', async () => {
  const ios = scratchIos();
  await prebuild(ios.root, withNativeLinks);

  expect(ios.read()).toBe(APP_PODFILE);
});

// Upstream changing how it autolinks must stop the prebuild, not leave the
// extension silently linking Worklets' second runtime again.
test('throws when the share extension block no longer has the anchor', async () => {
  const ios = scratchIos(
    `${APP_PODFILE}\ntarget 'BracemarkShareExtension' do\n  config = autolink_everything!\nend\n`,
  );

  await expect(prebuild(ios.root, withNativeLinks)).rejects.toThrow(/could not find/);
});

// The patched Ruby, run: `list_native_modules!` returns symbol keys
// (react-native/scripts/cocoapods/autolinking.rb) and the filter has to match on
// `package[:name]`, the npm name. A string-keyed or `:package_name` filter would
// parse, install and drop nothing.
test('the patched Ruby drops exactly the excluded packages', async () => {
  const ios = scratchIos();
  await prebuild(ios.root, withUpstream, withNativeLinks);
  const share = shareBlock(ios.read());
  const patched = share.slice(
    share.indexOf('share_native_modules = list_native_modules!'),
    share.indexOf('config = link_native_modules!(share_native_modules)') +
      'config = link_native_modules!(share_native_modules)'.length,
  );

  const names = [
    'react-native-reanimated',
    'react-native-worklets',
    '@react-native-community/netinfo',
    'react-native-screens',
    'react-native-gesture-handler',
  ];
  const script = `
    require 'json'
    def list_native_modules!(_cmd)
      { "ios_packages": ${JSON.stringify(names)}.map { |n| { "name": n, "path": "x" } } }
    end
    def link_native_modules!(config) = config
    config_command = ['true']
    ${patched}
    puts JSON.generate(config[:ios_packages].map { |p| p[:name] })
  `;
  const { execFileSync } =
    jest.requireActual<typeof import('node:child_process')>('node:child_process');
  let linked: string[];
  try {
    linked = JSON.parse(execFileSync('ruby', ['-e', script], { encoding: 'utf8' }));
  } catch (error) {
    // No Ruby, no CocoaPods either: this machine never prebuilds iOS.
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }

  expect(linked).toEqual(['react-native-screens', 'react-native-gesture-handler']);
});

// The plugin's ⚠: a library dropped from the extension must register no
// Fabric component, or codegen's shared RCTThirdPartyComponentsProvider builds
// a dictionary literal with a nil in it and the extension dies at launch. What
// codegen reads is each library's `codegenConfig.ios.componentProvider`, so a
// bump that adds one to an excluded library fails here.
test('excludes no library that registers a Fabric component', async () => {
  const ios = scratchIos();
  await prebuild(ios.root, withUpstream, withNativeLinks);
  // The list as the Podfile carries it, so the check reads what pods will see.
  const match = /reject! do \|package\|\n\s*(\[.*\])\.include\?/.exec(shareBlock(ios.read()));
  expect(match).not.toBeNull();
  const excluded = JSON.parse(match?.[1] ?? '[]') as string[];
  expect(excluded.length).toBeGreaterThan(0);

  for (const name of excluded) {
    const manifest = jest.requireActual<{
      codegenConfig?: { ios?: { componentProvider?: Record<string, string> } };
    }>(require.resolve(`${name}/package.json`, { paths: [APP_ROOT] }));
    expect({ name, components: manifest.codegenConfig?.ios?.componentProvider ?? {} }).toEqual({
      name,
      components: {},
    });
  }
});
