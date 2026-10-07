// The placeholder fix is a chain of strings across two languages, and none of
// it is reachable from jest as BEHAVIOUR: whether a hint wraps is Android's
// TextView laying it out, which only a device shows (modules/bracemark-input's
// Kotlin header). What jest can hold is the wiring — that `ui/input.tsx` asks,
// on the platform that needs it, for the module and the function the Kotlin
// actually declares, with the tag of the view it means. Each of those fails
// silently: the lookup is optional and the call is `?.`, so a rename on either
// side leaves a field whose placeholder wraps again and a suite that is green.

import * as fs from 'node:fs';
import * as path from 'node:path';

import * as React from 'react';
import * as ReactNative from 'react-native';
import { fireEvent, render } from '@testing-library/react-native';

import type { Input as InputComponent } from '../components/ui/input';

// Looked up once, at import, so what the cases steer lives inside the factory
// and is read back off the mock (features/share/share-swipe-guard.spec.tsx).
jest.mock('expo-modules-core', () => {
  const inputModule = {};
  const requested: string[] = [];
  const lookup = { absent: false };
  return {
    requireOptionalNativeModule: (name: string) => {
      requested.push(name);
      return lookup.absent ? null : inputModule;
    },
    mockInputModule: inputModule,
    mockRequested: requested,
    mockLookup: lookup,
  };
});

const mockCore = jest.requireMock<{
  mockInputModule: Record<string, jest.Mock | undefined>;
  mockRequested: string[];
  mockLookup: { absent: boolean };
}>('expo-modules-core');
const { mockInputModule, mockRequested, mockLookup } = mockCore;

// What the Kotlin half declares, read as text — comments dropped, because the
// header restates the contract in prose (docs/testing.md, _the doc-comment
// decoy_).
const kotlin = fs
  .readFileSync(
    path.join(
      __dirname,
      '../../modules/bracemark-input/android/src/main/java/com/bracemark/input/BracemarkInputModule.kt',
    ),
    'utf8',
  )
  .split('\n')
  .filter((line) => !line.trim().startsWith('//'))
  .join('\n');
const declaredNames = [...kotlin.matchAll(/^\s*Name\("([^"]+)"\)/gm)].map((match) => match[1]);
const declaredFunctions = [...kotlin.matchAll(/^\s*AsyncFunction\("([^"]+)"\)/gm)].map(
  (match) => match[1],
);

// The lookup and the platform check both happen at import, so each case
// requires the field again, as the platform it is about. The renderer's own
// `react` and `react-native` go back in: a re-required copy beside them fails
// as "Invalid hook call" (lib/font-scale.spec.tsx). So does THIS file's copy of
// the mock above — an isolated registry runs the factory again, and the lookup
// would land on a module and a list no case here can see.
//
// The platform is set TWICE because `Platform` is two objects here. React
// Native's index hands it out through a lazy getter, and a getter read inside
// the isolated registry requires a fresh `Platform` module — the one the
// binding consults at import. The field reads it again at render, after the
// isolation has ended, and gets the ordinary one.
function loadInput(os: 'android' | 'ios'): typeof InputComponent {
  jest.replaceProperty(ReactNative.Platform, 'OS', os);
  let Input: typeof InputComponent | undefined;
  jest.isolateModules(() => {
    jest.doMock('react', () => React);
    jest.doMock('react-native', () => ReactNative);
    jest.doMock('expo-modules-core', () => mockCore);
    jest.replaceProperty(ReactNative.Platform, 'OS', os);
    Input =
      jest.requireActual<typeof import('../components/ui/input')>('../components/ui/input').Input;
  });
  if (!Input) throw new Error('Input did not load');
  return Input;
}

// React Native's Android layout event: the view's tag rides beside `layout`.
const layoutEvent = { nativeEvent: { layout: { x: 0, y: 0, width: 300, height: 40 }, target: 42 } };

beforeEach(() => {
  for (const name of Object.keys(mockInputModule)) delete mockInputModule[name];
  mockRequested.length = 0;
  mockLookup.absent = false;
});

afterEach(() => {
  jest.restoreAllMocks();
});

test('on Android a laid-out field asks the module its Kotlin half declares, by tag', () => {
  expect(declaredNames).toHaveLength(1);
  expect(declaredFunctions).toHaveLength(1);
  const declared = (mockInputModule[declaredFunctions[0]] = jest.fn(() => Promise.resolve()));

  const Input = loadInput('android');
  expect(mockRequested).toEqual(declaredNames);

  // A call site's own `onLayout` still runs — the editor's focus scroll and
  // every measured field depend on the prop being composed, not replaced.
  const onLayout = jest.fn();
  const { getByTestId } = render(<Input testID="probe" onLayout={onLayout} />);
  fireEvent(getByTestId('probe'), 'layout', layoutEvent);

  expect(declared).toHaveBeenCalledWith(42);
  expect(onLayout).toHaveBeenCalledTimes(1);
});

// A dev build installed before the module existed has no such module, and the
// lookup returns null there. The field must still lay out.
test('does nothing on Android when the installed binary has no module', () => {
  mockLookup.absent = true;
  const Input = loadInput('android');

  const { getByTestId } = render(<Input testID="probe" />);
  expect(() => fireEvent(getByTestId('probe'), 'layout', layoutEvent)).not.toThrow();
});

// UITextField truncates its placeholder itself, so iOS never looks the module
// up — and gets the call site's handler untouched.
test('leaves iOS alone', () => {
  const Input = loadInput('ios');
  expect(mockRequested).toEqual([]);

  const onLayout = jest.fn();
  const { getByTestId } = render(<Input testID="probe" onLayout={onLayout} />);
  fireEvent(getByTestId('probe'), 'layout', layoutEvent);
  expect(onLayout).toHaveBeenCalledTimes(1);
});
