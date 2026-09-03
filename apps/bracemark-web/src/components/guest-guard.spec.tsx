/**
 * @jest-environment jsdom
 */
// The `?next=` param is the only value in this app that a stranger can put into
// a navigation, and GuestGuard is where it is spent: land a signed-in user on
// `/sign-in?next=//evil.com` and, without the guard, signing in becomes an open
// redirect wearing our own domain in the link.
//
// It is a component spec rather than a unit test of `safeNext` because that
// function is deliberately not exported — the reachable surface is "an
// authenticated visitor arrives with this URL, where do they end up" — and
// because the two no-render states below (`loading`, `ending`) are half of what
// this file promises: never flash the sign-in form at someone who is about to be
// bounced, and never route at all while a sign-out is tearing down.
//
// `redirect()` really does throw (it unmounts the subtree before commit), and the
// mock keeps that shape on purpose: it is what lets the spec assert that the auth
// form never rendered, not merely that a destination was recorded.

import { render, screen } from '@testing-library/react';

import { GuestGuard } from './guest-guard';

let mockStatus = 'unauthenticated';
let mockNext: string | null = null;

const mockRedirect = jest.fn((href: string) => {
  throw new Error(`NEXT_REDIRECT:${href}`);
});

jest.mock('next/navigation', () => ({
  redirect: (href: string) => mockRedirect(href),
  useSearchParams: () => new URLSearchParams(mockNext === null ? '' : `next=${mockNext}`),
}));

jest.mock('@stxapps/web-react', () => ({
  useAuth: () => ({ status: mockStatus }),
}));

// The redirect throw propagates out of `render`, and React logs it on the way.
// Swallow both so a spec that is asserting a DESTINATION doesn't read as a crash.
function renderGuard() {
  const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
  try {
    render(
      <GuestGuard>
        <p>sign-in form</p>
      </GuestGuard>,
    );
  } catch (error) {
    if (!(error instanceof Error) || !error.message.startsWith('NEXT_REDIRECT:')) throw error;
  } finally {
    errorSpy.mockRestore();
  }
}

describe('GuestGuard', () => {
  beforeEach(() => {
    mockStatus = 'unauthenticated';
    mockNext = null;
    mockRedirect.mockClear();
  });

  it('renders the auth form for a signed-out visitor', () => {
    renderGuard();
    expect(screen.getByText('sign-in form')).toBeTruthy();
    expect(mockRedirect).not.toHaveBeenCalled();
  });

  it('sends an authenticated visitor to the app', () => {
    mockStatus = 'authenticated';
    renderGuard();
    expect(mockRedirect).toHaveBeenCalledWith('/links');
    expect(screen.queryByText('sign-in form')).toBeNull();
  });

  it('honors a `?next=` set by AuthGuard, query string and all', () => {
    mockStatus = 'authenticated';
    mockNext = encodeURIComponent('/links?list=list-abc');
    renderGuard();
    expect(mockRedirect).toHaveBeenCalledWith('/links?list=list-abc');
  });

  // Each of these is a `?next=` someone could hand a signed-in user. None may
  // leave the origin, and none may be sanitized into something that does — the
  // rejection is wholesale, back to /links.
  it.each([
    ['a protocol-relative host', '//evil.com'],
    ['a backslash-disguised host', '/\\evil.com'],
    ['an absolute https URL', 'https://evil.com/'],
    ['a scheme-bearing URL', 'javascript:alert(1)'],
    ['a bare relative path', 'links'],
    ['an empty value', ''],
  ])('refuses %s and sends the user to /links', (_label, next) => {
    mockStatus = 'authenticated';
    mockNext = encodeURIComponent(next);
    renderGuard();
    expect(mockRedirect).toHaveBeenCalledWith('/links');
  });

  // Both no-render states, and the reason each exists: 'loading' must not flash
  // the form at someone about to be bounced, and 'ending' must not route at all —
  // during a sign-out AuthGuard is the only component allowed to navigate.
  it.each(['loading', 'ending'])('renders nothing and never routes while %s', (status) => {
    mockStatus = status;
    renderGuard();
    expect(screen.queryByText('sign-in form')).toBeNull();
    expect(mockRedirect).not.toHaveBeenCalled();
  });
});
