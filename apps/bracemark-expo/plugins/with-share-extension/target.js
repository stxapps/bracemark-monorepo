const path = require('node:path');

const { withXcodeProject } = require('expo/config-plugins');

const { shareExtensionNames, expoFonts, pbx } = require('./util');

// THE SHARE EXTENSION'S XCODE TARGET, written into the generated pbxproj.
//
// Vendored from expo-share-extension 5.0.6 (MIT, © Max Ast; ./LICENSE-expo-share-extension) — its
// `withShareExtensionTarget` and `xcode/*` helpers — and rewritten to write
// each object directly, so the result reads like a target Xcode itself would
// make: phases named Sources / Frameworks / Resources rather than five phases
// all called "Embed Foundation Extensions", one embed phase on the app rather
// than an empty one beside a "Copy Files", no orphaned build files.
//
// ⚠ THE CONTROLLER, THE FONT AND preprocessing.js ARE REFERENCED IN PLACE —
// `sourceTree = SOURCE_ROOT`, relative to `ios/` — not copied into it. Upstream
// copied the controller out of node_modules on every prebuild, so an edit in
// `ios/` died at the next `--clean` and four config plugins had to patch the
// copy instead (docs/share-sheet.md, _"Full-screen" is a SIZE_). Referenced,
// an edit made in Xcode lands in the tracked file. Only the generated
// Info.plist and entitlements live in `ios/<target>/` (files.js).
//
// What this does NOT set, on purpose: the deployment target and the device
// family. Other plugins write those onto the app target, some after this runs,
// so identity.js copies them across in a `finalized` pass and asserts the two
// targets agree.

const PHASE = 2147483647;

// The "Start Packager" phase, as React Native's own app template writes it.
const START_PACKAGER = `export RCT_METRO_PORT="\${RCT_METRO_PORT:=8081}"
echo "export RCT_METRO_PORT=\${RCT_METRO_PORT}" > "\${SRCROOT}/../node_modules/react-native/scripts/.packager.env"
if [ -z "\${RCT_NO_LAUNCH_PACKAGER+xxx}" ] ; then
  if nc -w 5 -z localhost \${RCT_METRO_PORT} ; then
    if ! curl -s "http://localhost:\${RCT_METRO_PORT}/status" | grep -q "packager-status:running" ; then
      echo "Port \${RCT_METRO_PORT} already in use, packager is either not running or not running correctly"
      exit 2
    fi
  else
    open "$SRCROOT/../node_modules/react-native/scripts/launchPackager.command" || echo "Can't start packager automatically"
  fi
fi
`;

// Embeds the share bundle as `main.jsbundle` in a Release build — the app's own
// phase, pointed at the share entry. (A Debug build asks Metro instead:
// ShareViewController's `bundleURL()`.)
const bundleReactNative = (entryFile) => `set -e
NODE_BINARY=\${NODE_BINARY:-node}

# Source environment files
if [[ -f "$PODS_ROOT/../.xcode.env" ]]; then
  source "$PODS_ROOT/../.xcode.env"
fi
if [[ -f "$PODS_ROOT/../.xcode.env.local" ]]; then
  source "$PODS_ROOT/../.xcode.env.local"
fi

export PROJECT_ROOT="$PROJECT_DIR"/..
export ENTRY_FILE="$PROJECT_ROOT/${entryFile}"

if [[ -z "$CLI_PATH" ]]; then
  export CLI_PATH="$("$NODE_BINARY" --print "require.resolve('@expo/cli', { paths: [require.resolve('expo/package.json')] })")"
fi
if [[ -z "$BUNDLE_COMMAND" ]]; then
  export BUNDLE_COMMAND="export:embed"
fi

REACT_NATIVE_SCRIPTS_PATH=$("$NODE_BINARY" --print "require('path').dirname(require.resolve('react-native/package.json')) + '/scripts'")
WITH_ENVIRONMENT="$REACT_NATIVE_SCRIPTS_PATH/xcode/with-environment.sh"
REACT_NATIVE_XCODE="$REACT_NATIVE_SCRIPTS_PATH/react-native-xcode.sh"

/bin/sh -c "$WITH_ENVIRONMENT $REACT_NATIVE_XCODE"
`;

const FILE_TYPES = {
  '.swift': 'sourcecode.swift',
  '.ttf': 'file',
  '.otf': 'file',
  '.js': 'sourcecode.javascript',
  '.plist': 'text.plist.xml',
  '.entitlements': 'text.plist.entitlements',
};

