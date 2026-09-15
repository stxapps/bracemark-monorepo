import * as React from 'react';
import { render, screen } from '@testing-library/react-native';

import { Text } from './ui/text';
import { AuthGuard } from './auth-guard';
import { GuestGuard } from './guest-guard';
import { HomeGuard } from './home-guard';

let mockStatus = 'authenticated';
let mockReason: string | null = null;
let mockPathname = '/links';
let mockParams: { next?: string | string[] } = {};
const mockRedirect = jest.fn();

jest.mock('expo-router', () => ({
  Redirect: ({ href }: { href: string }) => {
    mockRedirect(href);
    return null;
  },
  usePathname: () => mockPathname,
  useLocalSearchParams: () => mockParams,
}));

jest.mock('@stxapps/expo-react', () => ({
  useAuth: () => ({ status: mockStatus, reason: mockReason }),
}));

beforeEach(() => {
  mockStatus = 'authenticated';
  mockReason = null;
  mockPathname = '/links';
  mockParams = {};
  mockRedirect.mockClear();
});

describe('AuthGuard', () => {
  test('renders protected content only for an authenticated user', () => {
    render(
      <AuthGuard>
        <Text>Protected content</Text>
      </AuthGuard>,
    );

    expect(screen.getByText('Protected content')).toBeTruthy();
    expect(mockRedirect).not.toHaveBeenCalled();
  });

  test('returns an expired or direct session to sign-in with its intended path', () => {
    mockStatus = 'unauthenticated';
    mockReason = 'expired';
    mockPathname = '/settings/subscription';

    render(
      <AuthGuard>
        <Text>Protected content</Text>
      </AuthGuard>,
    );

    expect(mockRedirect).toHaveBeenCalledWith(
      `/sign-in?next=${encodeURIComponent('/settings/subscription')}`,
    );
    expect(screen.queryByText('Protected content')).toBeNull();
  });

  test('sends a deliberate sign-out home without offering a return path', () => {
    mockStatus = 'unauthenticated';
    mockReason = 'signed-out';

    render(
      <AuthGuard>
        <Text>Protected content</Text>
      </AuthGuard>,
    );

    expect(mockRedirect).toHaveBeenCalledWith('/');
  });

  test.each(['loading', 'ending'])('renders nothing and does not navigate while %s', (next) => {
    mockStatus = next;

    render(
      <AuthGuard>
        <Text>Protected content</Text>
      </AuthGuard>,
    );

    expect(screen.queryByText('Protected content')).toBeNull();
    expect(mockRedirect).not.toHaveBeenCalled();
  });
});

describe('GuestGuard', () => {
  test('renders the auth form for a signed-out visitor', () => {
    mockStatus = 'unauthenticated';

    render(
      <GuestGuard>
        <Text>Sign-in form</Text>
      </GuestGuard>,
    );

    expect(screen.getByText('Sign-in form')).toBeTruthy();
    expect(mockRedirect).not.toHaveBeenCalled();
  });

  test('returns an authenticated visitor to the in-app path AuthGuard saved', () => {
    mockParams = { next: '/settings/data?from=share' };

    render(
      <GuestGuard>
        <Text>Sign-in form</Text>
      </GuestGuard>,
    );

    expect(mockRedirect).toHaveBeenCalledWith('/settings/data?from=share');
    expect(screen.queryByText('Sign-in form')).toBeNull();
  });

  test.each([
    ['a protocol-relative host', '//evil.example'],
    ['a backslash-disguised host', '/\\evil.example'],
    ['an absolute URL', 'https://evil.example/'],
    ['a scheme-bearing value', 'mailto:evil@example.com'],
    ['a bare relative path', 'links'],
    ['an empty value', ''],
  ])('rejects %s as a return path', (_label, next) => {
    mockParams = { next };

    render(
      <GuestGuard>
        <Text>Sign-in form</Text>
      </GuestGuard>,
    );

    expect(mockRedirect).toHaveBeenCalledWith('/links');
  });

  test('rejects a repeated next parameter instead of choosing one', () => {
    mockParams = { next: ['/settings/data', '//evil.example'] };

    render(
      <GuestGuard>
        <Text>Sign-in form</Text>
      </GuestGuard>,
    );

    expect(mockRedirect).toHaveBeenCalledWith('/links');
  });

  test.each(['loading', 'ending'])('renders nothing and does not navigate while %s', (next) => {
    mockStatus = next;

    render(
      <GuestGuard>
        <Text>Sign-in form</Text>
      </GuestGuard>,
    );

    expect(screen.queryByText('Sign-in form')).toBeNull();
    expect(mockRedirect).not.toHaveBeenCalled();
  });
});

// The third route-level gate, on `/`. It differs from the two above in having
// CONTENT of its own to withhold — the landing hero — and `/` is the launch
// route, so the state that matters most here is the one where nothing has been
// decided yet: every signed-in cold start passes through 'loading' on its way to
// the redirect, and an ungated hero would flash the signed-out CTAs at them each
// time.
describe('HomeGuard', () => {
  test('shows the landing to a signed-out visitor', () => {
    mockStatus = 'unauthenticated';

    render(
      <HomeGuard>
        <Text>Landing hero</Text>
      </HomeGuard>,
    );

    expect(screen.getByText('Landing hero')).toBeTruthy();
    expect(mockRedirect).not.toHaveBeenCalled();
  });

  test('sends an authenticated visitor into the app instead of the landing', () => {
    render(
      <HomeGuard>
        <Text>Landing hero</Text>
      </HomeGuard>,
    );

    expect(mockRedirect).toHaveBeenCalledWith('/links');
    expect(screen.queryByText('Landing hero')).toBeNull();
  });

  test.each(['loading', 'ending'])(
    'withholds the landing and does not navigate while %s',
    (next) => {
      mockStatus = next;

      render(
        <HomeGuard>
          <Text>Landing hero</Text>
        </HomeGuard>,
      );

      expect(screen.queryByText('Landing hero')).toBeNull();
      expect(mockRedirect).not.toHaveBeenCalled();
    },
  );
});
