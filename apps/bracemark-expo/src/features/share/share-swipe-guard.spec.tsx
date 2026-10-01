import { render } from '@testing-library/react-native';

import { ShareSwipeGuard } from './share-swipe-guard';

// The module is looked up once, at import — before any `const` in this file
// exists — so the object is made inside the factory and the cases change what
// is ON it.
jest.mock('expo-modules-core', () => {
  const guardModule = {};
  return { requireOptionalNativeModule: () => guardModule };
});

const mockGuardModule = jest
  .requireMock<{ requireOptionalNativeModule: () => { setHeld?: jest.Mock } }>('expo-modules-core')
  .requireOptionalNativeModule();

beforeEach(() => {
  mockGuardModule.setHeld = jest.fn();
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
