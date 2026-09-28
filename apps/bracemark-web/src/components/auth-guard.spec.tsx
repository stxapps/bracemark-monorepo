/**
 * @jest-environment jsdom
 */
// AuthGuard picks between four exits, and three of them are invisible from any
// other layer: which one you get depends on the auth `reason` and on whether the
// app is running installed — neither of which a rendered page shows.
//
//   revoked / direct visit  → /sign-in?next=<the whole intended path>
//   deliberate sign-out     → location.replace(SITE_URL), off this origin
//   sign-out while INSTALLED→ /sign-in, staying in scope
//   loading / ending        → nothing, and no navigation
//
// The two that carry the real cost are the last pair. An installed window that
// navigates out of its manifest scope doesn't navigate — the platform hands the
// document to an in-app browser and strands the user outside the app window, and
// nothing on the far side can put them back. And 'ending' is the frame where the
// store is about to be wiped: the gate has to close BEFORE that, because it is
// what unmounts every descendant that might otherwise navigate on its own (see
// this file's header and docs/data-lifecycle.md, _the sign-out teardown_). A gate
// that treated 'ending' as merely "not authenticated" would bounce the user to
// /sign-in?next=… mid-teardown, which is the wrong destination AND a second
// navigator in the same frame.
//
// `e2e/web/account.e2e.ts` drives the visible half of the browser-tab sign-out.
// It cannot reach the installed branch (it would need a real standalone display
// mode) or the `next=` composition, which is why they are pinned here.
//
// The `redirect()` mock throws like the real one, so "protected content never
// paints for a signed-out user" is assertable rather than assumed.
//
// WHAT THIS SPEC CANNOT SEE, stated because the gap is not obvious: `location`
// and `location.replace` are `[LegacyUnforgeable]`, so jsdom 26 exposes them as
// non-configurable, non-writable own properties and there is no way to stub
// either. The browser-tab exit is therefore asserted as "a real document
// navigation was attempted" — jsdom answers one with its
// `Not implemented: navigation` jsdomError — and NOT as "…to SITE_URL". The
// destination is the half a browser flow does cover; the halves it can't are
// which MECHANISM was used (next/navigation's redirect() on a cross-origin href
// is the documented crash) and whether the installed branch navigates at all,
// and both of those are what the two tests below actually pin.

import { render, screen } from '@testing-library/react';

import { AuthGuard } from './auth-guard';

let mockStatus = 'authenticated';
let mockReason: string | null = null;
let mockPathname = '/links';
let mockSearch = '';
let mockInstalled = false;

const mockRedirect = jest.fn((href: string) => {
  throw new Error(`NEXT_REDIRECT:${href}`);
});

jest.mock('next/navigation', () => ({
  redirect: (href: string) => mockRedirect(href),
  usePathname: () => mockPathname,
  useSearchParams: () => new URLSearchParams(mockSearch),
}));

jest.mock('@stxapps/web-react', () => ({
  useAuth: () => ({ status: mockStatus, reason: mockReason }),
}));

beforeAll(() => {
  // jsdom ships no matchMedia at all. `(display-mode: browser)` matching is the
  // BROWSER-TAB case, which is why this answers `matches: true` by default.
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    value: (query: string) => ({ media: query, matches: !mockInstalled }),
  });
});

// Everything console.error saw during the render — React's rethrow report for
// the redirect throw, and jsdom's jsdomError for an attempted navigation.
let consoleErrors: string[] = [];

// jsdom's stand-in for leaving the document. It carries no URL, so it answers
// "did this branch navigate", not "where to" (see the header).
const attemptedDocumentNavigation = () =>
  consoleErrors.some((line) => line.includes('Not implemented: navigation'));

function renderGuard() {
  consoleErrors = [];
  const errorSpy = jest
    .spyOn(console, 'error')
    .mockImplementation(
      (...args: unknown[]) => void consoleErrors.push(args.map(String).join(' ')),
    );
  try {
    render(
      <AuthGuard>
        <p>protected content</p>
      </AuthGuard>,
    );
  } catch (error) {
    if (!(error instanceof Error) || !error.message.startsWith('NEXT_REDIRECT:')) throw error;
  } finally {
    errorSpy.mockRestore();
  }
}

describe('AuthGuard', () => {
  beforeEach(() => {
    mockStatus = 'authenticated';
    mockReason = null;
    mockPathname = '/links';
    mockSearch = '';
    mockInstalled = false;
    mockRedirect.mockClear();
  });

  it('renders the app for an authenticated user', () => {
    renderGuard();
    expect(screen.getByText('protected content')).toBeTruthy();
    expect(mockRedirect).not.toHaveBeenCalled();
    expect(attemptedDocumentNavigation()).toBe(false);
  });

  describe('a session that ended without being asked to', () => {
    // 'revoked': the server told this device to forget (docs/sessions.md). An
    // EXPIRED session never gets here — it stays authenticated, library open.
    it('stashes the whole intended path, query string included', () => {
      mockStatus = 'unauthenticated';
      mockReason = 'revoked';
      mockPathname = '/links';
      mockSearch = 'list=list-abc&tag=tag-xyz';
      renderGuard();

      expect(mockRedirect).toHaveBeenCalledWith(
        `/sign-in?next=${encodeURIComponent('/links?list=list-abc&tag=tag-xyz')}`,
      );
      // The point of redirecting in render rather than in an effect.
      expect(screen.queryByText('protected content')).toBeNull();
    });

    it('stashes a bare path with no trailing `?` when there is no query', () => {
      mockStatus = 'unauthenticated';
      mockReason = null; // a direct visit to a protected URL
      mockPathname = '/settings/account';
      renderGuard();

      expect(mockRedirect).toHaveBeenCalledWith(
        `/sign-in?next=${encodeURIComponent('/settings/account')}`,
      );
    });
  });

  describe('a deliberate sign-out', () => {
    it('leaves this origin by document navigation, not through the router', () => {
      mockStatus = 'unauthenticated';
      mockReason = 'signed-out';
      renderGuard();

      expect(attemptedDocumentNavigation()).toBe(true);
      // Handing a cross-origin href to next/navigation's redirect() is the bug
      // this file's header is about — Router takes its MPA branch, throws
      // mid-render, and a later dispatch turns that into "Rendered more hooks
      // than during the previous render", stranding the user signed-out on the
      // page they were leaving. So redirect() must not be reached AT ALL here,
      // and no `?next=` is offered for a sign-out the user asked for.
      expect(mockRedirect).not.toHaveBeenCalled();
      expect(screen.queryByText('protected content')).toBeNull();
    });

    it('stays on this origin when running as an installed app', () => {
      mockInstalled = true;
      mockStatus = 'unauthenticated';
      mockReason = 'signed-out';
      renderGuard();

      // The manifest scope trap: the apex is outside `start_url: "."`, so an
      // installed window that goes there is handed to an in-app browser and the
      // app window is gone for good. Nothing may leave the document here.
      expect(attemptedDocumentNavigation()).toBe(false);
      expect(mockRedirect).toHaveBeenCalledWith('/sign-in');
    });
  });

  // The teardown frame. Not "not authenticated yet" and not "signed out" — a
  // state to hold still in, so the subtree comes down before the store is wiped.
  it.each(['loading', 'ending'])('renders nothing and navigates nowhere while %s', (status) => {
    mockStatus = status;
    mockReason = 'signed-out'; // the reason 'ending' always carries
    renderGuard();

    expect(screen.queryByText('protected content')).toBeNull();
    expect(mockRedirect).not.toHaveBeenCalled();
    expect(attemptedDocumentNavigation()).toBe(false);
  });
});
