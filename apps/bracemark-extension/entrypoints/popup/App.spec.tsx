import { act, fireEvent, render, screen } from '@testing-library/react';

import { TRASH_ID } from '@stxapps/shared';

import { type FakeBrowser, installFakeBrowser } from '../../testing/fake-browser';
import App from './App';

// The popup's whole router: four inputs (auth status, the active tab, whether that
// tab is already in the local store, and whether the match is in Trash) picking one
// of five screens. It is a state machine with no URL, so nothing but a spec can
// exercise its branches — and three of them are wrong in ways that look like
// nothing:
//
//   - THE `?? null` IN THE LIVE QUERY. `readLinkByUrlKey` answers `undefined` for
//     "not saved", and `useLiveQuery` answers `undefined` while it is still
//     resolving. Coercing the settled not-found case to `null` is what keeps
//     `undefined` meaning ONLY "still loading" — without it every unsaved tab is
//     perpetually loading, i.e. the popup never opens its editor at all.
//   - A MATCH IN TRASH IS NOT "ALREADY SAVED". The user removed it, and the web app
//     hides Trash from every view but Trash, so Complete's saved state would point
//     at something they can't find. Falling through to a plain editor is no better:
//     Save would mint a live copy shadowing the trashed one, and `readLinkByUrlKey`
//     (a `.first()` on the index) would then return an arbitrary one of the two.
//   - THE MOUNT KICK COVERS BOTH ENTRY PATHS. "Opened while already signed in" and
//     "just signed in" both mount this subtree, so one effect covers both; without
//     it a fresh sign-in runs no cycle until the hourly alarm.

const mockUseAuth = jest.fn();
const mockUseSync = jest.fn();
const mockReadLinkByUrlKey = jest.fn();
const mockUsePendingChangesCount = jest.fn(() => 0);

jest.mock('@stxapps/web-react', () => ({
  get useAuth() {
    return mockUseAuth;
  },
  get useSync() {
    return mockUseSync;
  },
  get readLinkByUrlKey() {
    return mockReadLinkByUrlKey;
  },
  get usePendingChangesCount() {
    return mockUsePendingChangesCount;
  },
}));

// The store reads go through a stand-in that keeps the two properties App depends
// on — the querier runs, and it answers `undefined` until it settles.
jest.mock('dexie-react-hooks', () => require('../../testing/live-query'));

// The screens themselves are pinned in their own specs; here they only need to be
// identifiable, and to report the props the router chose for them.
jest.mock('./SignIn', () => ({ SignIn: () => <div>SIGN IN</div> }));
jest.mock('./Complete', () => ({
  Complete: ({ link }: { link: { url: string } }) => <div>COMPLETE {link.url}</div>,
}));
jest.mock('./Editor', () => ({
  Editor: ({ url, trashed }: { url: string; trashed?: { url: string } }) => (
    <div>
      EDITOR {url} {trashed ? 'RESTORING' : 'FRESH'}
    </div>
  ),
}));

const SAVED = { url: 'https://example.com/post', listId: 'inbox' };

let fake: FakeBrowser;

/** What the browser reports for the tab the user has open. */
function activeTab(tab: Record<string, unknown> | null): void {
  fake.tabs.query.mockResolvedValue(tab ? [tab] : []);
}

/** Render and let the tab query + the live query settle. */
async function open(): Promise<void> {
  render(<App />);
  await act(async () => undefined);
}

const body = () => document.body.textContent ?? '';

beforeEach(() => {
  jest.clearAllMocks();
  fake = installFakeBrowser();
  mockUseAuth.mockReturnValue({ status: 'authenticated' });
  mockUseSync.mockReturnValue({ requestSync: jest.fn() });
  mockReadLinkByUrlKey.mockResolvedValue(undefined);
  activeTab({ url: 'https://example.com/post', title: 'A post' });
});