function addShareExtensionTarget(project, opts) {
  const objects = project.hash.project.objects;
  const add = (isa, object, comment) => {
    const uuid = project.generateUuid();
    objects[isa] ??= {};
    objects[isa][uuid] = { isa, ...object };
    objects[isa][`${uuid}_comment`] = comment;
    return uuid;
  };
  const ref = (value, comment) => ({ value, comment });

  const { targetName, bundleIdentifier, entitlementsFile } = opts.names;

  // --- files ---------------------------------------------------------------

  const fileRef = (file, { inPlace }) => {
    const name = path.basename(file);
    return ref(
      add(
        'PBXFileReference',
        {
          lastKnownFileType: pbx(FILE_TYPES[path.extname(file)] ?? 'file'),
          name: pbx(name),
          path: pbx(file),
          // In-place files resolve from the project's directory (`ios/`); the
          // generated two resolve from the target's group.
          sourceTree: inPlace ? 'SOURCE_ROOT' : pbx('<group>'),
        },
        name,
      ),
      name,
    );
  };
  const buildFile = (file, phaseName) => {
    const comment = `${file.comment} in ${phaseName}`;
    return ref(
      add('PBXBuildFile', { fileRef: file.value, fileRef_comment: file.comment }, comment),
      comment,
    );
  };

  const controller = fileRef(opts.controller, { inPlace: true });
  const resources = opts.resources.map((file) => fileRef(file, { inPlace: true }));
  const plistRef = fileRef('Info.plist', { inPlace: false });
  const entitlementsRef = fileRef(entitlementsFile, { inPlace: false });

  const productName = `${targetName}.appex`;
  const product = ref(
    add(
      'PBXFileReference',
      {
        explicitFileType: pbx('wrapper.app-extension'),
        includeInIndex: 0,
        path: pbx(productName),
        sourceTree: 'BUILT_PRODUCTS_DIR',
      },
      productName,
    ),
    productName,
  );

  const group = ref(
    add(
      'PBXGroup',
      {
        children: [controller, ...resources, plistRef, entitlementsRef],
        name: pbx(targetName),
        path: pbx(targetName),
        sourceTree: pbx('<group>'),
      },
      targetName,
    ),
    targetName,
  );

  const pbxProject = project.getFirstProject().firstProject;
  objects.PBXGroup[pbxProject.mainGroup].children.push(group);
  objects.PBXGroup[pbxProject.productRefGroup].children.push(product);

  // --- phases --------------------------------------------------------------

  const phase = (isa, name, object) =>
    ref(
      add(isa, { buildActionMask: PHASE, runOnlyForDeploymentPostprocessing: 0, ...object }, name),
      name,
    );
  const script = (name, shellScript) =>
    phase('PBXShellScriptBuildPhase', name, {
      files: [],
      inputPaths: [],
      name: pbx(name),
      outputPaths: [],
      shellPath: '/bin/sh',
      shellScript: pbx(shellScript),
    });

  const buildPhases = [
    script('Start Packager', START_PACKAGER),
    phase('PBXSourcesBuildPhase', 'Sources', { files: [buildFile(controller, 'Sources')] }),
    phase('PBXFrameworksBuildPhase', 'Frameworks', { files: [] }),
    phase('PBXResourcesBuildPhase', 'Resources', {
      files: resources.map((file) => buildFile(file, 'Resources')),
    }),
    script('Bundle React Native code and images', bundleReactNative(opts.entryFile)),
  ];

  // --- build settings ------------------------------------------------------

  const settings = {
    CLANG_ENABLE_MODULES: 'YES',
    CODE_SIGN_ENTITLEMENTS: pbx(`${targetName}/${entitlementsFile}`),
    CURRENT_PROJECT_VERSION: pbx(opts.buildNumber),
    ...(opts.developmentTeam && { DEVELOPMENT_TEAM: pbx(opts.developmentTeam) }),
    ENABLE_ON_DEMAND_RESOURCES: 'NO',
    GENERATE_INFOPLIST_FILE: 'YES',
    INFOPLIST_FILE: pbx(`${targetName}/Info.plist`),
    LD_RUNPATH_SEARCH_PATHS: pbx(
      '$(inherited) @executable_path/Frameworks @executable_path/../../Frameworks',
    ),
    MARKETING_VERSION: pbx(opts.marketingVersion),
    PRODUCT_BUNDLE_IDENTIFIER: pbx(bundleIdentifier),
    PRODUCT_NAME: pbx(targetName),
    SWIFT_VERSION: '5.0',
    VERSIONING_SYSTEM: pbx('apple-generic'),
  };
  const configuration = (name, extra) =>
    ref(
      add('XCBuildConfiguration', { buildSettings: { ...settings, ...extra }, name }, name),
      name,
    );
  const configurationListComment = `Build configuration list for PBXNativeTarget "${targetName}"`;
  const configurationList = add(
    'XCConfigurationList',
    {
      buildConfigurations: [
        configuration('Debug', { SWIFT_ACTIVE_COMPILATION_CONDITIONS: 'DEBUG' }),
        configuration('Release', {}),
      ],
      defaultConfigurationIsVisible: 0,
      defaultConfigurationName: 'Release',
    },
    configurationListComment,
  );

  // --- the target, and the app embedding it --------------------------------

  const target = add(
    'PBXNativeTarget',
    {
      buildConfigurationList: configurationList,
      buildConfigurationList_comment: configurationListComment,
      buildPhases,
      buildRules: [],
      dependencies: [],
      name: pbx(targetName),
      productName: pbx(targetName),
      productReference: product.value,
      productReference_comment: product.comment,
      productType: pbx('com.apple.product-type.app-extension'),
    },
    targetName,
  );

  const projectUuid = project.getFirstProject().uuid;
  pbxProject.targets.push(ref(target, targetName));
  pbxProject.attributes.TargetAttributes ??= {};
  pbxProject.attributes.TargetAttributes[target] = { LastSwiftMigration: 1250 };

  const proxy = add(
    'PBXContainerItemProxy',
    {
      containerPortal: projectUuid,
      containerPortal_comment: 'Project object',
      proxyType: 1,
      remoteGlobalIDString: target,
      remoteInfo: pbx(targetName),
    },
    'PBXContainerItemProxy',
  );
  const dependency = add(
    'PBXTargetDependency',
    {
      target,
      target_comment: targetName,
      targetProxy: proxy,
      targetProxy_comment: 'PBXContainerItemProxy',
    },
    'PBXTargetDependency',
  );

  const app = objects.PBXNativeTarget[opts.appTarget];
  app.dependencies.push(ref(dependency, 'PBXTargetDependency'));
  // dstSubfolderSpec 13 is PlugIns — where an app's extensions live.
  app.buildPhases.push(
    phase('PBXCopyFilesBuildPhase', 'Embed Foundation Extensions', {
      dstPath: pbx(''),
      dstSubfolderSpec: 13,
      files: [buildFile(product, 'Embed Foundation Extensions')],
      name: pbx('Embed Foundation Extensions'),
    }),
  );
}

