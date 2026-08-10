// The iOS share-extension entry — a SEPARATE Metro bundle from index.js
// (expo-share-extension's convention; the name 'shareExtension' is the
// library's contract). Registers only the share root: the extension process
// never loads the router or the app tree, which keeps its boot and memory
// inside the extension budget (docs/share-sheet.md). Polyfills first, same
// rule as index.js.
import './src/polyfills';

import { AppRegistry } from 'react-native';

import { ShareRoot } from './src/features/share/share-root';

AppRegistry.registerComponent('shareExtension', () => ShareRoot);