describe('the auth branch', () => {
  it('shows a quiet spinner while auth is still resolving', async () => {
    mockUseAuth.mockReturnValue({ status: 'loading' });

    render(<App />);

    expect(screen.getByText('Loading')).toBeTruthy();
    // Nothing is queried, and no cycle is kicked, until there is a session.
    expect(fake.tabs.query).not.toHaveBeenCalled();
    await act(async () => undefined);
  });

  it('shows sign-in when there is no session, with no sync footer to speak of', async () => {
    mockUseAuth.mockReturnValue({ status: 'unauthenticated' });

    render(<App />);

    expect(body()).toContain('SIGN IN');
    await act(async () => undefined);
  });

  it('kicks a background cycle the moment the popup is authenticated', async () => {
    const requestSync = jest.fn();
    mockUseSync.mockReturnValue({ requestSync });

    await open();

    // Not a count: StrictMode (docs/testing.md) runs the mount effect twice, which
    // the popup's real root does too — the worker's single-flight coalesces kicks.
    expect(requestSync).toHaveBeenCalled();
  });
});

describe('the tab branch', () => {
  it('names the boundary when the tab is not a web page', async () => {
    // A chrome:// page, the web store, a PDF viewer. "Can't be saved" alone leaves
    // the user re-clicking the icon wondering what broke.
    activeTab({ url: 'chrome://extensions', title: 'Extensions' });

    await open();

    expect(screen.getByText('Nothing to save here')).toBeTruthy();
    expect(body()).toContain('Open an http or https page');
  });

  it('says the same when there is no tab at all', async () => {
    activeTab(null);

    await open();

    expect(screen.getByText('Nothing to save here')).toBeTruthy();
  });

  it('says the same when the tab query is refused', async () => {
    fake.tabs.query.mockRejectedValue(new Error('no permission'));

    await open();

    expect(screen.getByText('Nothing to save here')).toBeTruthy();
  });

  it('waits rather than guessing while the tab query is in flight', async () => {
    render(<App />);

    expect(screen.getByText('Loading')).toBeTruthy();
    await act(async () => undefined);
  });
});

describe('the already-saved branch', () => {
  it('opens the editor for a tab that is not in the library', async () => {
    await open();

    expect(body()).toContain('EDITOR');
    expect(body()).toContain('FRESH');
  });

  it('skips straight to the complete screen for a tab that is', async () => {
    mockReadLinkByUrlKey.mockResolvedValue(SAVED);

    await open();

    expect(body()).toContain('COMPLETE https://example.com/post');
  });

  it('does not go to the store at all for a tab it cannot save', async () => {
    // Canonical matching itself is `readLinkByUrlKey`'s job and is pinned in
    // web-react; what this file owns is only whether to ask.
    activeTab({ url: 'chrome://extensions', title: 'Extensions' });

    await open();

    expect(mockReadLinkByUrlKey).not.toHaveBeenCalled();
  });

  it('does not sit on the spinner once the query settles as "not saved"', async () => {
    // The `?? null` coercion. Without it `undefined` means both "loading" and "not
    // saved", and the popup never leaves the spinner for an unsaved page.
    mockReadLinkByUrlKey.mockResolvedValue(undefined);

    await open();

    expect(screen.queryByText('Loading')).toBeNull();
  });
});

describe('a match in Trash', () => {
  it('offers a restore instead of a receipt', async () => {
    mockReadLinkByUrlKey.mockResolvedValue({ ...SAVED, listId: TRASH_ID });

    await open();

    expect(body()).toContain('EDITOR');
    expect(body()).toContain('RESTORING');
    expect(body()).not.toContain('COMPLETE');
  });
});

describe('the sync view', () => {
  it('swaps the whole popup for the sync detail, and back', async () => {
    mockUseSync.mockReturnValue({
      requestSync: jest.fn(),
      storeStatus: 'ready',
      bgSyncStatus: 'idle',
      lastSyncAt: null,
      lastError: null,
      blockedCount: 0,
    });
    await open();

    fireEvent.click(screen.getByText('Not synced yet'));
    expect(body()).toContain('Pending changes');
    expect(body()).not.toContain('EDITOR');

    fireEvent.click(screen.getByRole('button', { name: 'Back' }));
    // The save flow unmounted with the view swap, so it re-queries the tab on the
    // way back — the popup is a state machine, not a router with cached screens.
    await act(async () => undefined);
    expect(body()).toContain('EDITOR');
  });

  it('opens the options page from the header', async () => {
    await open();

    fireEvent.click(screen.getByRole('button', { name: 'Settings' }));

    expect(fake.runtime.openOptionsPage).toHaveBeenCalledTimes(1);
  });
});
