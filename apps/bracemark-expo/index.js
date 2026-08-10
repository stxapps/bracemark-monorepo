// The native entry (package.json `main`). This used to be `expo-router/entry`
// directly; expo-share-extension requires a literal index.js, so the router
// entry moved behind this shim (docs/share-sheet.md). Two things live here:
//
//  - the router app, exactly as before (`expo-router/entry` registers the root
//    component itself), with the polyfills evaluated FIRST — same rule as the
//    old first-line-of-_layout import (see src/polyfills.ts);
//  - the Android share activity's root: ShareActivity (modules/bracemark-share)
//    boots THIS bundle in the app's process and mounts 'bracemarkShare', so the
//    component must be registered in the main bundle. iOS does NOT use this —
//    the extension is a separate process with its own entry (index.share.js).
import './src/polyfills';
import 'expo-router/entry';

import { AppRegistry } from 'react-native';

import { ShareRoot } from './src/features/share/share-root';

AppRegistry.registerComponent('bracemarkShare', () => ShareRoot);
