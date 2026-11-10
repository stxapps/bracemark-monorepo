import type { ExpoConfig } from 'expo/config';

// The Expo app config. This is TS rather than the app.json it replaced for one
// reason: `ios.appleTeamId` has to come from the environment. In JSON it was
// the LITERAL string "process.env.APPLE_TEAM_ID" — JSON has no interpolation —
// and @expo/config-plugins' withDevelopmentTeam wrote that value verbatim into
// DEVELOPMENT_TEAM, so app signing was broken. (Reaching the iOS share
// extension's target is a separate problem with a separate plugin below —
// docs/expo-build.md, "ios share extension build settings".)
//
// APPLE_TEAM_ID is read from `.env.local` (gitignored; see docs/env-files.md).
// It is NOT `EXPO_PUBLIC_`-prefixed on purpose — that prefix means "inline into
// the JS bundle", and this value is only ever needed at config-evaluation time.
// `expo prebuild` forces NODE_ENV=development before loading env files, which
// is why the var belongs in the mode-agnostic `.env.local` and not in
// `.env.production`. Unset is safe: withDevelopmentTeam skips a falsy id and
// leaves the pbxproj alone, so a clone without the file still prebuilds — you
// just pick the team by hand in Xcode.
const config: ExpoConfig = {
  name: 'Bracemark',
  slug: 'bracemark',
  // ONE version string, and it has to be this key rather than `ios.version` /
  // `android.version`: plugins/with-share-extension seeds the iOS share extension
  // target's MARKETING_VERSION from the top-level `config.version`, `expo-constants` hands
  // that same value to Settings → About, and only the app target takes
  // `ios.version`. Scaffolded as 0.0.0 here with 1.0.0 on both platform blocks,
  // the three disagreed SILENTLY: the app bundle said 1.0.0, the iOS share
  // extension shipped CFBundleShortVersionString 0.0.0 — which App Store
  // validation rejects at upload, the first place it is reported — and About
  // read "0.0.0 (1)" to the user. The platform overrides are gone so there is
  // one number to bump. `buildNumber`/`versionCode` stay per-platform because
  // they are genuinely different concepts. → docs/expo-build.md, _versions_.
  version: '1.3.0',
  // Every orientation, on every device — not portrait with tablets excepted.
  // iPadOS requires all four for Split View / Stage Manager unless the app
  // opts out of multitasking (`UIRequiresFullScreen`), Android 16 ignores a
  // lock on any display 600dp+ anyway, and on Android 13–15 a lock letterboxes
  // a landscape tablet. A phone-only lock was weighed and dropped: it can't be
  // said per device class in this file, and it would buy nothing a split-screen
  // or freeform window — or a Flip's cover screen — doesn't already demand, since
  // those hand the app the same short, wide windows a rotation does.
  // docs/expo-build.md, _devices_.
  orientation: 'default',
  icon: './assets/images/icon.png',
  scheme: 'bracemark',
  userInterfaceStyle: 'automatic',
  newArchEnabled: true,
  ios: {
    icon: {
      light: './assets/images/ios-light.png',
      dark: './assets/images/ios-dark.png',
      tinted: './assets/images/ios-tinted.png',
    },
    // iPad-native, not the iPhone build in compatibility mode. ONE-WAY: once a
    // build with iPad support ships, App Store Connect rejects any later build
    // that drops it. The Android half is a Play Console setting, not anything in
    // this file. docs/expo-build.md, _devices_.
    supportsTablet: true,
    bundleIdentifier: 'com.bracemark.app',
    appleTeamId: process.env.APPLE_TEAM_ID,
    buildNumber: '1',
    // The App Group the app and the iOS share extension share: the snapshot and
    // outbox files live in its container, and its id doubles as the keychain
    // access group for the session mirror (docs/share-sheet.md). Stated here
    // once — Expo writes it into the app's entitlements, and
    // plugins/with-share-extension into the extension's, and reads it from here.
    // ⚠ packages/expo-react/src/data/app-group.ts restates the id for JS, and
    // src/features/share/share-app-group.spec.ts pins the two together.
    entitlements: {
      'com.apple.security.application-groups': ['group.com.bracemark.app'],
    },
  },
  android: {
    adaptiveIcon: {
      foregroundImage: './assets/images/adaptive-icon.png',
      backgroundColor: '#ffffff',
    },
    edgeToEdgeEnabled: true,
    package: 'com.bracemark.app',
    versionCode: 5,
    // The local store holds decrypted data. The manifest-policy plugin also
    // excludes device transfer, which allowBackup alone does not always stop.
    allowBackup: false,
    // Android 13+ system pickers and app-private files need no legacy storage
    // access, and the app deliberately has no vibration/haptic feedback.
    blockedPermissions: [
      'android.permission.READ_EXTERNAL_STORAGE',
      'android.permission.WRITE_EXTERNAL_STORAGE',
      'android.permission.VIBRATE',
    ],
  },
  web: {
    bundler: 'metro',
    favicon: './assets/images/favicon.png',
  },
  plugins: [
    // Does the job on iOS only; the Android half is the plugin right after it.
    // On iOS the file registers under its internal family name ("Inter",
    // tools/scripts/rename-inter.py) and CoreText walks the `wght` axis by
    // itself. On Android this plugin drops it into assets/fonts/, where React
    // Native looks a family up by FILE name — `Inter.ttf`, which doesn't exist —
    // and silently falls back to the system face at regular or bold only: no
    // Inter, and no font-medium/font-semibold anywhere.
    //
    // It stays the TOP-LEVEL `fonts` key rather than `ios.fonts`, even though
    // `ios.fonts` would describe it better: plugins/with-share-extension reads
    // exactly `fonts` off this entry to embed Inter in the iOS share extension
    // target, and would silently get nothing. The Android copy that comes with it is
    // deleted again by the plugin below.
    ['expo-font', { fonts: ['./assets/fonts/InterVariable.ttf'] }],
    [
      './plugins/with-android-variable-font',
      { fontFamily: 'Inter', path: './assets/fonts/InterVariable.ttf' },
    ],
    [
      'expo-splash-screen',
      {
        image: './assets/images/splash-icon.png',
        imageWidth: 200,
        resizeMode: 'contain',
        backgroundColor: '#ffffff',
        dark: {
          image: './assets/images/splash-icon-dark.png',
          backgroundColor: '#0a0a0a',
        },
      },
    ],
    'expo-router',
    'expo-iap',
    [
      'expo-local-authentication',
      {
        faceIDPermission:
          'Bracemark uses Face ID to unlock the app and locked lists on this device.',
      },
    ],
    [
      // The app only ever calls launchImageLibraryAsync (link-edit-panel.tsx),
      // so camera/microphone are declined explicitly. Left undefined, the plugin
      // writes DEFAULT NSCameraUsageDescription + NSMicrophoneUsageDescription
      // strings and adds android.permission.RECORD_AUDIO; `false` deletes those
      // Info.plist keys and emits tools:node="remove" for CAMERA + RECORD_AUDIO
      // (the latter also cancels expo-image-picker's own manifest CAMERA entry).
      'expo-image-picker',
      {
        photosPermission:
          'Bracemark uses your photo library to let you pick a custom preview image for a saved link.',
        cameraPermission: false,
        microphonePermission: false,
      },
    ],
    [
      // The iOS SHARE EXTENSION target (not the browser extension) — vendored
      // from expo-share-extension and now ours: the plugin builds the target,
      // its Info.plist, entitlements and Podfile block; the controller is
      // modules/bracemark-share/ios-extension/ShareViewController.swift. Its
      // position in this array does not matter (identity.js is `finalized`).
      // docs/share-sheet.md, docs/dependency-upgrades.md.
      //
      // Two things the old options said, which are now code in that controller
      // rather than config: the root view is CLEAR (share-kit.tsx draws its own
      // panel inside it, over the host app under the system's dimming), and it
      // FILLS ITS SUPERVIEW — no fixed height. A 520pt container used to make
      // the keyboard unsurvivable (a ~520pt picker above a ~340pt keyboard),
      // and a screen-sized one hung the sheet 72pt off the bottom. Nothing in
      // JS may assume the surface's origin: the lift is the share frame's own
      // overlap with the keyboard, measured natively against the frame itself
      // (features/share/share-keyboard.ts), because on an iPad this container
      // is a form sheet that floats mid-screen and that the host moves for the
      // keyboard on its own.
      './plugins/with-share-extension',
      {
        activationRules: [{ type: 'url', max: 1 }, { type: 'text' }],
        excludedExpoModules: [
          'expo-dev-client',
          'expo-splash-screen',
          'expo-updates',
          'expo-image',
          'expo-iap',
          // The review sheet needs the host app's window scene, which an app
          // extension can't reach (`UIApplication.shared` is unavailable to
          // one), and the sheet never asks from here anyway
          // (src/lib/review-prompt.ts).
          'expo-store-review',
          // Never called from the sheet (its bundle names no ImageManipulator
          // module), and linking it broke every Archive: it pulls
          // SDWebImageWebPCoder → SDWebImage/Core into this target while the
          // app gets the full SDWebImage via expo-image, so CocoaPods builds
          // two variants whose SDWebImage.bundle collide in the archive's
          // UninstalledProducts ("Multiple commands produce"). A Release BUILD
          // is unaffected — only an install-action build flattens them — which
          // is why the e2e Release builds never saw it. docs/share-sheet.md.
          'expo-image-manipulator',
          // NEVER CALLED FROM THE SHEET, and linking one is not free: every
          // Expo module this target links is instantiated when the share
          // extension starts, against a hard 120MB cap the sheet runs close to
          // (docs/share-sheet.md, _the share extension has almost no memory to
          // spare_). Neither share bundle — production or dev — names any of
          // their native modules; the only dev-bundle reference, expo's
          // `withDevTools` keep-awake, is a try/catch'd optional require. The
          // dev-launcher trio is what `expo-dev-client` above pulls in (the
          // bundle only probes `NativeModules.EXDevLauncher` behind a guard).
          // Expo modules are safe to drop per target — each target gets its own
          // ExpoModulesProvider — unlike the community ones, which
          // excludedCommunityModules below can only partly drop (see the ⚠ in
          // plugins/with-share-extension/podfile.js). NOT expo-router, though
          // the sheet never routes: its Swift pod ExpoHead is what makes Expo's
          // autolinking build
          // react-native-screens with modular headers in this target, and
          // Screens has to stay linked here (that same ⚠), so without
          // expo-router `pod install` fails ("ExpoHead depends upon RNScreens,
          // which does not define modules").
          'expo-dev-launcher',
          'expo-dev-menu',
          'expo-dev-menu-interface',
          'expo-linking',
          'expo-document-picker',
          'expo-image-picker',
          'expo-sharing',
          'expo-clipboard',
          'expo-keep-awake',
          'expo-local-authentication',
          'expo-font',
          'expo-system-ui',
        ],
        // Linked into the share extension and never called from it. Only a
        // library that registers NO Fabric component can go here: codegen's
        // shared RCTThirdPartyComponentsProvider crashes the extension at start
        // on an unlinked component class (plugins/with-share-extension/podfile.js,
        // its ⚠). Worklets is the one that matters — Nitro's optional require
        // would otherwise build a second Hermes runtime in this process.
        excludedCommunityModules: [
          'react-native-reanimated',
          'react-native-worklets',
          '@react-native-community/netinfo',
        ],
        preprocessingFile: './share-extension/preprocessing.js',
      },
    ],
    // The two OS floors below are quoted by hand in bracemark-site's FAQ
    // (content/faq.tsx, `platforms`), which cannot import them. Raise one, bump
    // it there in the same change.
    [
      'expo-build-properties',
      {
        ios: {
          // 26, not the 18 it was scaffolded with: nothing below 26 has ever
          // been run, and iOS 26 restyled the system chrome. The floor only
          // lowers for free — raising it after launch strands installed users
          // on their last compatible build, talking to a moving api.
          deploymentTarget: '26.0',
        },
        android: {
          minSdkVersion: 33,
          enableMinifyInReleaseBuilds: true,
          enableShrinkResourcesInReleaseBuilds: true,
        },
      },
    ],
    // The theme crossover-time pickers (docs/theme.md). Listed bare, and it is a
    // deliberate NO-OP: this plugin exists only to restyle the Android dialogs,
    // and every one of its branches early-returns without an `android` option —
    // so the pickers keep the platform's own appearance, which is what we want.
    // It's named here anyway because `expo-doctor` flags a package whose config
    // plugin is missing from the config, and without the entry the next
    // `expo install` re-prompts for it.
    '@react-native-community/datetimepicker',
    // Play upload-key signing for release builds. Local plugin because there is
    // no signing surface in app config or expo-build-properties, and `android/`
    // is wiped by `prebuild --clean`. Handles no credential: it names four
    // BRACEMARK_UPLOAD_* Gradle properties that live in ~/.gradle/gradle.properties,
    // outside the repo, and Gradle falls back to debug signing when they are
    // absent. See docs/expo-build.md — android release signing.
    './plugins/with-android-signing',
    // Disable unqualified RTL layouts and exclude all local data from Android
    // cloud backup/device transfer. See docs/expo-build.md — android manifest policy.
    './plugins/with-android-manifest-policy',
    // expo-dev-launcher's ML Kit barcode scanner (the dev launcher's QR button)
    // is debug-only code, but on Android its libraries were linked into release
    // too: ~5 MB of native lib per ABI, a ContentProvider that runs at every
    // launch, and a Play Services module download. This strips them from
    // release only. Its release manifest also removes SYSTEM_ALERT_WINDOW
    // (debug retains it for the dev performance monitor) and two exported
    // activities nothing in release starts. See the plugin, and
    // docs/expo-build.md.
    './plugins/with-android-release-trim',
  ],
};

export default config;
