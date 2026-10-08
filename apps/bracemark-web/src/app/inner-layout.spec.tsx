// A saved links URL can carry search text that resolves for any account. The
// root Initializer must forget it when its account leaves, even after the routed
// subtree unmounts, while preserving it through reload hydration and navigation.

import { type ReactNode } from 'react';
import { render } from '@testing-library/react';

import { readLinksReturn, recordLinksReturn } from '../lib/links-return';
import { InnerLayout } from './inner-layout';

let mockAuth: {
  status: 'loading' | 'authenticated' | 'unauthenticated' | 'ending';
  username: string | null;
  reason: 'signed-out' | 'revoked' | null;
};

// Keep Initializer and the storage helpers real; replace the surrounding
// providers and browser services so only account transitions drive this spec.
jest.mock('@stxapps/web-react', () => ({
  AuthProvider: ({ children }: { children: ReactNode }) => children,
  useAuth: () => mockAuth,
}));
jest.mock('@stxapps/react', () => ({
  ApiClientProvider: ({ children }: { children: ReactNode }) => children,
  ExtractClientProvider: ({ children }: { children: ReactNode }) => children,
}));
jest.mock('@stxapps/web-ui/contexts/theme-provider', () => ({
  ThemeProvider: ({ children }: { children: ReactNode }) => children,
}));
jest.mock('@serwist/next/react', () => ({
  SerwistProvider: ({ children }: { children: ReactNode }) => children,
}));
jest.mock('../lib/api-client', () => ({ apiClient: {} }));
jest.mock('../lib/extract-client', () => ({ extractClient: {} }));
jest.mock('../lib/service-worker-update-check', () => ({
  watchForServiceWorkerUpdates: () => () => undefined,
}));
jest.mock('../components/update-pill', () => ({ UpdatePill: () => null }));
jest.mock('../components/update-required-banner', () => ({ UpdateRequiredBanner: () => null }));

const SEARCH = '/links?q=tax+2024';

beforeEach(() => {
  sessionStorage.clear();
  mockAuth = { status: 'authenticated', username: 'alice', reason: null };
});

it.each(['signed-out', 'revoked'] as const)(
  'forgets the view on %s after the routed subtree unmounts',
  (reason) => {
    const { rerender } = render(
      <InnerLayout>
        <div>Links</div>
      </InnerLayout>,
    );
    recordLinksReturn(SEARCH);

    mockAuth = { ...mockAuth, status: 'ending' };
    rerender(<InnerLayout>{null}</InnerLayout>);
    expect(readLinksReturn()).toBe(SEARCH);

    mockAuth = { status: 'unauthenticated', username: null, reason };
    rerender(<InnerLayout>{null}</InnerLayout>);

    expect(readLinksReturn()).toBe('/links');
  },
);

it('forgets the view when a different account takes the tab over', () => {
  const { rerender } = render(<InnerLayout>{null}</InnerLayout>);
  recordLinksReturn(SEARCH);

  mockAuth = { ...mockAuth, username: 'bob' };
  rerender(<InnerLayout>{null}</InnerLayout>);

  expect(readLinksReturn()).toBe('/links');
});

it('preserves the view during reload hydration and repeated account renders', () => {
  recordLinksReturn(SEARCH);
  mockAuth = { status: 'loading', username: null, reason: null };
  const { rerender } = render(<InnerLayout>{null}</InnerLayout>);
  expect(readLinksReturn()).toBe(SEARCH);

  mockAuth = { status: 'authenticated', username: 'alice', reason: null };
  rerender(<InnerLayout>{null}</InnerLayout>);
  rerender(<InnerLayout>{null}</InnerLayout>);

  expect(readLinksReturn()).toBe(SEARCH);
});

it('preserves the view when an initial session read fails and sign-in follows', () => {
  recordLinksReturn(SEARCH);
  mockAuth = { status: 'loading', username: null, reason: null };
  const { rerender } = render(<InnerLayout>{null}</InnerLayout>);

  mockAuth = { ...mockAuth, status: 'unauthenticated' };
  rerender(<InnerLayout>{null}</InnerLayout>);
  expect(readLinksReturn()).toBe(SEARCH);

  mockAuth = { status: 'authenticated', username: 'alice', reason: null };
  rerender(<InnerLayout>{null}</InnerLayout>);

  expect(readLinksReturn()).toBe(SEARCH);
});

it('preserves the view on an authenticated mount and route changes', () => {
  recordLinksReturn(SEARCH);
  const { rerender } = render(
    <InnerLayout>
      <div>Links</div>
    </InnerLayout>,
  );
  expect(readLinksReturn()).toBe(SEARCH);

  rerender(
    <InnerLayout>
      <div>Settings</div>
    </InnerLayout>,
  );

  expect(readLinksReturn()).toBe(SEARCH);
});
