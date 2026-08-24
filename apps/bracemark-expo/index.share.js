// The iOS share-extension entry — a SEPARATE Metro bundle from index.js
// (expo-share-extension's convention; the name 'shareExtension' is the
// library's contract). Registers only the share root: the extension process
// never loads the router or the app tree, which keeps its boot and memory
// inside the extension budget (docs/share-sheet.md). Polyfills first, same
// rule as index.js.
import './src/polyfills';

import { AppRegistry } from 'react-native';

import { ShareRoot } from './src/features/share/share-root';
import { markShareExtensionProcess } from './src/lib/font-scale';

// THE ONE THING THIS ENTRY SAYS BEYOND "render the share root", and it has to be
// said here: React Native's font-scale multiplier is computed from
// `UIApplication.sharedApplication`, which does not exist in an app-extension
// process, so it comes out as **0** and every `Text`/`TextInput` in this bundle
// lays out at zero point — invisible, with a correct accessibility tree and a
// green test suite. `lib/font-scale.ts` carries the full derivation; the flag is
// per-JS-context, and this bundle IS that context. Android's share activity
// rides `index.js` in the app's own process, where scaling works, and must
// never set it.
//
// Before `registerComponent`, though only ordering against the first RENDER
// matters — the chokepoints read the flag per render, not at module init.
markShareExtensionProcess();

AppRegistry.registerComponent('shareExtension', () => ShareRoot);