const withShareExtensionTarget = (config, props) =>
  withXcodeProject(config, (cfg) => {
    const project = cfg.modResults;
    const names = shareExtensionNames(cfg);
    const { projectRoot, platformProjectRoot } = cfg.modRequest;

    const targets = project.pbxNativeTargetSection();
    const existing = Object.entries(targets).find(
      ([key, target]) =>
        !key.endsWith('_comment') && target.name?.replace(/"/g, '') === names.targetName,
    );
    // A prebuild without --clean: the target is already there, and its
    // settings are identity.js's to keep in step.
    if (existing) return cfg;

    const [appTarget] =
      Object.entries(targets).find(
        ([key, target]) =>
          !key.endsWith('_comment') &&
          target.productType?.replace(/"/g, '') === 'com.apple.product-type.application',
      ) ?? [];
    if (!appTarget) {
      throw new Error('with-share-extension: the Xcode project has no application target.');
    }

    // Project-root-relative paths (as app.config.ts writes them), made
    // relative to `ios/` for SOURCE_ROOT.
    const inPlace = (file) => path.relative(platformProjectRoot, path.resolve(projectRoot, file));

    addShareExtensionTarget(project, {
      names,
      appTarget,
      controller: inPlace(props.controller),
      resources: [
        ...expoFonts(cfg),
        ...(props.preprocessingFile ? [props.preprocessingFile] : []),
      ].map(inPlace),
      entryFile: props.entryFile,
      developmentTeam: cfg.ios?.appleTeamId,
      marketingVersion: cfg.version ?? '1.0.0',
      buildNumber: cfg.ios?.buildNumber ?? '1',
    });
    return cfg;
  });

module.exports = { withShareExtensionTarget };
