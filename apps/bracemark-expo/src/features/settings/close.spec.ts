import { router } from 'expo-router';

import { closeSettings } from './close';

jest.mock('expo-router', () => ({
  router: {
    canDismiss: jest.fn(),
    dismiss: jest.fn(),
    replace: jest.fn(),
  },
}));

const canDismiss = router.canDismiss as jest.Mock;
const dismiss = router.dismiss as jest.Mock;
const replace = router.replace as jest.Mock;

beforeEach(() => {
  jest.clearAllMocks();
});

test('dismisses one settings card when there is a screen underneath', () => {
  canDismiss.mockReturnValue(true);

  closeSettings();

  expect(dismiss).toHaveBeenCalledTimes(1);
  expect(replace).not.toHaveBeenCalled();
});

test('replaces a cold settings entry with links when there is nothing to uncover', () => {
  canDismiss.mockReturnValue(false);

  closeSettings();

  expect(replace).toHaveBeenCalledWith('/links');
  expect(dismiss).not.toHaveBeenCalled();
});
