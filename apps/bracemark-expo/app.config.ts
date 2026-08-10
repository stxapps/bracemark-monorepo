import type { ExpoConfig } from 'expo/config';

// The Expo app config. This is TS rather than the app.json it replaced for one
// reason: `ios.appleTeamId` has to come from the environment. In JSON it was
// the LITERAL string "process.env.APPLE_TEAM_ID" — JSON has no interpolation —
// and @expo/config-plugins' withDevelopmentTeam writes that value verbatim into
// DEVELOPMENT_TEAM for EVERY native target in the pbxproj, so signing was
// broken in both the app and the share-extension target.
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
  version: '0.0.0',
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
    version: '0.0.0',
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
    version: '0.0.0',
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
        height: 520,
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
    // Play upload-key signing for release builds. Local plugin because there is
    // no signing surface in app config or expo-build-properties, and `android/`
    // is wiped by `prebuild --clean`. No-ops when the BRACEMARK_UPLOAD_* vars are
    // absent from `.env.local`. See docs/setup.md — android release signing.
    './plugins/with-android-signing',
  ],
};

export default config;
