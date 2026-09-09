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
  // `android.version`: `expo-share-extension` reads the top-level `config.version`
  // for the share extension target's MARKETING_VERSION, `expo-constants` hands
  // that same value to Settings → About, and only the app target takes
  // `ios.version`. Scaffolded as 0.0.0 here with 1.0.0 on both platform blocks,
  // the three disagreed SILENTLY: the app bundle said 1.0.0, the iOS share
  // extension shipped CFBundleShortVersionString 0.0.0 — which App Store
  // validation rejects at upload, the first place it is reported — and About
  // read "0.0.0 (1)" to the user. The platform overrides are gone so there is
  // one number to bump. `buildNumber`/`versionCode` stay per-platform because
  // they are genuinely different concepts. → docs/expo-build.md, _versions_.
  version: '1.0.0',
  orientation: 'portrait',
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
    supportsTablet: false,
    bundleIdentifier: 'com.bracemark.app',
    appleTeamId: process.env.APPLE_TEAM_ID,
    buildNumber: '1',
  },
  android: {
    adaptiveIcon: {
      foregroundImage: './assets/images/adaptive-icon.png',
      backgroundColor: '#ffffff',
    },
    edgeToEdgeEnabled: true,
    package: 'com.bracemark.app',
    versionCode: 1,
  },
  web: {
    bundler: 'metro',
    favicon: './assets/images/favicon.png',
  },
  plugins: [
    ['expo-font', { fonts: ['./assets/fonts/InterVariable.ttf'] }],
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
      // The app only ever calls launchImageLibraryAsync (link-edit-screen.tsx),
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
      'expo-share-extension',
      {
        activationRules: [{ type: 'url', max: 1 }, { type: 'text' }],
        // The surface the extension mounts into, and it must NOT paint. Left
        // undefined the plugin writes no `ShareExtensionBackgroundColor`, and
        // ShareExtensionViewController falls back to `.systemBackground` — an
        // opaque slab with square corners. The sheet's four screens are not all
        // one height (compose and saved are ~280, the pickers ~520), and the
        // difference showed as dead white above the header. Alpha 0 makes it
        // clear so the sheet draws its OWN panel inside it, the way the Android
        // half already does; what shows through is the host app under the
        // system's dimming. `features/share/share-kit.tsx` is the other half of
        // this and says so. (`alpha` is 0–1 in the Swift, unlike the 0–255
        // channels beside it.)
        backgroundColor: { red: 0, green: 0, blue: 0, alpha: 0 },
        // NO `height`, and that is a decision rather than an omission.
        //
        // The plugin writes `ShareExtensionHeight` into the extension's
        // Info.plist, and ShareExtensionViewController turns it into a root
        // view of exactly that many points pinned to the bottom of the screen
        // (`y = screenBounds.height - height`); with the key absent it uses
        // `screenBounds` — the full screen — instead. This used to say 520,
        // "sized for the PICKERS", and it is what made the keyboard
        // unsurvivable on this surface: a picker is ~520pt of chrome and list,
        // the keyboard covers ~340pt of the screen, and a 520pt container
        // cannot hold the first above the second no matter how correctly the
        // sheet lifts itself. The panel is bottom-anchored and draws its own
        // background, so a full-screen container changes NOTHING visually while
        // the keyboard is down — it only stops being the ceiling when it is up.
        //
        // Two consequences worth knowing. The transparent root now covers the
        // screen and still takes touches, which is why share-kit.tsx's
        // `share-backdrop` (already there for the band) matters more: it is the
        // tap-outside-to-close for the whole screen now. And nothing in JS may
        // assume the surface's origin any more — the lift is computed from the
        // keyboard's own top edge (features/share/share-keyboard.ts), not from
        // where this container starts.
        excludedPackages: [
          'expo-dev-client',
          'expo-splash-screen',
          'expo-updates',
          'expo-image',
          'expo-iap',
        ],
        preprocessingFile: './share-extension/preprocessing.js',
      },
    ],
    [
      'expo-build-properties',
      {
        ios: {
          deploymentTarget: '18.0',
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
    // DEVELOPMENT_TEAM and IPHONEOS_DEPLOYMENT_TARGET for the iOS SHARE
    // EXTENSION target, neither of which reaches it: withDevelopmentTeam runs
    // before expo-share-extension creates the target, and expo-build-properties
    // skips it by product type. Without this, Xcode's Signing & Capabilities
    // Team is empty on BracemarkShareExtension after every prebuild, and that
    // target builds for iOS 15.1 against Pods built for the 18.0 set above.
    // Position in this array does not matter: it is a `finalized` mod, which
    // runs after the whole chain. See the plugin.
    './plugins/with-share-extension-build-settings',
  ],
};

export default config;
