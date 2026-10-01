import * as fs from 'node:fs';
import * as path from 'node:path';

import * as React from 'react';
import * as ReactNative from 'react-native';
import { render } from '@testing-library/react-native';

import { ShareSwipeGuard } from './share-swipe-guard';

// The module is looked up once, at import — before any `const` in this file
// exists — so everything the cases steer is made inside the factory and read
// back off the mock: the module object (the cases change what is ON it), the
// name it was looked up by, and whether the lookup finds a module at all.
jest.mock('expo-modules-core', () => {
  const guardModule = {};
  const requested: string[] = [];
  const lookup = { absent: false };
  return {
    requireOptionalNativeModule: (name: string) => {
      requested.push(name);
      return lookup.absent ? null : guardModule;
    },
    mockGuardModule: guardModule,
    mockRequested: requested,
    mockLookup: lookup,
  };
});

const { mockGuardModule, mockRequested, mockLookup } = jest.requireMock<{
  mockGuardModule: Record<string, jest.Mock | undefined>;
  mockRequested: string[];
  mockLookup: { absent: boolean };
}>('expo-modules-core');

beforeEach(() => {
  for (const name of Object.keys(mockGuardModule)) delete mockGuardModule[name];
  mockGuardModule.setHeld = jest.fn();
  mockLookup.absent = false;
});

// The whole contract: held for exactly as long as a picker is on screen. A
// guard that never lets go would leave the compose screen unswipeable, which is
// the one screen meant to keep the platform's gesture.
test('holds the swipe while mounted and gives it back on unmount', () => {
  const { unmount } = render(<ShareSwipeGuard />);
  expect(mockGuardModule.setHeld).toHaveBeenLastCalledWith(true);

  unmount();
  expect(mockGuardModule.setHeld).toHaveBeenLastCalledWith(false);
});

// A dev build installed before `setHeld` existed still has a module of this
// name, so a JS reload ahead of the native rebuild reaches this component with
// nothing to call. A TypeError here unmounts the whole sheet — in a process
// with no redbox, that reads as the picker closing the share sheet.
test('does nothing, rather than throwing, on a native build without setHeld', () => {
  delete mockGuardModule.setHeld;

  const { unmount } = render(<ShareSwipeGuard />);
  expect(() => unmount()).not.toThrow();
});

// The two cases above hold the component to a fake that answers to whatever
// name it is asked for and carries a `setHeld` because this file put one there.
// The real module answers to the name and the function its Swift declares, and
// nothing relates those strings to these: a rename on either side typechecks,
// lints, passes both cases above, and `requireOptionalNativeModule` + `?.` —
// there for the reasons the component gives — turn the mismatch into a guard
// that silently never holds. So this one builds the fake FROM the Swift.
test('asks for the module, and calls the function, its Swift half declares', () => {
  const swift = fs
    .readFileSync(
      path.join(
        __dirname,
        '../../../modules/bracemark-share/ios/BracemarkShareSwipeGuardModule.swift',
      ),
      'utf8',
    )
    .split('\n')
    // The header restates the contract in prose (docs/testing.md, _the
    // doc-comment decoy_).
    .filter((line) => !line.trim().startsWith('//'))
    .join('\n');
  // Anchored to the line: `Notification.Name("…")` is in this file too.
  const names = [...swift.matchAll(/^\s*Name\("([^"]+)"\)/gm)].map((match) => match[1]);
  const functions = [...swift.matchAll(/^\s*Function\("([^"]+)"\)/gm)].map((match) => match[1]);
  expect(names).toHaveLength(1);
  expect(functions).toHaveLength(1);

  expect([...new Set(mockRequested)]).toEqual(names);

  delete mockGuardModule.setHeld;
  const declared = (mockGuardModule[functions[0]] = jest.fn());
  render(<ShareSwipeGuard />);
  expect(declared).toHaveBeenLastCalledWith(true);
});

// Android's share activity renders the same two pickers, `holdSwipe` and all,
// and there is no module there: the lookup is skipped off iOS, and it would
// return null anyway. The cases above cannot see that — their fake always
// exists — and share-screen.spec.tsx mocks this whole component, so dropping
// the first `?.` passes everything while every Android share that opens a
// picker throws.
test('does nothing where there is no module at all', () => {
  mockLookup.absent = true;
  // The lookup happens at import, so the component is required again.
  let Guard = ShareSwipeGuard;
  jest.isolateModules(() => {
    // The renderer's own copies: a re-required `react` beside it fails as
    // "Invalid hook call" (lib/font-scale.spec.tsx).
    jest.doMock('react', () => React);
    jest.doMock('react-native', () => ReactNative);
    Guard =
      jest.requireActual<typeof import('./share-swipe-guard')>(
        './share-swipe-guard',
      ).ShareSwipeGuard;
  });
  expect(Guard).not.toBe(ShareSwipeGuard);

  const { unmount } = render(<Guard />);
  expect(() => unmount()).not.toThrow();
  expect(mockGuardModule.setHeld).not.toHaveBeenCalled();
});
