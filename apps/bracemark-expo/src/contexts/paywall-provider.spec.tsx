import * as React from 'react';
import { Pressable } from 'react-native';
import { PortalHost } from '@rn-primitives/portal';
import { fireEvent, render, screen } from '@testing-library/react-native';

import { Text } from '../components/ui/text';
import { PaywallProvider, usePaywall } from './paywall-provider';

const mockPush = jest.fn();
const mockOnDismiss = jest.fn();

jest.mock('expo-router', () => ({
  useRouter: () => ({ push: mockPush }),
}));

function Trigger() {
  const paywall = usePaywall();
  return (
    <Pressable role="button" onPress={() => paywall.show('searchEditor', mockOnDismiss)}>
      <Text>Show paywall</Text>
    </Pressable>
  );
}

function mount() {
  return render(
    <>
      <PaywallProvider>
        <Trigger />
      </PaywallProvider>
      <PortalHost />
    </>,
  );
}

beforeEach(() => {
  mockPush.mockClear();
  mockOnDismiss.mockClear();
});

test('a caller can show the feature-specific upgrade dialog', () => {
  mount();

  fireEvent.press(screen.getByText('Show paywall'));

  expect(screen.getByText('Not now')).toBeTruthy();
  expect(screen.getByText(/Upgrade to/)).toBeTruthy();
});

test('dismissing restores the interrupted caller', () => {
  mount();

  fireEvent.press(screen.getByText('Show paywall'));
  fireEvent.press(screen.getByText('Not now'));

  expect(mockOnDismiss).toHaveBeenCalledTimes(1);
  expect(screen.queryByText('Not now')).toBeNull();
  expect(mockPush).not.toHaveBeenCalled();
});

test('upgrading routes to subscriptions without reopening the interrupted surface', () => {
  mount();

  fireEvent.press(screen.getByText('Show paywall'));
  fireEvent.press(screen.getByText(/Upgrade to/));

  expect(mockPush).toHaveBeenCalledWith('/settings/subscription');
  expect(mockOnDismiss).not.toHaveBeenCalled();
  expect(screen.queryByText('Not now')).toBeNull();
});

test('the hook refuses reads outside its provider', () => {
  function OutsideProbe() {
    usePaywall();
    return null;
  }
  const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);

  expect(() => render(<OutsideProbe />)).toThrow(/must be used within <PaywallProvider>/);

  errorSpy.mockRestore();
});
