// The iOS share extension's block in the generated Podfile, as far as jest can
// reach it (plugins/with-share-extension/podfile.js; docs/share-sheet.md, _the
// share extension has almost no memory to spare_, rule 3).
//
// Every way this goes wrong is silent until a device: a filter that lands in
// the APP's target and drops Reanimated from the app, a filter that runs before
// `list_native_modules!` and hands the app an extension-shaped component
// provider, an extension block whose autolinking drifts from the app's, or an
// excluded library that later starts registering a Fabric component — which,
// unlinked, is a nil in codegen's shared component dictionary and kills the
// share extension at launch.
//
// The mod runs for real against `__fixtures__/expo-sdk54.Podfile`: the app half
// of the Podfile `expo prebuild` generates on SDK 54, verbatim. When the SDK
// moves, the plugin's own throw is what reports a template it no longer
// understands (at prebuild); refresh the fixture from that prebuild's
// `ios/Podfile` in the same change.

import * as fs from 'node:fs';
import * as path from 'node:path';

type ModConfig = Record<string, unknown> & {
  modResults?: { contents: string };
  mods?: { ios?: Record<string, (config: Record<string, unknown>) => Promise<ModConfig>> };
};

const APP_ROOT = path.join(__dirname, '..', '..', '..');
const TEMPLATE = fs.readFileSync(
  path.join(__dirname, '__fixtures__', 'expo-sdk54.Podfile'),
  'utf8',
);

const { withShareExtensionPodfile } = jest.requireActual<{
  withShareExtensionPodfile: (config: ModConfig, props: Record<string, string[]>) => ModConfig;
}>('../../../plugins/with-share-extension/podfile');

const { default: appConfig } = jest.requireActual<{
  default: { plugins: unknown[] } & Record<string, unknown>;
}>('../../../app.config');

// The options app.config.ts actually passes, so what is checked is what ships.
const shareOptions = (() => {
  const entry = appConfig.plugins.find(
    (plugin) => Array.isArray(plugin) && plugin[0] === './plugins/with-share-extension',
  ) as [string, { excludedExpoModules: string[]; excludedCommunityModules: string[] }];
  return entry[1];
})();

async function prebuild(podfile = TEMPLATE): Promise<string> {
  const config = withShareExtensionPodfile({ ...appConfig }, shareOptions);
  const result = await config.mods?.ios?.podfile?.({
    ...config,
    modRequest: { platformProjectRoot: '/nowhere', projectRoot: APP_ROOT },
    modResults: { contents: podfile },
  });
  if (!result?.modResults) throw new Error('the podfile mod returned no results');
  return result.modResults.contents;
}

const SHARE_TARGET = /^target 'BracemarkShareExtension' do$/m;
const shareBlock = (podfile: string) => podfile.slice(podfile.search(SHARE_TARGET));
const appBlock = (podfile: string) => podfile.slice(0, podfile.search(SHARE_TARGET));

test('autolinks the share extension as list → filter → link', async () => {
  const share = shareBlock(await prebuild());

  expect(share).not.toContain('use_native_modules!(config_command)');
  // The order is the claim: list (which writes codegen's autolinking.json for
  // BOTH targets), then the filter, then link.
  const list = share.indexOf('share_native_modules = list_native_modules!(config_command)');
  const reject = share.indexOf('share_native_modules[:ios_packages].reject!');
  const link = share.indexOf('config = link_native_modules!(share_native_modules)');
  expect(list).toBeGreaterThan(-1);
  expect(reject).toBeGreaterThan(list);
  expect(link).toBeGreaterThan(reject);
  // …and before `use_react_native!`, which reads `config[:reactNativePath]`.
  expect(share.indexOf('use_react_native!(')).toBeGreaterThan(link);
});

