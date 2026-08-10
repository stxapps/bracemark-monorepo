jest.mock('expo/src/winter/ImportMetaRegistry', () => ({
  ImportMetaRegistry: {
    get url() {
      return null;
    },
  },
}));

// These ship official jest mocks — the real modules need a native runtime.
jest.mock('@react-native-community/netinfo', () =>
  require('@react-native-community/netinfo/jest/netinfo-mock.js'),
);
jest.mock(
  'react-native-safe-area-context',
  () => require('react-native-safe-area-context/jest/mock').default,
);
jest.mock('react-native-keyboard-controller', () =>
  require('react-native-keyboard-controller/jest'),
);

// A real gesture needs a native runtime (RNGestureHandlerModule), so the stub
// keeps only the shape the settings tables' drag layer builds against
// (drag-sort.tsx): a chainable builder, and a detector that renders its child.
// Rendering a draggable row is then testable; the gesture itself is device-only.
//
// Note: gesture-handler also reaches React Native's legacy Paper renderer
// (`RNRenderer` → `Renderer/shims/ReactNative`), which throws unless `react`
// matches the version RN bundles its renderer for **exactly** (RN 0.81.5 →
// 19.1.0; Fabric's renderer has no such assertion). That's why the root
// `package.json` pins `react`/`react-dom`/`react-test-renderer` to an exact
// `19.1.0` rather than a `^` range — a caret silently floats to 19.2.x and
// breaks the drag surface on device, not just here.
jest.mock('react-native-gesture-handler', () => {
  const gesture = new Proxy({}, { get: (_target, _prop) => () => gesture }) as Record<
    string,
    unknown
  >;
  return {
    Gesture: { Pan: () => gesture, Tap: () => gesture, LongPress: () => gesture },
    GestureDetector: ({ children }: { children: React.ReactNode }) => children,
    GestureHandlerRootView: ({ children }: { children: React.ReactNode }) => children,
  };
});

// Uniwind's className→style bridge runs in the Metro transform / native
// runtime; under jest the HOC is an identity wrapper (className is ignored), and
// the `Uniwind` runtime (ThemeProvider's `setTheme`) is a no-op stub.
// `useCSSVariable` (ui/switch.tsx's token bridge) resolves against the theme vars
// the Metro transform generates, so it has nothing to read here — it returns
// `undefined` per name, the real hook's own miss value, which leaves the wrapped
// component on its platform default colors.
jest.mock('uniwind', () => ({
  withUniwind: (Component: unknown) => Component,
  Uniwind: { setTheme: jest.fn() },
  useCSSVariable: (name: string | string[]) =>
    Array.isArray(name) ? name.map(() => undefined) : undefined,
  // Light is the jest default; specs that care can re-mock it. Read by
  // components/ui/input.tsx for the iOS keyboardAppearance.
  useUniwind: () => ({ theme: 'light', hasAdaptiveThemes: true }),
}));

if (typeof global.structuredClone === 'undefined') {
  global.structuredClone = (object) => JSON.parse(JSON.stringify(object));
}
