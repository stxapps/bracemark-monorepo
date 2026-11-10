// The rest of plugins/with-share-extension — the iOS share extension's Xcode
// target (target.js), its Info.plist and entitlements (files.js), and the pass
// that makes it agree with the app (identity.js) — run for real, the way
// share-extension-podfile.spec.ts runs podfile.js.
//
// This is the half of the vendoring we took on: expo-share-extension generated
// the target through the `xcode` package's helpers, and target.js writes every
// pbxproj object itself (docs/dependency-upgrades.md, _the app-side blocker_ —
// "the part that breaks across Xcode versions"). A slip there is not a failed
// prebuild. It is a project Xcode opens with a file in red, an extension that
// is built and never embedded, a share sheet that does not list Bracemark, or
// an archive App Store Connect rejects — each one an hour from the edit.
//
// The mods run against `__fixtures__/expo-sdk54.pbxproj`: the project of the
// SDK 54 prebuild template (`expo/template.tgz`, ios/HelloWorld.xcodeproj),
// verbatim. Prebuild renames HelloWorld; nothing here depends on the name — the
// plugin finds the app by product type. Refresh the fixture from the new
// template when the SDK moves.
//
// What this cannot see: that Xcode builds what the project describes, and that
// the system offers the extension. Those are a Debug build and SHARE-IOS-001
// (docs/e2e.md).

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

type Entry = { value: string; comment: string };
type PbxObject = Record<string, unknown> & {
  name?: string;
  buildSettings?: Record<string, unknown>;
};
type Objects = Record<string, Record<string, PbxObject | string>>;
type Project = {
  parseSync: () => Project;
  writeSync: () => string;
  hash: { project: { objects: Objects } };
};
type ModConfig = Record<string, unknown> & {
  mods?: { ios?: Record<string, (config: Record<string, unknown>) => Promise<ModConfig>> };
};
type Plugin = (config: ModConfig, props: Record<string, unknown>) => ModConfig;

const APP_ROOT = path.join(__dirname, '..', '..', '..');
const FIXTURE = path.join(__dirname, '__fixtures__', 'expo-sdk54.pbxproj');
const PLUGIN = '../../../plugins/with-share-extension';

const { fromConfigPlugins } = jest.requireActual<{
  fromConfigPlugins: (id: string) => unknown;
}>(`${PLUGIN}/util`);
const xcode = fromConfigPlugins('xcode') as { project: (file: string) => Project };
const plist = fromConfigPlugins('@expo/plist') as {
  parse: (text: string) => Record<string, unknown>;
  build: (value: unknown) => string;
};

const { withShareExtensionFiles } = jest.requireActual<{ withShareExtensionFiles: Plugin }>(
  `${PLUGIN}/files`,
);
const { withShareExtensionTarget } = jest.requireActual<{ withShareExtensionTarget: Plugin }>(
  `${PLUGIN}/target`,
);
const { withShareExtensionIdentity } = jest.requireActual<{ withShareExtensionIdentity: Plugin }>(
  `${PLUGIN}/identity`,
);

const { default: appConfig } = jest.requireActual<{
  default: {
    name: string;
    version: string;
    ios: { bundleIdentifier: string; buildNumber: string; entitlements: Record<string, string[]> };
    plugins: unknown[];
  } & Record<string, unknown>;
}>('../../../app.config');

// The options app.config.ts actually passes, plus the two index.js fixes, so
// what is checked is what ships.
const shareOptions = (() => {
  const entry = appConfig.plugins.find(
    (plugin) => Array.isArray(plugin) && plugin[0] === './plugins/with-share-extension',
  ) as [string, { activationRules: unknown[]; preprocessingFile: string }];
  const index = fs.readFileSync(
    path.join(APP_ROOT, 'plugins', 'with-share-extension', 'index.js'),
    'utf8',
  );
  const fixed = (key: string) => {
    const value = new RegExp(`${key}: '([^']+)'`).exec(index)?.[1];
    if (!value) throw new Error(`index.js no longer fixes \`${key}\``);
    return value;
  };
  return { ...entry[1], controller: fixed('controller'), entryFile: fixed('entryFile') };
})();

