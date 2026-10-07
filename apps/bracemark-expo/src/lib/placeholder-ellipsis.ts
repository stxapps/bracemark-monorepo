// The JS half of `BracemarkInput` (modules/bracemark-input, whose Kotlin header
// carries the mechanism): keep a single-line field's placeholder on one line on
// Android, ending in an ellipsis, where React Native 0.81 lets it wrap onto a
// second line the field clips. `ui/input.tsx` is the only caller.

import { Platform } from 'react-native';
import { requireOptionalNativeModule } from 'expo-modules-core';

type InputModule = { ellipsizePlaceholder: (viewTag: number) => Promise<void> };

// OPTIONAL, not required: the module is Android-only, and a dev build installed
// before it existed has no such module either — there the placeholder wraps as
// it did, which is a blemish, where a required lookup would be a crash on the
// first field. Null under jest too.
const inputModule =
  Platform.OS === 'android' ? requireOptionalNativeModule<InputModule>('BracemarkInput') : null;

/**
 * Ask Android to truncate this field's placeholder rather than wrap it. The
 * setting lives on the native view, so once per mounted field is enough; a
 * repeat is a no-op. Nothing awaits it and a failure is swallowed — the worst
 * outcome is the wrapped placeholder this exists to remove.
 */
export function ellipsizePlaceholder(viewTag: number): void {
  inputModule?.ellipsizePlaceholder(viewTag).catch(() => undefined);
}