// Copied, not restated — so the two targets cannot drift the way they had under
// expo-share-extension (`npx expo-modules-autolinking` against the app's `node
// --eval`).
test('uses the app’s own autolinking command and use_react_native! call', async () => {
  const podfile = await prebuild();
  const app = appBlock(podfile);
  const share = shareBlock(podfile);

  const command = /^ {2}if ENV\['EXPO_USE_COMMUNITY_AUTOLINKING'\][\s\S]*?^ {2}end$/m;
  const reactNative = /^ {2}use_react_native!\([\s\S]*?^ {2}\)$/m;
  expect(command.exec(share)?.[0]).toBe(command.exec(app)?.[0]);
  expect(reactNative.exec(share)?.[0]).toBe(reactNative.exec(app)?.[0]);
});

test('excludes the configured Expo modules, and expo-updates always', async () => {
  const share = shareBlock(await prebuild());
  const exclude = JSON.parse(/^ {2}exclude = (\[.*\])$/m.exec(share)?.[1] ?? 'null') as string[];

  expect(exclude[0]).toBe('expo-updates');
  expect(new Set(exclude)).toEqual(new Set(['expo-updates', ...shareOptions.excludedExpoModules]));
  expect(share).toContain('use_expo_modules!(exclude: exclude)');
});

test('leaves the app target’s own autolinking alone', async () => {
  const app = appBlock(await prebuild());

  expect(app).toContain('  config = use_native_modules!(config_command)');
  expect(app).not.toContain('share_native_modules');
  expect(app).toMatch(/^ {2}use_expo_modules!$/m);
});

// Inside the app's post_install, after React Native's own call, so its settings
// are the last word for every pod — the extension's included.
test('lets every pod use app-only API, from inside post_install', async () => {
  const app = appBlock(await prebuild());
  const postInstall = app.indexOf('post_install do |installer|');
  const call = app.indexOf('react_native_post_install(');
  const setting = app.indexOf("config.build_settings['APPLICATION_EXTENSION_API_ONLY'] = 'No'");

  expect(postInstall).toBeGreaterThan(-1);
  expect(setting).toBeGreaterThan(call);
  expect(call).toBeGreaterThan(postInstall);
  // Still inside the block: the block's `end` comes after it.
  expect(app.indexOf('\n  end\n', setting)).toBeGreaterThan(setting);
});

test('is idempotent across a second prebuild over the same Podfile', async () => {
  const once = await prebuild();
  expect(await prebuild(once)).toBe(once);
});

// A template the plugin no longer understands must stop the prebuild, not
// leave the extension linking nothing — or everything.
test('throws on a template without the pieces it copies', async () => {
  await expect(prebuild(TEMPLATE.replace(/use_react_native!/g, 'use_rn!'))).rejects.toThrow(
    /could not find use_react_native!/,
  );
  await expect(prebuild(TEMPLATE.replace(/react_native_post_install/g, 'rn_post'))).rejects.toThrow(
    /could not find react_native_post_install/,
  );
});

// The generated Ruby, run: `list_native_modules!` returns symbol keys
// (react-native/scripts/cocoapods/autolinking.rb) and the filter has to match on
// `package[:name]`, the npm name. A string-keyed or `:package_name` filter would
// parse, install and drop nothing.
test('the generated Ruby drops exactly the excluded packages', async () => {
  const share = shareBlock(await prebuild());
  const generated = share.slice(
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
    ${generated}
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

// podfile.js's ⚠: a library dropped from the extension must register no Fabric
// component, or codegen's shared RCTThirdPartyComponentsProvider builds a
// dictionary literal with a nil in it and the extension dies at launch. What
// codegen reads is each library's `codegenConfig.ios.componentProvider`, so a
// bump that adds one to an excluded library fails here.
test('excludes no library that registers a Fabric component', async () => {
  // The list as the Podfile carries it, so the check reads what pods will see.
  const match = /reject! do \|package\|\n\s*(\[.*\])\.include\?/.exec(shareBlock(await prebuild()));
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