const TEAM = 'TEAM123456';
const TARGET = 'BracemarkShareExtension';
// What `expo-build-properties` and core `withDeviceFamily` leave on the APP
// target — and never on an app-extension target (identity.js's header).
const APP_DEPLOYMENT_TARGET = '26.0';
const APP_DEVICE_FAMILY = '"1,2"';

const unquote = (value: unknown) => String(value).replace(/^"|"$/g, '');
// A quoted pbxproj string as the text it stands for: the parser hands back the
// token as written, escapes and all.
const unescape = (value: unknown) => unquote(value).replace(/\\(["\\])/g, '$1');
const section = (project: Project, isa: string): [string, PbxObject][] =>
  Object.entries(project.hash.project.objects[isa] ?? {}).filter(
    (entry): entry is [string, PbxObject] => !entry[0].endsWith('_comment'),
  );
const object = (project: Project, isa: string, uuid: string) =>
  project.hash.project.objects[isa][uuid] as PbxObject;
const nativeTarget = (project: Project, name: string) => {
  const found = section(project, 'PBXNativeTarget').find(
    ([, target]) => unquote(target.name) === name,
  );
  if (!found) throw new Error(`no target "${name}" in the project`);
  return found[1];
};
const appTarget = (project: Project) => {
  const found = section(project, 'PBXNativeTarget').find(
    ([, target]) => unquote(target.productType) === 'com.apple.product-type.application',
  );
  if (!found) throw new Error('no application target in the project');
  return found[1];
};
const configurationsOf = (project: Project, target: PbxObject) =>
  (
    object(project, 'XCConfigurationList', target.buildConfigurationList as string)
      .buildConfigurations as Entry[]
  ).map(({ value }) => object(project, 'XCBuildConfiguration', value));
const phasesOf = (target: PbxObject) => target.buildPhases as Entry[];
// The files a build phase holds, as the file references behind them.
const filesOf = (project: Project, isa: string, phase: Entry) =>
  (object(project, isa, phase.value).files as Entry[]).map(({ value }) =>
    object(project, 'PBXFileReference', object(project, 'PBXBuildFile', value).fileRef as string),
  );

const temporary: string[] = [];
afterAll(() => {
  for (const dir of temporary) fs.rmSync(dir, { recursive: true, force: true });
});

// One prebuild, in the order the mod compiler runs these (`dangerous`, then
// `xcodeproj`, then `finalized`), into a throwaway `ios/`.
async function prebuild(
  options: {
    props?: Record<string, unknown>;
    teamAtCreation?: string | undefined;
    appPlist?: Record<string, unknown>;
    finalize?: boolean;
  } = {},
): Promise<{ ios: string; project: Project; pbxprojPath: string }> {
  const props = { ...shareOptions, ...options.props };
  const config = (team: string | undefined): ModConfig => ({
    ...appConfig,
    ios: { ...appConfig.ios, appleTeamId: team },
  });
  const ios = fs.mkdtempSync(path.join(os.tmpdir(), 'share-extension-'));
  temporary.push(ios);
  const request = (platformProjectRoot: string) => ({
    projectRoot: APP_ROOT,
    platformProjectRoot,
    projectName: 'Bracemark',
  });
  const run = async (plugin: Plugin, key: string, team: string | undefined, extra: object) => {
    const withMod = plugin(config(team), props);
    const result = await withMod.mods?.ios?.[key]?.({ ...withMod, ...extra });
    if (!result) throw new Error(`the ${key} mod returned nothing`);
    return result;
  };

  // The app's own Info.plist, as prebuild leaves it: literals, not references.
  fs.mkdirSync(path.join(ios, 'HelloWorld'));
  fs.writeFileSync(
    path.join(ios, 'HelloWorld', 'Info.plist'),
    plist.build({
      CFBundleShortVersionString: appConfig.version,
      CFBundleVersion: appConfig.ios.buildNumber,
      CFBundleDisplayName: appConfig.name,
      ...options.appPlist,
    }),
  );

  await run(withShareExtensionFiles, 'dangerous', TEAM, { modRequest: request(ios) });

  const project = xcode.project(FIXTURE).parseSync();
  for (const buildConfig of configurationsOf(project, appTarget(project))) {
    Object.assign(buildConfig.buildSettings ?? {}, {
      IPHONEOS_DEPLOYMENT_TARGET: APP_DEPLOYMENT_TARGET,
      TARGETED_DEVICE_FAMILY: APP_DEVICE_FAMILY,
    });
  }
  // The REAL `ios/` as the platform root here, though nothing is written to it:
  // the in-place references are relative to it, and these are the paths Xcode
  // will resolve.
  const team = 'teamAtCreation' in options ? options.teamAtCreation : TEAM;
  await run(withShareExtensionTarget, 'xcodeproj', team, {
    modRequest: request(path.join(APP_ROOT, 'ios')),
    modResults: project,
  });

  const pbxprojPath = path.join(ios, 'Bracemark.xcodeproj', 'project.pbxproj');
  fs.mkdirSync(path.dirname(pbxprojPath));
  fs.writeFileSync(pbxprojPath, project.writeSync());

  if (options.finalize !== false) {
    await run(withShareExtensionIdentity, 'finalized', TEAM, { modRequest: request(ios) });
  }
  // Re-read from disk: what is checked is the file prebuild leaves behind.
  return { ios, project: xcode.project(pbxprojPath).parseSync(), pbxprojPath };
}

const extensionPlist = (ios: string) =>
  plist.parse(fs.readFileSync(path.join(ios, TARGET, 'Info.plist'), 'utf8')) as Record<
    string,
    unknown
  > & {
    NSExtension: {
      NSExtensionAttributes: Record<string, unknown> & {
        NSExtensionActivationRule: Record<string, unknown>;
      };
      NSExtensionPrincipalClass: string;
      NSExtensionPointIdentifier: string;
    };
  };

describe('the Xcode target', () => {
  // A target the app does not embed builds, signs, and ships nowhere: the
  // share sheet simply never lists Bracemark.
  test('is an app extension the app depends on and embeds in PlugIns', async () => {
    const { project } = await prebuild();
    const extension = nativeTarget(project, TARGET);
    const app = appTarget(project);

    expect(unquote(extension.productType)).toBe('com.apple.product-type.app-extension');
    expect(section(project, 'PBXNativeTarget')).toHaveLength(2);

    const dependencies = (app.dependencies as Entry[]).map(
      ({ value }) => object(project, 'PBXTargetDependency', value).target,
    );
    const [extensionUuid] =
      section(project, 'PBXNativeTarget').find(([, target]) => target === extension) ?? [];
    expect(dependencies).toEqual([extensionUuid]);

    const embeds = phasesOf(app)
      .filter(({ value }) => project.hash.project.objects.PBXCopyFilesBuildPhase?.[value])
      .map(({ value }) => object(project, 'PBXCopyFilesBuildPhase', value));
    // ONE embed phase. (Upstream left an empty one beside a "Copy Files".)
    expect(embeds).toHaveLength(1);
    // 13 is PlugIns, where the system looks for an app's extensions.
    expect(embeds[0].dstSubfolderSpec).toBe(13);
    const embedded = (embeds[0].files as Entry[]).map(({ value }) =>
      object(project, 'PBXFileReference', object(project, 'PBXBuildFile', value).fileRef as string),
    );
    expect(embedded.map((file) => unquote(file.path))).toEqual([`${TARGET}.appex`]);
    expect(embedded[0]).toBe(
      object(project, 'PBXFileReference', extension.productReference as string),
    );
  });

  test('builds in the order an app target does: packager, sources, frameworks, resources, bundle', async () => {
    const { project } = await prebuild();
    expect(phasesOf(nativeTarget(project, TARGET)).map(({ comment }) => comment)).toEqual([
      'Start Packager',
      'Sources',
      'Frameworks',
      'Resources',
      'Bundle React Native code and images',
    ]);
  });

  // In place is the point of the vendoring: an edit made in Xcode lands in the
  // tracked file. It is also a path nothing checks until Xcode shows it in red
  // — after a move of the controller, the font or the preprocessing file.
  test('compiles the controller and bundles the font and preprocessing.js, in place, from files that exist', async () => {
    const { project } = await prebuild();
    const [, sources, , resources] = phasesOf(nativeTarget(project, TARGET));
    const referenced = [
      ...filesOf(project, 'PBXSourcesBuildPhase', sources),
      ...filesOf(project, 'PBXResourcesBuildPhase', resources),
    ];

    expect(referenced.map((file) => unquote(file.name))).toEqual([
      'ShareViewController.swift',
      'InterVariable.ttf',
      'preprocessing.js',
    ]);
    for (const file of referenced) {
      expect(file.sourceTree).toBe('SOURCE_ROOT');
      // SOURCE_ROOT is `ios/`; nothing of ours is copied into it.
      expect(unquote(file.path)).toMatch(/^\.\.\//);
      expect(fs.existsSync(path.join(APP_ROOT, 'ios', unquote(file.path)))).toBe(true);
    }
    // The plist's side of the same file: Safari looks the preprocessing file up
    // in the bundle by the name the Info.plist gives it.
    expect(shareOptions.preprocessingFile).toMatch(/\/preprocessing\.js$/);
  });

  // A Release build embeds index.share.js as main.jsbundle from this phase. The
  // app's entry there instead would boot the router in a 120 MB process.
  test('bundles the share entry, not the app’s', async () => {
    const { project } = await prebuild();
    const bundle = phasesOf(nativeTarget(project, TARGET))[4];
    const script = unescape(object(project, 'PBXShellScriptBuildPhase', bundle.value).shellScript);

    expect(script).toContain(`export ENTRY_FILE="$PROJECT_ROOT/${shareOptions.entryFile}"`);
    expect(shareOptions.entryFile).toBe('index.share.js');
    expect(fs.existsSync(path.join(APP_ROOT, shareOptions.entryFile))).toBe(true);
  });

  // ⚠ The bundle id is what the App Store and the provisioning profile know the
  // extension as; a different one ships a NEW extension (util.js).
  test('is signed and identified as the extension the App Store already knows', async () => {
    const { project } = await prebuild({ finalize: false });
    const configurations = configurationsOf(project, nativeTarget(project, TARGET));

    expect(configurations.map((buildConfig) => buildConfig.name)).toEqual(['Debug', 'Release']);
    for (const { buildSettings = {} } of configurations) {
      expect(unquote(buildSettings.PRODUCT_BUNDLE_IDENTIFIER)).toBe(
        `${appConfig.ios.bundleIdentifier}.ShareExtension`,
      );
      expect(buildSettings.DEVELOPMENT_TEAM).toBe(TEAM);
      expect(unquote(buildSettings.INFOPLIST_FILE)).toBe(`${TARGET}/Info.plist`);
      expect(unquote(buildSettings.CODE_SIGN_ENTITLEMENTS)).toBe(
        `${TARGET}/${TARGET}.entitlements`,
      );
      // identity.js's to copy from the app, and nobody else's to guess.
      expect(buildSettings).not.toHaveProperty('IPHONEOS_DEPLOYMENT_TARGET');
      expect(buildSettings).not.toHaveProperty('TARGETED_DEVICE_FAMILY');
    }
    // The two files those settings name are the two files.js writes.
    const { ios } = await prebuild();
    expect(fs.readdirSync(path.join(ios, TARGET)).sort()).toEqual([
      `${TARGET}.entitlements`,
      'Info.plist',
    ]);
    // `#if DEBUG` in the controller picks Metro over the embedded bundle.
    expect(configurations[0].buildSettings?.SWIFT_ACTIVE_COMPILATION_CONDITIONS).toBe('DEBUG');
    expect(configurations[1].buildSettings).not.toHaveProperty(
      'SWIFT_ACTIVE_COMPILATION_CONDITIONS',
    );
  });

  // target.js writes each object by hand, so nothing guarantees an id it names
  // was ever defined. Xcode's answer to a dangling one ranges from a red file
  // to refusing the project.
  test('names no object the project does not define', async () => {
    const { project } = await prebuild();
    const objects = project.hash.project.objects;
    const defined = new Set(
      Object.values(objects).flatMap((entries) =>
        Object.keys(entries).filter((key) => !key.endsWith('_comment')),
      ),
    );
    const dangling: string[] = [];
    const walk = (value: unknown, where: string) => {
      if (typeof value === 'string') {
        if (/^[0-9A-F]{24}$/.test(value) && !defined.has(value)) dangling.push(where);
      } else if (Array.isArray(value)) {
        value.forEach((item, index) => walk(item, `${where}[${index}]`));
      } else if (value && typeof value === 'object') {
        for (const [key, child] of Object.entries(value)) walk(child, `${where}.${key}`);
      }
    };
    for (const [isa, entries] of Object.entries(objects)) {
      for (const [uuid, entry] of Object.entries(entries)) {
        if (!uuid.endsWith('_comment')) walk(entry, `${isa}.${uuid}`);
      }
    }

    // The positive control: the walk does reach the extension's references.
    expect(defined.size).toBeGreaterThan(
      section(xcode.project(FIXTURE).parseSync(), 'PBXFileReference').length,
    );
    expect(dangling).toEqual([]);
  });

  // What the writer emits is an OpenStep property list, and the build scripts
  // go into it as quoted strings — one unescaped quote and Xcode cannot open
  // the project at all. `plutil` is the system's own parser.
  test('is a project file the system can parse', async () => {
    const { pbxprojPath } = await prebuild();
    const { execFileSync } =
      jest.requireActual<typeof import('node:child_process')>('node:child_process');
    try {
      execFileSync('plutil', ['-lint', pbxprojPath], { encoding: 'utf8' });
    } catch (error) {
      // No plutil: not a Mac, and this machine never opens the project.
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }
  });

  // A prebuild without --clean runs over a project that already has the target.
  test('is not added twice by a second prebuild over the same project', async () => {
    const { project } = await prebuild({ finalize: false });
    const once = project.writeSync();
    const again = withShareExtensionTarget({ ...appConfig }, shareOptions);
    await again.mods?.ios?.xcodeproj?.({
      ...again,
      modRequest: { projectRoot: APP_ROOT, platformProjectRoot: path.join(APP_ROOT, 'ios') },
      modResults: project,
    });

    expect(section(project, 'PBXNativeTarget')).toHaveLength(2);
    expect(project.writeSync()).toBe(once);
  });
});

describe('the Info.plist and entitlements', () => {
  // The class is named by a string the build resolves; a rename that misses it
  // gives an extension the system launches and cannot instantiate.
  test('declares a share extension whose principal class is the controller', async () => {
    const { ios } = await prebuild();
    const { NSExtension } = extensionPlist(ios);

    expect(NSExtension.NSExtensionPointIdentifier).toBe('com.apple.share-services');
    const principal = /^\$\(PRODUCT_MODULE_NAME\)\.(\w+)$/.exec(
      NSExtension.NSExtensionPrincipalClass,
    )?.[1];
    expect(fs.readFileSync(path.join(APP_ROOT, shareOptions.controller), 'utf8')).toContain(
      `class ${principal}: UIViewController`,
    );
  });

  // ⚠ The WEB PAGE key is what makes Safari run preprocessing.js: without it a
  // share from Safari still arrives — as a bare URL, with no title and no
  // read-mode copy, and nothing to say why.
  test('asks Safari for the page when there is a preprocessing file, and names that file', async () => {
    const { ios } = await prebuild();
    const attributes = extensionPlist(ios).NSExtension.NSExtensionAttributes;

    expect(attributes.NSExtensionActivationRule).toEqual({
      NSExtensionActivationSupportsWebPageWithMaxCount: 1,
      NSExtensionActivationSupportsWebURLWithMaxCount: 1,
      NSExtensionActivationSupportsText: true,
    });
    // By its name without the extension — and it is the file the target bundles.
    expect(attributes.NSExtensionJavaScriptPreprocessingFile).toBe(
      path.basename(shareOptions.preprocessingFile, '.js'),
    );
  });

  test('offers a web URL alone without one, and refuses a rule the controller cannot read', async () => {
    const { ios } = await prebuild({
      props: { preprocessingFile: undefined, activationRules: [{ type: 'url', max: 3 }] },
      finalize: false,
    });
    const attributes = extensionPlist(ios).NSExtension.NSExtensionAttributes;
    expect(attributes.NSExtensionActivationRule).toEqual({
      NSExtensionActivationSupportsWebURLWithMaxCount: 3,
    });
    expect(attributes).not.toHaveProperty('NSExtensionJavaScriptPreprocessingFile');

    // The controller's image, video and file branches went with the vendoring;
    // a rule for one would list Bracemark for shares it then shows as empty.
    await expect(
      prebuild({ props: { activationRules: [{ type: 'image' }] }, finalize: false }),
    ).rejects.toThrow(/activation rule "image" is not supported/);
  });

  // A font file in the bundle that UIAppFonts does not name is not registered:
  // the sheet falls back to the system face, silently.
  test('registers the fonts expo-font embeds, by file name', async () => {
    const { ios, project } = await prebuild();
    const fonts = extensionPlist(ios).UIAppFonts as string[];
    const [, , , resources] = phasesOf(nativeTarget(project, TARGET));
    const bundled = filesOf(project, 'PBXResourcesBuildPhase', resources).map((file) =>
      unquote(file.name),
    );

    expect(fonts.length).toBeGreaterThan(0);
    for (const font of fonts) expect(bundled).toContain(font);
  });

  // Two targets, one container: the snapshot and outbox files, and the session
  // mirror's keychain group. A second group here is a container the app never
  // opens.
  test('entitles the extension to exactly the app’s App Group', async () => {
    const { ios } = await prebuild();
    const entitlements = plist.parse(
      fs.readFileSync(path.join(ios, TARGET, `${TARGET}.entitlements`), 'utf8'),
    );

    expect(entitlements).toEqual({
      'com.apple.security.application-groups':
        appConfig.ios.entitlements['com.apple.security.application-groups'],
    });
  });

  test('stops the prebuild when the app config does not name exactly one App Group', async () => {
    for (const groups of [undefined, [], ['group.a', 'group.b']]) {
      const config = {
        ...appConfig,
        ios: {
          ...appConfig.ios,
          entitlements: { 'com.apple.security.application-groups': groups },
        },
      } as ModConfig;
      const withMod = withShareExtensionFiles(config, shareOptions);
      await expect(
        (async () =>
          withMod.mods?.ios?.dangerous?.({
            ...withMod,
            modRequest: { projectRoot: APP_ROOT, platformProjectRoot: os.tmpdir() },
          }))(),
      ).rejects.toThrow(/must name exactly one App Group/);
    }
  });
});

describe('the agreement with the app', () => {
  // `expo-build-properties` skips an app-extension target by design, and core
  // `withDeviceFamily` runs before this one exists. Unset, the extension links
  // Pods built for a newer iOS than it targets, and on an iPad the share sheet
  // runs it in iPhone compatibility mode.
  test('copies the deployment target and device family from the app target', async () => {
    const before = await prebuild({ finalize: false });
    for (const { buildSettings } of configurationsOf(
      before.project,
      nativeTarget(before.project, TARGET),
    )) {
      expect(buildSettings).not.toHaveProperty('IPHONEOS_DEPLOYMENT_TARGET');
    }

    const { project } = await prebuild();
    for (const { buildSettings = {} } of configurationsOf(project, nativeTarget(project, TARGET))) {
      expect(buildSettings.IPHONEOS_DEPLOYMENT_TARGET).toBe(APP_DEPLOYMENT_TARGET);
      expect(buildSettings.TARGETED_DEVICE_FAMILY).toBe(APP_DEVICE_FAMILY);
    }
  });

  // App Store validation rejects an extension whose version differs from the
  // app's, at upload. The template leaves MARKETING_VERSION = 1.0 on the app.
  test('puts the version the app ships on every target', async () => {
    const { project } = await prebuild({
      appPlist: { CFBundleShortVersionString: '9.8.7', CFBundleVersion: '42' },
    });

    for (const [, target] of section(project, 'PBXNativeTarget')) {
      for (const { buildSettings = {} } of configurationsOf(project, target)) {
        expect(buildSettings.MARKETING_VERSION).toBe('9.8.7');
        expect(String(buildSettings.CURRENT_PROJECT_VERSION)).toBe('42');
      }
    }
  });

  // The guards, which exist because each of these is otherwise found at
  // archive time, at upload, or in front of a user.
  test('stops the prebuild when the label under the icon is not the app’s name', async () => {
    await expect(prebuild({ appPlist: { CFBundleDisplayName: 'Bracemark Beta' } })).rejects.toThrow(
      /ships CFBundleDisplayName "Bracemark", but the app ships "Bracemark Beta"/,
    );
  });

  test('stops the prebuild when the extension has no team and the app has one', async () => {
    await expect(prebuild({ teamAtCreation: undefined })).rejects.toThrow(
      /has no DEVELOPMENT_TEAM/,
    );
  });
});
